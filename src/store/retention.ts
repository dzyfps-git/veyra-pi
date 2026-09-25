/**
 * Keeping the local archive from growing without end.
 *
 * Two jobs, both on this app's own files only:
 *
 *   compressArchivedRaw  Rewrites an older, uncompressed raw capture as
 *                        .sparkprofile.zst (13x smaller). The compressed copy
 *                        is decompressed and hashed against the capture's
 *                        recorded hash before the database points at it, and
 *                        only then is the old file removed.
 *
 *   cleanupLocal         Removes raw captures older than the retention window
 *                        (Settings, Retention). Everything measured from them
 *                        stays: the daily ledger, the per-minute detail, the
 *                        capture's record. Never removed: pinned captures
 *                        (anomalies, or pinned by hand), your own profiles, and
 *                        anything recorded since the last update while going
 *                        back is still possible, because going back re-imports
 *                        those from their raw files.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

import type { Store } from './db.ts';
import type { SettingsStore } from '../settings/store.ts';
import { compressRaw, RAW_EXTENSION } from '../ingest/pipeline.ts';
import { zstdDecompressSync } from 'node:zlib';

export type CompressOutcome = 'compressed' | 'already' | 'missing';

export function compressArchivedRaw(store: Store, captureId: number): CompressOutcome {
  const row = store.db.prepare('SELECT archive_path, content_sha256 FROM capture WHERE id = ?').get(captureId) as
    | { archive_path: string | null; content_sha256: string }
    | undefined;
  if (row === undefined || row.archive_path === null) return 'missing';
  if (row.archive_path.endsWith('.zst')) return 'already';
  const file = store.resolveDataPath(row.archive_path);
  if (file === undefined || !existsSync(file)) return 'missing';

  const bytes = readFileSync(file);
  if (createHash('sha256').update(bytes).digest('hex') !== row.content_sha256) {
    throw new Error(`capture ${captureId}: ${file} does not match its recorded hash; left as it is`);
  }
  const target = file.replace(/\.sparkprofile$/, '') + RAW_EXTENSION;
  const compressed = compressRaw(bytes);
  const check = createHash('sha256').update(zstdDecompressSync(compressed)).digest('hex');
  if (check !== row.content_sha256) throw new Error(`capture ${captureId}: compressed copy did not verify; left as it is`);
  writeFileSync(`${target}.part`, compressed, { flush: true });
  renameSync(`${target}.part`, target);
  store.db.prepare('UPDATE capture SET archive_path = ? WHERE id = ?').run(store.toStoredPath(target), captureId);
  rmSync(file, { force: true });
  return 'compressed';
}

export interface CleanupSummary {
  at: number;
  removed: number;
  bytes: number;
  keptPinned: number;
  keptManual: number;
  keptForGoingBack: number;
  days: number;
}

/**
 * Remove raw captures past the retention window. `protectSince` is the time
 * after which raw files are needed for going back (see runtime/updates.ts).
 */
export function cleanupLocal(
  store: Store,
  settings: SettingsStore,
  options: { now?: number; protectSince?: number } = {},
): CleanupSummary {
  const now = options.now ?? Date.now();
  const days = settings.getNumber('retention.rawDays');
  const cutoff = now - days * 86_400_000;
  const old = store.db
    .prepare(
      `SELECT id, archive_path, pinned, is_manual, ingested_at FROM capture
        WHERE archive_path IS NOT NULL AND started_at IS NOT NULL AND started_at < ?
        ORDER BY started_at`,
    )
    .all(cutoff) as Array<{ id: number; archive_path: string; pinned: number; is_manual: number; ingested_at: number }>;

  const summary: CleanupSummary = { at: now, removed: 0, bytes: 0, keptPinned: 0, keptManual: 0, keptForGoingBack: 0, days };
  const forget = store.db.prepare('UPDATE capture SET archive_path = NULL WHERE id = ?');
  for (const c of old) {
    if (c.pinned === 1) {
      summary.keptPinned += 1;
      continue;
    }
    if (c.is_manual === 1) {
      summary.keptManual += 1;
      continue;
    }
    if (options.protectSince !== undefined && c.ingested_at > options.protectSince) {
      summary.keptForGoingBack += 1;
      continue;
    }
    const file = store.resolveDataPath(c.archive_path);
    let size = 0;
    try {
      if (file !== undefined) size = statSync(file).size;
    } catch {
      // Already gone: only the record needs updating.
    }
    // The record first: a file the database no longer points at is clutter,
    // a database pointing at a missing file is an error.
    forget.run(c.id);
    if (file !== undefined) rmSync(file, { force: true });
    summary.removed += 1;
    summary.bytes += size;
  }
  store.setMeta('cleanup.local.last', JSON.stringify(summary));
  return summary;
}

export function lastCleanup(store: Pick<Store, 'getMeta'>): CleanupSummary | undefined {
  try {
    const raw = store.getMeta('cleanup.local.last');
    return raw === undefined || raw === '' ? undefined : (JSON.parse(raw) as CleanupSummary);
  } catch {
    return undefined;
  }
}
