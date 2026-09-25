/**
 * Importing profiles people upload to spark's viewer.
 *
 * A manual `/spark profiler start --timeout 300` ends by UPLOADING its result
 * to spark's web service, not by writing a file, so the harvester never sees
 * it. The upload link is not in the server log either -- spark sends it to
 * whoever ran the command. It IS recorded in `config/spark/activity.json`,
 * which spark keeps for exactly this purpose, so that file is where uploads
 * are found.
 *
 * ## What this reaches, and what it does not
 *
 *   reads   config/spark/activity.json on the server, read only
 *   fetches https://spark-usercontent.lucko.me/<code> -- the raw bytes behind
 *           a spark.lucko.me/<code> link, which is where spark put them
 *
 * Nothing is sent to the server and nothing is uploaded anywhere. Only links
 * of the exact form https://spark.lucko.me/<code> are followed; anything else
 * in the file is ignored. Off by default, because it is the one thing in the
 * application that downloads from a service on the internet.
 *
 * Every code is tried once (three times if the download itself failed) and
 * the outcome recorded, so an upload is never fetched twice and a link that
 * turned out to be a heap summary rather than a profile is not retried.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';

import type { Store } from '../store/db.ts';
import { ingestFile, type IngestOptions } from '../ingest/pipeline.ts';
import type { Mappings } from '../decode/mappings.ts';

export interface UploadEntry {
  code: string;
  url: string;
  /** When spark recorded the upload. */
  at: number;
  /** Who ran it: a player name, or "Console". */
  by: string;
}

const LINK = /^https:\/\/spark\.lucko\.me\/([A-Za-z0-9]{6,24})$/;
export const CONTENT_HOST = 'https://spark-usercontent.lucko.me/';
const MAX_BYTES = 256 * 1024 * 1024;

/** Profiler uploads listed in activity.json, oldest first. */
export function readUploads(serverRoot: string): UploadEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(serverRoot, 'config', 'spark', 'activity.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: UploadEntry[] = [];
  for (const entry of parsed as Array<Record<string, unknown>>) {
    if (entry?.['type'] !== 'Profiler') continue;
    const data = entry['data'] as Record<string, unknown> | undefined;
    if (data?.['type'] !== 'url' || typeof data['value'] !== 'string') continue;
    const match = LINK.exec(data['value']);
    if (match === null) continue;
    const at = Number(entry['time']);
    if (!Number.isFinite(at)) continue;
    const user = entry['user'] as Record<string, unknown> | undefined;
    out.push({ code: match[1]!, url: data['value'], at, by: typeof user?.['name'] === 'string' ? user['name'] : 'unknown' });
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface UploadDeps {
  store: Store;
  serverId: string;
  serverRoot: string;
  mappings: Mappings;
  archiveDir: string;
  archiveRaw: boolean;
  /** Only uploads this recent are considered. spark's own links expire. */
  lookbackMs: number;
  /** At most this many downloads per call, so a backlog is spread out. */
  maxPerRun?: number;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  now?: () => number;
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; bytes: () => Promise<Uint8Array> }>;
  ingest?: (file: string, options: IngestOptions) => { status: string; captureId: number };
}

export interface UploadRunResult {
  imported: number;
  skipped: number;
  failed: number;
}

function status(store: Store, code: string): { status: string; attempts: number } | undefined {
  return store.db.prepare('SELECT status, attempts FROM upload_import WHERE code = ?').get(code) as
    | { status: string; attempts: number }
    | undefined;
}

function remember(
  store: Store,
  entry: UploadEntry,
  outcome: string,
  detail: string,
  captureId?: number,
): void {
  store.db
    .prepare(
      `INSERT INTO upload_import (code, uploaded_at, uploaded_by, status, capture_id, detail, attempted_at, attempts)
       VALUES (?,?,?,?,?,?,?,1)
       ON CONFLICT(code) DO UPDATE SET status = excluded.status, capture_id = excluded.capture_id,
         detail = excluded.detail, attempted_at = excluded.attempted_at, attempts = attempts + 1`,
    )
    .run(entry.code, entry.at, entry.by, outcome, captureId ?? null, detail.slice(0, 500), Date.now());
}

async function defaultFetch(url: string): Promise<{ ok: boolean; status: number; bytes: () => Promise<Uint8Array> }> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'perfint (archiving its own server profiles)' },
    signal: AbortSignal.timeout(60_000),
  });
  return { ok: res.ok, status: res.status, bytes: async () => new Uint8Array(await res.arrayBuffer()) };
}

export async function importUploads(deps: UploadDeps): Promise<UploadRunResult> {
  const now = deps.now ?? Date.now;
  const result: UploadRunResult = { imported: 0, skipped: 0, failed: 0 };
  const due = readUploads(deps.serverRoot).filter((entry) => {
    if (now() - entry.at > deps.lookbackMs) return false;
    const seen = status(deps.store, entry.code);
    return seen === undefined || (seen.status === 'download-failed' && seen.attempts < 3);
  });

  for (const entry of due.slice(0, deps.maxPerRun ?? 3)) {
    let bytes: Uint8Array;
    try {
      const res = await (deps.fetch ?? defaultFetch)(CONTENT_HOST + entry.code);
      if (!res.ok) {
        // 404 is final: the upload has expired or never existed.
        const final = res.status === 404;
        remember(deps.store, entry, final ? 'gone' : 'download-failed', `HTTP ${res.status}`);
        if (final) result.skipped += 1;
        else result.failed += 1;
        continue;
      }
      bytes = await res.bytes();
    } catch (error) {
      remember(deps.store, entry, 'download-failed', (error as Error).message);
      result.failed += 1;
      continue;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
      remember(deps.store, entry, 'not-a-profile', `${bytes.byteLength} bytes`);
      result.skipped += 1;
      continue;
    }

    const stage = path.join(deps.store.dataDir, 'incoming');
    mkdirSync(stage, { recursive: true });
    const staged = path.join(stage, `${entry.code}.sparkprofile`);
    writeFileSync(staged, bytes);
    try {
      const outcome = (deps.ingest ?? ingestFile)(staged, {
        store: deps.store,
        serverId: deps.serverId,
        mappings: deps.mappings,
        archiveDir: deps.archiveDir,
        archiveRaw: deps.archiveRaw,
        serverRoot: deps.serverRoot,
        isManual: true,
      });
      remember(deps.store, entry, outcome.status === 'duplicate' ? 'duplicate' : 'imported', `by ${entry.by}`, outcome.captureId);
      deps.log('info', `imported ${entry.by}'s upload ${entry.url} as capture ${outcome.captureId} (${outcome.status})`);
      result.imported += 1;
    } catch (error) {
      // Not every spark upload is a profile (heap summaries share the list).
      remember(deps.store, entry, 'not-a-profile', (error as Error).message);
      result.skipped += 1;
    } finally {
      rmSync(staged, { force: true });
    }
  }
  return result;
}
