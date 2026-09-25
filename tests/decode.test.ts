import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { decodeSparkProfile } from '../src/decode/sparkprofile.ts';
import { aggregateProfile } from '../src/decode/aggregate.ts';
import { loadTinyMappings, mapFrame, NO_MAPPINGS } from '../src/decode/mappings.ts';
import { REAL_ARCHIVE, type HeadlineExpectation } from './fixtures/real-archive.ts';

/**
 * These tests run against a real capture archive, which lives outside the
 * repository (tests/fixtures/real-archive.ts says where). They skip cleanly
 * without it so the suite still passes on a fresh checkout, but they are the
 * ones that actually matter: they pin the headline MSPT figure to values that
 * were derived by hand and used to make real optimization decisions.
 */
const MAPPINGS = REAL_ARCHIVE.mappings ?? '';
const EXPECTATIONS: HeadlineExpectation[] = REAL_ARCHIVE.headline ?? [];

function analyse(file: string) {
  const mappings = MAPPINGS !== '' && existsSync(MAPPINGS) ? loadTinyMappings(MAPPINGS) : NO_MAPPINGS;
  const profile = decodeSparkProfile(readFileSync(file));
  const agg = aggregateProfile(profile, {
    renameFrame: (c, m) => mapFrame(c, m, mappings),
    mappingsAvailable: mappings.available,
  });
  return { profile, agg };
}

describe('headline MSPT reproduces the archive', () => {
  for (const expectation of EXPECTATIONS) {
    const name = expectation.file.split('/').pop() ?? expectation.file;
    test(`${name.slice(0, 24)} -> ${expectation.tickMsPerTick} ms/tick`, (t) => {
      if (!existsSync(expectation.file)) {
        t.skip('capture archive not available');
        return;
      }
      const { agg } = analyse(expectation.file);
      assert.ok(agg.tickMsPerTick !== undefined, 'tick anchor should be found');
      assert.equal(
        Number(agg.tickMsPerTick.toFixed(3)),
        expectation.tickMsPerTick,
        'tick-inclusive ms/tick must match the hand-derived figure',
      );

      if (expectation.idleMsPerTick !== undefined) {
        const ticks = agg.divisorTicks ?? 1;
        const idle = (agg.threads[0]?.idleMs ?? 0) / ticks;
        assert.equal(Number(idle.toFixed(3)), expectation.idleMsPerTick);
      }
    });
  }

  test('wall time is NOT reported as work', (t) => {
    const first = EXPECTATIONS[0];
    if (first === undefined || !existsSync(first.file)) {
      t.skip('capture archive not available');
      return;
    }
    const { agg } = analyse(first.file);
    const thread = agg.threads[0]!;
    const ticks = agg.divisorTicks ?? 1;
    // A healthy server parks out most of its 50 ms budget. If the headline
    // figure ever drifts toward wall time, the idle split has broken.
    assert.ok(thread.totalMs / ticks > 49, 'sanity: wall time is ~50 ms/tick');
    assert.ok(agg.tickMsPerTick! < thread.totalMs / ticks / 2, 'tick time must be far below wall time');
  });
});

describe('nesting discipline', () => {
  // Guards against the class of error where `entrySet()` and its own nested
  // `lambda$entrySet$12` were added together.
  test('self time never exceeds total, and children never exceed their parent', (t) => {
    const first = EXPECTATIONS[0];
    if (first === undefined || !existsSync(first.file)) {
      t.skip('capture archive not available');
      return;
    }
    const { agg } = analyse(first.file);

    const childTotals = new Map<number, number>();
    for (const row of agg.rows) {
      if (row.parentIndex >= 0) {
        childTotals.set(row.parentIndex, (childTotals.get(row.parentIndex) ?? 0) + row.totalMs);
      }
    }

    let checked = 0;
    for (const [index, row] of agg.rows.entries()) {
      assert.ok(row.selfMs >= 0, `selfMs must not be negative at row ${index}`);
      assert.ok(row.selfMs <= row.totalMs + 1e-6, `selfMs must not exceed totalMs at row ${index}`);

      const kids = childTotals.get(index) ?? 0;
      // Allow a small tolerance: sampling assigns whole intervals, so a
      // child can round marginally above its parent.
      assert.ok(
        kids <= row.totalMs * 1.001 + 1,
        `children (${kids}) must not exceed parent total (${row.totalMs}) at ${row.label}`,
      );
      checked += 1;
    }
    assert.ok(checked > 1000, 'expected a substantial tree to check');
  });

  test('a parent and its own descendant are never summed as disjoint work', (t) => {
    const first = EXPECTATIONS[0];
    if (first === undefined || !existsSync(first.file)) {
      t.skip('capture archive not available');
      return;
    }
    const { agg } = analyse(first.file);
    // Summing self time over every row must reconstruct the thread's sampled
    // total. If nested totals were being added instead, this would overshoot.
    const selfSum = agg.rows.reduce((sum, r) => sum + r.selfMs, 0);
    const wall = agg.threads.reduce((sum, t2) => sum + t2.totalMs, 0);
    assert.ok(
      Math.abs(selfSum - wall) / wall < 0.01,
      `sum of self time (${selfSum.toFixed(0)}) should reconstruct wall time (${wall.toFixed(0)})`,
    );
  });
});

describe('degradation without mappings', () => {
  test('park time is reported as unclassified rather than guessed', (t) => {
    const first = EXPECTATIONS[0];
    if (first === undefined || !existsSync(first.file)) {
      t.skip('capture archive not available');
      return;
    }
    const profile = decodeSparkProfile(readFileSync(first.file));
    const agg = aggregateProfile(profile, { mappingsAvailable: false });
    const thread = agg.threads[0]!;

    assert.equal(agg.tickMsPerTick, undefined, 'no tick figure may be invented without mappings');
    assert.equal(thread.idleMs, 0, 'idle must not be claimed without the anchor');
    assert.equal(thread.blockedMs, 0, 'blocked must not be claimed without the anchor');
    assert.ok(thread.unclassifiedWaitMs > 0, 'park time must still be accounted for, just unclassified');
  });
});
