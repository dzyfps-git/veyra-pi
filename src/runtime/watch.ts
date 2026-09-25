/**
 * "Watch folder" collection: import profiles someone saved by hand.
 *
 * For servers profiled manually -- typically a staging server on this PC --
 * nothing is ever sent to the console. The server's spark folder is read, and
 * any `.sparkprofile` that has stopped changing is archived as a manual
 * capture.
 *
 * A file is imported only after it has been seen twice, at least
 * `settleMs` apart, with the same size and modification time: spark writes
 * large profiles in pieces, and reading one mid-write would archive a
 * truncated capture. Every file's outcome is recorded by name, size and
 * modification time, so nothing is read twice and a replaced file (same name,
 * new content) is picked up again. Files are never moved, renamed or deleted.
 */

import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import type { Store } from '../store/db.ts';
import { ingestFile, type IngestOptions } from '../ingest/pipeline.ts';
import type { Mappings } from '../decode/mappings.ts';

export interface WatchDeps {
  store: Store;
  serverId: string;
  serverRoot: string;
  sparkDir: string;
  mappings: Mappings;
  archiveDir: string;
  archiveRaw: boolean;
  /** Pending sightings, kept by the caller between scans. */
  pending: Map<string, { size: number; mtime: number; seenAt: number }>;
  settleMs?: number;
  now?: () => number;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  ingest?: (file: string, options: IngestOptions) => { status: string; captureId: number };
}

export interface WatchResult {
  imported: number;
  waiting: number;
  failed: number;
}

export function scanWatchedFolder(deps: WatchDeps): WatchResult {
  const now = deps.now ?? Date.now;
  const settle = deps.settleMs ?? 20_000;
  const dir = path.join(deps.serverRoot, deps.sparkDir);
  const result: WatchResult = { imported: 0, waiting: 0, failed: 0 };

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.sparkprofile'));
  } catch {
    return result;
  }

  const done = deps.store.db.prepare(
    'SELECT 1 FROM watched_file WHERE server_id = ? AND name = ? AND size = ? AND mtime = ?',
  );
  const record = deps.store.db.prepare(
    `INSERT INTO watched_file (server_id, name, size, mtime, status, capture_id, at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(server_id, name) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
       status = excluded.status, capture_id = excluded.capture_id, at = excluded.at`,
  );

  for (const name of names) {
    const file = path.join(dir, name);
    let size: number;
    let mtime: number;
    try {
      const stats = statSync(file);
      if (!stats.isFile()) continue;
      size = stats.size;
      mtime = Math.floor(stats.mtimeMs);
    } catch {
      continue;
    }
    if (done.get(deps.serverId, name, size, mtime) !== undefined) continue;

    const seen = deps.pending.get(name);
    if (seen === undefined || seen.size !== size || seen.mtime !== mtime) {
      deps.pending.set(name, { size, mtime, seenAt: now() });
      result.waiting += 1;
      continue;
    }
    if (now() - seen.seenAt < settle) {
      result.waiting += 1;
      continue;
    }

    deps.pending.delete(name);
    try {
      const outcome = (deps.ingest ?? ingestFile)(file, {
        store: deps.store,
        serverId: deps.serverId,
        mappings: deps.mappings,
        archiveDir: deps.archiveDir,
        archiveRaw: deps.archiveRaw,
        serverRoot: deps.serverRoot,
        isManual: true,
      });
      record.run(deps.serverId, name, size, mtime, outcome.status, outcome.captureId, now());
      if (outcome.status !== 'duplicate') {
        result.imported += 1;
        deps.log('info', `imported ${name} as capture ${outcome.captureId}`);
      }
    } catch (error) {
      record.run(deps.serverId, name, size, mtime, 'unreadable', null, now());
      result.failed += 1;
      deps.log('warn', `${name} could not be imported: ${(error as Error).message}`);
    }
  }
  return result;
}
