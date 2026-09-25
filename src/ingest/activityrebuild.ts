/**
 * Rebuilding the day and season roll-ups split by who was online.
 *
 * Runs once, in the background, on a database from before the split
 * (store/rollups.ts). Each capture is added to the `*_next` tables from its
 * sidecar and stored split; the live tables keep serving every page until
 * the rebuild has caught up, and then one transaction swaps them in. The
 * collector drives it a capture at a time, only while the PC is calm.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { Store } from '../store/db.ts';
import { decodeSidecar } from '../store/sidecar.ts';
import { addSplitToNextDays } from '../analysis/split.ts';
import { captureWindowActivity, dayKey, writeLedger, type LedgerRowInput } from './ledger.ts';

/**
 * Carry a day over as it is, under 'unknown', when one of its captures can no
 * longer be split (its detail file expired). Permanent history is never
 * dropped by the rebuild; that day simply cannot be told apart by activity.
 */
export function copyDayAsUnknown(store: Store, seasonId: number, day: string): void {
  store.transaction(() => {
    store.db
      .prepare(
        `INSERT INTO path_daily_next (day, server_id, season_id, path_id, activity, self_ms, total_ms, ticks,
                                      windows_present, windows_total, captures_present, category)
         SELECT day, server_id, season_id, path_id, 'unknown', self_ms, total_ms, ticks,
                windows_present, windows_total, captures_present, category
           FROM path_daily WHERE season_id = ? AND day = ?`,
      )
      .run(seasonId, day);
    store.db
      .prepare(
        `INSERT INTO path_rollup_next (season_id, path_id, category, activity, self_ms, total_ms, ticks, ms_per_tick,
                                       windows_present, windows_total, days, last_day, captures)
         SELECT d.season_id, d.path_id, d.category, a.activity, d.self_ms, d.total_ms, d.ticks, d.self_ms / max(d.ticks, 1),
                d.windows_present, d.windows_total, 1, d.day, d.captures_present
           FROM path_daily d, (SELECT 'unknown' AS activity UNION ALL SELECT 'all') a
          WHERE d.season_id = ? AND d.day = ?
         ON CONFLICT(season_id, path_id, category, activity) DO UPDATE SET
           self_ms         = self_ms + excluded.self_ms,
           total_ms        = total_ms + excluded.total_ms,
           ticks           = ticks + excluded.ticks,
           ms_per_tick     = (self_ms + excluded.self_ms) / MAX(ticks + excluded.ticks, 1),
           windows_present = windows_present + excluded.windows_present,
           windows_total   = windows_total + excluded.windows_total,
           captures        = captures + excluded.captures,
           days            = days + (CASE WHEN last_day = excluded.last_day THEN 0 ELSE 1 END),
           last_day        = excluded.last_day`,
      )
      .run(seasonId, day);
  });
}

/** Can every capture of this day still be split? */
export function dayCanBeSplit(store: Store, seasonId: number, day: string): boolean {
  const rows = store.db
    .prepare(`SELECT sidecar_path FROM capture WHERE season_id = ? AND date(started_at / 1000, 'unixepoch') = ?`)
    .all(seasonId, day) as Array<{ sidecar_path: string | null }>;
  return rows.every((r) => {
    const file = store.resolveDataPath(r.sidecar_path);
    return file !== undefined && existsSync(file);
  });
}

/** Captures not yet in the `*_next` tables, oldest first. */
export function capturesForNext(store: Store, done: ReadonlySet<number>): number[] {
  const ids = store.db.prepare('SELECT id FROM capture ORDER BY started_at, id').all() as Array<{ id: number }>;
  return ids.map((r) => r.id).filter((id) => !done.has(id));
}

/**
 * Add one capture to the `*_next` roll-ups. 'missing' when its sidecar is
 * gone (it is then left out, exactly as the live roll-ups have it once its
 * detail expired), 'unresolved' when a path in it is not known.
 */
export function addCaptureToNext(
  store: Store,
  captureId: number,
  options: { minWindows: number; minSamples: number },
): 'ok' | 'missing' | 'unresolved' {
  const db = store.db;
  const capture = db
    .prepare('SELECT id, server_id, season_id, started_at, divisor_ticks, interval_micros, sidecar_path FROM capture WHERE id = ?')
    .get(captureId) as
    | { id: number; server_id: string; season_id: number; started_at: number; divisor_ticks: number | null; interval_micros: number | null; sidecar_path: string | null }
    | undefined;
  if (capture === undefined) return 'missing';
  const file = store.resolveDataPath(capture.sidecar_path);
  if (file === undefined || !existsSync(file)) return 'missing';
  const sidecar = decodeSidecar(readFileSync(file));

  // Path ids in sidecar row order: stored at ingest; resolved by name when not.
  const stored = db.prepare('SELECT ids FROM capture_path_ids WHERE capture_id = ?').get(captureId) as { ids: Uint8Array } | undefined;
  let pathIds: Int32Array;
  if (stored !== undefined && stored.ids.byteLength === sidecar.rows.length * 4) {
    pathIds = new Int32Array(stored.ids.buffer.slice(stored.ids.byteOffset, stored.ids.byteOffset + stored.ids.byteLength));
  } else {
    const frameOf = db.prepare('SELECT id FROM frame WHERE label = ?');
    const pathOf = db.prepare('SELECT id FROM path WHERE parent_id = ? AND frame_id = ?');
    pathIds = new Int32Array(sidecar.rows.length).fill(-1);
    for (const [i, row] of sidecar.rows.entries()) {
      const frame = frameOf.get(row.label) as { id: number } | undefined;
      const parent = row.parentIndex < 0 ? 0 : pathIds[row.parentIndex]!;
      const path = frame === undefined || parent < 0 ? undefined : (pathOf.get(parent, frame.id) as { id: number } | undefined);
      if (path === undefined) return 'unresolved';
      pathIds[i] = path.id;
    }
  }

  const rows: LedgerRowInput[] = sidecar.rows.map((row, i) => {
    let present = 0;
    for (const ms of row.totalMsByWindow) if (ms !== 0) present += 1;
    return {
      // Only the split roll-ups are rebuilt; the per-method tier is not touched.
      frameId: 0,
      pathId: pathIds[i]!,
      selfMs: row.selfMs,
      totalMs: row.totalMs,
      category: row.category,
      present,
      selfByWindow: row.selfMsByWindow,
      totalByWindow: row.totalMsByWindow,
    };
  });
  const activity = captureWindowActivity(db, captureId, sidecar.windows);
  store.transaction(() => {
    writeLedger(
      db,
      {
        serverId: capture.server_id,
        seasonId: capture.season_id,
        day: dayKey(capture.started_at),
        ticks: capture.divisor_ticks ?? 0,
        windowsTotal: sidecar.windows.length,
        intervalMs: (capture.interval_micros ?? 10_000) / 1000,
        minWindows: options.minWindows,
        minSamples: options.minSamples,
        rows,
        windowActivity: activity.activity,
        windowTicks: activity.ticks,
      },
      { suffix: '_next', activity: true },
    );
    addSplitToNextDays(db, captureId);
  });
  return 'ok';
}

export interface RebuildPace {
  /** May heavy work run now (the PC is calm)? */
  allowed(): boolean;
  /** Wait, yielding to everything else. */
  breathe(ms: number): Promise<void>;
  /** The app is shutting down: stop, and start again next time. */
  stopped(): boolean;
}

/**
 * Split the roll-ups by activity for a database from before the split.
 * Adds captures to the `*_next` tables oldest first, a capture at a time,
 * catching up with any that arrive meanwhile, then swaps them in. Returns
 * false when it stopped early; it starts over cleanly next time.
 */
export async function rebuildActivityRollups(
  store: Store,
  options: { minWindows: number; minSamples: number },
  pace: RebuildPace,
  log: (text: string) => void,
): Promise<boolean> {
  const { beginShadowRollups, hasActivityRollups, swapInShadowRollups } = await import('../store/rollups.ts');
  if (hasActivityRollups(store.db)) return true;
  beginShadowRollups(store.db);
  const done = new Set<number>();
  const copiedDays = new Set<string>();
  let split = 0;
  let carried = 0;
  for (;;) {
    const todo = capturesForNext(store, done);
    // Caught up: swap now, before anything else can run, so no capture
    // arriving in between is left out.
    if (todo.length === 0) break;
    for (const id of todo) {
      while (!pace.allowed()) {
        await pace.breathe(15_000);
        if (pace.stopped()) return false;
      }
      if (pace.stopped()) return false;
      const facts = store.db.prepare('SELECT season_id, started_at FROM capture WHERE id = ?').get(id) as
        | { season_id: number; started_at: number }
        | undefined;
      done.add(id);
      if (facts === undefined) continue;
      const day = dayKey(facts.started_at);
      const key = `${facts.season_id}/${day}`;
      if (copiedDays.has(key)) {
        addSplitToNextDays(store.db, id);
        continue;
      }
      const result = dayCanBeSplit(store, facts.season_id, day) ? addCaptureToNext(store, id, options) : 'missing';
      if (result === 'unresolved') {
        // Should not happen (every path was recorded at ingest). Carrying the
        // day over now could count its earlier captures twice, so stop and
        // keep the current roll-ups untouched.
        log(`playing and idle: capture ${id} names a call path the archive does not know; kept the current figures`);
        return false;
      }
      if (result !== 'ok') {
        // This day cannot be split: carry it over whole, and every capture
        // of it counted there, so nothing is double counted or dropped.
        copyDayAsUnknown(store, facts.season_id, day);
        copiedDays.add(key);
        const sameDay = store.db
          .prepare(`SELECT id FROM capture WHERE season_id = ? AND date(started_at / 1000, 'unixepoch') = ?`)
          .all(facts.season_id, day) as Array<{ id: number }>;
        for (const c of sameDay) {
          if (!done.has(c.id) || c.id === id) {
            done.add(c.id);
            addSplitToNextDays(store.db, c.id);
          }
        }
        carried += 1;
      } else split += 1;
      await pace.breathe(250);
    }
  }
  swapInShadowRollups(store.db);
  log(`playing and idle: ${split} captures split${carried === 0 ? '' : `, ${carried} day(s) kept whole (their detail had expired)`}`);
  return true;
}
