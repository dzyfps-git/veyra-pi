/**
 * Patch confidence: a verdict always comes with its reasons.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assessConfidence } from '../src/analysis/confidence.ts';
import type { ValidationResult } from '../src/analysis/validate.ts';
import type { Coverage } from '../src/store/health.ts';

const full: Coverage = { spanMs: 1, recordedMs: 1, fraction: 1, gaps: [] };
const thin: Coverage = { spanMs: 10, recordedMs: 3, fraction: 0.3, gaps: [] };
const base = (over: Partial<ValidationResult>): ValidationResult => ({
  verdict: 'improved', deltaMsPerTick: -0.2, ciLow: -0.3, ciHigh: -0.1, beforeMedian: 0.5, afterMedian: 0.3,
  beforeWindows: 60, afterWindows: 60, bucketsCompared: [1, 2], explanation: '', ...over,
});
const gate = { minWindows: 10, minEffect: 0.03, before: full, after: full };

describe('confidence', () => {
  test('everything strong: a verified improvement', () => {
    const c = assessConfidence(base({}), gate);
    assert.equal(c.level, 'verified');
    assert.ok(c.checks.every((x) => x.ok));
  });

  test('the same numbers over a thinly recorded span are only "likely", and say why', () => {
    const c = assessConfidence(base({}), { ...gate, after: thin });
    assert.equal(c.level, 'likely');
    assert.ok(c.checks.some((x) => !x.ok && /30% of the after span/.test(x.text)));
  });

  test('an interval that reaches into the noise floor is not verified', () => {
    const c = assessConfidence(base({ ciHigh: -0.01 }), gate);
    assert.equal(c.level, 'likely');
    assert.ok(c.checks.some((x) => !x.ok && /floor/.test(x.text)));
  });

  test('too few matched minutes: not enough evidence, with the count', () => {
    const c = assessConfidence(base({ verdict: 'inconclusive', beforeWindows: 4, afterWindows: 60 }), gate);
    assert.equal(c.level, 'not-enough');
    assert.ok(c.checks.some((x) => !x.ok && /4 before/.test(x.text)));
  });

  test('a regression is reported as such, strong or not', () => {
    const c = assessConfidence(base({ verdict: 'regressed', deltaMsPerTick: 0.2, ciLow: 0.1, ciHigh: 0.3 }), gate);
    assert.equal(c.level, 'worse');
    assert.equal(c.strong, true);
  });
});
