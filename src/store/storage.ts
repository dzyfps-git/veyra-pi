/**
 * Where everything is kept, how big it is, and moving the archive.
 *
 * The settings page used to show "data" and "data/archive": values relative
 * to a folder nobody could see, which answered "where is my data" with a
 * riddle. Everything here is resolved to a real location first, so the page
 * can show the actual folder, what is in it, and how much room is left.
 *
 * ## Two folders, and why only one moves
 *
 *   data folder   The database, logs and backups. Chosen by the desktop app
 *                 (%APPDATA%\perfint\data) before this process even starts,
 *                 because the database that would hold the setting lives in
 *                 it. Shown, openable, not movable from inside.
 *
 *   archive       Raw profiles and per-capture sidecars -- almost all of the
 *                 bytes, and the part that grows. Defaults to "archive"
 *                 inside the data folder; can be moved to any folder, for
 *                 example a larger drive.
 *
 * ## Moving the archive
 *
 * Every file is copied and its hash checked BEFORE anything else changes.
 * Only when every copy verifies are the stored paths switched, in one
 * transaction, together with the setting. Only after that are the old files
 * removed -- each one re-hashed first against its new copy. A failure at any
 * earlier point removes the new copies and leaves everything as it was.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import * as path from 'node:path';

import type { Store } from './db.ts';
import type { SettingsStore } from '../settings/store.ts';

/** The archive folder actually in use, as an absolute path. */
export function archiveDirOf(store: Pick<Store, 'dataDir'>, settings: SettingsStore): string {
  const configured = settings.getString('storage.archiveDir').trim();
  if (configured === '') return path.join(store.dataDir, 'archive');
  return path.isAbsolute(configured) ? path.normalize(configured) : path.join(store.dataDir, configured);
}

/** Free bytes on the volume holding `dir`, looking upward until something exists. */
export function freeBytes(dir: string): number | undefined {
  let probe = path.resolve(dir);
  for (;;) {
    if (existsSync(probe)) {
      try {
        const stats = statfsSync(probe);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
}

export interface FolderUsage {
  path: string;
  exists: boolean;
  bytes: number;
  files: number;
}

export function folderUsage(dir: string, match?: (name: string) => boolean): FolderUsage {
  const usage: FolderUsage = { path: dir, exists: existsSync(dir), bytes: 0, files: 0 };
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (match === undefined || match(entry.name))) {
        try {
          usage.bytes += statSync(full).size;
          usage.files += 1;
        } catch {
          // A file that vanished mid-walk simply is not counted.
        }
      }
    }
  };
  if (usage.exists) walk(dir);
  return usage;
}

export interface StorageSummary {
  dataDir: string;
  databaseBytes: number;
  archive: FolderUsage;
  rawProfiles: FolderUsage;
  sidecars: FolderUsage;
  backups: FolderUsage;
  archiveIsDefault: boolean;
  freeBytesAtArchive: number | undefined;
  freeBytesAtData: number | undefined;
  minFreeBytes: number;
}

export function storageSummary(store: Pick<Store, 'dataDir'>, settings: SettingsStore): StorageSummary {
  const archive = archiveDirOf(store, settings);
  const dbFile = path.join(store.dataDir, 'perfint.sqlite');
  let databaseBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      databaseBytes += statSync(dbFile + suffix).size;
    } catch {
      // Absent WAL/SHM files are normal.
    }
  }
  return {
    dataDir: store.dataDir,
    databaseBytes,
    archive: folderUsage(archive),
    rawProfiles: folderUsage(archive, (n) => n.endsWith('.sparkprofile') || n.endsWith('.sparkprofile.zst')),
    sidecars: folderUsage(archive, (n) => n.endsWith('.sidecar.zst')),
    backups: folderUsage(path.join(store.dataDir, 'backups')),
    archiveIsDefault: settings.getString('storage.archiveDir').trim() === '',
    freeBytesAtArchive: freeBytes(archive),
    freeBytesAtData: freeBytes(store.dataDir),
    minFreeBytes: settings.getNumber('storage.minFreeGb') * 1024 ** 3,
  };
}

/** Is there room to archive another capture? Used before a harvest. */
export function diskFloorProblem(store: Pick<Store, 'dataDir'>, settings: SettingsStore): string | undefined {
  const dir = archiveDirOf(store, settings);
  const free = freeBytes(dir);
  const floor = settings.getNumber('storage.minFreeGb') * 1024 ** 3;
  if (free === undefined || free >= floor) return undefined;
  return (
    `only ${(free / 1024 ** 3).toFixed(1)} GB free where the archive lives (${dir}); ` +
    `the floor is ${settings.getNumber('storage.minFreeGb')} GB, so nothing new is written until space is freed`
  );
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface MoveResult {
  ok: boolean;
  error?: string;
  moved: number;
  bytes: number;
  from: string;
  to: string;
  /** Old files that could not be removed afterwards. Harmless; listed so they can be tidied. */
  leftBehind: string[];
}

/**
 * Move the archive to another folder, verifying every byte.
 *
 * `target` must be an absolute folder that is empty or does not exist yet --
 * merging into a folder that already holds files is refused, because then a
 * later cleanup could not tell which files are ours.
 */
export function moveArchive(store: Store, settings: SettingsStore, target: string): MoveResult {
  const from = archiveDirOf(store, settings);
  const to = path.normalize(target.trim());
  const result: MoveResult = { ok: false, moved: 0, bytes: 0, from, to, leftBehind: [] };
  const fail = (error: string): MoveResult => ({ ...result, error });

  if (to === '' || !path.isAbsolute(to)) return fail('Choose a full folder path, for example D:\\Veyra archive.');
  if (path.resolve(to) === path.resolve(from)) return fail('That is already where the archive is.');
  if (isInside(to, from)) return fail('The new folder cannot be inside the current archive.');
  if (isInside(from, to)) return fail('The new folder cannot contain the current archive.');
  if (path.resolve(to) === path.resolve(store.dataDir)) {
    return fail('Choose a folder of its own, not the data folder itself.');
  }
  if (existsSync(to)) {
    let entries: string[];
    try {
      if (!statSync(to).isDirectory()) return fail('That path is a file, not a folder.');
      entries = readdirSync(to);
    } catch (error) {
      return fail(`That folder cannot be read: ${(error as Error).message}`);
    }
    if (entries.length > 0) {
      return fail('That folder is not empty. Choose an empty folder, or a new one to be created.');
    }
  }

  // Every file the database points at inside the current archive.
  const rows = store.db
    .prepare('SELECT id, archive_path, sidecar_path FROM capture')
    .all() as Array<{ id: number; archive_path: string | null; sidecar_path: string | null }>;
  const plan: Array<{ id: number; column: 'archive_path' | 'sidecar_path'; oldFile: string; newFile: string }> = [];
  for (const row of rows) {
    for (const column of ['archive_path', 'sidecar_path'] as const) {
      const oldFile = store.resolveDataPath(row[column]);
      if (oldFile === undefined || !isInside(oldFile, from)) continue;
      if (!existsSync(oldFile)) continue; // already gone (retention); nothing to carry
      plan.push({ id: row.id, column, oldFile, newFile: path.join(to, path.relative(from, oldFile)) });
    }
  }

  const needed = plan.reduce((n, p) => n + statSync(p.oldFile).size, 0);
  const free = freeBytes(to);
  if (free !== undefined && free < needed * 1.1 + 64 * 1024 ** 2) {
    return fail(`Not enough space there: ${(needed / 1024 ** 2).toFixed(0)} MB needed.`);
  }

  // 1. Copy and verify everything. Nothing else has changed yet.
  const created: string[] = [];
  try {
    mkdirSync(to, { recursive: true });
    for (const step of plan) {
      mkdirSync(path.dirname(step.newFile), { recursive: true });
      copyFileSync(step.oldFile, step.newFile);
      created.push(step.newFile);
      if (hashFile(step.newFile) !== hashFile(step.oldFile)) throw new Error(`copy of ${step.oldFile} did not verify`);
      result.bytes += statSync(step.newFile).size;
    }
  } catch (error) {
    for (const file of created) {
      try {
        unlinkSync(file);
      } catch {
        // Best effort; the originals are untouched either way.
      }
    }
    return fail(`Nothing was moved: ${(error as Error).message}`);
  }

  // 2. Switch the setting, then the paths. The settings store runs its own
  // transaction, so the two cannot share one; if switching the paths fails,
  // the setting is put back and the new copies removed.
  // Back in the default place is stored as "default", so the archive keeps
  // following the data folder if that ever moves.
  const previous = settings.getString('storage.archiveDir');
  const value = path.resolve(to) === path.resolve(store.dataDir, 'archive') ? '' : to;
  settings.apply({ 'storage.archiveDir': value }, { actor: 'storage-move' });
  if (settings.getString('storage.archiveDir') !== value) {
    for (const file of created) {
      try {
        unlinkSync(file);
      } catch {
        // Originals are untouched either way.
      }
    }
    return fail('The new location could not be saved; nothing was moved.');
  }
  try {
    store.transaction(() => {
      for (const step of plan) {
        store.db
          .prepare(`UPDATE capture SET ${step.column} = ? WHERE id = ?`)
          .run(store.toStoredPath(step.newFile), step.id);
      }
    });
  } catch (error) {
    settings.apply({ 'storage.archiveDir': previous }, { actor: 'storage-move' });
    for (const file of created) {
      try {
        unlinkSync(file);
      } catch {
        // Originals are untouched either way.
      }
    }
    return fail(`Nothing was moved: ${(error as Error).message}`);
  }

  // 3. Only now remove the originals, each re-checked against its copy.
  for (const step of plan) {
    try {
      if (hashFile(step.oldFile) === hashFile(step.newFile)) unlinkSync(step.oldFile);
      else result.leftBehind.push(step.oldFile);
    } catch {
      result.leftBehind.push(step.oldFile);
    }
  }
  // Empty day folders left behind are tidied; anything non-empty is kept.
  const prune = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) prune(path.join(dir, entry.name));
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // Not empty, or in use: leave it.
    }
  };
  prune(from);

  result.moved = plan.length;
  result.ok = true;
  return result;
}

// ---------------------------------------------------------------------------
// Captures that are not history.
// ---------------------------------------------------------------------------

/**
 * Seconds-long captures saved by restoring background profiling.
 *
 * Restoring is start-then-stop, and the stop saves the few seconds between
 * them. Those files were archived as captures until that was noticed; this
 * finds them so they can be taken back out. A real harvest cannot look like
 * this: the collector never harvests a background profiler younger than its
 * minimum age, and a manual capture is never matched.
 */
export function findRestoreStubs(store: Pick<Store, 'db'>): Array<{ id: number; source_name: string }> {
  return store.db
    .prepare(
      `SELECT id, source_name FROM capture
        WHERE is_manual = 0 AND window_count <= 1
          AND ended_at IS NOT NULL AND ended_at - started_at < 60000
        ORDER BY id`,
    )
    .all() as Array<{ id: number; source_name: string }>;
}

/**
 * Take captures out of the archive. Their files are MOVED into
 * backups/removed-captures, not deleted, and the database rows go (their
 * per-minute statistics and mod lists follow by cascade). The daily ledger
 * still counts them until it is rebuilt, which the caller must do.
 */
export function forgetCaptures(store: Store, ids: readonly number[]): { removed: number; files: number } {
  if (ids.length === 0) return { removed: 0, files: 0 };
  const keep = path.join(store.dataDir, 'backups', 'removed-captures');
  let files = 0;
  const rows = store.db
    .prepare(`SELECT id, archive_path, sidecar_path FROM capture WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Array<{ id: number; archive_path: string | null; sidecar_path: string | null }>;

  store.transaction(() => {
    for (const row of rows) store.db.prepare('DELETE FROM capture WHERE id = ?').run(row.id);
  });

  for (const row of rows) {
    for (const stored of [row.archive_path, row.sidecar_path]) {
      const file = store.resolveDataPath(stored);
      if (file === undefined || !existsSync(file)) continue;
      try {
        mkdirSync(keep, { recursive: true });
        const target = path.join(keep, `capture-${row.id}-${path.basename(file)}`);
        copyFileSync(file, target);
        if (hashFile(target) === hashFile(file)) {
          unlinkSync(file);
          files += 1;
        }
      } catch {
        // Leaving a stray file in the archive is harmless.
      }
    }
  }
  return { removed: rows.length, files };
}
