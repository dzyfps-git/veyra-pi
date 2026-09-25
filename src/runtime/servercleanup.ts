/**
 * Removing harvested profiles from the server's spark folder.
 *
 * Every harvest leaves spark's saved file behind on the server (about 15 MB
 * each, ~1.4 GB a day at a 15-minute interval). Once a copy is safely in the
 * archive here, the server's copy is only a safety buffer.
 *
 * A file is eligible only when ALL of these hold, checked in this order:
 *   - its name is exactly spark's saved-profile pattern, and it is a plain
 *     file directly in the spark folder (no links, no subfolders);
 *   - it is older than the safety buffer (Settings, Cleanup) and older than
 *     the minimum age, so nothing still being written is ever touched;
 *   - this app harvested it: the harvest recorded the server-side hash and a
 *     matching local copy ("verify / match" in the audit log). Profiles you
 *     saved yourself, or another tool did, are never eligible;
 *   - a capture with that exact content is in the archive.
 * Then, immediately before removing it, the file is hashed again and must
 * still match, and its size and time must be unchanged.
 *
 * Off by default, and dry-run (report only) by default once switched on.
 * Every decision is written to the audit log either way.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';

import type { Store } from '../store/db.ts';
import type { SettingsStore } from '../settings/store.ts';
import { SAVED_PROFILE_PATTERN } from './harvest.ts';

export interface ServerCleanupSummary {
  at: number;
  dryRun: boolean;
  /** Files that were (or in a dry run, would have been) removed. */
  removed: string[];
  bytes: number;
  keptRecent: number;
  keptNotOurs: number;
  keptNotArchived: number;
  failed: string[];
}

function audit(store: Store, serverId: string, at: number, outcome: string, detail: string, target: string, sha: string | null, dryRun: boolean): void {
  store.db
    .prepare(
      `INSERT INTO server_action (server_id, at, action, target, sha256, dry_run, outcome, detail)
       VALUES (?,?,'cleanup',?,?,?,?,?)`,
    )
    .run(serverId, at, target, sha, dryRun ? 1 : 0, outcome, detail.slice(0, 2000));
}

export function cleanupServer(
  store: Store,
  settings: SettingsStore,
  server: { id: string; sparkDirLocal: string },
  options: { now?: number; dryRun?: boolean } = {},
): ServerCleanupSummary {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? settings.getBoolean('cleanup.server.dryRun');
  const keepMs = settings.getNumber('cleanup.server.retentionHours') * 3_600_000;
  const minAgeMs = settings.getNumber('cleanup.server.minFileAgeMinutes') * 60_000;
  const summary: ServerCleanupSummary = {
    at: now,
    dryRun,
    removed: [],
    bytes: 0,
    keptRecent: 0,
    keptNotOurs: 0,
    keptNotArchived: 0,
    failed: [],
  };

  const verified = store.db.prepare(
    `SELECT sha256 FROM server_action
      WHERE server_id = ? AND action = 'verify' AND outcome = 'match' AND target = ? AND sha256 IS NOT NULL
      ORDER BY at DESC LIMIT 1`,
  );
  const archived = store.db.prepare('SELECT 1 AS ok FROM capture WHERE content_sha256 = ?');

  for (const name of readdirSync(server.sparkDirLocal)) {
    if (!SAVED_PROFILE_PATTERN.test(name)) continue;
    const file = path.join(server.sparkDirLocal, name);
    let before: { size: number; mtimeMs: number };
    try {
      const l = lstatSync(file);
      if (!l.isFile() || l.isSymbolicLink()) continue;
      before = { size: l.size, mtimeMs: l.mtimeMs };
    } catch {
      continue;
    }
    const age = now - before.mtimeMs;
    if (age < Math.max(keepMs, minAgeMs)) {
      summary.keptRecent += 1;
      continue;
    }
    const record = verified.get(server.id, name) as { sha256: string } | undefined;
    if (record === undefined) {
      summary.keptNotOurs += 1;
      continue;
    }
    if (archived.get(record.sha256) === undefined) {
      summary.keptNotArchived += 1;
      continue;
    }

    if (dryRun) {
      audit(store, server.id, now, 'would delete', `${before.size} bytes, harvested and archived`, name, record.sha256, true);
      summary.removed.push(name);
      summary.bytes += before.size;
      continue;
    }
    try {
      const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
      const after = statSync(file);
      if (sha !== record.sha256) throw new Error('its content no longer matches what was harvested');
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('it changed while being checked');
      unlinkSync(file);
      audit(store, server.id, now, 'deleted', `${before.size} bytes, harvested and archived`, name, sha, false);
      summary.removed.push(name);
      summary.bytes += before.size;
    } catch (error) {
      audit(store, server.id, now, 'kept', (error as Error).message, name, record.sha256, false);
      summary.failed.push(`${name}: ${(error as Error).message}`);
    }
  }
  store.setMeta(`cleanup.server.last.${server.id}`, JSON.stringify(summary));
  return summary;
}

export function lastServerCleanup(store: Pick<Store, 'getMeta'>, serverId: string): ServerCleanupSummary | undefined {
  try {
    const raw = store.getMeta(`cleanup.server.last.${serverId}`);
    return raw === undefined || raw === '' ? undefined : (JSON.parse(raw) as ServerCleanupSummary);
  } catch {
    return undefined;
  }
}
