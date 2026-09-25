/**
 * What monitoring was doing, over time -- and how much of a span was actually
 * recorded.
 *
 * ## Health
 *
 * The collector writes one row whenever a server's monitoring state changes,
 * never on every tick, so the history of states stays small and readable:
 *
 *   collecting   the last harvest worked; waiting for the next one
 *   waiting      a harvest was skipped for an ordinary reason (too young,
 *                someone else profiling) and will retry shortly
 *   restoring    background profiling was lost and is being put back
 *   watching     watch-folder mode is looking for saved profiles
 *   offline      the server is not answering
 *   paused       all monitoring paused
 *   off          collection switched off for this server
 *   disk-full    the archive drive is below its floor
 *   failing      harvests are failing
 *   stalled      nothing has been recorded for far longer than it should
 *
 * ## Coverage
 *
 * Missing data must never make a period look better than it was, so any
 * figure over a span can say how much of that span is actually behind it.
 * Coverage is measured from the one-minute windows that exist, not from
 * captures (a capture can be anything from seconds to an hour). Each gap is
 * explained by the monitoring state that was in force when it began; a gap
 * from before states were recorded says exactly that rather than guessing.
 */

import type { DatabaseSync } from 'node:sqlite';

export type MonitorState =
  | 'collecting'
  | 'waiting'
  | 'restoring'
  | 'watching'
  | 'offline'
  | 'paused'
  | 'off'
  | 'disk-full'
  | 'failing'
  | 'stalled';

export const STATE_WORDS: Record<MonitorState, { words: string; tone: 'ok' | 'info' | 'warn' | 'bad' }> = {
  collecting: { words: 'Collecting normally', tone: 'ok' },
  waiting: { words: 'Waiting to retry', tone: 'info' },
  restoring: { words: 'Restoring background profiling', tone: 'info' },
  watching: { words: 'Watching its folder', tone: 'ok' },
  offline: { words: 'Server not answering', tone: 'warn' },
  paused: { words: 'Paused', tone: 'warn' },
  off: { words: 'Collection off', tone: 'info' },
  'disk-full': { words: 'Archive drive nearly full', tone: 'bad' },
  failing: { words: 'Harvests failing', tone: 'bad' },
  stalled: { words: 'Nothing recorded recently', tone: 'bad' },
};

/** Reason shown for a gap that began while this state was in force. */
const GAP_REASON: Record<MonitorState, string> = {
  collecting: 'between captures (spark discards anything older than its last hour)',
  waiting: 'a harvest was postponed',
  restoring: 'background profiling had stopped',
  watching: 'no profile was saved',
  offline: 'the server was not answering',
  paused: 'monitoring was paused',
  off: 'collection was off',
  'disk-full': 'the archive drive was full',
  failing: 'harvests were failing',
  stalled: 'nothing was being recorded',
};

export function recordState(db: DatabaseSync, serverId: string, state: MonitorState, detail = '', at = Date.now()): boolean {
  const last = currentState(db, serverId);
  if (last !== undefined && last.state === state) return false;
  db.prepare('INSERT INTO monitor_event (server_id, at, state, detail) VALUES (?,?,?,?)').run(serverId, at, state, detail.slice(0, 500));
  return true;
}

export function currentState(
  db: DatabaseSync,
  serverId: string,
): { state: MonitorState; since: number; detail: string } | undefined {
  const row = db
    .prepare('SELECT state, at, detail FROM monitor_event WHERE server_id = ? ORDER BY at DESC, id DESC LIMIT 1')
    .get(serverId) as { state: MonitorState; at: number; detail: string } | undefined;
  return row === undefined ? undefined : { state: row.state, since: row.at, detail: row.detail };
}

export function recentStates(db: DatabaseSync, serverId: string, limit = 12): Array<{ state: MonitorState; at: number; detail: string }> {
  return db
    .prepare('SELECT state, at, detail FROM monitor_event WHERE server_id = ? ORDER BY at DESC, id DESC LIMIT ?')
    .all(serverId, limit) as Array<{ state: MonitorState; at: number; detail: string }>;
}

function stateAt(db: DatabaseSync, serverId: string, at: number): MonitorState | undefined {
  const row = db
    .prepare('SELECT state FROM monitor_event WHERE server_id = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1')
    .get(serverId, at) as { state: MonitorState } | undefined;
  return row?.state;
}

export interface Gap {
  fromMs: number;
  toMs: number;
  reason: string;
}

export interface Coverage {
  spanMs: number;
  recordedMs: number;
  /** 0..1 */
  fraction: number;
  gaps: Gap[];
}

/**
 * How much of [fromMs, toMs) has per-minute data, for one server (and
 * optionally one season), and where the holes are.
 *
 * Gaps shorter than `minGapMs` are ignored: consecutive windows are rarely
 * exactly back to back, and the minute between two harvests is not a hole
 * worth listing -- but it is still counted as unrecorded time.
 */
export function coverage(
  db: DatabaseSync,
  input: { serverId: string; fromMs: number; toMs: number; seasonId?: number; minGapMs?: number },
): Coverage {
  const minGap = input.minGapMs ?? 10 * 60_000;
  const windows = db
    .prepare(
      `SELECT w.start_time AS s, COALESCE(w.end_time, w.start_time + 60000) AS e
         FROM capture_window w JOIN capture c ON c.id = w.capture_id
        WHERE c.server_id = ? ${input.seasonId === undefined ? '' : 'AND c.season_id = ?'}
          AND w.start_time < ? AND COALESCE(w.end_time, w.start_time + 60000) > ?
        ORDER BY w.start_time`,
    )
    .all(
      ...(input.seasonId === undefined
        ? [input.serverId, input.toMs, input.fromMs]
        : [input.serverId, input.seasonId, input.toMs, input.fromMs]),
    ) as Array<{ s: number; e: number }>;

  // Union of window intervals clipped to the span. Overlapping captures (a
  // manual profile during background collection) must not count twice.
  let recorded = 0;
  const gaps: Gap[] = [];
  let cursor = input.fromMs;
  for (const w of windows) {
    const s = Math.max(w.s, input.fromMs);
    const e = Math.min(w.e, input.toMs);
    if (e <= cursor) continue;
    if (s > cursor) {
      if (s - cursor >= minGap) gaps.push({ fromMs: cursor, toMs: s, reason: '' });
      recorded += e - s;
    } else {
      recorded += e - cursor;
    }
    cursor = Math.max(cursor, e);
  }
  if (input.toMs - cursor >= minGap) gaps.push({ fromMs: cursor, toMs: input.toMs, reason: '' });

  for (const gap of gaps) {
    const state = stateAt(db, input.serverId, gap.fromMs + 1);
    gap.reason = state === undefined ? 'no record of what monitoring was doing then' : GAP_REASON[state];
  }

  const span = Math.max(0, input.toMs - input.fromMs);
  return { spanMs: span, recordedMs: recorded, fraction: span === 0 ? 0 : recorded / span, gaps };
}

/** "17.2 of 24 hours (72%)" */
export function coverageWords(c: Coverage): string {
  const h = (ms: number): string => {
    const hours = ms / 3_600_000;
    return hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
  };
  return `${h(c.recordedMs)} of ${h(c.spanMs)} recorded (${Math.round(c.fraction * 100)}%)`;
}
