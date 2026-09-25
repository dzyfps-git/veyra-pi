/**
 * Whether anyone was playing during a minute: the one place that decides it.
 *
 * An empty server ticks in well under a millisecond, so hours with nobody
 * online would make typical and "normal" figures look far healthier than the
 * server is while people play. Idle minutes are kept (they are a useful
 * baseline for slow drift) but never mixed with play.
 */

export type Activity = 'playing' | 'idle' | 'unknown';

export function activityOf(players: number | null | undefined): Activity {
  if (players === null || players === undefined) return 'unknown';
  return players === 0 ? 'idle' : 'playing';
}

/** Only minutes while playing, only idle ones, or all of them. */
export type ActivityFilter = 'all' | 'playing' | 'idle';

/** The capture_window condition for a filter ('' for all). */
export function activitySql(filter: ActivityFilter, column = 'players'): string {
  return filter === 'playing' ? ` AND ${column} > 0` : filter === 'idle' ? ` AND ${column} = 0` : '';
}

/** What figures show unless another view is chosen: play, since that is what players feel. */
export const DEFAULT_ACTIVITY: ActivityFilter = 'playing';

export function activityFilterOf(value: string | null | undefined): ActivityFilter {
  return value === 'playing' || value === 'idle' || value === 'all' ? value : DEFAULT_ACTIVITY;
}

/** How a view is named wherever its numbers are shown. */
export const ACTIVITY_WORDS: Record<ActivityFilter, string> = {
  playing: 'while playing',
  idle: 'nobody online',
  all: 'all minutes',
};

/** Is this minute a fair comparison for that one: the same activity, and while playing, within one player. */
export function similarLoad(a: number | null | undefined, b: number | null | undefined): boolean {
  const x = activityOf(a);
  if (x === 'unknown' || x !== activityOf(b)) return false;
  return x === 'idle' || Math.abs(a! - b!) <= 1;
}
