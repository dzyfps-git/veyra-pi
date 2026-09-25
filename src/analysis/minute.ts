/**
 * One minute, explained: what the server was doing, and what was different
 * from its normal minutes.
 *
 * The evidence is spark's per-minute slices of the server thread. "Normal" is
 * the median of the neighbouring minutes (the same capture and the ones
 * either side, so the same world, modpack and time of day), preferring those
 * with a similar player count. What this can and cannot say is part of the
 * result, never left for the reader to assume:
 *
 *   can     which minute, how bad its worst tick was, how many ticks it lost,
 *           which parts of the game, mods and methods took longer than normal,
 *           and whether the thread was working or waiting -- and on what.
 *   cannot  the exact second, which player or where, and what other threads
 *           were doing (why a chunk took long to load happens off the server
 *           thread, which background profiling does not watch).
 */

import { similarLoad } from './activity.ts';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { decodeSidecar, type Sidecar } from '../store/sidecar.ts';
import { explainWait, SYSTEMS, type SystemKey } from './systems.ts';
import { pathStep, subjectKey, subjectName, type PathState } from './subjects.ts';
import { isLibraryFrame, ownersOf, readableMethod } from './owner.ts';

const SEPARATOR = ' > ';

export interface MinuteWindow {
  captureId: number;
  windowId: number;
  startTime: number;
  endTime: number;
  ticks: number | null;
  msptMedian: number | null;
  msptMax: number | null;
  players: number | null;
  entities: number | null;
  tileEntities: number | null;
  chunks: number | null;
  seasonId: number;
  sidecarPath: string | null;
}

export interface Difference {
  label: string;
  /** ms per tick in this minute, and in a normal minute. */
  here: number;
  normal: number;
  detail?: string;
  /** For a part of the game: the things inside it (entity types, blocks, commands...). */
  things?: Difference[];
  /** For a thing: the mod it belongs to. */
  owner?: string;
  /** The part of the game's key, and for a thing its subject key (analysis/subjects.ts), for links. */
  system?: string;
  subject?: string;
}

export interface Wait {
  ms: number;
  msPerTick: number;
  what: string;
  cause: string;
  path: string;
}

export interface MinuteDetail {
  window: MinuteWindow;
  baselineMinutes: number;
  baselineMatchedPlayers: boolean;
  /** Ticks the minute fell short of 1200, as seconds of lost time. */
  lostSeconds: number;
  evidence: boolean;
  why?: string;
  systems: Difference[];
  mods: Difference[];
  methods: Difference[];
  waits: Wait[];
  working: { here: number; normal: number };
  waiting: { here: number; normal: number };
}

const WINDOW_SQL = `SELECT w.capture_id AS captureId, w.window_id AS windowId, w.start_time AS startTime, w.end_time AS endTime,
  w.ticks, w.mspt_median AS msptMedian, w.mspt_max AS msptMax, w.players, w.entities, w.tile_entities AS tileEntities,
  w.chunks, c.season_id AS seasonId, c.sidecar_path AS sidecarPath
  FROM capture_window w JOIN capture c ON c.id = w.capture_id`;

export function windowAt(db: DatabaseSync, serverId: string, at: number): MinuteWindow | undefined {
  return db
    .prepare(`${WINDOW_SQL} WHERE c.server_id = ? AND w.start_time <= ? AND w.end_time > ? ORDER BY w.start_time DESC LIMIT 1`)
    .get(serverId, at, at) as MinuteWindow | undefined;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Decoded sidecars, kept briefly: a page looking at a few minutes reads the
 * same files. Each is ~20 MB decoded, so only a few are kept, and all are let
 * go after a few idle minutes -- this app shares the PC with the server.
 */
const CACHE_SIZE = 3;
const CACHE_IDLE_MS = 3 * 60_000;
const cache = new Map<string, { at: number; sidecar: Sidecar }>();
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
function sidecarOf(file: string): Sidecar {
  if (cacheTimer !== undefined) clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => cache.clear(), CACHE_IDLE_MS);
  cacheTimer.unref?.();
  const hit = cache.get(file);
  if (hit !== undefined) {
    hit.at = Date.now();
    return hit.sidecar;
  }
  const sidecar = decodeSidecar(readFileSync(file));
  cache.set(file, { at: Date.now(), sidecar });
  if (cache.size > CACHE_SIZE) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
    cache.delete(oldest[0]);
  }
  return sidecar;
}

/**
 * Each row's part of the game and mod, worked out once per file: classifying
 * is string work, and a comparison sums the same rows over dozens of minutes.
 */
type RowInfo = { system: SystemKey | undefined; mod: string; method: string; thing: string; thingOwner: string };
const rowInfo = new WeakMap<Sidecar, RowInfo[]>();
function infoOf(sidecar: Sidecar): RowInfo[] {
  let info = rowInfo.get(sidecar);
  if (info === undefined) {
    // One pass, parent before child, on each row's own frame: taking every
    // path apart as text cost ~115 MB per capture.
    const owners = ownersOf(sidecar.rows);
    const steps: PathState[] = new Array(sidecar.rows.length);
    const meaningful: Array<string | undefined> = new Array(sidecar.rows.length);
    const thingOwners: string[] = new Array(sidecar.rows.length);
    const causes: Array<string | undefined> = new Array(sidecar.rows.length);
    info = sidecar.rows.map((row, i) => {
      const parent = row.parentIndex >= 0 && row.parentIndex < i ? row.parentIndex : -1;
      const above = parent < 0 ? undefined : steps[parent];
      const step = pathStep(row.label, above);
      steps[i] = step;
      meaningful[i] = isLibraryFrame(row.label) ? (parent < 0 ? undefined : meaningful[parent]) : row.label;
      const key = subjectKey(step);
      thingOwners[i] = parent >= 0 && key !== '' && above !== undefined && key === subjectKey(above) ? thingOwners[parent]! : owners[i]!;
      if (row.category === 'blocked' || row.category === 'waiting') {
        causes[i] = (parent >= 0 ? causes[parent] : undefined) ?? explainWait(row.path.split(SEPARATOR)).cause;
      }
      const system: SystemKey | undefined =
        row.category === 'idle'
          ? undefined
          : row.category === 'blocked' || row.category === 'waiting'
            ? 'waiting'
            : (step.system ?? (step.inTick ? 'other' : undefined));
      const thing = system === 'waiting' ? causes[i]! : step.system === undefined ? '' : key;
      return {
        system,
        mod: owners[i]!,
        method: meaningful[i] ?? row.label,
        thing,
        thingOwner: system === 'waiting' || thing === '' ? '' : thingOwners[i]!,
      };
    });
    rowInfo.set(sidecar, info);
  }
  return info;
}

export function minuteDetail(
  db: DatabaseSync,
  resolvePath: (stored: string | null) => string | undefined,
  serverId: string,
  at: number,
): MinuteDetail | undefined {
  const window = windowAt(db, serverId, at);
  if (window === undefined) return undefined;
  const lostSeconds = window.ticks === null ? 0 : Math.max(0, (1200 - window.ticks) * 0.05);
  const empty = (why: string): MinuteDetail => ({
    window,
    baselineMinutes: 0,
    baselineMatchedPlayers: false,
    lostSeconds,
    evidence: false,
    why,
    systems: [],
    mods: [],
    methods: [],
    waits: [],
    working: { here: 0, normal: 0 },
    waiting: { here: 0, normal: 0 },
  });
  const file = resolvePath(window.sidecarPath);
  if (file === undefined) return empty('The per-minute detail for this capture is no longer kept.');

  // Neighbouring captures of the same season give "normal".
  const neighbours = db
    .prepare(
      `SELECT id, sidecar_path FROM capture WHERE server_id = ? AND season_id = ? AND sidecar_path IS NOT NULL
         AND id != ? ORDER BY abs(started_at - (SELECT started_at FROM capture WHERE id = ?)) LIMIT 2`,
    )
    .all(serverId, window.seasonId, window.captureId, window.captureId) as Array<{ id: number; sidecar_path: string }>;

  let target: Sidecar;
  try {
    target = sidecarOf(file);
  } catch (error) {
    return empty(`The per-minute detail could not be read: ${(error as Error).message}`);
  }
  const index = target.windows.indexOf(window.windowId);
  if (index < 0) return empty('This minute is not in its capture’s detail.');

  // Baseline minutes: [sidecar, window index], preferring similar player counts.
  const stats = db.prepare('SELECT window_id, players, ticks FROM capture_window WHERE capture_id = ?');
  const candidates: Array<{ sidecar: Sidecar; index: number; players: number | null; ticks: number }> = [];
  const add = (captureId: number, sidecar: Sidecar, skip?: number): void => {
    for (const w of stats.all(captureId) as Array<{ window_id: number; players: number | null; ticks: number | null }>) {
      if (w.window_id === skip) continue;
      const i = sidecar.windows.indexOf(w.window_id);
      if (i >= 0 && (w.ticks ?? 0) > 0) candidates.push({ sidecar, index: i, players: w.players, ticks: w.ticks! });
    }
  };
  add(window.captureId, target, window.windowId);
  for (const n of neighbours) {
    const f = resolvePath(n.sidecar_path);
    if (f === undefined) continue;
    try {
      add(n.id, sidecarOf(f));
    } catch {
      // A neighbour that cannot be read just narrows the baseline.
    }
  }
  const similar = candidates.filter((c) => similarLoad(window.players, c.players));
  const baseline = similar.length >= 5 ? similar : candidates;
  if (baseline.length < 3) return empty('Too few other minutes nearby to say what normal looks like.');

  const ticksHere = Math.max(window.ticks ?? 1200, 1);
  const perTick = (ms: number, ticks: number): number => ms / Math.max(ticks, 1);

  // Per-window totals by part of the game, by mod, and by method (self time, additive).
  type Totals = {
    systems: Map<string, number>;
    things: Map<string, number>;
    mods: Map<string, number>;
    methods: Map<string, number>;
    work: number;
    wait: number;
  };
  const thingOwner = new Map<string, string>();
  const totalsOf = (sidecar: Sidecar, i: number, ticks: number): Totals => {
    const t: Totals = { systems: new Map(), things: new Map(), mods: new Map(), methods: new Map(), work: 0, wait: 0 };
    const info = infoOf(sidecar);
    for (let r = 0; r < sidecar.rows.length; r += 1) {
      const row = sidecar.rows[r]!;
      const ms = row.selfMsByWindow[i] ?? 0;
      if (ms === 0) continue;
      const system = info[r]!.system;
      if (system === undefined) continue;
      const v = perTick(ms, ticks);
      if (system === 'waiting') t.wait += v;
      else t.work += v;
      t.systems.set(system, (t.systems.get(system) ?? 0) + v);
      const thing = `${system}\u0001${info[r]!.thing}`;
      t.things.set(thing, (t.things.get(thing) ?? 0) + v);
      if (info[r]!.thingOwner !== '' && !thingOwner.has(thing)) thingOwner.set(thing, info[r]!.thingOwner);
      if (system !== 'waiting') {
        const mod = info[r]!.mod;
        t.mods.set(mod, (t.mods.get(mod) ?? 0) + v);
        const method = info[r]!.method;
        t.methods.set(method, (t.methods.get(method) ?? 0) + v);
      }
    }
    return t;
  };
  const here = totalsOf(target, index, ticksHere);
  const normals = baseline.map((b) => totalsOf(b.sidecar, b.index, b.ticks));
  const normalOf = (pick: (t: Totals) => Map<string, number>, key: string): number => median(normals.map((n) => pick(n).get(key) ?? 0));

  const diffs = (pick: (t: Totals) => Map<string, number>, label: (key: string) => string, min: number, limit: number, detail?: (key: string) => string): Difference[] => {
    const keys = new Set<string>(pick(here).keys());
    const out: Difference[] = [];
    for (const key of keys) {
      const h = pick(here).get(key) ?? 0;
      const n = normalOf(pick, key);
      if (h - n < min) continue;
      const d: Difference = { label: label(key), here: h, normal: n };
      if (detail !== undefined) d.detail = detail(key);
      out.push(d);
    }
    return out.sort((a, b) => b.here - b.normal - (a.here - a.normal)).slice(0, limit);
  };

  const thingKeys = [...new Set([...here.things.keys(), ...normals.flatMap((n) => [...n.things.keys()])])];
  const thingsOf = (system: string): Difference[] =>
    thingKeys
      .filter((k) => k.startsWith(`${system}\u0001`))
      .map((k) => {
        const d: Difference = {
          label: subjectName(system as SystemKey, k.slice(system.length + 1)),
          here: here.things.get(k) ?? 0,
          normal: normalOf((t) => t.things, k),
          system,
          subject: k.slice(system.length + 1),
        };
        const owner = thingOwner.get(k);
        if (owner !== undefined && owner !== 'Minecraft') d.owner = owner;
        return d;
      })
      .filter((d) => d.here >= 0.01 || d.normal >= 0.01)
      .sort((a, b) => b.here - a.here)
      .slice(0, 30);
  const systems = [...new Set([...here.systems.keys(), ...normals.flatMap((n) => [...n.systems.keys()])])]
    .map((key) => ({
      label: SYSTEMS[key as SystemKey].name,
      here: here.systems.get(key) ?? 0,
      normal: normalOf((t) => t.systems, key),
      detail: SYSTEMS[key as SystemKey].about,
      things: thingsOf(key),
      system: key,
    }))
    .filter((d) => d.here > 0.05 || d.normal > 0.05)
    .sort((a, b) => b.here - a.here);

  // Waits, by their topmost waiting frame.
  const waits: Wait[] = [];
  for (const row of target.rows) {
    if (row.category !== 'blocked' && row.category !== 'waiting') continue;
    const parent = row.parentIndex >= 0 ? target.rows[row.parentIndex] : undefined;
    if (parent !== undefined && (parent.category === 'blocked' || parent.category === 'waiting')) continue;
    const ms = row.totalMsByWindow[index] ?? 0;
    if (ms < 20) continue;
    const frames = row.path.split(SEPARATOR);
    const { what, cause } = explainWait(frames);
    waits.push({ ms, msPerTick: perTick(ms, ticksHere), what, cause, path: row.path });
  }
  waits.sort((a, b) => b.ms - a.ms);

  return {
    window,
    baselineMinutes: baseline.length,
    baselineMatchedPlayers: baseline === similar,
    lostSeconds,
    evidence: true,
    systems,
    mods: diffs((t) => t.mods, (k) => k, 0.05, 8),
    methods: diffs((t) => t.methods, readableMethod, 0.05, 10, (k) => k),
    waits: waits.slice(0, 6),
    working: { here: here.work, normal: median(normals.map((n) => n.work)) },
    waiting: { here: here.wait, normal: median(normals.map((n) => n.wait)) },
  };
}

/** A freeze: one tick of at least this long (half a second), which players notice. */
export const FREEZE_MS = 500;

export interface Stall {
  window: MinuteWindow;
  /** Worst single tick in the minute, ms. */
  worstTick: number;
  wait?: Wait;
}

/** Minutes whose worst tick was at least `minMs`, worst first, with the main wait explained where known. */
export function stalls(
  db: DatabaseSync,
  resolvePath: (stored: string | null) => string | undefined,
  serverId: string,
  fromMs: number,
  toMs: number,
  options: { minMs?: number; limit?: number; explain?: number } = {},
): Stall[] {
  const rows = db
    .prepare(`${WINDOW_SQL} WHERE c.server_id = ? AND w.start_time >= ? AND w.start_time < ? AND w.mspt_max >= ? ORDER BY w.mspt_max DESC LIMIT ?`)
    .all(serverId, fromMs, toMs, options.minMs ?? FREEZE_MS, options.limit ?? 50) as unknown as MinuteWindow[];
  return rows.map((window, i) => {
    const stall: Stall = { window, worstTick: window.msptMax ?? 0 };
    if (i >= (options.explain ?? 12)) return stall;
    const file = resolvePath(window.sidecarPath);
    if (file === undefined) return stall;
    try {
      const sidecar = sidecarOf(file);
      const index = sidecar.windows.indexOf(window.windowId);
      let best: Wait | undefined;
      for (const row of sidecar.rows) {
        if (row.category !== 'blocked' && row.category !== 'waiting') continue;
        const parent = row.parentIndex >= 0 ? sidecar.rows[row.parentIndex] : undefined;
        if (parent !== undefined && (parent.category === 'blocked' || parent.category === 'waiting')) continue;
        const ms = row.totalMsByWindow[index] ?? 0;
        if (best === undefined || ms > best.ms) {
          const { what, cause } = explainWait(row.path.split(SEPARATOR));
          best = { ms, msPerTick: ms / Math.max(window.ticks ?? 1200, 1), what, cause, path: row.path };
        }
      }
      // A wait explains a stall only when it is a real share of it.
      if (best !== undefined && best.ms >= Math.min(300, stall.worstTick * 0.4)) stall.wait = best;
    } catch {
      // Unexplained is shown as unexplained.
    }
    return stall;
  });
}

export interface PlayerBand {
  players: number;
  minutes: number;
  median: number;
  p90: number;
  worstMinute: number;
}

/** What MSPT normally looks like at each player count, over a span. */
export function msptByPlayers(db: DatabaseSync, serverId: string, seasonId: number, fromMs: number, toMs: number): PlayerBand[] {
  const rows = db
    .prepare(
      `SELECT w.players, w.mspt_median FROM capture_window w JOIN capture c ON c.id = w.capture_id
        WHERE c.server_id = ? AND c.season_id = ? AND w.start_time >= ? AND w.start_time < ?
          AND w.players IS NOT NULL AND w.mspt_median IS NOT NULL`,
    )
    .all(serverId, seasonId, fromMs, toMs) as Array<{ players: number; mspt_median: number }>;
  const by = new Map<number, number[]>();
  for (const r of rows) {
    const list = by.get(r.players) ?? [];
    list.push(r.mspt_median);
    by.set(r.players, list);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([players, values]) => {
      const s = [...values].sort((a, b) => a - b);
      return {
        players,
        minutes: s.length,
        median: median(s),
        p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]!,
        worstMinute: s[s.length - 1]!,
      };
    });
}
