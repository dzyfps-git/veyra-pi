/**
 * Looking at part of a season instead of all of it.
 *
 * The ledger and findings normally read `path_rollup`, the whole season
 * summed. That answers "what has this season cost", but not "what did the
 * last three days look like" -- which is the question after a deploy, a
 * busy weekend, or a world that has grown.
 *
 * ## Days from the ledger, hours from the minutes
 *
 * The permanent per-path ledger (`path_daily`) keeps one row per path per
 * UTC day, which is what lets it keep every cost forever. Whole-day ranges
 * read it. Hour presets and custom date-and-time spans instead read each
 * capture's per-minute detail (see hourly.ts), so "the five hours since the
 * deploy" means exactly those minutes, not the days that contain them.
 *
 * ## Relative to the data, not the clock
 *
 * "Last 3 days" means the three days up to the newest capture in the season,
 * not up to today. A season that ended, or collection that was paused, would
 * otherwise show an empty page for a question that has a perfectly good
 * answer. The page states the dates it actually used.
 *
 * Range is separate from retention. Retention decides how long raw files are
 * kept; this only decides how much of what is kept to look at, and the daily
 * ledger itself is kept forever.
 */

import { hasActivityRollups, storedActivitySql } from '../store/rollups.ts';
import type { ActivityFilter } from '../analysis/activity.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface DayRange {
  /** Inclusive, `YYYY-MM-DD`, UTC -- the same key the ledger is written with. */
  fromDay: string;
  toDay: string;
}

export const RANGE_PRESETS: ReadonlyArray<{ id: string; label: string; days?: number; hours?: number; group: string }> = [
  { id: 'season', label: 'Whole season', group: 'All' },
  { id: '1h', label: 'Last hour', hours: 1, group: 'Hours' },
  { id: '3h', label: 'Last 3 hours', hours: 3, group: 'Hours' },
  { id: '5h', label: 'Last 5 hours', hours: 5, group: 'Hours' },
  { id: '12h', label: 'Last 12 hours', hours: 12, group: 'Hours' },
  { id: '24h', label: 'Last 24 hours', hours: 24, group: 'Hours' },
  { id: '1d', label: 'Latest day', days: 1, group: 'Days' },
  { id: '2d', label: '2 days', days: 2, group: 'Days' },
  { id: '3d', label: '3 days', days: 3, group: 'Days' },
  { id: '7d', label: '7 days', days: 7, group: 'Days' },
  { id: '14d', label: '14 days', days: 14, group: 'Days' },
  { id: 'custom', label: 'Custom…', group: 'Custom' },
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * First and last day the season has ledger rows for. Two index lookups: a
 * plain min()/max() with this WHERE reads every row of the season (26 ms on
 * a month of history; this takes 0.04 ms).
 */
export function seasonDayBounds(db: DatabaseSync, seasonId: number): DayRange | undefined {
  const row = db
    .prepare(
      `SELECT (SELECT day FROM path_daily WHERE season_id = ?1 ORDER BY season_id, day LIMIT 1) AS first,
              (SELECT day FROM path_daily WHERE season_id = ?1 ORDER BY season_id DESC, day DESC LIMIT 1) AS last`,
    )
    .get(seasonId) as { first: string | null; last: string | null } | undefined;
  if (row?.first == null || row.last == null) return undefined;
  return { fromDay: row.first, toDay: row.last };
}

function shiftDay(day: string, deltaDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

export interface ResolvedRange {
  preset: string;
  /** Undefined means the whole season: read the rollup. */
  range?: DayRange;
  /** An exact span in time, read minute by minute from the sidecars. */
  time?: { fromMs: number; toMs: number };
  /** What was actually used, in words, for the page to state. */
  description: string;
  /** Set when the request could not be honoured as asked. */
  problem?: string;
}

/**
 * Turn `?range=…&from=…&to=…` into the days to read.
 *
 * Anything it cannot honour falls back to the whole season and says why,
 * rather than guessing at what was meant.
 */
const LOCAL_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function localLabel(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A local "YYYY-MM-DDTHH:MM", as a date-time input produces, for a moment. */
export function localInputValue(ms: number): string {
  return localLabel(ms).replace(' ', 'T');
}

export function resolveRange(
  params: URLSearchParams,
  bounds: DayRange | undefined,
  latestMoment?: number,
): ResolvedRange {
  const preset = params.get('range') ?? 'season';
  if (preset === 'season' || bounds === undefined) {
    return { preset: 'season', description: 'the whole season' };
  }

  const hours = RANGE_PRESETS.find((p) => p.id === preset)?.hours;
  if (hours !== undefined) {
    if (latestMoment === undefined) {
      return { preset: 'season', description: 'the whole season', problem: 'This season has no per-minute data yet.' };
    }
    const time = { fromMs: latestMoment - hours * 3_600_000, toMs: latestMoment };
    return {
      preset,
      time,
      description: `${localLabel(time.fromMs)} to ${localLabel(time.toMs)}, the ${hours} hour${hours === 1 ? '' : 's'} up to the latest capture`,
    };
  }

  if (preset === 'custom') {
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    // Date AND time: an exact span, minute by minute.
    if (LOCAL_MOMENT.test(from) && LOCAL_MOMENT.test(to)) {
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        return { preset, description: 'the whole season', problem: 'Pick both a start and an end.' };
      }
      if (fromMs >= toMs) return { preset, description: 'the whole season', problem: 'The start is after the end.' };
      return { preset, time: { fromMs, toMs }, description: `${localLabel(fromMs)} to ${localLabel(toMs)}` };
    }
    if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return { preset, description: 'the whole season', problem: 'Pick both a start and an end date.' };
    }
    if (from > to) {
      return { preset, description: 'the whole season', problem: 'The start date is after the end date.' };
    }
    const range = {
      fromDay: from < bounds.fromDay ? bounds.fromDay : from,
      toDay: to > bounds.toDay ? bounds.toDay : to,
    };
    if (range.fromDay > range.toDay) {
      return {
        preset,
        description: 'the whole season',
        problem: `This season has data from ${bounds.fromDay} to ${bounds.toDay}; those dates are outside it.`,
      };
    }
    return { preset, range, description: `${range.fromDay} to ${range.toDay} (UTC days)` };
  }

  const days = RANGE_PRESETS.find((p) => p.id === preset)?.days;
  if (days === undefined) return { preset: 'season', description: 'the whole season', problem: 'Unknown range.' };
  const fromDay = shiftDay(bounds.toDay, -(days - 1));
  const range = { fromDay: fromDay < bounds.fromDay ? bounds.fromDay : fromDay, toDay: bounds.toDay };
  return {
    preset,
    range,
    description:
      range.fromDay === range.toDay
        ? `${range.toDay}, the latest day with data (UTC)`
        : `${range.fromDay} to ${range.toDay}, the ${days} days up to the latest capture (UTC)`,
  };
}

/**
 * The table expression to read per-path totals from, aliased by the caller.
 *
 * Without a range it is the materialised rollup. With one, the same columns
 * are computed from the daily ledger for just those days, so every query
 * built on the rollup works unchanged. The parameters must be bound before
 * any that appear later in the statement.
 */
export function rollupSource(
  db: DatabaseSync,
  seasonId: number,
  range: DayRange | undefined,
  activity: ActivityFilter = 'all',
): { sql: string; params: Array<string | number> } {
  // Split by who was online once the roll-ups are (store/rollups.ts); the
  // season keeps an 'all' row per path, days sum their activities.
  if (hasActivityRollups(db)) {
    if (range === undefined) return { sql: `(SELECT * FROM path_rollup WHERE activity = '${activity}')`, params: [] };
    return {
      sql: `(SELECT season_id, path_id, category,
                  sum(self_ms) AS self_ms, sum(total_ms) AS total_ms, sum(ticks) AS ticks,
                  sum(self_ms) / max(sum(ticks), 1) AS ms_per_tick,
                  sum(windows_present) AS windows_present, sum(windows_total) AS windows_total,
                  count(DISTINCT day) AS days, max(day) AS last_day, sum(captures_present) AS captures
             FROM path_daily
            WHERE season_id = ? AND day >= ? AND day <= ?${storedActivitySql(activity)}
            GROUP BY season_id, path_id, category)`,
      params: [seasonId, range.fromDay, range.toDay],
    };
  }
  if (range === undefined) return { sql: 'path_rollup', params: [] };
  return {
    sql: `(SELECT season_id, path_id, category,
                  sum(self_ms) AS self_ms, sum(total_ms) AS total_ms, sum(ticks) AS ticks,
                  sum(self_ms) / max(sum(ticks), 1) AS ms_per_tick,
                  sum(windows_present) AS windows_present, sum(windows_total) AS windows_total,
                  count(DISTINCT day) AS days, max(day) AS last_day, sum(captures_present) AS captures
             FROM path_daily
            WHERE season_id = ? AND day >= ? AND day <= ?
            GROUP BY season_id, path_id, category)`,
    params: [seasonId, range.fromDay, range.toDay],
  };
}
