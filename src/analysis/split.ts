/**
 * Where the tick went, minute by minute: every sample of tick work, counted
 * once, by part of the game, by mod, and by the thing inside the part
 * (subjects.ts) -- stored per capture when it is imported.
 *
 * Why stored rather than worked out from the ledger on each view:
 *
 *   - The ledger keeps call paths one by one only above an evidence floor.
 *     The time below it (a quarter of the tick on a big modpack) could only
 *     ever be shown as "small scattered costs"; here it is classified like
 *     everything else, so the parts add up to the whole tick.
 *   - Classifying ~100,000 paths took most of a second on every visit.
 *   - It is per minute, so any span -- the last hour, a custom range -- is
 *     exact, and the ticks it is divided by are the ticks spark counted in
 *     exactly those minutes.
 *
 * Alongside the samples, each minute keeps spark's own timing (its median
 * tick), because sampling can disagree with it: spark samples every 10 ms by
 * default and the server ticks every 50 ms, so at low load a whole minute's
 * samples can all land inside the tick or all outside it. Such minutes are
 * counted, and the page says how much of a span they are.
 */

import { activityOf, activitySql, type ActivityFilter } from './activity.ts';
import { hasActivityRollups, storedActivitySql } from '../store/rollups.ts';
import type { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { SYSTEMS, explainWait, type SystemKey } from './systems.ts';
import { pathStep, subjectKey, subjectName, type PathState } from './subjects.ts';
import { ownersOf } from './owner.ts';

/** The blob's layout. */
const SPLIT_FORMAT = 1;
/**
 * The naming rules' version (subjects.ts). Stored with each split; captures
 * split by older rules are split again in the background, so a better name
 * reaches all of history, not only new captures.
 */
export const SPLIT_VERSION = 2;

export interface SplitSourceRow {
  path: string;
  label: string;
  source: string | null;
  parentIndex: number;
  category: string;
  selfMsByWindow: readonly number[];
}

export interface SplitCell {
  system: SystemKey;
  /** The mod whose code the time was in; '' for waiting. */
  owner: string;
  /** subjects.ts key; '' when the time is the part's own, not one thing's. */
  subject: string;
  /** The mod the thing belongs to (the entity's, the block's...). */
  subjectOwner: string;
}

export interface CaptureSplit {
  /** Window ids, in the order of each cell's values. */
  windows: number[];
  cells: SplitCell[];
  /** Per cell, sampled ms in each window. */
  ms: Float64Array[];
}

/** Classify a capture's rows (parent before child) into cells, per window. */
export function computeSplit(rows: readonly SplitSourceRow[], windows: readonly number[]): CaptureSplit {
  const owners = ownersOf(rows);
  const states: Array<PathState | undefined> = new Array(rows.length);
  const subjectOwners: string[] = new Array(rows.length);
  const waitCauses: Array<string | undefined> = new Array(rows.length);
  const index = new Map<string, number>();
  const cells: SplitCell[] = [];
  const ms: Float64Array[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const p = row.parentIndex >= 0 && row.parentIndex < i ? row.parentIndex : -1;
    const above = p < 0 ? undefined : states[p];
    const state = pathStep(row.label, above);
    states[i] = state;
    const key = subjectKey(state);
    subjectOwners[i] = p >= 0 && key !== '' && above !== undefined && key === subjectKey(above) ? subjectOwners[p]! : owners[i]!;
    if (row.category === 'idle') continue;

    let system: SystemKey | undefined;
    let subject: string;
    if (row.category === 'blocked' || row.category === 'waiting') {
      // One cause per wait: the topmost waiting frame decides for all below it.
      const inherited = p >= 0 ? waitCauses[p] : undefined;
      subject = inherited ?? explainWait(row.path.split(' > ')).cause;
      waitCauses[i] = subject;
      system = 'waiting';
    } else {
      system = state.system ?? (state.inTick ? 'other' : undefined);
      subject = state.system === undefined ? '' : key;
    }
    if (system === undefined) continue;

    const values = row.selfMsByWindow;
    let any = false;
    for (let w = 0; w < values.length; w += 1) if (values[w] !== 0) any = true;
    if (!any) continue;

    const owner = system === 'waiting' ? '' : owners[i]!;
    const subjectOwner = system === 'waiting' || subject === '' ? '' : subjectOwners[i]!;
    const cellKey = `${system}\u0001${owner}\u0001${subject}\u0001${subjectOwner}`;
    let c = index.get(cellKey);
    if (c === undefined) {
      c = cells.length;
      index.set(cellKey, c);
      cells.push({ system, owner, subject, subjectOwner });
      ms.push(new Float64Array(windows.length));
    }
    const target = ms[c]!;
    for (let w = 0; w < windows.length; w += 1) target[w] = target[w]! + (values[w] ?? 0);
  }
  return { windows: [...windows], cells, ms };
}

// ---------------------------------------------------------------------------
// Storage: zstd JSON, strings interned, values sparse in hundredths of a ms.
// ---------------------------------------------------------------------------

interface Payload {
  v: number;
  w: number[];
  d: string[];
  /** Per cell: system, owner, subject, subjectOwner as dictionary ids. */
  c: number[];
  /** Per cell: [window index, hundredths of a ms, ...] for non-zero windows. */
  m: number[][];
}

export function encodeSplit(split: CaptureSplit): Buffer {
  const dict: string[] = [];
  const ids = new Map<string, number>();
  const intern = (s: string): number => {
    let id = ids.get(s);
    if (id === undefined) {
      id = dict.length;
      ids.set(s, id);
      dict.push(s);
    }
    return id;
  };
  const c: number[] = [];
  for (const cell of split.cells) c.push(intern(cell.system), intern(cell.owner), intern(cell.subject), intern(cell.subjectOwner));
  const m = split.ms.map((values) => {
    const pairs: number[] = [];
    values.forEach((v, w) => {
      const h = Math.round(v * 100);
      if (h !== 0) pairs.push(w, h);
    });
    return pairs;
  });
  const payload: Payload = { v: SPLIT_FORMAT, w: split.windows, d: dict, c, m };
  return zstdCompressSync(Buffer.from(JSON.stringify(payload), 'utf8'));
}

export function decodeSplit(blob: Uint8Array): CaptureSplit {
  const payload = JSON.parse(zstdDecompressSync(blob).toString('utf8')) as Payload;
  if (payload.v !== SPLIT_FORMAT) throw new Error(`split format ${payload.v} is not supported`);
  const cells: SplitCell[] = [];
  const ms: Float64Array[] = [];
  for (let i = 0; i * 4 < payload.c.length; i += 1) {
    const at = (k: number): string => payload.d[payload.c[i * 4 + k]!] ?? '';
    cells.push({ system: at(0) as SystemKey, owner: at(1), subject: at(2), subjectOwner: at(3) });
    const values = new Float64Array(payload.w.length);
    const pairs = payload.m[i] ?? [];
    for (let j = 0; j + 1 < pairs.length; j += 2) values[pairs[j]!] = pairs[j + 1]! / 100;
    ms.push(values);
  }
  return { windows: payload.w, cells, ms };
}

// ---------------------------------------------------------------------------
// Saving, and the per-day roll-up used for whole days and seasons.
// ---------------------------------------------------------------------------

interface WindowStat {
  window_id: number;
  ticks: number | null;
  mspt_median: number | null;
  mspt_max: number | null;
  players?: number | null;
}

/**
 * A minute whose samples cannot be trusted to add up: the tick was short
 * (under ~1.5 sampling intervals) and the samples disagree with spark's own
 * timing by more than 2x either way, without a long tick to explain it.
 */
export function alignedMinute(sampledMs: number, w: WindowStat, intervalMs: number): boolean {
  const ticks = w.ticks ?? 0;
  const median = w.mspt_median ?? 0;
  if (ticks <= 0 || median <= 0 || median >= intervalMs * 1.5 || (w.mspt_max ?? 0) >= 250) return false;
  const ratio = sampledMs / ticks / median;
  return ratio < 0.5 || ratio > 2;
}

interface DayTotals {
  minutes: number;
  ticks: number;
  sampledMs: number;
  measuredMs: number;
  measuredTicks: number;
  aligned: number;
}

function dayTotals(split: CaptureSplit, stats: readonly WindowStat[], intervalMs: number): DayTotals {
  const byWindow = new Map(stats.map((s) => [s.window_id, s]));
  const t: DayTotals = { minutes: 0, ticks: 0, sampledMs: 0, measuredMs: 0, measuredTicks: 0, aligned: 0 };
  split.windows.forEach((id, w) => {
    const s = byWindow.get(id);
    if (s === undefined || (s.ticks ?? 0) <= 0) return;
    let sampled = 0;
    for (const values of split.ms) sampled += values[w]!;
    t.minutes += 1;
    t.ticks += s.ticks!;
    t.sampledMs += sampled;
    if (s.mspt_median !== null) {
      t.measuredMs += s.mspt_median * s.ticks!;
      t.measuredTicks += s.ticks!;
    }
    if (alignedMinute(sampled, s, intervalMs)) t.aligned += 1;
  });
  return t;
}

/** Where a capture's per-day totals go: the live roll-ups, or the `_next` ones a rebuild fills. */
export interface DayTarget {
  suffix: '' | '_next';
  activity: boolean;
}

function addToDays(
  db: DatabaseSync,
  capture: { id: number; season_id: number; day: string; interval_ms: number },
  split: CaptureSplit,
  sign: 1 | -1,
  target: DayTarget = { suffix: '', activity: hasActivityRollups(db) },
): void {
  const t = target.suffix;
  const stats = db
    .prepare('SELECT window_id, ticks, mspt_median, mspt_max, players FROM capture_window WHERE capture_id = ?')
    .all(capture.id) as unknown as WindowStat[];
  // One group per activity the capture had (or one group when not split).
  const groups = new Map<string, WindowStat[]>();
  for (const st of stats) {
    const key = target.activity ? activityOf(st.players) : '';
    const list = groups.get(key) ?? [];
    list.push(st);
    groups.set(key, list);
  }
  const cells = db.prepare(
    target.activity
      ? `INSERT INTO split_day${t} (season_id, day, activity, system, owner, subject, subject_owner, self_ms) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(season_id, day, activity, system, owner, subject, subject_owner) DO UPDATE SET self_ms = self_ms + excluded.self_ms`
      : `INSERT INTO split_day (season_id, day, system, owner, subject, subject_owner, self_ms) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(season_id, day, system, owner, subject, subject_owner) DO UPDATE SET self_ms = self_ms + excluded.self_ms`,
  );
  const ticks = db.prepare(
    target.activity
      ? `INSERT INTO split_day_ticks${t} (season_id, day, activity, captures, minutes, ticks, sampled_ms, measured_ms, measured_ticks, aligned_minutes)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(season_id, day, activity) DO UPDATE SET
       captures = captures + excluded.captures, minutes = minutes + excluded.minutes, ticks = ticks + excluded.ticks,
       sampled_ms = sampled_ms + excluded.sampled_ms, measured_ms = measured_ms + excluded.measured_ms,
       measured_ticks = measured_ticks + excluded.measured_ticks, aligned_minutes = aligned_minutes + excluded.aligned_minutes`
      : `INSERT INTO split_day_ticks (season_id, day, captures, minutes, ticks, sampled_ms, measured_ms, measured_ticks, aligned_minutes)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(season_id, day) DO UPDATE SET
       captures = captures + excluded.captures, minutes = minutes + excluded.minutes, ticks = ticks + excluded.ticks,
       sampled_ms = sampled_ms + excluded.sampled_ms, measured_ms = measured_ms + excluded.measured_ms,
       measured_ticks = measured_ticks + excluded.measured_ticks, aligned_minutes = aligned_minutes + excluded.aligned_minutes`,
  );
  for (const [activity, group] of groups) {
    const counted = new Set(group.filter((st) => (st.ticks ?? 0) > 0).map((st) => st.window_id));
    split.cells.forEach((cell, c) => {
      let total = 0;
      split.windows.forEach((id, w) => {
        if (counted.has(id)) total += split.ms[c]![w]!;
      });
      if (total === 0) return;
      if (target.activity) cells.run(capture.season_id, capture.day, activity, cell.system, cell.owner, cell.subject, cell.subjectOwner, sign * total);
      else cells.run(capture.season_id, capture.day, cell.system, cell.owner, cell.subject, cell.subjectOwner, sign * total);
    });
    const d = dayTotals(split, group, capture.interval_ms);
    const values = [sign, sign * d.minutes, sign * d.ticks, sign * d.sampledMs, sign * d.measuredMs, sign * d.measuredTicks, sign * d.aligned];
    if (target.activity) ticks.run(capture.season_id, capture.day, activity, ...values);
    else ticks.run(capture.season_id, capture.day, ...values);
  }
}

function captureFacts(db: DatabaseSync, captureId: number): { id: number; season_id: number; day: string; interval_ms: number } | undefined {
  const row = db.prepare('SELECT id, season_id, started_at, interval_micros FROM capture WHERE id = ?').get(captureId) as
    | { id: number; season_id: number; started_at: number | null; interval_micros: number | null }
    | undefined;
  if (row === undefined) return undefined;
  // The same day a capture's ledger rows are filed under (ingest/ledger.ts dayKey).
  const day = new Date(row.started_at ?? 0).toISOString().slice(0, 10);
  return { id: row.id, season_id: row.season_id, day, interval_ms: (row.interval_micros ?? 10_000) / 1000 };
}

/** Store a capture's split and add it to its day. Replaces an earlier one. */
export function saveSplit(db: DatabaseSync, captureId: number, split: CaptureSplit): void {
  const facts = captureFacts(db, captureId);
  if (facts === undefined) throw new Error(`capture ${captureId} does not exist`);
  const old = db.prepare('SELECT data FROM capture_split WHERE capture_id = ?').get(captureId) as { data: Uint8Array } | undefined;
  if (old !== undefined) addToDays(db, facts, decodeSplit(old.data), -1);
  db.prepare('INSERT OR REPLACE INTO capture_split (capture_id, version, data) VALUES (?, ?, ?)').run(captureId, SPLIT_VERSION, encodeSplit(split));
  addToDays(db, facts, split, 1);
}

/** Rebuild the per-day roll-up from the stored splits (after captures were removed). */
export function rebuildSplitDays(db: DatabaseSync): void {
  db.exec('DELETE FROM split_day; DELETE FROM split_day_ticks;');
  const rows = db.prepare('SELECT capture_id, data FROM capture_split ORDER BY capture_id').all() as Array<{ capture_id: number; data: Uint8Array }>;
  for (const row of rows) {
    const facts = captureFacts(db, row.capture_id);
    if (facts !== undefined) addToDays(db, facts, decodeSplit(row.data), 1);
  }
  db.exec('DELETE FROM split_day WHERE abs(self_ms) < 1e-6');
}

/** Add one capture's stored split to the `_next` day roll-ups a rebuild fills. False when it has none yet. */
export function addSplitToNextDays(db: DatabaseSync, captureId: number): boolean {
  const facts = captureFacts(db, captureId);
  const row = db.prepare('SELECT data FROM capture_split WHERE capture_id = ?').get(captureId) as { data: Uint8Array } | undefined;
  if (facts === undefined || row === undefined) return false;
  addToDays(db, facts, decodeSplit(row.data), 1, { suffix: '_next', activity: true });
  return true;
}

export function capturesWithoutSplit(db: DatabaseSync): Array<{ id: number; sidecar_path: string }> {
  return db
    .prepare(
      `SELECT c.id, c.sidecar_path FROM capture c LEFT JOIN capture_split s ON s.capture_id = c.id
        WHERE (s.capture_id IS NULL OR s.version < ?) AND c.sidecar_path IS NOT NULL ORDER BY c.id DESC`,
    )
    .all(SPLIT_VERSION) as Array<{ id: number; sidecar_path: string }>;
}

// ---------------------------------------------------------------------------
// Reading: a span's figures.
// ---------------------------------------------------------------------------

export type SplitSpan = {
  days?: { fromDay: string; toDay: string };
  time?: { fromMs: number; toMs: number };
  /** Playing or idle minutes alone, or all (analysis/activity.ts). */
  activity?: ActivityFilter;
};

export interface Slice {
  key: string;
  name: string;
  about?: string;
  /** Sampled ms per tick. */
  mspt: number;
  /** The mod it belongs to, for things inside a part. */
  owner?: string;
}

export interface SplitResult {
  /** Ticks spark counted in the minutes behind the figures. */
  ticks: number;
  minutes: number;
  captures: number;
  /** Captures overlapping the span with no split yet (still being prepared). */
  pending: number;
  /** Sampled tick work per tick: what the parts add up to. */
  totalMspt: number;
  /** spark's own median tick over the same minutes, tick-weighted. */
  measuredMspt: number | undefined;
  /** Minutes whose samples line up with the tick and cannot be trusted to add up. */
  alignedMinutes: number;
  systems: Slice[];
  mods: Slice[];
  /** The raw cells, per tick, for drill-downs. */
  cells: Array<SplitCell & { mspt: number }>;
}

interface Acc {
  ticks: number;
  minutes: number;
  captures: number;
  pending: number;
  sampledMs: number;
  measuredMs: number;
  measuredTicks: number;
  aligned: number;
  cells: Map<string, { cell: SplitCell; ms: number }>;
}

function addCell(acc: Acc, cell: SplitCell, ms: number): void {
  const key = `${cell.system}\u0001${cell.owner}\u0001${cell.subject}\u0001${cell.subjectOwner}`;
  const hit = acc.cells.get(key);
  if (hit === undefined) acc.cells.set(key, { cell, ms });
  else hit.ms += ms;
}

/** A span's split: whole days from the roll-up, exact times minute by minute. */
export function splitFor(db: DatabaseSync, seasonId: number, span: SplitSpan = {}): SplitResult {
  const acc: Acc = { ticks: 0, minutes: 0, captures: 0, pending: 0, sampledMs: 0, measuredMs: 0, measuredTicks: 0, aligned: 0, cells: new Map() };

  if (span.time === undefined) {
    const from = span.days?.fromDay ?? '0000-00-00';
    const to = span.days?.toDay ?? '9999-99-99';
    // Split by activity once the roll-ups are; before that, everything.
    const act = hasActivityRollups(db) ? storedActivitySql(span.activity ?? 'all') : '';
    const t = db
      .prepare(
        `SELECT COALESCE(sum(captures), 0) AS captures, COALESCE(sum(minutes), 0) AS minutes, COALESCE(sum(ticks), 0) AS ticks,
                COALESCE(sum(sampled_ms), 0) AS sampled, COALESCE(sum(measured_ms), 0) AS measured,
                COALESCE(sum(measured_ticks), 0) AS measuredTicks, COALESCE(sum(aligned_minutes), 0) AS aligned
           FROM split_day_ticks WHERE season_id = ? AND day >= ? AND day <= ?${act}`,
      )
      .get(seasonId, from, to) as { captures: number; minutes: number; ticks: number; sampled: number; measured: number; measuredTicks: number; aligned: number };
    Object.assign(acc, { captures: t.captures, minutes: t.minutes, ticks: t.ticks, sampledMs: t.sampled, measuredMs: t.measured, measuredTicks: t.measuredTicks, aligned: t.aligned });
    for (const r of db
      .prepare(
        `SELECT system, owner, subject, subject_owner, sum(self_ms) AS ms FROM split_day
          WHERE season_id = ? AND day >= ? AND day <= ?${act} GROUP BY system, owner, subject, subject_owner`,
      )
      .iterate(seasonId, from, to) as Iterable<{ system: SystemKey; owner: string; subject: string; subject_owner: string; ms: number }>) {
      if (r.ms > 1e-9) addCell(acc, { system: r.system, owner: r.owner, subject: r.subject, subjectOwner: r.subject_owner }, r.ms);
    }
    acc.pending = (
      db
        .prepare(
          `SELECT count(*) AS n FROM capture c LEFT JOIN capture_split s ON s.capture_id = c.id
            WHERE c.season_id = ? AND s.capture_id IS NULL AND date(c.started_at / 1000, 'unixepoch') BETWEEN ? AND ?`,
        )
        .get(seasonId, from, to) as { n: number }
    ).n;
  } else {
    const { fromMs, toMs } = span.time;
    const captures = db
      .prepare(
        `SELECT c.id, c.interval_micros, s.data FROM capture c LEFT JOIN capture_split s ON s.capture_id = c.id
          WHERE c.season_id = ? AND c.started_at < ? AND COALESCE(c.ended_at, c.started_at) >= ? ORDER BY c.started_at`,
      )
      .all(seasonId, toMs, fromMs) as Array<{ id: number; interval_micros: number | null; data: Uint8Array | null }>;
    const windowsOf = db.prepare(
      `SELECT window_id, ticks, mspt_median, mspt_max FROM capture_window WHERE capture_id = ? AND start_time >= ? AND start_time < ?${activitySql(span.activity ?? 'all')}`,
    );
    for (const capture of captures) {
      const stats = windowsOf.all(capture.id, fromMs, toMs) as unknown as WindowStat[];
      if (stats.length === 0) continue;
      if (capture.data === null) {
        acc.pending += 1;
        continue;
      }
      const split = decodeSplit(capture.data);
      const t = dayTotals(split, stats, (capture.interval_micros ?? 10_000) / 1000);
      acc.captures += 1;
      acc.minutes += t.minutes;
      acc.ticks += t.ticks;
      acc.sampledMs += t.sampledMs;
      acc.measuredMs += t.measuredMs;
      acc.measuredTicks += t.measuredTicks;
      acc.aligned += t.aligned;
      const included = new Set(stats.filter((s) => (s.ticks ?? 0) > 0).map((s) => s.window_id));
      const indexes = split.windows.map((id, w) => (included.has(id) ? w : -1)).filter((w) => w >= 0);
      split.cells.forEach((cell, c) => {
        let ms = 0;
        for (const w of indexes) ms += split.ms[c]![w]!;
        if (ms !== 0) addCell(acc, cell, ms);
      });
    }
  }

  const per = (ms: number): number => (acc.ticks > 0 ? ms / acc.ticks : 0);
  const systems = new Map<SystemKey, number>();
  const mods = new Map<string, number>();
  const cells: SplitResult['cells'] = [];
  let total = 0;
  for (const { cell, ms } of acc.cells.values()) {
    total += ms;
    systems.set(cell.system, (systems.get(cell.system) ?? 0) + ms);
    if (cell.system !== 'waiting') mods.set(cell.owner, (mods.get(cell.owner) ?? 0) + ms);
    cells.push({ ...cell, mspt: per(ms) });
  }
  return {
    ticks: acc.ticks,
    minutes: acc.minutes,
    captures: acc.captures,
    pending: acc.pending,
    totalMspt: per(total),
    measuredMspt: acc.measuredTicks > 0 ? acc.measuredMs / acc.measuredTicks : undefined,
    alignedMinutes: acc.aligned,
    systems: [...systems.entries()]
      .map(([key, ms]) => ({ key, name: SYSTEMS[key]?.name ?? key, about: SYSTEMS[key]?.about ?? '', mspt: per(ms) }))
      .sort((a, b) => b.mspt - a.mspt),
    mods: [...mods.entries()].map(([key, ms]) => ({ key, name: key, mspt: per(ms) })).sort((a, b) => b.mspt - a.mspt),
    cells,
  };
}

/** The things inside one part of the game, biggest first. */
export function subjectsOf(result: SplitResult, system: SystemKey, owner?: string): Slice[] {
  const by = new Map<string, { mspt: number; owners: Map<string, number> }>();
  for (const c of result.cells) {
    if (c.system !== system || (owner !== undefined && c.owner !== owner)) continue;
    const hit = by.get(c.subject) ?? { mspt: 0, owners: new Map() };
    hit.mspt += c.mspt;
    hit.owners.set(c.subjectOwner, (hit.owners.get(c.subjectOwner) ?? 0) + c.mspt);
    by.set(c.subject, hit);
  }
  return [...by.entries()]
    .map(([key, v]) => {
      const main = [...v.owners.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      const slice: Slice = { key, name: subjectName(system, key), mspt: v.mspt };
      if (main !== '') slice.owner = main;
      return slice;
    })
    .sort((a, b) => b.mspt - a.mspt);
}

/** For one mod: which parts of the game (and things in them) its time was in. */
export function placesOf(result: SplitResult, owner: string): Array<{ system: SystemKey; mspt: number; subjects: Slice[] }> {
  const systems = new Map<SystemKey, number>();
  for (const c of result.cells) if (c.owner === owner) systems.set(c.system, (systems.get(c.system) ?? 0) + c.mspt);
  return [...systems.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([system, mspt]) => ({ system, mspt, subjects: subjectsOf(result, system, owner) }));
}
