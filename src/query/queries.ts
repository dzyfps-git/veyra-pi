/**
 * Read queries for the interface.
 *
 * Kept apart from the store's write path so the UI cannot accidentally mutate
 * anything, and so query shapes can change without touching ingest.
 */

import { DEFAULT_ACTIVITY, type ActivityFilter } from '../analysis/activity.ts';
import { effectiveActivity, rollupActivitySql } from '../store/rollups.ts';
import type { DatabaseSync } from 'node:sqlite';
import { rollupSource, type DayRange } from './range.ts';

export interface Overview {
  captures: number;
  environments: number;
  seasons: number;
  paths: number;
  ledgerRows: number;
  frameRows: number;
  mods: number;
  firstCapture: number | null;
  lastCapture: number | null;
  totalCaptureMinutes: number;
  rawBytes: number;
}

export function overview(db: DatabaseSync): Overview {
  const row = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM capture)                         AS captures,
         (SELECT count(*) FROM environment)                     AS environments,
         (SELECT count(*) FROM season)                          AS seasons,
         (SELECT count(*) FROM path)                            AS paths,
         (SELECT count(*) FROM path_daily)                      AS ledgerRows,
         (SELECT count(*) FROM frame_daily)                     AS frameRows,
         (SELECT count(*) FROM mod)                             AS mods,
         (SELECT min(started_at) FROM capture)                  AS firstCapture,
         (SELECT max(started_at) FROM capture)                  AS lastCapture,
         (SELECT sum(raw_bytes) FROM capture)                   AS rawBytes,
         (SELECT sum(ended_at - started_at) FROM capture
            WHERE started_at IS NOT NULL AND ended_at IS NOT NULL) AS spanMs`,
    )
    .get() as Record<string, number | null>;

  return {
    captures: row['captures'] ?? 0,
    environments: row['environments'] ?? 0,
    seasons: row['seasons'] ?? 0,
    paths: row['paths'] ?? 0,
    ledgerRows: row['ledgerRows'] ?? 0,
    frameRows: row['frameRows'] ?? 0,
    mods: row['mods'] ?? 0,
    firstCapture: row['firstCapture'] ?? null,
    lastCapture: row['lastCapture'] ?? null,
    totalCaptureMinutes: (row['spanMs'] ?? 0) / 60000,
    rawBytes: row['rawBytes'] ?? 0,
  };
}

export interface CaptureRow {
  id: number;
  source_name: string;
  started_at: number | null;
  window_count: number;
  path_count: number;
  interval_micros: number | null;
  tick_ms_per_tick: number | null;
  idle_ms_per_tick: number | null;
  blocked_ms_per_tick: number | null;
  between_tick_ms_per_tick: number | null;
  wall_ms_per_tick: number | null;
  raw_bytes: number;
  engine_inferred: string | null;
  sampler_engine: string | null;
  season_ordinal: number;
  os_name: string;
  cpu_threads: number | null;
  is_manual: number;
}

export function captures(db: DatabaseSync, limit = 200, serverId?: string): CaptureRow[] {
  return db
    .prepare(
      `SELECT c.id, c.source_name, c.started_at, c.window_count, c.path_count, c.interval_micros,
              c.tick_ms_per_tick, c.idle_ms_per_tick, c.blocked_ms_per_tick,
              c.between_tick_ms_per_tick, c.wall_ms_per_tick, c.raw_bytes,
              c.engine_inferred, c.sampler_engine, c.is_manual,
              s.ordinal AS season_ordinal, e.os_name, e.cpu_threads
         FROM capture c
         JOIN season s      ON s.id = c.season_id
         JOIN environment e ON e.id = s.environment_id
        ${serverId === undefined ? '' : 'WHERE c.server_id = ?'}
        ORDER BY c.started_at DESC
        LIMIT ?`,
    )
    .all(...(serverId === undefined ? [limit] : [serverId, limit])) as unknown as CaptureRow[];
}

export interface WindowPoint {
  start_time: number | null;
  mspt_median: number | null;
  mspt_max: number | null;
  tps: number | null;
  players: number | null;
  entities: number | null;
  chunks: number | null;
}

export function recentWindows(db: DatabaseSync, limit = 500): WindowPoint[] {
  return db
    .prepare(
      `SELECT start_time, mspt_median, mspt_max, tps, players, entities, chunks
         FROM capture_window
        WHERE start_time IS NOT NULL
        ORDER BY start_time DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as WindowPoint[];
}

export interface EnvironmentRow {
  id: number;
  os_name: string;
  cpu_model: string;
  cpu_threads: number | null;
  mc_version: string;
  loader_name: string;
  loader_version: string;
  java_major: string;
  first_seen: number;
  last_seen: number;
  captures: number;
  seasons: number;
}

export function environments(db: DatabaseSync): EnvironmentRow[] {
  return db
    .prepare(
      `SELECT e.*,
              (SELECT count(*) FROM capture c JOIN season s ON s.id = c.season_id
                WHERE s.environment_id = e.id) AS captures,
              (SELECT count(*) FROM season s WHERE s.environment_id = e.id) AS seasons
         FROM environment e
        ORDER BY e.first_seen`,
    )
    .all() as unknown as EnvironmentRow[];
}

export interface SeasonOption {
  id: number;
  ordinal: number;
  label: string | null;
  started_at: number;
  os_name: string;
  cpu_threads: number | null;
  mc_version: string;
  loader_name: string;
  captures: number;
  last_capture: number | null;
  server_id: string;
  server_name: string;
  cpu_model: string | null;
  world_seed: string | null;
}

/**
 * Seasons available to look at, most recently active first.
 *
 * Ordinals restart per environment, because seasons are detected per machine
 * (see `groupByEnvironment`). So an ordinal alone does not identify a season
 * to a reader -- the environment has to be shown beside it.
 */
/** What a season is called: its given name, or "Season 2". */
export function seasonName(s: { label: string | null; ordinal: number }): string {
  return s.label ?? `Season ${s.ordinal}`;
}

export function seasonOptions(db: DatabaseSync, serverId?: string): SeasonOption[] {
  return db
    .prepare(
      `SELECT s.id, s.ordinal, s.label, s.started_at,
              e.os_name, e.cpu_threads, e.cpu_model, e.mc_version, e.loader_name,
              sv.id AS server_id, sv.display_name AS server_name, w.seed AS world_seed,
              (SELECT count(*)        FROM capture c WHERE c.season_id = s.id) AS captures,
              (SELECT max(started_at) FROM capture c WHERE c.season_id = s.id) AS last_capture
         FROM season s
         JOIN environment e ON e.id = s.environment_id
         JOIN server sv     ON sv.id = s.server_id
         LEFT JOIN world w  ON w.id = s.world_id
        ${serverId === undefined ? '' : 'WHERE s.server_id = ?'}
        ORDER BY last_capture DESC, s.started_at DESC`,
    )
    .all(...(serverId === undefined ? [] : [serverId])) as unknown as SeasonOption[];
}

/**
 * The season holding the most recent capture -- of one server, when given.
 * The sensible default to show.
 */
export function latestSeasonId(db: DatabaseSync, serverId?: string): number | undefined {
  const where = serverId === undefined ? '' : 'WHERE server_id = ?';
  const args = serverId === undefined ? [] : [serverId];
  const row = db.prepare(`SELECT season_id FROM capture ${where} ORDER BY started_at DESC LIMIT 1`).get(...args) as
    | { season_id: number }
    | undefined;
  if (row !== undefined) return row.season_id;
  const fallback = db.prepare(`SELECT id FROM season ${where} ORDER BY started_at DESC LIMIT 1`).get(...args) as
    | { id: number }
    | undefined;
  return fallback?.id;
}

export interface LedgerRow {
  path_id: number;
  label: string;
  source_mod: string | null;
  depth: number;
  self_ms: number;
  total_ms: number;
  ticks: number;
  windows_present: number;
  windows_total: number;
  days: number;
  captures_present: number;
  category: string;
  self_ms_per_tick: number;
  /** Server-thread seconds per day. Makes constant small costs legible. */
  seconds_per_day: number;
}

export interface LedgerQuery {
  /**
   * Which season to read. Defaults to the one with the most recent capture.
   * There is deliberately no "every season at once" option; see `ledger()`.
   */
  seasonId?: number;
  /** Only paths at or above this ms/tick. */
  minMsPerTick?: number;
  /** Only paths at or BELOW this ms/tick -- the "small recurring costs" view. */
  maxMsPerTick?: number;
  /** Only paths present in at least this fraction of observed windows. */
  minPersistence?: number;
  category?: string;
  search?: string;
  limit?: number;
  orderBy?: 'self' | 'persistence' | 'seconds';
  /** Only these days. Without it, the whole season (the fast materialised rollup). */
  range?: DayRange;
  /** A prepared table with rollup columns (an exact time span); overrides `range`. */
  table?: string;
  /** While playing (the default), nobody online, or all minutes. */
  activity?: ActivityFilter;
}

const PERSISTENCE_SQL = 'CAST(r.windows_present AS REAL) / max(r.windows_total, 1)';

/**
 * The ledger view.
 *
 * Deliberately supports an upper bound as well as a lower one, because the
 * interesting query is often "everything under 0.05 ms/tick that has been
 * there every day for a month" -- the costs a conventional profiler view
 * sorts to the bottom and nobody ever scrolls to.
 *
 * **Scoped to one season, always.** The first version summed `path_daily`
 * across every season at once, which silently pooled two different machines:
 * the Windows test box, where spark falls back to the safepoint-biased
 * ThreadMXBean sampler, and Linux production, which uses async-profiler.
 * Their capture ranges overlap in time, so the pooled figure was not a longer
 * history of one thing, it was an average of two incomparable ones. Nothing
 * is lost by scoping -- every season stays queryable and the ledger still
 * holds every path it ever recorded.
 *
 * Reading `path_rollup` instead of grouping `path_daily` is the other half of
 * the change. With the season fixed, `(season_id, path_id, category)` is the
 * rollup's primary key, so every row is already the aggregate and the query
 * does no grouping at all.
 */
export function ledger(db: DatabaseSync, query: LedgerQuery = {}): LedgerRow[] {
  const seasonId = query.seasonId ?? latestSeasonId(db);
  if (seasonId === undefined) return [];

  const where: string[] = ['r.season_id = ?', 'r.ticks > 0'];
  const params: Array<string | number> = [seasonId];

  // Search resolves to a set of path ids FIRST, against the 43k-row frame
  // table, rather than testing `f.label LIKE ?` on every joined row of the
  // season. Same result set; measured 286 ms -> 95 ms on the real archive.
  // The CTE binds ahead of everything else, so its parameters go in front.
  const searching = query.search !== undefined && query.search !== '';
  const cte = searching
    ? `WITH hit(id) AS (
         SELECT id FROM path WHERE frame_id IN (SELECT id FROM frame WHERE label LIKE ?)
         UNION
         SELECT id FROM path WHERE source_mod LIKE ?
       )
       `
    : '';
  if (searching) params.unshift(`%${query.search!}%`, `%${query.search!}%`);

  if (query.category !== undefined) {
    where.push('r.category = ?');
    params.push(query.category);
  }
  // These filtered the grouped result before. Against the rollup they are
  // ordinary predicates on a stored, indexed column.
  if (query.minMsPerTick !== undefined) {
    where.push('r.ms_per_tick >= ?');
    params.push(query.minMsPerTick);
  }
  if (query.maxMsPerTick !== undefined) {
    where.push('r.ms_per_tick <= ?');
    params.push(query.maxMsPerTick);
  }
  if (query.minPersistence !== undefined) {
    where.push(`${PERSISTENCE_SQL} >= ?`);
    params.push(query.minPersistence);
  }

  // 'seconds' and 'self' are the same ordering: seconds per day is ms/tick
  // times a constant. Both spellings are accepted because they read
  // differently at the call site, but there is no second sort to perform.
  const order =
    query.orderBy === 'persistence'
      ? 'persistence DESC, r.ms_per_tick DESC, r.path_id'
      : 'r.ms_per_tick DESC, r.path_id';

  const limit = query.limit ?? 100;

  // The range subquery sits in FROM, after the search CTE and before WHERE,
  // so its parameters bind between the two.
  const source =
    query.table !== undefined
      ? { sql: query.table, params: [] }
      : rollupSource(db, seasonId, query.range, effectiveActivity(db, seasonId, query.activity ?? DEFAULT_ACTIVITY));
  params.splice(searching ? 2 : 0, 0, ...source.params);

  const rows = db
    .prepare(
      `${cte}SELECT r.path_id  AS path_id,
              f.label           AS label,
              p.source_mod      AS source_mod,
              p.depth           AS depth,
              r.self_ms         AS self_ms,
              r.total_ms        AS total_ms,
              r.ticks           AS ticks,
              r.windows_present AS windows_present,
              r.windows_total   AS windows_total,
              r.days            AS days,
              r.captures        AS captures_present,
              r.category        AS category,
              r.ms_per_tick     AS self_per_tick,
              ${PERSISTENCE_SQL} AS persistence,
              r.ms_per_tick * 20 * 86400 / 1000 AS seconds_per_day
         FROM ${source.sql} r
         JOIN path  p ON p.id = r.path_id
         JOIN frame f ON f.id = p.frame_id
         ${searching ? 'JOIN hit ON hit.id = r.path_id' : ''}
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT ${limit}`,
    )
    .all(...params) as Array<Record<string, number | string | null>>;

  return rows.map((r) => ({
    path_id: r['path_id'] as number,
    label: r['label'] as string,
    source_mod: r['source_mod'] as string | null,
    depth: r['depth'] as number,
    self_ms: r['self_ms'] as number,
    total_ms: r['total_ms'] as number,
    ticks: r['ticks'] as number,
    windows_present: r['windows_present'] as number,
    windows_total: r['windows_total'] as number,
    days: r['days'] as number,
    captures_present: r['captures_present'] as number,
    category: r['category'] as string,
    self_ms_per_tick: r['self_per_tick'] as number,
    seconds_per_day: r['seconds_per_day'] as number,
  }));
}

export interface ModCost {
  source_mod: string;
  self_ms: number;
  ticks: number;
  self_ms_per_tick: number;
  paths: number;
}

/**
 * Cost attributed to each mod, within one season.
 *
 * Season-scoped for the same reason the ledger is: a sum across two
 * environments describes neither of them.
 *
 * `paths` counts DISTINCT call paths. It previously counted rows of
 * `path_daily`, which is path-days -- one path seen on twelve days counted
 * twelve times, so the figure tracked retention rather than the mod's
 * actual footprint.
 */
export function costByMod(db: DatabaseSync, seasonId?: number, limit = 40): ModCost[] {
  const season = seasonId ?? latestSeasonId(db);
  if (season === undefined) return [];

  const rows = db
    .prepare(
      `SELECT COALESCE(p.source_mod, '<unattributed>') AS source_mod,
              sum(r.self_ms)            AS self_ms,
              sum(r.ticks)              AS ticks,
              count(DISTINCT r.path_id) AS paths
         FROM path_rollup r
         JOIN path p ON p.id = r.path_id
        WHERE r.ticks > 0 AND r.season_id = ?${rollupActivitySql(db, 'all').replace('activity', 'r.activity')}
        GROUP BY source_mod
        ORDER BY self_ms DESC
        LIMIT ${limit}`,
    )
    .all(season) as Array<Record<string, number | string>>;

  return rows.map((r) => ({
    source_mod: r['source_mod'] as string,
    self_ms: r['self_ms'] as number,
    ticks: r['ticks'] as number,
    paths: r['paths'] as number,
    self_ms_per_tick: (r['self_ms'] as number) / Math.max(r['ticks'] as number, 1),
  }));
}

export interface TailSummary {
  paths: number;
  selfMs: number;
  totalMs: number;
}

export function tailSummary(db: DatabaseSync): TailSummary {
  const row = db
    .prepare('SELECT COALESCE(sum(paths),0) paths, COALESCE(sum(self_ms),0) self_ms, COALESCE(sum(total_ms),0) total_ms FROM path_daily_tail')
    .get() as Record<string, number>;
  return { paths: row['paths'] ?? 0, selfMs: row['self_ms'] ?? 0, totalMs: row['total_ms'] ?? 0 };
}
