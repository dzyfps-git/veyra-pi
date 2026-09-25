/**
 * Ledger figures for an exact span of time -- "the five hours since the
 * deploy" -- rather than whole days.
 *
 * The permanent ledger is per UTC day, which cannot answer that. Every
 * capture's sidecar, though, keeps each call path's time for every one-minute
 * window, and `capture_window` knows when each window started and how many
 * ticks it held. So an hour range is computed exactly: only the minutes
 * inside it count, from every capture that overlaps it.
 *
 * The result is written to a temporary table with the same columns as
 * `path_rollup`, so the ledger and findings queries read it without knowing
 * the difference. It lives only in this connection and is rebuilt when the
 * range or the archive changes.
 *
 * Coverage is reported rather than assumed: a capture whose sidecar is gone
 * (once retention exists) cannot contribute minutes, and the page says how
 * many did.
 */

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';

import { CATEGORY_NAMES, sumSidecarWindows, type WindowSums } from '../store/sidecar.ts';
import { activitySql, type ActivityFilter } from '../analysis/activity.ts';

export interface TimeRange {
  fromMs: number;
  toMs: number;
}

export interface HourlyCoverage {
  captures: number;
  capturesWithDetail: number;
  minutes: number;
}

const TABLE = 'temp.range_rollup';
let cacheKey = '';
let cacheCoverage: HourlyCoverage = { captures: 0, capturesWithDetail: 0, minutes: 0 };

/**
 * One capture's contribution to a range: only rows with a path and some time.
 * Captures wholly inside a range are kept, so moving a range forward by one
 * capture reads one file instead of all of them. Bounded, and let go after a
 * few idle minutes: this app shares the PC with the server.
 */
interface Part {
  path: Int32Array;
  category: Uint8Array;
  self: Float64Array;
  total: Float64Array;
  present: Uint16Array;
  windows: number;
  ticks: number;
}

// About 23 bytes a row: roughly 90 MB at most, enough for a day of captures.
const PART_CACHE_ROWS = 4_000_000;
const PART_CACHE_IDLE_MS = 3 * 60_000;
const partCache = new Map<number, Part>();
let partCacheRows = 0;
let partCacheTimer: ReturnType<typeof setTimeout> | undefined;

function compact(pathIds: Int32Array, sums: WindowSums, windows: number, ticks: number): Part {
  let n = 0;
  for (let r = 0; r < sums.rows; r += 1) if (pathIds[r]! >= 0 && (sums.self[r] !== 0 || sums.total[r] !== 0)) n += 1;
  const part: Part = {
    path: new Int32Array(n), category: new Uint8Array(n), self: new Float64Array(n), total: new Float64Array(n),
    present: new Uint16Array(n), windows, ticks,
  };
  let j = 0;
  for (let r = 0; r < sums.rows; r += 1) {
    if (pathIds[r]! < 0 || (sums.self[r] === 0 && sums.total[r] === 0)) continue;
    part.path[j] = pathIds[r]!;
    part.category[j] = sums.category[r]!;
    part.self[j] = sums.self[r]!;
    part.total[j] = sums.total[r]!;
    part.present[j] = sums.present[r]!;
    j += 1;
  }
  return part;
}

function remember(captureId: number, part: Part): void {
  partCache.set(captureId, part);
  partCacheRows += part.path.length;
  for (const [id, old] of partCache) {
    if (partCacheRows <= PART_CACHE_ROWS) break;
    partCache.delete(id);
    partCacheRows -= old.path.length;
  }
}

function touchCache(): void {
  if (partCacheTimer !== undefined) clearTimeout(partCacheTimer);
  partCacheTimer = setTimeout(() => {
    partCache.clear();
    partCacheRows = 0;
  }, PART_CACHE_IDLE_MS);
  partCacheTimer.unref?.();
}

function ensureTable(db: DatabaseSync): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS range_rollup (
    season_id INTEGER NOT NULL, path_id INTEGER NOT NULL, category TEXT NOT NULL,
    self_ms REAL NOT NULL, total_ms REAL NOT NULL, ticks INTEGER NOT NULL, ms_per_tick REAL NOT NULL,
    windows_present INTEGER NOT NULL, windows_total INTEGER NOT NULL, days INTEGER NOT NULL,
    last_day TEXT NOT NULL, captures INTEGER NOT NULL,
    PRIMARY KEY (season_id, path_id, category))`);
}

/**
 * Fill the temporary table for one season and span. Returns the table name
 * to read from and how much of the span had per-minute detail.
 */
export function prepareTimeRange(
  db: DatabaseSync,
  seasonId: number,
  range: TimeRange,
  resolvePath: (stored: string | null) => string | undefined,
  activity: ActivityFilter = 'all',
): { table: string; coverage: HourlyCoverage } {
  ensureTable(db);
  const captures = db
    .prepare(
      `SELECT c.id, c.sidecar_path, c.started_at
         FROM capture c
        WHERE c.season_id = ? AND c.started_at < ? AND COALESCE(c.ended_at, c.started_at) >= ?
        ORDER BY c.started_at`,
    )
    .all(seasonId, range.toMs, range.fromMs) as Array<{ id: number; sidecar_path: string | null; started_at: number }>;

  const key = `${seasonId}|${range.fromMs}|${range.toMs}|${activity}|${captures.map((c) => c.id).join(',')}`;
  if (key === cacheKey) return { table: TABLE, coverage: cacheCoverage };

  const windowsOf = db.prepare(
    `SELECT window_id, start_time, ticks FROM capture_window
      WHERE capture_id = ? AND start_time >= ? AND start_time < ?${activitySql(activity)}`,
  );
  const windowCount = db.prepare('SELECT count(*) AS n FROM capture_window WHERE capture_id = ?');
  const frameByLabel = db.prepare('SELECT id FROM frame WHERE label = ?');
  const pathByEdge = db.prepare('SELECT id FROM path WHERE parent_id = ? AND frame_id = ?');
  const idsOf = db.prepare('SELECT ids FROM capture_path_ids WHERE capture_id = ?');
  const saveIds = db.prepare('INSERT OR REPLACE INTO capture_path_ids (capture_id, ids) VALUES (?, ?)');
  const frameMemo = new Map<string, number | undefined>();
  const edgeMemo = new Map<string, number | undefined>();

  // One accumulator per (path, category), keyed by number and kept in
  // parallel arrays: string keys and an object per path were most of the cost.
  const index = new Map<number, number>();
  const accPath: number[] = [];
  const accCat: number[] = [];
  const accSelf: number[] = [];
  const accTotal: number[] = [];
  const accTicks: number[] = [];
  const accPresent: number[] = [];
  const accWindows: number[] = [];
  const accCaptures: number[] = [];
  const accDays: number[] = [];
  const accLastDay: string[] = [];
  /** The capture last added, and the minutes it counted, so a path spark
   * recorded twice in one capture (split by line number) counts that
   * capture's ticks once. */
  const accLastCapture: number[] = [];
  const accLastPresent: number[] = [];
  const coverage: HourlyCoverage = { captures: captures.length, capturesWithDetail: 0, minutes: 0 };

  for (const capture of captures) {
    const windows = windowsOf.all(capture.id, range.fromMs, range.toMs) as Array<{
      window_id: number;
      start_time: number;
      ticks: number | null;
    }>;
    if (windows.length === 0) continue;
    const whole = windows.length === (windowCount.get(capture.id) as { n: number }).n;
    let part = whole ? partCache.get(capture.id) : undefined;
    if (part === undefined) {
      const file = resolvePath(capture.sidecar_path);
      if (file === undefined || !existsSync(file)) continue;
      const included = new Set(windows.map((w) => w.window_id));
      const sums = sumSidecarWindows(readFileSync(file), (id) => included.has(id));

      // Path ids for this capture's rows: stored at ingest, or resolved once
      // now and stored, so the next span over this capture skips this step.
      const stored = idsOf.get(capture.id) as { ids: Uint8Array } | undefined;
      let pathIds: Int32Array;
      if (stored !== undefined && stored.ids.byteLength === sums.rows * 4) {
        pathIds = new Int32Array(stored.ids.buffer.slice(stored.ids.byteOffset, stored.ids.byteOffset + stored.ids.byteLength));
      } else {
        pathIds = new Int32Array(sums.rows).fill(-1);
        for (let r = 0; r < sums.rows; r += 1) {
          const label = sums.label(r);
          let frameId = frameMemo.get(label);
          if (!frameMemo.has(label)) {
            frameId = (frameByLabel.get(label) as { id: number } | undefined)?.id;
            frameMemo.set(label, frameId);
          }
          const parentIndex = sums.parent[r]!;
          const parentId = parentIndex < 0 ? 0 : (pathIds[parentIndex] ?? -1);
          if (frameId === undefined || parentId < 0) continue;
          const edge = `${parentId}:${frameId}`;
          let pathId = edgeMemo.get(edge);
          if (!edgeMemo.has(edge)) {
            pathId = (pathByEdge.get(parentId, frameId) as { id: number } | undefined)?.id;
            edgeMemo.set(edge, pathId);
          }
          pathIds[r] = pathId ?? -1;
        }
        saveIds.run(capture.id, Buffer.from(pathIds.buffer));
      }
      part = compact(pathIds, sums, windows.length, windows.reduce((n, w) => n + (w.ticks ?? 0), 0));
      if (whole) remember(capture.id, part);
    }
    coverage.capturesWithDetail += 1;
    coverage.minutes += part.windows;
    const day = new Date(capture.started_at).toISOString().slice(0, 10);

    for (let r = 0; r < part.path.length; r += 1) {
      const key = part.path[r]! * 4 + part.category[r]!;
      let a = index.get(key);
      if (a === undefined) {
        a = accPath.length;
        index.set(key, a);
        accPath.push(part.path[r]!);
        accCat.push(part.category[r]!);
        accSelf.push(0); accTotal.push(0); accTicks.push(0); accPresent.push(0); accWindows.push(0); accCaptures.push(0);
        accDays.push(0); accLastDay.push(''); accLastCapture.push(-1); accLastPresent.push(0);
      }
      accSelf[a]! += part.self[r]!;
      accTotal[a]! += part.total[r]!;
      const present = part.present[r]!;
      if (accLastCapture[a] === capture.id) {
        // The same path again in this capture: its time adds, its ticks do not.
        const most = Math.max(accLastPresent[a]!, present);
        accPresent[a]! += most - accLastPresent[a]!;
        accLastPresent[a] = most;
        continue;
      }
      accLastCapture[a] = capture.id;
      accLastPresent[a] = present;
      accTicks[a]! += part.ticks;
      accPresent[a]! += present;
      accWindows[a]! += part.windows;
      accCaptures[a]! += 1;
      // Captures come in time order, so days only move forward.
      if (accLastDay[a] !== day) {
        accDays[a]! += 1;
        accLastDay[a] = day;
      }
    }
  }
  touchCache();

  db.exec('DELETE FROM temp.range_rollup');
  const insert = db.prepare(
    `INSERT INTO temp.range_rollup VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(season_id, path_id, category) DO UPDATE SET
       self_ms = self_ms + excluded.self_ms, total_ms = total_ms + excluded.total_ms`,
  );
  db.exec('BEGIN');
  try {
    for (let a = 0; a < accPath.length; a += 1) {
      // The same evidence floor as the daily ledger: a path seen in one
      // window with one sample carries no statistical content, and writing
      // hundreds of thousands of them was most of the remaining cost.
      if (accPresent[a]! < 2 && accTotal[a]! < 2 * 10) continue;
      // Pure pass-through frames have no time of their own and never rank in
      // any list read from this table.
      if (accSelf[a]! <= 0) continue;
      insert.run(
        seasonId, accPath[a]!, CATEGORY_NAMES[accCat[a]!] ?? 'work', accSelf[a]!, accTotal[a]!, accTicks[a]!,
        accSelf[a]! / Math.max(accTicks[a]!, 1), accPresent[a]!, accWindows[a]!, accDays[a]!, accLastDay[a]!, accCaptures[a]!,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  cacheKey = key;
  cacheCoverage = coverage;
  return { table: TABLE, coverage };
}

/** The newest moment the season has per-minute statistics for. */
export function seasonLatestMoment(db: DatabaseSync, seasonId: number): number | undefined {
  const row = db
    .prepare(
      `SELECT max(w.end_time) AS t FROM capture_window w JOIN capture c ON c.id = w.capture_id WHERE c.season_id = ?`,
    )
    .get(seasonId) as { t: number | null } | undefined;
  return row?.t ?? undefined;
}
