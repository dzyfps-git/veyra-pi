/**
 * How sure are we that a patch did what it looks like it did?
 *
 * `validate()` produces the statistics: matched minutes, medians, a
 * bootstrap interval. This turns them into an answer a person can act on,
 * and -- more importantly -- into the reasons behind it, so "not enough
 * evidence yet" always says what is missing.
 *
 *   verified     The effect is larger than the noise floor across its whole
 *                95% interval, backed by enough player-matched minutes on
 *                both sides, with most of both spans actually recorded.
 *   likely       The statistics point one way, but at least one condition is
 *                weak (few minutes, thin coverage, interval touching the
 *                floor). Worth believing provisionally, not recording as fact.
 *   not-enough   No verdict can be drawn yet, and the reasons say why.
 *   no-change    Measured, and the difference is inside the noise.
 *   worse        As `verified`/`likely`, in the wrong direction.
 */

import type { ValidationResult } from './validate.ts';
import type { Coverage } from '../store/health.ts';

export type ConfidenceLevel = 'verified' | 'likely' | 'not-enough' | 'no-change' | 'worse';

export interface Check {
  ok: boolean;
  text: string;
}

export interface Confidence {
  level: ConfidenceLevel;
  /** For "worse": whether the regression is itself well supported. */
  strong: boolean;
  headline: string;
  checks: Check[];
}

export function assessConfidence(
  result: ValidationResult,
  input: { minWindows: number; minEffect: number; before?: Coverage; after?: Coverage },
): Confidence {
  const checks: Check[] = [];
  const enough = result.beforeWindows >= input.minWindows && result.afterWindows >= input.minWindows;
  checks.push({
    ok: enough,
    text: `${result.beforeWindows} before and ${result.afterWindows} after player-matched minutes (at least ${input.minWindows} each needed)`,
  });
  checks.push({
    ok: result.bucketsCompared.length > 0,
    text:
      result.bucketsCompared.length === 0
        ? 'No player count appears on both sides, so nothing like-for-like can be compared'
        : `Compared only at matching player counts (${result.bucketsCompared.length} group${result.bucketsCompared.length === 1 ? '' : 's'} present on both sides)`,
  });
  for (const [side, c] of [['before', input.before], ['after', input.after]] as const) {
    if (c === undefined) continue;
    checks.push({
      ok: c.fraction >= 0.6,
      text: `${Math.round(c.fraction * 100)}% of the ${side} span was recorded${c.fraction >= 0.6 ? '' : ', so it may not represent the whole period'}`,
    });
  }

  const delta = result.deltaMsPerTick;
  const intervalKnown = result.ciLow !== undefined && result.ciHigh !== undefined;
  const excludesZero = intervalKnown && (result.ciHigh! < 0 || result.ciLow! > 0);
  const beyondFloor =
    intervalKnown && (result.ciHigh! <= -input.minEffect || result.ciLow! >= input.minEffect);
  if (intervalKnown) {
    checks.push({
      ok: excludesZero,
      text: excludesZero
        ? 'The 95% interval does not include "no change"'
        : 'The 95% interval includes "no change", so noise could explain the difference',
    });
    checks.push({
      ok: beyondFloor,
      text: beyondFloor
        ? `The whole interval is beyond the ${input.minEffect} MSPT floor for a meaningful change`
        : `Part of the interval is inside the ${input.minEffect} MSPT floor for a meaningful change`,
    });
  }

  const weak = checks.some((c) => !c.ok);
  const size = delta === undefined ? '' : `${Math.abs(delta).toFixed(3)} MSPT`;

  switch (result.verdict) {
    case 'inconclusive':
      return { level: 'not-enough', strong: false, headline: 'Not enough evidence yet', checks };
    case 'no-measurable-change':
      return { level: 'no-change', strong: !weak, headline: 'No measurable change', checks };
    case 'improved':
      return weak
        ? { level: 'likely', strong: false, headline: `Likely improved, by about ${size}`, checks }
        : { level: 'verified', strong: true, headline: `Verified improvement of ${size}`, checks };
    case 'regressed':
      return {
        level: 'worse',
        strong: !weak,
        headline: weak ? `Possibly worse, by about ${size}` : `Verified worse, by ${size}`,
        checks,
      };
    default:
      return { level: 'not-enough', strong: false, headline: 'Not enough evidence yet', checks };
  }
}
