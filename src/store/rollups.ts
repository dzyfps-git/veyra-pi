/**
 * The daily and season roll-ups, kept apart by who was online.
 *
 * Every row carries an activity (analysis/activity.ts): minutes while playing,
 * minutes with nobody online, and minutes whose player count was not recorded.
 * "All" is their sum, so any view can switch exactly between While playing,
 * Nobody online and All without storing anything twice. The one exception is
 * `path_rollup`, the season total read on every Findings view, which also
 * keeps an 'all' row per path so the default views never group at read time.
 *
 * A database from before this change has the same tables without the column.
 * It keeps working as it was while the collector rebuilds the roll-ups into
 * `*_next` tables in the background (cli/collector.ts), and swaps them in with
 * one transaction when they have caught up. hasActivityRollups() says which
 * shape is live.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { ActivityFilter } from '../analysis/activity.ts';

/** What a row is stored under; 'all' exists only in path_rollup. */
export type StoredActivity = 'playing' | 'idle' | 'unknown';
export const STORED_ACTIVITIES: readonly StoredActivity[] = ['playing', 'idle', 'unknown'];

const TABLES = ['path_daily', 'path_rollup', 'split_day', 'split_day_ticks'] as const;
const INDEXES = ['ledger_by_path', 'ledger_by_season', 'rollup_by_self', 'rollup_by_pertick'] as const;

function tablesDDL(s: string): string {
  return `
CREATE TABLE IF NOT EXISTS path_daily${s} (
  day              TEXT    NOT NULL,
  server_id        TEXT    NOT NULL REFERENCES server(id),
  season_id        INTEGER NOT NULL REFERENCES season(id),
  path_id          INTEGER NOT NULL REFERENCES path(id),
  activity         TEXT    NOT NULL,
  self_ms          REAL    NOT NULL,
  total_ms         REAL    NOT NULL,
  ticks            INTEGER NOT NULL,
  windows_present  INTEGER NOT NULL,
  windows_total    INTEGER NOT NULL,
  captures_present INTEGER NOT NULL,
  category         TEXT    NOT NULL,
  PRIMARY KEY (day, season_id, path_id, activity)
);
CREATE TABLE IF NOT EXISTS path_rollup${s} (
  season_id       INTEGER NOT NULL REFERENCES season(id),
  path_id         INTEGER NOT NULL REFERENCES path(id),
  category        TEXT    NOT NULL,
  activity        TEXT    NOT NULL,
  self_ms         REAL    NOT NULL,
  total_ms        REAL    NOT NULL,
  ticks           INTEGER NOT NULL,
  ms_per_tick     REAL    NOT NULL,
  windows_present INTEGER NOT NULL,
  windows_total   INTEGER NOT NULL,
  days            INTEGER NOT NULL,
  last_day        TEXT    NOT NULL,
  captures        INTEGER NOT NULL,
  PRIMARY KEY (season_id, path_id, category, activity)
);
CREATE TABLE IF NOT EXISTS split_day${s} (
  season_id     INTEGER NOT NULL REFERENCES season(id),
  day           TEXT    NOT NULL,
  activity      TEXT    NOT NULL,
  system        TEXT    NOT NULL,
  owner         TEXT    NOT NULL,
  subject       TEXT    NOT NULL,
  subject_owner TEXT    NOT NULL,
  self_ms       REAL    NOT NULL,
  PRIMARY KEY (season_id, day, activity, system, owner, subject, subject_owner)
);
CREATE TABLE IF NOT EXISTS split_day_ticks${s} (
  season_id       INTEGER NOT NULL REFERENCES season(id),
  day             TEXT    NOT NULL,
  activity        TEXT    NOT NULL,
  captures        INTEGER NOT NULL,
  minutes         INTEGER NOT NULL,
  ticks           INTEGER NOT NULL,
  sampled_ms      REAL    NOT NULL,
  measured_ms     REAL    NOT NULL,
  measured_ticks  INTEGER NOT NULL,
  aligned_minutes INTEGER NOT NULL,
  PRIMARY KEY (season_id, day, activity)
);`;
}

function indexesDDL(s: string): string {
  return `
CREATE INDEX IF NOT EXISTS ledger_by_path${s}    ON path_daily${s} (path_id, day);
CREATE INDEX IF NOT EXISTS ledger_by_season${s}  ON path_daily${s} (season_id, day, activity);
CREATE INDEX IF NOT EXISTS rollup_by_self${s}    ON path_rollup${s} (season_id, activity, self_ms DESC);
CREATE INDEX IF NOT EXISTS rollup_by_pertick${s} ON path_rollup${s} (season_id, activity, ms_per_tick DESC);`;
}

const live = new WeakMap<DatabaseSync, boolean>();

/** Are the live roll-ups the ones split by activity? */
export function hasActivityRollups(db: DatabaseSync): boolean {
  const known = live.get(db);
  if (known !== undefined) return known;
  const n = (db.prepare("SELECT count(*) AS n FROM pragma_table_info('path_rollup') WHERE name = 'activity'").get() as { n: number }).n;
  live.set(db, n > 0);
  return n > 0;
}

/** A new database gets the split roll-ups from the start. */
export function ensureRollupTables(db: DatabaseSync): void {
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'path_rollup'").get();
  if (exists !== undefined) return;
  db.exec(tablesDDL('') + indexesDDL(''));
  live.set(db, true);
}

/** Empty `*_next` tables to rebuild into (any earlier, unfinished attempt is discarded). */
export function beginShadowRollups(db: DatabaseSync): void {
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}_next`);
  db.exec(tablesDDL('_next') + indexesDDL('_next'));
}

/** Put the rebuilt roll-ups in place of the old ones, in one transaction. */
export function swapInShadowRollups(db: DatabaseSync): void {
  db.exec('BEGIN');
  try {
    for (const t of TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
      db.exec(`ALTER TABLE ${t}_next RENAME TO ${t}`);
    }
    for (const i of INDEXES) db.exec(`DROP INDEX IF EXISTS ${i}_next`);
    db.exec(indexesDDL(''));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  live.set(db, true);
}

/** Rows to read for a filter, as a condition on `activity` ('' for every stored row). */
export function storedActivitySql(filter: ActivityFilter): string {
  return filter === 'all' ? '' : ` AND activity = '${filter}'`;
}

/** The season total rows for a filter: 'all' has its own rows in path_rollup. */
export function rollupActivitySql(db: DatabaseSync, filter: ActivityFilter): string {
  return hasActivityRollups(db) ? ` AND activity = '${filter}'` : '';
}

/**
 * The filter a season's figures can actually be read under. Before the
 * roll-ups are split, only All exists. A season recorded before player counts
 * existed has no playing or idle minutes at all, so it falls back to All
 * rather than showing nothing; otherwise the choice stands, even when it
 * finds nothing (no idle minutes is an answer).
 */
export function effectiveActivity(db: DatabaseSync, seasonId: number, requested: ActivityFilter): ActivityFilter {
  if (!hasActivityRollups(db)) return 'all';
  if (requested === 'all') return 'all';
  const known = db.prepare("SELECT 1 AS ok FROM path_rollup WHERE season_id = ? AND activity IN ('playing', 'idle') LIMIT 1").get(seasonId);
  return known === undefined ? 'all' : requested;
}
