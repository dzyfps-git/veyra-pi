/**
 * Writing one capture into the permanent ledger -- and rebuilding it.
 *
 * ## The bug this file exists to prevent from coming back
 *
 * The daily ledger first recorded ticks as `MAX(ticks, excluded.ticks)` while
 * adding time up. With one capture per day that is harmless. With two, the
 * day's time was the sum of both captures but its ticks were only the larger
 * one's, so ms/tick for that day came out inflated -- by up to 7x on a day
 * with seven captures. The season rollup, written incrementally, added both
 * and was right; a season whose rollup had been rebuilt FROM the daily table
 * inherited the error. It surfaced when a day range was compared against the
 * whole-season figure and they disagreed.
 *
 * Two rules now hold, and the tests pin both:
 *
 *   - Ticks are additive, exactly like time. Two captures are two stretches
 *     of server time.
 *   - Each capture contributes ONCE per key. A method reached from five call
 *     paths is one frame, so it is summed in memory first and written once;
 *     adding its ticks five times would be the same bug in the other
 *     direction. The same goes for `captures_present`, which the per-method
 *     table previously never incremented at all.
 */

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';

import type { Store } from '../store/db.ts';
import { decodeSidecar } from '../store/sidecar.ts';
import { rebuildSplitDays } from '../analysis/split.ts';
import { activityOf } from '../analysis/activity.ts';
import { hasActivityRollups, STORED_ACTIVITIES, type StoredActivity } from '../store/rollups.ts';

export interface LedgerRowInput {
  frameId: number;
  pathId: number;
  selfMs: number;
  totalMs: number;
  category: string;
  /** Windows in this capture in which the path had any time. */
  present: number;
  /** Per-window time, in the capture's window order, to divide it by who was online. */
  selfByWindow?: readonly number[];
  totalByWindow?: readonly number[];
}

export interface LedgerCaptureInput {
  serverId: string;
  seasonId: number;
  day: string;
  /** Server ticks this capture covered. The same for every row. */
  ticks: number;
  windowsTotal: number;
  intervalMs: number;
  minWindows: number;
  minSamples: number;
  rows: readonly LedgerRowInput[];
  /** Who was online in each window, in the rows' window order (store/rollups.ts). Absent: unknown. */
  windowActivity?: readonly StoredActivity[];
  /** Ticks in each window, to divide the capture's ticks between activities. */
  windowTicks?: readonly (number | null)[];
}

/** Where to write: the live roll-ups, or the `_next` ones a rebuild fills. */
export interface LedgerTarget {
  suffix: '' | '_next';
  /** The roll-ups carry an activity column. */
  activity: boolean;
}

/**
 * The capture's windows and ticks by activity. Ticks are divided by each
 * window's own tick count (or evenly when unknown), with the remainder
 * placed so the parts add up to the capture's ticks exactly.
 */
function activityShares(input: LedgerCaptureInput): Array<{ activity: StoredActivity; windows: number[]; ticks: number; share: number }> {
  const n = input.windowsTotal;
  const by = new Map<StoredActivity, { windows: number[]; weight: number }>();
  for (let w = 0; w < n; w += 1) {
    const a = input.windowActivity?.[w] ?? 'unknown';
    const e = by.get(a) ?? { windows: [], weight: 0 };
    e.windows.push(w);
    e.weight += Math.max(0, input.windowTicks?.[w] ?? 0) || 1;
    by.set(a, e);
  }
  if (by.size === 0) by.set('unknown', { windows: [], weight: 1 });
  const weightSum = [...by.values()].reduce((t, e) => t + e.weight, 0);
  const parts = STORED_ACTIVITIES.filter((a) => by.has(a)).map((a) => {
    const e = by.get(a)!;
    const exact = (input.ticks * e.weight) / weightSum;
    return { activity: a, windows: e.windows, exact, ticks: Math.floor(exact), share: e.weight / weightSum };
  });
  let left = input.ticks - parts.reduce((t, p) => t + p.ticks, 0);
  for (const p of [...parts].sort((x, y) => y.exact - x.exact - (y.ticks - x.ticks))) {
    if (left <= 0) break;
    p.ticks += 1;
    left -= 1;
  }
  return parts.map(({ activity, windows, ticks, share }) => ({ activity, windows, ticks, share }));
}

export function writeLedger(
  db: DatabaseSync,
  input: LedgerCaptureInput,
  target: LedgerTarget = { suffix: '', activity: hasActivityRollups(db) },
): { paths: number; tail: number } {
  const t = target.suffix;
  // A rebuild fills only the split roll-ups; the per-method tier and the
  // tail are not split and stay as they are.
  const rebuilding = t !== '';
  // --- tier 1, per method: everything, no floor -------------------------
  const frames = new Map<number, { self: number; total: number }>();
  for (const row of input.rows) {
    const f = frames.get(row.frameId) ?? { self: 0, total: 0 };
    f.self += row.selfMs;
    f.total += row.totalMs;
    frames.set(row.frameId, f);
  }
  const frameLedger = db.prepare(
    `INSERT INTO frame_daily (day, server_id, season_id, frame_id, self_ms, total_ms, ticks, captures_present)
     VALUES (?,?,?,?,?,?,?,1)
     ON CONFLICT(day, season_id, frame_id) DO UPDATE SET
       self_ms          = self_ms + excluded.self_ms,
       total_ms         = total_ms + excluded.total_ms,
       ticks            = ticks + excluded.ticks,
       captures_present = captures_present + 1`,
  );
  if (!rebuilding) {
    for (const [frameId, f] of frames) {
      frameLedger.run(input.day, input.serverId, input.seasonId, frameId, f.self, f.total, input.ticks);
    }
  }

  // --- tier 2, per call path: above the evidence floor ------------------
  const paths = new Map<string, LedgerRowInput>();
  for (const row of input.rows) {
    const key = `${row.pathId}|${row.category}`;
    const p = paths.get(key);
    if (p === undefined) paths.set(key, { ...row, ...(row.selfByWindow === undefined ? {} : { selfByWindow: [...row.selfByWindow], totalByWindow: [...(row.totalByWindow ?? [])] }) });
    else {
      p.selfMs += row.selfMs;
      p.totalMs += row.totalMs;
      p.present = Math.max(p.present, row.present);
      // The same path twice in one capture (split by line): its minutes add.
      if (p.selfByWindow !== undefined && row.selfByWindow !== undefined) {
        const self = p.selfByWindow as number[];
        const total = p.totalByWindow as number[];
        for (let w = 0; w < row.selfByWindow.length; w += 1) {
          self[w] = (self[w] ?? 0) + (row.selfByWindow[w] ?? 0);
          total[w] = (total[w] ?? 0) + (row.totalByWindow?.[w] ?? 0);
        }
      }
    }
  }

  const pathLedger = db.prepare(
    target.activity
      ? `INSERT INTO path_daily${t}
       (day, server_id, season_id, path_id, activity, self_ms, total_ms, ticks,
        windows_present, windows_total, captures_present, category)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT(day, season_id, path_id, activity) DO UPDATE SET
       self_ms          = self_ms + excluded.self_ms,
       total_ms         = total_ms + excluded.total_ms,
       ticks            = ticks + excluded.ticks,
       windows_present  = windows_present + excluded.windows_present,
       windows_total    = windows_total + excluded.windows_total,
       captures_present = captures_present + 1`
      : `INSERT INTO path_daily
       (day, server_id, season_id, path_id, self_ms, total_ms, ticks,
        windows_present, windows_total, captures_present, category)
     VALUES (?,?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT(day, season_id, path_id) DO UPDATE SET
       self_ms          = self_ms + excluded.self_ms,
       total_ms         = total_ms + excluded.total_ms,
       ticks            = ticks + excluded.ticks,
       windows_present  = windows_present + excluded.windows_present,
       windows_total    = windows_total + excluded.windows_total,
       captures_present = captures_present + 1`,
  );
  // Maintained alongside the daily ledger so the Findings page never has to
  // group the whole ledger at read time.
  const rollup = db.prepare(
    `INSERT INTO path_rollup${t}
       (season_id, path_id, category, ${target.activity ? 'activity, ' : ''}self_ms, total_ms, ticks, ms_per_tick,
        windows_present, windows_total, days, last_day, captures)
     VALUES (?,?,?,${target.activity ? '?,' : ''}?,?,?,?,?,?,1,?,1)
     ON CONFLICT(season_id, path_id, category${target.activity ? ', activity' : ''}) DO UPDATE SET
       self_ms         = self_ms + excluded.self_ms,
       total_ms        = total_ms + excluded.total_ms,
       ticks           = ticks + excluded.ticks,
       ms_per_tick     = (self_ms + excluded.self_ms) / MAX(ticks + excluded.ticks, 1),
       windows_present = windows_present + excluded.windows_present,
       windows_total   = windows_total + excluded.windows_total,
       captures        = captures + 1,
       -- Ingest is chronological, so a change of day means a new day.
       days            = days + (CASE WHEN last_day = excluded.last_day THEN 0 ELSE 1 END),
       last_day        = excluded.last_day`,
  );

  const shares = target.activity ? activityShares(input) : [];
  let kept = 0;
  let tailPaths = 0;
  let tailSelf = 0;
  let tailTotal = 0;
  for (const row of paths.values()) {
    const samples = input.intervalMs > 0 ? row.totalMs / input.intervalMs : 0;
    // Kept or not is decided on the whole capture, so All is exactly what it was.
    if (row.present >= input.minWindows || samples >= input.minSamples) {
      kept += 1;
      if (!target.activity) {
        pathLedger.run(
          input.day, input.serverId, input.seasonId, row.pathId,
          row.selfMs, row.totalMs, input.ticks,
          row.present, input.windowsTotal, row.category,
        );
        rollup.run(
          input.seasonId, row.pathId, row.category,
          row.selfMs, row.totalMs, input.ticks,
          row.selfMs / Math.max(input.ticks, 1),
          row.present, input.windowsTotal, input.day,
        );
        continue;
      }
      // Minutes it appeared in: from its per-minute time when known (a path
      // recorded twice in one capture counts the minutes either copy had), so
      // All over the season and All summed over days always agree.
      let presentAll = row.present;
      if (row.totalByWindow !== undefined) {
        presentAll = 0;
        for (const ms of row.totalByWindow) if (ms !== 0) presentAll += 1;
      }
      rollup.run(
        input.seasonId, row.pathId, row.category, 'all',
        row.selfMs, row.totalMs, input.ticks,
        row.selfMs / Math.max(input.ticks, 1),
        presentAll, input.windowsTotal, input.day,
      );
      // Its time goes to each activity by the minutes it had there; a row
      // for every activity the capture had, so ticks add up per activity.
      let selfWindows = 0;
      let totalWindows = 0;
      for (const w of shares.flatMap((sh) => sh.windows)) {
        selfWindows += row.selfByWindow?.[w] ?? 0;
        totalWindows += row.totalByWindow?.[w] ?? 0;
      }
      for (const sh of shares) {
        let self = 0;
        let total = 0;
        let present = 0;
        for (const w of sh.windows) {
          self += row.selfByWindow?.[w] ?? 0;
          const tw = row.totalByWindow?.[w] ?? 0;
          total += tw;
          if (tw !== 0) present += 1;
        }
        const selfPart = selfWindows > 0 ? (row.selfMs * self) / selfWindows : row.selfMs * sh.share;
        const totalPart = totalWindows > 0 ? (row.totalMs * total) / totalWindows : row.totalMs * sh.share;
        const presentPart = row.selfByWindow === undefined ? (sh === shares[0] ? row.present : 0) : present;
        pathLedger.run(
          input.day, input.serverId, input.seasonId, row.pathId, sh.activity,
          selfPart, totalPart, sh.ticks,
          presentPart, sh.windows.length, row.category,
        );
        rollup.run(
          input.seasonId, row.pathId, row.category, sh.activity,
          selfPart, totalPart, sh.ticks,
          selfPart / Math.max(sh.ticks, 1),
          presentPart, sh.windows.length, input.day,
        );
      }
    } else {
      tailPaths += 1;
      tailSelf += row.selfMs;
      tailTotal += row.totalMs;
    }
  }

  if (tailPaths > 0 && !rebuilding) {
    db.prepare(
      `INSERT INTO path_daily_tail (day, season_id, paths, self_ms, total_ms)
       VALUES (?,?,?,?,?)
       ON CONFLICT(day, season_id) DO UPDATE SET
         paths    = paths + excluded.paths,
         self_ms  = self_ms + excluded.self_ms,
         total_ms = total_ms + excluded.total_ms`,
    ).run(input.day, input.seasonId, tailPaths, tailSelf, tailTotal);
  }
  return { paths: kept, tail: tailPaths };
}

/** Who was online in each of a capture's windows, in the given window order. */
export function captureWindowActivity(
  db: DatabaseSync,
  captureId: number,
  windowIds: readonly number[],
): { activity: StoredActivity[]; ticks: Array<number | null> } {
  const rows = db.prepare('SELECT window_id, players, ticks FROM capture_window WHERE capture_id = ?').all(captureId) as Array<{
    window_id: number;
    players: number | null;
    ticks: number | null;
  }>;
  const by = new Map(rows.map((r) => [r.window_id, r]));
  return {
    activity: windowIds.map((id) => activityOf(by.get(id)?.players)),
    ticks: windowIds.map((id) => by.get(id)?.ticks ?? null),
  };
}

export function dayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export interface RebuildResult {
  ok: boolean;
  captures: number;
  /** Why it did not run, when it did not. Nothing is changed in that case. */
  refused?: string;
  /** Total self time before and after, per season. Must be identical. */
  selfMsBefore: number;
  selfMsAfter: number;
  /** Days whose recorded time changed, and how. Empty when only ticks were corrected. */
  changedDays?: string[];
}

/**
 * Recompute the whole ledger from each capture's sidecar.
 *
 * Needs no decoding and no mappings: the sidecar holds every path the capture
 * recorded, with its time, and the frames and paths it names already exist.
 * Runs in one transaction, and refuses before touching anything if any
 * capture's sidecar is missing or names a path the archive does not know --
 * a partial rebuild would silently drop history, which is worse than the
 * error it corrects.
 *
 * The rebuilt ledger must hold exactly the time the captures hold, or the
 * transaction is rolled back. Every day whose time changed is reported:
 * the ticks bug changes no time at all, so a changed day means the old
 * ledger held rows no capture accounts for.
 */
export function rebuildLedger(
  store: Store,
  options: { minWindows: number; minSamples: number },
): RebuildResult {
  const db = store.db;
  const captures = db
    .prepare(
      `SELECT id, server_id, season_id, started_at, divisor_ticks, interval_micros, sidecar_path
         FROM capture ORDER BY started_at, id`,
    )
    .all() as Array<{
    id: number;
    server_id: string;
    season_id: number;
    started_at: number;
    divisor_ticks: number | null;
    interval_micros: number | null;
    sidecar_path: string | null;
  }>;

  const selfOf = (): number =>
    (db.prepare('SELECT COALESCE(sum(self_ms), 0) AS s FROM frame_daily').get() as { s: number }).s;
  const selfMsBefore = selfOf();
  const refuse = (why: string): RebuildResult => ({
    ok: false,
    captures: captures.length,
    refused: why,
    selfMsBefore,
    selfMsAfter: selfMsBefore,
  });

  // Resolve everything first, write nothing until all of it resolved.
  // Held in memory for the duration: a million single-row lookups against
  // SQLite was most of a 20-second rebuild on a month of history.
  const frames = new Map<string, number>();
  for (const f of db.prepare('SELECT id, label FROM frame').iterate() as Iterable<{ id: number; label: string }>) {
    frames.set(f.label, f.id);
  }
  const edges = new Map<string, number>();
  for (const p of db.prepare('SELECT id, parent_id, frame_id FROM path').iterate() as Iterable<{
    id: number;
    parent_id: number;
    frame_id: number;
  }>) {
    edges.set(`${p.parent_id}:${p.frame_id}`, p.id);
  }
  const prepared: Array<{ capture: (typeof captures)[number]; input: LedgerCaptureInput }> = [];

  for (const capture of captures) {
    const file = store.resolveDataPath(capture.sidecar_path);
    if (file === undefined || !existsSync(file)) {
      return refuse(`capture ${capture.id} has no sidecar, so its ledger rows could not be recomputed`);
    }
    const sidecar = decodeSidecar(readFileSync(file));
    const activity = captureWindowActivity(db, capture.id, sidecar.windows);
    const pathIds: number[] = [];
    const rows: LedgerRowInput[] = [];
    for (const [index, row] of sidecar.rows.entries()) {
      const label = row.label;
      const frameId = frames.get(label);
      const parentId = row.parentIndex < 0 ? 0 : (pathIds[row.parentIndex] ?? -1);
      const pathId = frameId === undefined || parentId < 0 ? undefined : edges.get(`${parentId}:${frameId}`);
      if (frameId === undefined || pathId === undefined) {
        return refuse(`capture ${capture.id} names a call path the archive does not know (${label})`);
      }
      pathIds[index] = pathId;
      let present = 0;
      for (const ms of row.totalMsByWindow) if (ms !== 0) present += 1;
      rows.push({
        frameId,
        pathId,
        selfMs: row.selfMs,
        totalMs: row.totalMs,
        category: row.category,
        present,
        selfByWindow: row.selfMsByWindow,
        totalByWindow: row.totalMsByWindow,
      });
    }
    prepared.push({
      capture,
      input: {
        serverId: capture.server_id,
        seasonId: capture.season_id,
        day: dayKey(capture.started_at),
        ticks: capture.divisor_ticks ?? 0,
        windowsTotal: sidecar.windows.length,
        intervalMs: (capture.interval_micros ?? 10000) / 1000,
        minWindows: options.minWindows,
        minSamples: options.minSamples,
        rows,
        windowActivity: activity.activity,
        windowTicks: activity.ticks,
      },
    });
  }

  // What each day held before, to report every day whose time changed. Time
  // can legitimately change only where the old ledger held rows no capture
  // accounts for -- a capture removed without its rows, then ingested again.
  const daysBefore = new Map(
    (db.prepare('SELECT season_id, day, sum(self_ms) AS s FROM frame_daily GROUP BY 1, 2').all() as Array<{
      season_id: number;
      day: string;
      s: number;
    }>).map((r) => [`${r.season_id}/${r.day}`, r.s]),
  );
  const expected = prepared.reduce((n, p) => n + p.input.rows.reduce((m, r) => m + r.selfMs, 0), 0);

  let selfMsAfter = 0;
  const changedDays: string[] = [];
  store.transaction(() => {
    for (const table of ['frame_daily', 'path_daily', 'path_daily_tail', 'path_rollup']) {
      db.exec(`DELETE FROM ${table}`);
    }
    for (const { input } of prepared) writeLedger(db, input);
    // The per-day split follows the captures that exist now.
    rebuildSplitDays(db);
    selfMsAfter = selfOf();
    // The check that matters: the new ledger holds exactly what the captures
    // hold. Floating-point summation order is the only slack allowed.
    if (Math.abs(selfMsAfter - expected) > Math.max(1, expected * 1e-9)) {
      throw new Error(
        `rebuilt ledger holds ${selfMsAfter.toFixed(1)} ms but the captures hold ${expected.toFixed(1)} ms; rolled back`,
      );
    }
    const after = db.prepare('SELECT season_id, day, sum(self_ms) AS s FROM frame_daily GROUP BY 1, 2').all() as Array<{
      season_id: number;
      day: string;
      s: number;
    }>;
    const seen = new Set<string>();
    for (const r of after) {
      const key = `${r.season_id}/${r.day}`;
      seen.add(key);
      const was = daysBefore.get(key) ?? 0;
      if (Math.abs(was - r.s) > 1) changedDays.push(`season ${key}: ${was.toFixed(0)} -> ${r.s.toFixed(0)} ms`);
    }
    for (const [key, was] of daysBefore) {
      if (!seen.has(key) && was > 1) changedDays.push(`season ${key}: ${was.toFixed(0)} -> 0 ms (no capture)`);
    }
  });
  return { ok: true, captures: captures.length, selfMsBefore, selfMsAfter, changedDays };
}
