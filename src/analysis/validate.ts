/**
 * A/B validation of an optimization.
 *
 * The question is narrow on purpose: did the cost of THIS call path change
 * after a specific deploy? Whole-server MSPT is the wrong instrument — it
 * moves with player count, time of day, what people are building, and which
 * chunks happen to be loaded. A change worth 0.2 ms/tick is invisible under
 * that noise, and a change worth nothing can look like a win.
 *
 * Three things make the comparison mean something:
 *
 *  1. **Matched conditions.** Windows are bucketed by player count and only
 *     compared against the same bucket. Comparing a quiet afternoon to a busy
 *     evening measures the players, not the patch.
 *
 *  2. **A confidence interval, not a point estimate.** Bootstrapped over the
 *     window samples. If the interval spans zero the honest answer is "no
 *     measurable change", and that is reported as a real result rather than
 *     being spun as a small win.
 *
 *  3. **A minimum detectable effect.** Below the configured gate the verdict
 *     is `inconclusive`, because a difference smaller than the measurement
 *     floor is not a difference.
 *
 * Synthetic benchmarks never reach this code. They live in a separate field
 * on the record and can never produce a `improved` verdict, because a
 * microbenchmark showing a function got faster is not evidence that the
 * server's tick budget did.
 */

import { readFileSync, existsSync } from 'node:fs';

import { decodeSidecar } from '../store/sidecar.ts';
import type { DatabaseSync } from 'node:sqlite';

export type Verdict = 'improved' | 'regressed' | 'no-measurable-change' | 'inconclusive';

export interface Observation {
  /** Self ms per tick for the target path in this window. */
  msPerTick: number;
  players: number;
  startTime: number;
}

export interface ValidationOptions {
  /** Deploy time. Windows before this are "before", after it are "after". */
  deployedAt: number;
  /**
   * Smallest change worth reporting, ms/tick. Default 0.03, the acceptance
   * gate the hand-run analysis used.
   */
  minEffect?: number;
  /** Minimum matched windows on each side before any verdict is offered. */
  minWindowsPerSide?: number;
  /** Player-count bucket width. Windows only compare within a bucket. */
  playerBucketSize?: number;
  bootstrapSamples?: number;
}

export interface ValidationResult {
  verdict: Verdict;
  /** Negative means the cost went down, i.e. an improvement. */
  deltaMsPerTick: number | undefined;
  ciLow: number | undefined;
  ciHigh: number | undefined;
  beforeMedian: number | undefined;
  afterMedian: number | undefined;
  beforeWindows: number;
  afterWindows: number;
  /** Buckets that had enough data on both sides to be usable. */
  bucketsCompared: number[];
  explanation: string;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function sampleWithReplacement(values: readonly number[]): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = values[Math.floor(Math.random() * values.length)]!;
  }
  return out;
}

/**
 * Bootstrap a confidence interval for the difference of medians.
 *
 * Non-parametric on purpose: tick-time distributions are skewed and spiky,
 * so a t-test's assumptions do not hold.
 */
function bootstrapDifference(
  before: readonly number[],
  after: readonly number[],
  samples: number,
): { low: number; high: number } {
  const diffs: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    diffs.push(median(sampleWithReplacement(after)) - median(sampleWithReplacement(before)));
  }
  diffs.sort((a, b) => a - b);
  return {
    low: diffs[Math.floor(diffs.length * 0.025)] ?? 0,
    high: diffs[Math.floor(diffs.length * 0.975)] ?? 0,
  };
}

export function validate(
  before: readonly Observation[],
  after: readonly Observation[],
  options: ValidationOptions,
): ValidationResult {
  const minEffect = options.minEffect ?? 0.03;
  const minWindows = options.minWindowsPerSide ?? 10;
  const bucketSize = options.playerBucketSize ?? 2;
  const bootstrapSamples = options.bootstrapSamples ?? 2000;

  const bucketOf = (players: number): number => Math.floor(players / bucketSize);

  // Only compare like with like. A bucket present on just one side tells us
  // nothing and is excluded rather than averaged in.
  const beforeByBucket = new Map<number, number[]>();
  const afterByBucket = new Map<number, number[]>();
  for (const o of before) {
    const key = bucketOf(o.players);
    beforeByBucket.set(key, [...(beforeByBucket.get(key) ?? []), o.msPerTick]);
  }
  for (const o of after) {
    const key = bucketOf(o.players);
    afterByBucket.set(key, [...(afterByBucket.get(key) ?? []), o.msPerTick]);
  }

  const shared: number[] = [];
  const matchedBefore: number[] = [];
  const matchedAfter: number[] = [];
  for (const [bucket, beforeValues] of beforeByBucket) {
    const afterValues = afterByBucket.get(bucket);
    if (afterValues === undefined) continue;
    if (beforeValues.length < 3 || afterValues.length < 3) continue;
    shared.push(bucket);
    matchedBefore.push(...beforeValues);
    matchedAfter.push(...afterValues);
  }

  const base = {
    bucketsCompared: shared.sort((a, b) => a - b),
    beforeWindows: matchedBefore.length,
    afterWindows: matchedAfter.length,
  };

  if (shared.length === 0) {
    return {
      ...base,
      verdict: 'inconclusive',
      deltaMsPerTick: undefined,
      ciLow: undefined,
      ciHigh: undefined,
      beforeMedian: undefined,
      afterMedian: undefined,
      explanation:
        'No player-count bucket had data on both sides of the deploy. The two periods are not comparable, ' +
        'so no verdict can be given. Capture more data under similar conditions.',
    };
  }

  if (matchedBefore.length < minWindows || matchedAfter.length < minWindows) {
    return {
      ...base,
      verdict: 'inconclusive',
      deltaMsPerTick: undefined,
      ciLow: undefined,
      ciHigh: undefined,
      beforeMedian: median(matchedBefore),
      afterMedian: median(matchedAfter),
      explanation:
        `Only ${matchedBefore.length} matched windows before and ${matchedAfter.length} after ` +
        `(need ${minWindows} each). Not enough to distinguish a real change from noise.`,
    };
  }

  const beforeMedian = median(matchedBefore);
  const afterMedian = median(matchedAfter);
  const delta = afterMedian - beforeMedian;
  const ci = bootstrapDifference(matchedBefore, matchedAfter, bootstrapSamples);

  const crossesZero = ci.low <= 0 && ci.high >= 0;
  const belowFloor = Math.abs(delta) < minEffect;

  let verdict: Verdict;
  let explanation: string;

  if (belowFloor) {
    verdict = 'no-measurable-change';
    explanation =
      `The difference (${delta >= 0 ? '+' : ''}${delta.toFixed(4)} MSPT) is below the ${minEffect} MSPT ` +
      'floor. A change smaller than the measurement floor is not a change.';
  } else if (crossesZero) {
    verdict = 'no-measurable-change';
    explanation =
      `Point estimate ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} MSPT, but the 95% interval ` +
      `[${ci.low.toFixed(4)}, ${ci.high.toFixed(4)}] includes zero. Consistent with no effect.`;
  } else if (delta < 0) {
    verdict = 'improved';
    explanation =
      `Cost fell by ${Math.abs(delta).toFixed(4)} MSPT (95% CI ` +
      `[${Math.abs(ci.high).toFixed(4)}, ${Math.abs(ci.low).toFixed(4)}]), measured across ` +
      `${shared.length} matched player-count bucket${shared.length === 1 ? '' : 's'}.`;
  } else {
    verdict = 'regressed';
    explanation =
      `Cost ROSE by ${delta.toFixed(4)} MSPT (95% CI [${ci.low.toFixed(4)}, ${ci.high.toFixed(4)}]). ` +
      'This change appears to have made the target worse.';
  }

  return {
    ...base,
    verdict,
    deltaMsPerTick: delta,
    ciLow: ci.low,
    ciHigh: ci.high,
    beforeMedian,
    afterMedian,
    explanation,
  };
}

/**
 * Pull per-window observations for one call path from archived sidecars.
 *
 * This is what the sidecar exists for: SQLite holds daily totals, which are
 * too coarse to stratify by player count, while the sidecar keeps every
 * window of every capture.
 */
export function collectObservations(
  db: DatabaseSync,
  pathText: string,
  range: {
    fromMs: number;
    toMs: number;
    /**
     * REQUIRED. A comparison that spans a season spans a different world,
     * modpack or machine, and measures that difference rather than the
     * change being validated. It used to be optional, which meant a
     * before/after straddling a world reset would have been accepted.
     */
    seasonId: number;
  },
  /** Turns a stored path into one that can be opened. See Store.resolveDataPath. */
  resolvePath: (stored: string) => string | undefined = (stored) => stored,
): Observation[] {
  const rows = db
    .prepare(
      `SELECT id, sidecar_path, started_at, divisor_ticks, window_count
         FROM capture
        WHERE started_at BETWEEN ? AND ?
          AND sidecar_path IS NOT NULL
          AND season_id = ?
        ORDER BY started_at`,
    )
    .all(range.fromMs, range.toMs, range.seasonId) as Array<{
    id: number;
    sidecar_path: string;
    started_at: number;
    divisor_ticks: number | null;
    window_count: number;
  }>;

  const out: Observation[] = [];

  for (const capture of rows) {
    const file = resolvePath(capture.sidecar_path);
    if (file === undefined || !existsSync(file)) continue;

    let sidecar;
    try {
      sidecar = decodeSidecar(readFileSync(file));
    } catch {
      continue; // A damaged sidecar must not abort the whole comparison.
    }

    const target = sidecar.rows.find((r) => r.path === pathText);
    if (target === undefined) continue;

    // Per-window player counts come from the stored window statistics.
    const windows = db
      .prepare('SELECT window_id, players, ticks, start_time FROM capture_window WHERE capture_id = ? ORDER BY window_id')
      .all(capture.id) as Array<{ window_id: number; players: number | null; ticks: number | null; start_time: number | null }>;

    windows.forEach((window, index) => {
      const selfMs = target.selfMsByWindow[index] ?? 0;
      const ticks = window.ticks ?? 0;
      if (ticks <= 0) return;
      out.push({
        msPerTick: selfMs / ticks,
        players: window.players ?? 0,
        startTime: window.start_time ?? capture.started_at,
      });
    });
  }

  return out;
}

export type ComparisonScope =
  | { ok: true; seasonId: number; reason: string }
  | { ok: false; reason: string };

/**
 * Which season a before/after comparison around `deployedAt` belongs to.
 *
 * Before and after must be the SAME season: same machine, same Minecraft,
 * same loader, same mod set family, same world. If the nearest capture on
 * each side belongs to a different season, the deploy coincided with a world
 * reset or modpack change, and any difference measured would be that change
 * rather than the patch. That is refused rather than reported, because a
 * confident-looking verdict on a confounded comparison is the most
 * misleading thing this system could produce.
 */
export function comparisonScope(db: DatabaseSync, serverId: string, deployedAt: number): ComparisonScope {
  const before = db
    .prepare(
      `SELECT season_id FROM capture
        WHERE server_id = ? AND started_at < ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(serverId, deployedAt) as { season_id: number } | undefined;
  const after = db
    .prepare(
      `SELECT season_id FROM capture
        WHERE server_id = ? AND started_at >= ?
        ORDER BY started_at ASC LIMIT 1`,
    )
    .get(serverId, deployedAt) as { season_id: number } | undefined;

  if (before === undefined) {
    return { ok: false, reason: 'there is no capture from before the deploy, so there is nothing to compare against' };
  }
  if (after === undefined) {
    return {
      ok: false,
      reason: 'there is no capture from after the deploy yet. Validation needs data from both sides.',
    };
  }
  if (before.season_id !== after.season_id) {
    return {
      ok: false,
      reason:
        'the deploy coincides with a season change -- a world reset, a modpack change or a different ' +
        'machine. Before and after are different environments, so any difference would measure that ' +
        'change rather than the patch. Deploy patches separately from resets and rotations to be able ' +
        'to measure them.',
    };
  }
  return { ok: true, seasonId: before.season_id, reason: 'before and after share one season' };
}
