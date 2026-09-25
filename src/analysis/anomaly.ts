/**
 * Anomaly detection and raw-evidence pinning.
 *
 * This is what makes a 15-day raw retention safe. Decoded history is kept
 * forever, but the raw `.sparkprofile` is the only thing that can be
 * re-examined in a way nobody anticipated — reopened in spark's viewer,
 * re-decoded with better mappings, or interrogated for a question the ledger
 * schema does not answer. Deleting the raw file for the one hour that
 * actually went wrong is the single worst outcome the retention policy can
 * produce.
 *
 * So a capture containing anything unusual is **pinned**, and a pinned
 * capture is never eligible for cleanup, regardless of age.
 *
 * Two design choices worth stating:
 *
 *   - Pinning leans toward keeping. A false positive costs about 40 MB of
 *     disk against 5.3 TB free; a false negative destroys the only copy of
 *     the evidence. Those are not symmetric.
 *   - But leaning is not the same as pinning everything. The first pass at
 *     these rules pinned 28 of 29 real captures, which is the same as
 *     pinning none: retention never fires, disk grows without bound, and
 *     "pinned" stops meaning anything. Two mistakes caused it, and both are
 *     worth remembering because they recur:
 *
 *       1. **Absolute thresholds borrowed from a different question.** The
 *          "bad median" threshold is about sustained slowness; a single 200 ms
 *          tick is routine in a 579-mod pack and says nothing. Thresholds are
 *          now relative to each season's own normal, with an absolute floor,
 *          which also means they survive a modpack rotation without being
 *          retuned.
 *       2. **A unit error.** Blocked time was compared as
 *          `ms_per_tick * 1000` against a threshold denominated in
 *          milliseconds of a single stall. 2.583 ms/tick is not a 2583 ms
 *          stall, and the comparison flagged almost every capture.
 *
 *   - Reasons are recorded as text, not as a code. When someone looks at a
 *     three-month-old pinned file and asks why it survived, the answer
 *     should be in the row rather than reconstructable from the thresholds
 *     that happened to be configured that week.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SettingsStore } from '../settings/store.ts';

export interface AnomalyReason {
  kind:
    | 'mspt-excursion'
    | 'tps-drop'
    | 'blocking-stall'
    | 'player-record'
    | 'first-in-season'
    | 'new-top-path'
    | 'manual';
  detail: string;
}

export interface PinDecision {
  captureId: number;
  sourceName: string;
  pin: boolean;
  reasons: AnomalyReason[];
}

/**
 * What "normal" looks like for one season.
 *
 * Derived from the season's own captures rather than configured, so the
 * definition of unusual travels across a modpack rotation on its own. A
 * season with three captures has a weak baseline, which is why every rule
 * that uses it also carries an absolute floor.
 */
export interface SeasonBaseline {
  captures: number;
  /** Median of each capture's worst single tick, ms. */
  medianWorstTick: number;
  /** Median per-capture blocked time, MSPT. */
  medianBlocked: number;
  peakPlayers: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function seasonBaseline(db: DatabaseSync, seasonId: number, excludeCaptureId?: number): SeasonBaseline {
  const rows = db
    .prepare(
      `SELECT c.id,
              COALESCE(c.blocked_ms_per_tick, 0)     AS blocked,
              COALESCE(MAX(w.mspt_max), 0)           AS worst,
              COALESCE(MAX(w.players), 0)            AS players
         FROM capture c
         LEFT JOIN capture_window w ON w.capture_id = c.id
        WHERE c.season_id = ? AND c.id != ?
        GROUP BY c.id`,
    )
    .all(seasonId, excludeCaptureId ?? -1) as Array<{
    id: number;
    blocked: number;
    worst: number;
    players: number;
  }>;

  return {
    captures: rows.length,
    medianWorstTick: median(rows.map((r) => r.worst).filter((v) => v > 0)),
    medianBlocked: median(rows.map((r) => r.blocked)),
    peakPlayers: rows.reduce((max, r) => Math.max(max, r.players), 0),
  };
}

interface CaptureRow {
  id: number;
  source_name: string;
  season_id: number;
  started_at: number | null;
  pinned: number;
  tick_ms_per_tick: number | null;
  blocked_ms_per_tick: number | null;
  is_manual: number;
}

/**
 * Decide whether one capture holds evidence worth keeping the raw file for.
 *
 * Reads only; `applyPins` is what writes. Split that way so the decision can
 * be shown as a dry run before anything is committed, which is the same
 * pattern the cleanup path uses.
 */
export function assessCapture(
  db: DatabaseSync,
  settings: SettingsStore,
  capture: CaptureRow,
  baseline?: SeasonBaseline,
): PinDecision {
  const reasons: AnomalyReason[] = [];
  const base = baseline ?? seasonBaseline(db, capture.season_id, capture.id);

  const badMedianMs = settings.getNumber('analysis.thresholds.msptMedianBad');

  const windows = db
    .prepare(
      `SELECT window_id, mspt_median, mspt_max, tps, players
         FROM capture_window WHERE capture_id = ?`,
    )
    .all(capture.id) as Array<{
    window_id: number;
    mspt_median: number | null;
    mspt_max: number | null;
    tps: number | null;
    players: number | null;
  }>;

  // Sustained slowness: a whole minute whose MEDIAN is at the bad threshold.
  // This one stays absolute, because the threshold is a statement about what
  // the server is for -- at 50 ms/tick it is losing ticks outright.
  for (const w of windows) {
    if (w.mspt_median !== null && w.mspt_median >= badMedianMs) {
      reasons.push({
        kind: 'mspt-excursion',
        detail: `window ${w.window_id} had a median of ${w.mspt_median.toFixed(1)} MSPT, at or above the "bad" threshold of ${badMedianMs}`,
      });
      break;
    }
  }

  // A single catastrophic tick. Relative to the season, with a one-second
  // floor: occasional 100-300 ms ticks are routine in a 579-mod pack and
  // pinning on them pins everything.
  const worstTick = windows.reduce<number>((max, w) => Math.max(max, w.mspt_max ?? 0), 0);
  const worstTickBar = Math.max(1000, base.medianWorstTick * 3);
  if (worstTick >= worstTickBar) {
    reasons.push({
      kind: 'mspt-excursion',
      detail:
        `a single tick reached ${worstTick.toFixed(0)} ms` +
        (base.captures === 0
          ? ' (over the one-second floor; no season baseline yet)'
          : `, against a season median worst tick of ${base.medianWorstTick.toFixed(0)} ms across ${base.captures} other capture${
              base.captures === 1 ? '' : 's'
            }`),
    });
  }

  // TPS below 19 is objectively losing ticks, so it is absolute too.
  const lowestTps = windows.reduce<number | null>(
    (min, w) => (w.tps === null ? min : min === null ? w.tps : Math.min(min, w.tps)),
    null,
  );
  if (lowestTps !== null && lowestTps < 19) {
    reasons.push({
      kind: 'tps-drop',
      detail: `TPS fell to ${lowestTps.toFixed(2)}; the server was losing ticks outright`,
    });
  }

  // Blocked time is lost tick time rather than idle waiting, so it is judged
  // at a lower bar than general slowness -- but in ms/tick, which is the unit
  // it is actually stored in.
  const blocked = capture.blocked_ms_per_tick ?? 0;
  const blockedBar = Math.max(2, base.medianBlocked * 3);
  if (blocked >= blockedBar) {
    reasons.push({
      kind: 'blocking-stall',
      detail:
        `${blocked.toFixed(3)} MSPT of blocked time -- the tick stalled rather than waited` +
        (base.captures === 0
          ? ''
          : `, against a season median of ${base.medianBlocked.toFixed(3)} MSPT`),
    });
  }

  const peakPlayers = windows.reduce<number>((max, w) => Math.max(max, w.players ?? 0), 0);
  if (peakPlayers > 0 && peakPlayers > base.peakPlayers) {
    reasons.push({
      kind: 'player-record',
      detail: `${peakPlayers} players, the highest seen this season (previous best ${base.peakPlayers}) -- the most valuable load condition to be able to re-examine`,
    });
  }

  // The first capture of a season is the only baseline that season has.
  const earlier = db
    .prepare('SELECT count(*) AS n FROM capture WHERE season_id = ? AND started_at < ?')
    .get(capture.season_id, capture.started_at ?? 0) as { n: number };
  if (earlier.n === 0) {
    reasons.push({
      kind: 'first-in-season',
      detail: 'first capture of this season -- the only baseline it has',
    });
  }

  if (capture.is_manual === 1) {
    reasons.push({
      kind: 'manual',
      detail: 'captured by hand, so it was taken to answer a specific question',
    });
  }

  return { captureId: capture.id, sourceName: capture.source_name, pin: reasons.length > 0, reasons };
}

export interface PinSummary {
  examined: number;
  pinned: number;
  alreadyPinned: number;
  decisions: PinDecision[];
  /**
   * Set when almost everything qualified.
   *
   * Pinning nearly every capture is indistinguishable from pinning none:
   * retention never fires and the flag stops carrying information. That has
   * happened once already, so it is surfaced rather than left to be noticed
   * when the disk fills.
   */
  overPinning?: string;
}

/**
 * Assess every capture and pin the ones holding unusual evidence.
 *
 * A pin is only ever added, never removed: once something has been judged
 * worth keeping, a later threshold change should not quietly make it
 * deletable. Unpinning is a deliberate act.
 */
export function applyPins(
  db: DatabaseSync,
  settings: SettingsStore,
  options: { dryRun?: boolean } = {},
): PinSummary {
  if (!settings.getBoolean('retention.pinAnomalies')) {
    return { examined: 0, pinned: 0, alreadyPinned: 0, decisions: [] };
  }

  const captures = db
    .prepare(
      `SELECT id, source_name, season_id, started_at, pinned, tick_ms_per_tick,
              blocked_ms_per_tick, is_manual
         FROM capture ORDER BY started_at`,
    )
    .all() as unknown as CaptureRow[];

  const summary: PinSummary = { examined: captures.length, pinned: 0, alreadyPinned: 0, decisions: [] };

  for (const capture of captures) {
    if (capture.pinned === 1) {
      summary.alreadyPinned += 1;
      continue;
    }
    const decision = assessCapture(db, settings, capture);
    if (!decision.pin) continue;

    summary.decisions.push(decision);
    summary.pinned += 1;
    if (options.dryRun === true) continue;

    db.prepare('UPDATE capture SET pinned = 1, pinned_reason = ? WHERE id = ?').run(
      decision.reasons.map((r) => r.detail).join('; '),
      capture.id,
    );
  }

  const considered = summary.examined - summary.alreadyPinned;
  if (considered >= 10 && summary.pinned / considered > 0.8) {
    summary.overPinning =
      `${summary.pinned} of ${considered} captures qualified as anomalous. That is high enough that ` +
      'retention will effectively never delete anything, which means the thresholds are describing ' +
      'normal behaviour rather than unusual behaviour. Worth retuning.';
  }

  return summary;
}

/**
 * Captures whose raw file may be deleted by retention.
 *
 * The inverse of this list is the safety guarantee, so it is expressed as a
 * query rather than reconstructed by the caller: anything pinned, anything
 * newer than the retention window, and anything not yet verified as archived
 * is excluded.
 */
export function rawDeletionCandidates(
  db: DatabaseSync,
  settings: SettingsStore,
  now = Date.now(),
): Array<{ id: number; source_name: string; archive_path: string; started_at: number | null }> {
  const days = settings.getNumber('retention.rawDays');
  const cutoff = now - days * 86_400_000;

  return db
    .prepare(
      `SELECT id, source_name, archive_path, started_at
         FROM capture
        WHERE pinned = 0
          AND archive_path IS NOT NULL
          AND started_at IS NOT NULL
          AND started_at < ?
        ORDER BY started_at`,
    )
    .all(cutoff) as Array<{ id: number; source_name: string; archive_path: string; started_at: number | null }>;
}
