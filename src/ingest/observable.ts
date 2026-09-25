/**
 * Observable profiles: per-entity and per-block cost, with coordinates.
 *
 * spark says how much time went to "Villager" in total; Observable says which
 * villager, and where. It is optional: only packs that include Observable
 * have it, and a profile only exists when someone runs one in-game. The game
 * client saves each result as JSON under `<instance>/observable_profiles/`
 * ("Profile saved locally to …"), on this PC, so importing is reading a local
 * folder: nothing is sent to the server and no command is issued.
 *
 * File shape (Observable 4.x, kotlinx.serialization of ProfilingData):
 *   { entities: Entry[], blocks: Entry[], traces, ticks }
 *   Entry: { entityId?, position?: { x, y, z, level? }, type, rate, ticks, traces? }
 * `rate` is nanoseconds per tick while that entity or block existed (the
 * in-game overlay divides it by 1000 to show μs/t). Its share of every tick
 * over the whole profile is rate × entry.ticks / profile.ticks.
 */

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const OBSERVABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS observable_profile (
  id          INTEGER PRIMARY KEY,
  server_id   TEXT    NOT NULL,
  file        TEXT    NOT NULL UNIQUE,
  size        INTEGER NOT NULL,
  taken_at    INTEGER NOT NULL,
  ticks       INTEGER NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS observable_entry (
  profile_id INTEGER NOT NULL REFERENCES observable_profile(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  x          INTEGER,
  y          INTEGER,
  z          INTEGER,
  level      TEXT,
  mspt       REAL    NOT NULL,
  rate_ns    REAL    NOT NULL,
  ticks      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS observable_entry_profile ON observable_entry(profile_id, mspt DESC);
`;

export interface ObservableEntry {
  kind: 'entity' | 'block';
  type: string;
  x: number | null;
  y: number | null;
  z: number | null;
  level: string | null;
  /** Share of every tick over the whole profile. */
  mspt: number;
  rateNs: number;
  ticks: number;
}

export interface ObservableProfile {
  ticks: number;
  entries: ObservableEntry[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Read one exported profile. Throws on anything that is not one. */
export function parseObservable(text: string): ObservableProfile {
  const data = JSON.parse(text) as Record<string, unknown>;
  // Some versions wrap it: { data: ProfilingData, diagnostics }.
  const body = (typeof data['data'] === 'object' && data['data'] !== null ? data['data'] : data) as Record<string, unknown>;
  const ticks = num(body['ticks']);
  if (ticks === null || ticks <= 0 || (!Array.isArray(body['entities']) && !Array.isArray(body['blocks']))) {
    throw new Error('not an Observable profile (no ticks, entities or blocks)');
  }
  const entries: ObservableEntry[] = [];
  for (const [kind, list] of [['entity', body['entities']], ['block', body['blocks']]] as const) {
    if (!Array.isArray(list)) continue;
    for (const raw of list as Array<Record<string, unknown>>) {
      const rate = num(raw['rate']);
      const t = num(raw['ticks']);
      if (rate === null || t === null || rate < 0 || t <= 0) continue;
      const pos = (typeof raw['position'] === 'object' && raw['position'] !== null ? raw['position'] : {}) as Record<string, unknown>;
      const level = pos['level'] ?? pos['dim'] ?? pos['dimension'];
      entries.push({
        kind,
        type: typeof raw['type'] === 'string' ? raw['type'] : 'unknown',
        x: num(pos['x']),
        y: num(pos['y']),
        z: num(pos['z']),
        level: typeof level === 'string' ? level : null,
        mspt: (rate * Math.min(t, ticks)) / ticks / 1e6,
        rateNs: rate,
        ticks: t,
      });
    }
  }
  return { ticks, entries };
}

/** "2026-09-23--18.04.11.json" → its local time, or the file's own time. */
export function takenAt(file: string, mtimeMs: number): number {
  const m = /(\d{4})-(\d{2})-(\d{2})--(\d{2})\.(\d{2})\.(\d{2})/.exec(path.basename(file));
  if (m === null) return mtimeMs;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(t) ? t : mtimeMs;
}

/**
 * Where game launchers keep instances on Windows, for finding
 * `observable_profiles` without asking. Only listed, never written.
 */
export function launcherRoots(home = os.homedir(), appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming')): string[] {
  return [
    path.join(appData, '.minecraft'),
    path.join(home, 'curseforge', 'minecraft', 'Instances'),
    path.join(appData, 'PrismLauncher', 'instances'),
    path.join(appData, 'ModrinthApp', 'profiles'),
    path.join(appData, 'com.modrinth.theseus', 'profiles'),
    path.join(appData, 'ATLauncher', 'instances'),
  ];
}

/**
 * Every `observable_profiles` folder where a launcher keeps an instance: the
 * root itself (vanilla), or root/<instance>/, root/<instance>/.minecraft/ or
 * root/<instance>/minecraft/. A few directory listings, nothing deeper.
 */
export function findProfileFolders(roots: readonly string[]): string[] {
  const found: string[] = [];
  const check = (dir: string): void => {
    const candidate = path.join(dir, 'observable_profiles');
    try {
      if (statSync(candidate).isDirectory()) found.push(candidate);
    } catch {
      // not there
    }
  };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    check(root);
    let instances: string[];
    try {
      instances = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of instances) {
      const dir = path.join(root, name);
      check(dir);
      check(path.join(dir, '.minecraft'));
      check(path.join(dir, 'minecraft'));
    }
  }
  return found;
}

/**
 * Import any new profiles from the folders. A file is imported once (by its
 * full path); one that is not a profile is remembered, so it is not re-read.
 */
export function importObservable(
  db: DatabaseSync,
  serverId: string,
  folders: readonly string[],
  now = Date.now(),
): { imported: number; failed: string[] } {
  db.exec(OBSERVABLE_SCHEMA);
  const known = db.prepare('SELECT size FROM observable_profile WHERE file = ?');
  const addProfile = db.prepare(
    'INSERT INTO observable_profile (server_id, file, size, taken_at, ticks, imported_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
  );
  const addEntry = db.prepare(
    'INSERT INTO observable_entry (profile_id, kind, type, x, y, z, level, mspt, rate_ns, ticks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  let imported = 0;
  const failed: string[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = readdirSync(folder).filter((n) => n.toLowerCase().endsWith('.json'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(folder, name);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      // Still being written, or already in.
      if (now - st.mtimeMs < 5_000 || known.get(file) !== undefined) continue;
      let profile: ObservableProfile;
      try {
        profile = parseObservable(readFileSync(file, 'utf8'));
      } catch (error) {
        failed.push(`${name}: ${(error as Error).message}`);
        // Remember it so a file that is not a profile is not re-read every cycle.
        addProfile.get(serverId, file, st.size, takenAt(file, st.mtimeMs), 0, now);
        continue;
      }
      db.exec('BEGIN');
      try {
        const { id } = addProfile.get(serverId, file, st.size, takenAt(file, st.mtimeMs), profile.ticks, now) as { id: number };
        for (const e of profile.entries) addEntry.run(id, e.kind, e.type, e.x, e.y, e.z, e.level, e.mspt, e.rateNs, e.ticks);
        db.exec('COMMIT');
        imported += 1;
      } catch (error) {
        db.exec('ROLLBACK');
        failed.push(`${name}: ${(error as Error).message}`);
      }
    }
  }
  return { imported, failed };
}

export interface ObservableView {
  profileId: number;
  takenAt: number;
  ticks: number;
  /** Totals per type, biggest first. */
  types: Array<{ type: string; count: number; mspt: number }>;
  /** The costliest individual entities or blocks. */
  top: Array<{ type: string; x: number | null; y: number | null; z: number | null; level: string | null; mspt: number }>;
}

/** The newest profile (or the newest inside a span), for one kind. */
export function observableFor(
  db: DatabaseSync,
  serverId: string,
  kind: 'entity' | 'block',
  span?: { fromMs: number; toMs: number },
): ObservableView | undefined {
  try {
    db.exec(OBSERVABLE_SCHEMA);
  } catch {
    return undefined;
  }
  const profile = db
    .prepare(
      `SELECT id, taken_at, ticks FROM observable_profile
        WHERE server_id = ? AND ticks > 0 ${span === undefined ? '' : 'AND taken_at >= ? AND taken_at <= ?'}
        ORDER BY taken_at DESC LIMIT 1`,
    )
    .get(...(span === undefined ? [serverId] : [serverId, span.fromMs, span.toMs])) as { id: number; taken_at: number; ticks: number } | undefined;
  if (profile === undefined) return undefined;
  const types = db
    .prepare(
      `SELECT type, count(*) AS count, sum(mspt) AS mspt FROM observable_entry
        WHERE profile_id = ? AND kind = ? GROUP BY type ORDER BY mspt DESC LIMIT 40`,
    )
    .all(profile.id, kind) as Array<{ type: string; count: number; mspt: number }>;
  if (types.length === 0) return undefined;
  const top = db
    .prepare(`SELECT type, x, y, z, level, mspt FROM observable_entry WHERE profile_id = ? AND kind = ? ORDER BY mspt DESC LIMIT 25`)
    .all(profile.id, kind) as ObservableView['top'];
  return { profileId: profile.id, takenAt: profile.taken_at, ticks: profile.ticks, types, top };
}
