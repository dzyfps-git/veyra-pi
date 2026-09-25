/**
 * Updating the app, and going back.
 *
 * New versions arrive as installer files in a
 * folder on this PC (the Updates page says which), or are downloaded from
 * GitHub releases into one (runtime/github.ts); each installer has a
 * small manifest next to it with its checksum and what is new.
 *
 * Installing (desktop/app/main.js does the actual running of the installer):
 *   1. wait for a moment between collections, never mid-harvest;
 *   2. back up the database (this module);
 *   3. keep a copy of the new installer, so it can be gone back to later;
 *   4. stop monitoring, run the installer silently, and start again.
 * Minecraft is never touched; monitoring pauses for about a minute.
 *
 * Going back reverses it: this version writes down which captures were
 * recorded since the update, the database is restored from the backup taken
 * just before it, and the previous installer runs. Whichever version starts
 * next re-imports those captures from the archive, so nothing recorded in
 * between is lost. (A version too old to read that list leaves it for the
 * next one that can.)
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as path from 'node:path';
import { homedir } from 'node:os';

import type { Store } from '../store/db.ts';
import type { SettingsStore } from '../settings/store.ts';
import { APP_VERSION, compareVersions, type Release } from '../core/changelog.ts';
import { SIDECAR_VERSION, READABLE_SIDECAR_VERSIONS } from '../store/sidecar.ts';

/**
 * electron-builder names installers "${productName} Setup ${version}.exe".
 * The product name is the brand (config/branding.toml, mirrored in
 * electron-builder.json), so it is passed in rather than written here.
 */
export function installerPattern(productName: string, options: { dotsForSpaces?: boolean } = {}): RegExp {
  // GitHub stores release assets with their spaces turned into dots.
  const space = options.dotsForSpaces === true ? '[ .]' : ' ';
  const literal = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, space);
  return new RegExp(`^${literal}${space}Setup${space}(\\d+\\.\\d+\\.\\d+)\\.exe$`);
}

export interface Manifest {
  version: string;
  sha256: string;
  size: number;
  notes: Release[];
}

export interface Installer {
  version: string;
  file: string;
  size: number;
  modifiedAt: number;
  manifest?: Manifest;
}

export interface UpdateRecord {
  from: string;
  to: string;
  at: number;
  backup: string;
  /** Sidecar formats `from` can read, so going back can be refused if it could not read what `to` wrote. */
  fromReads: number[];
}

const HISTORY_META = 'updates.history';
const REIMPORT_FILE = 'reimport.json';

export function updatesDir(store: Pick<Store, 'dataDir'>): string {
  return path.join(store.dataDir, 'updates');
}

/** Where releases downloaded from GitHub are kept (runtime/github.ts). */
export function githubDownloadsDir(store: Pick<Store, 'dataDir'>): string {
  return path.join(updatesDir(store), 'downloads');
}

export function keptInstallersDir(store: Pick<Store, 'dataDir'>): string {
  return path.join(updatesDir(store), 'installers');
}

/** Installers in the given folders, newest version first. Unreadable folders are skipped. */
export function findInstallers(folders: readonly string[], productName: string): Installer[] {
  const pattern = installerPattern(productName);
  const found = new Map<string, Installer>();
  for (const folder of folders) {
    if (folder === '' || !existsSync(folder)) continue;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = pattern.exec(name);
      if (match === null) continue;
      const file = path.join(folder, name);
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        const installer: Installer = { version: match[1]!, file, size: st.size, modifiedAt: st.mtimeMs };
        const manifest = readManifest(file);
        if (manifest !== undefined) installer.manifest = manifest;
        // The same version in two folders: prefer the one with a manifest.
        const seen = found.get(installer.version);
        if (seen === undefined || (seen.manifest === undefined && installer.manifest !== undefined)) found.set(installer.version, installer);
      } catch {
        // A file that vanished mid-scan is simply not offered.
      }
    }
  }
  return [...found.values()].sort((a, b) => compareVersions(b.version, a.version));
}

function readManifest(installer: string): Manifest | undefined {
  const file = installer.replace(/\.exe$/, '.json');
  if (!existsSync(file)) return undefined;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<Manifest>;
    if (typeof m.version !== 'string' || typeof m.sha256 !== 'string' || typeof m.size !== 'number') return undefined;
    return { version: m.version, sha256: m.sha256, size: m.size, notes: Array.isArray(m.notes) ? m.notes : [] };
  } catch {
    return undefined;
  }
}

export type Check = { ok: true; verified: boolean; detail: string } | { ok: false; detail: string };

/** Is this installer complete and what it says it is? Hashing ~110 MB takes about a second. */
export function checkInstaller(installer: Installer): Check {
  if (installer.manifest === undefined) {
    return installer.size > 10_000_000
      ? { ok: true, verified: false, detail: 'No checksum file next to it, so it cannot be verified; the size looks complete.' }
      : { ok: false, detail: 'The file is too small to be a complete installer.' };
  }
  const m = installer.manifest;
  if (m.version !== installer.version) return { ok: false, detail: `Its checksum file is for version ${m.version}, not ${installer.version}.` };
  if (m.size !== installer.size) return { ok: false, detail: `It is ${installer.size} bytes but should be ${m.size}; it may still be copying.` };
  const sha = createHash('sha256').update(readFileSync(installer.file)).digest('hex');
  if (sha !== m.sha256) return { ok: false, detail: 'Its checksum does not match; the file is damaged or incomplete.' };
  return { ok: true, verified: true, detail: 'Checksum verified.' };
}

export function history(store: Pick<Store, 'getMeta'>): UpdateRecord[] {
  try {
    const parsed = JSON.parse(store.getMeta(HISTORY_META) ?? '[]') as UpdateRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Keep a copy of an installer so its version can be gone back to later. Keeps the newest three. */
export function keepInstaller(store: Pick<Store, 'dataDir'>, installer: Installer, productName: string): string {
  const dir = keptInstallersDir(store);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(installer.file));
  if (path.resolve(target) !== path.resolve(installer.file) && (!existsSync(target) || statSync(target).size !== installer.size)) {
    copyFileSync(installer.file, target);
    const manifest = installer.file.replace(/\.exe$/, '.json');
    if (existsSync(manifest)) copyFileSync(manifest, target.replace(/\.exe$/, '.json'));
  }
  for (const old of findInstallers([dir], productName).slice(3)) {
    rmSync(old.file, { force: true });
    rmSync(old.file.replace(/\.exe$/, '.json'), { force: true });
  }
  return target;
}

/**
 * Back up the database before an update and remember it. Keeps the newest
 * three update backups; other backups are left alone.
 */
export function prepareUpdate(store: Store, to: string, now = Date.now()): UpdateRecord {
  const dir = path.join(store.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `before-update-${APP_VERSION}-to-${to}-${new Date(now).toISOString().replace(/[:.]/g, '-')}.sqlite`);
  store.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  const record: UpdateRecord = { from: APP_VERSION, to, at: now, backup, fromReads: [...READABLE_SIDECAR_VERSIONS] };
  const all = [...history(store), record];
  store.setMeta(HISTORY_META, JSON.stringify(all.slice(-10)));
  const updateBackups = readdirSync(dir)
    .filter((n) => n.startsWith('before-update-') && n.endsWith('.sqlite'))
    .map((n) => ({ n, t: statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of updateBackups.slice(3)) rmSync(path.join(dir, old.n), { force: true });
  return record;
}

export interface RollbackPlan {
  possible: boolean;
  /** Why not, when not. */
  reason?: string;
  record?: UpdateRecord;
  installer?: Installer;
  capturesSince: number;
}

/** Can this version be undone, and what would it take? */
export function rollbackPlan(store: Store, productName: string): RollbackPlan {
  const record = [...history(store)].reverse().find((r) => r.to === APP_VERSION);
  if (record === undefined) {
    return { possible: false, reason: 'This version was not installed through the app, so there is no backup from just before it.', capturesSince: 0 };
  }
  const capturesSince = (store.db.prepare('SELECT count(*) AS n FROM capture WHERE ingested_at > ?').get(record.at) as { n: number }).n;
  const installer = findInstallers([keptInstallersDir(store)], productName).find((i) => i.version === record.from);
  if (installer === undefined) {
    return { possible: false, reason: `The installer for ${record.from} was not kept, so it cannot be reinstalled.`, record, capturesSince };
  }
  if (!existsSync(record.backup)) {
    return { possible: false, reason: 'The database backup from before the update is missing.', record, installer, capturesSince };
  }
  if (!record.fromReads.includes(SIDECAR_VERSION)) {
    return {
      possible: false,
      reason: `Version ${record.from} cannot read the capture files this version writes, so going back would lose access to them.`,
      record,
      installer,
      capturesSince,
    };
  }
  return { possible: true, record, installer, capturesSince };
}

export interface ReimportEntry {
  file: string;
  serverId: string;
  serverRoot: string;
}

/**
 * Before going back: write down every capture recorded since the update, so
 * the version that starts next can import them again from the archive.
 */
export function writeReimportList(store: Store, record: UpdateRecord): number {
  const rows = store.db
    .prepare(
      `SELECT c.archive_path, c.server_id, s.root FROM capture c JOIN server s ON s.id = c.server_id
       WHERE c.ingested_at > ? AND c.archive_path IS NOT NULL ORDER BY c.started_at`,
    )
    .all(record.at) as Array<{ archive_path: string; server_id: string; root: string | null }>;
  const entries: ReimportEntry[] = rows
    .map((r) => ({ file: store.resolveDataPath(r.archive_path) ?? '', serverId: r.server_id, serverRoot: r.root ?? '' }))
    .filter((e) => e.file !== '');
  // Merge with anything still waiting from an earlier rollback.
  const merged = new Map(readReimportList(store).map((e) => [e.file, e]));
  for (const e of entries) merged.set(e.file, e);
  mkdirSync(updatesDir(store), { recursive: true });
  writeFileSync(path.join(updatesDir(store), REIMPORT_FILE), JSON.stringify([...merged.values()], null, 1));
  return entries.length;
}

export function readReimportList(store: Pick<Store, 'dataDir'>): ReimportEntry[] {
  const file = path.join(updatesDir(store), REIMPORT_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ReimportEntry[];
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e.file === 'string') : [];
  } catch {
    return [];
  }
}

export function saveReimportList(store: Pick<Store, 'dataDir'>, entries: ReimportEntry[]): void {
  const file = path.join(updatesDir(store), REIMPORT_FILE);
  if (entries.length === 0) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify(entries, null, 1));
}

/**
 * Called at start-up: notice that the version changed since last run.
 * Returns the version it was updated from, if it just was.
 */
export function noteRunningVersion(store: Pick<Store, 'getMeta' | 'setMeta'>, now = Date.now()): string | undefined {
  const last = store.getMeta('app.version');
  if (last === APP_VERSION) return undefined;
  store.setMeta('app.version', APP_VERSION);
  if (last === undefined || last === '') return undefined;
  store.setMeta('app.changedFrom', last);
  store.setMeta('app.changedAt', String(now));
  store.setMeta('app.whatsNewSeen', '');
  return last;
}

/** Tables whose current contents survive going back: what the person set up, not what was measured. */
const CARRIED_TABLES = ['setting', 'server'] as const;

/**
 * Prepare a database for going back: the backup from just before the
 * update, with today's settings and server setup copied into it (only the
 * columns both versions have), plus the list of captures to import again.
 * The desktop app swaps it in once monitoring has stopped.
 */
export function stageRollback(
  store: Store,
  productName: string,
  now = Date.now(),
): { staged: string; installer: Installer; record: UpdateRecord; reimport: number } {
  const plan = rollbackPlan(store, productName);
  if (!plan.possible || plan.record === undefined || plan.installer === undefined) {
    throw new Error(plan.reason ?? 'going back is not possible');
  }
  const dir = updatesDir(store);
  mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `rollback-to-${plan.record.from}-${new Date(now).toISOString().replace(/[:.]/g, '-')}.sqlite`);
  copyFileSync(plan.record.backup, staged);

  const target = new DatabaseSync(staged);
  try {
    target.exec('BEGIN');
    for (const table of CARRIED_TABLES) {
      const columnsOf = (db: DatabaseSync): string[] =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      const theirs = new Set(columnsOf(target));
      const shared = columnsOf(store.db).filter((c) => theirs.has(c));
      if (shared.length === 0) continue;
      const list = shared.map((c) => `"${c}"`).join(', ');
      const insert = target.prepare(`INSERT OR REPLACE INTO ${table} (${list}) VALUES (${shared.map(() => '?').join(', ')})`);
      for (const row of store.db.prepare(`SELECT ${list} FROM ${table}`).all() as Array<Record<string, SQLInputValue>>) {
        insert.run(...shared.map((c) => row[c] ?? null));
      }
    }
    target.exec('COMMIT');
  } catch (error) {
    try {
      target.exec('ROLLBACK');
    } catch {
      // Nothing to roll back.
    }
    target.close();
    rmSync(staged, { force: true });
    throw error;
  }
  target.close();

  const reimport = writeReimportList(store, plan.record);
  return { staged, installer: plan.installer, record: plan.record, reimport };
}

/**
 * Where to look for new installers: the chosen folder, or else the
 * Downloads folder. The app's own kept copies are always included.
 */
export function updateFolders(store: Pick<Store, 'dataDir'>, settings: Pick<SettingsStore, 'getString'>): string[] {
  const chosen = settings.getString('updates.folder').trim();
  const downloads = path.join(homedir(), 'Downloads');
  return [chosen === '' ? downloads : chosen, githubDownloadsDir(store), keptInstallersDir(store)];
}
