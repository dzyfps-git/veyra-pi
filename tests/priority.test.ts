import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { prioritise, ownModMatcher, OUTLOOKS } from '../src/analysis/priority.ts';

const strong = { samples: 50_000, persistence: 1 };

describe('fix outlook: from facts, never from a guess', () => {
  test('only an earlier investigation can say "needed"', () => {
    assert.equal(prioritise({ ...strong, msPerTick: 2, verdicts: ['necessary'] }).outlook, 'checked-needed');
    // A detector suggesting the work is necessary is not a conclusion.
    assert.notEqual(prioritise({ ...strong, msPerTick: 2, feasibility: 'unlikely' }).outlook, 'checked-needed');
  });

  test('a mod anywhere in the call path is named as where to look, not "the game’s own work"', () => {
    const driven = prioritise({ ...strong, msPerTick: 0.5, actionability: 'mod-driven', mod: 'apoli' });
    assert.equal(driven.outlook, 'mod-driven');
    assert.match(driven.outlookWhy, /apoli/);
    assert.equal(prioritise({ ...strong, msPerTick: 0.5, actionability: 'engine' }).outlook, 'game');
  });

  test('your own mods, known fixes and matched patterns come first', () => {
    assert.equal(prioritise({ ...strong, msPerTick: 0.1, mod: 'mymod_compat', ownMod: true }).outlook, 'own-mod');
    assert.equal(prioritise({ ...strong, msPerTick: 0.1, verdicts: ['config-switch'] }).outlook, 'known-fix');
    assert.equal(prioritise({ ...strong, msPerTick: 0.1, feasibility: 'likely' }).outlook, 'pattern');
    assert.equal(prioritise({ ...strong, msPerTick: 0.1, mod: 'somemod' }).outlook, 'mod');
  });

  test('your own mods are recognised by prefix', () => {
    const own = ownModMatcher('mymod, myprefix');
    assert.equal(own('mymod_compat'), true);
    assert.equal(own('MyPrefix-tools'), true);
    assert.equal(own('apoli'), false);
    assert.equal(own(null), false);
  });
});

describe('best chance to win MSPT back', () => {
  test('a small fixable cost outranks a large one found necessary', () => {
    const smallFixable = prioritise({ ...strong, msPerTick: 0.15, feasibility: 'likely' });
    const largeNecessary = prioritise({ ...strong, msPerTick: 5.0, verdicts: ['necessary'] });
    assert.ok(smallFixable.winBack > largeNecessary.winBack);
    assert.equal(largeNecessary.top, false, 'kept, but not flagged');
  });

  test('unchecked mod code is never buried below the game’s own work of the same size', () => {
    const mod = prioritise({ ...strong, msPerTick: 0.5, mod: 'x' });
    const game = prioritise({ ...strong, msPerTick: 0.5, actionability: 'engine' });
    assert.ok(mod.winBack > game.winBack);
    // ...but a big enough cost in the game's own work still ranks.
    assert.ok(prioritise({ ...strong, msPerTick: 4, actionability: 'engine' }).winBack > mod.winBack);
  });

  test('thin evidence counts for less and is never "worth a look now"', () => {
    const thin = prioritise({ msPerTick: 10, persistence: 1, samples: 12, verdicts: ['fixed-here'] });
    assert.equal(thin.confidence, 'thin');
    assert.equal(thin.top, false);
    assert.match(thin.rationale.join(' '), /provisional/i);
    assert.ok(prioritise({ msPerTick: 1, persistence: 1, samples: 100_000 }).winBack > prioritise({ msPerTick: 1, persistence: 1, samples: 40 }).winBack);
  });

  test('high gameplay risk ranks a finding down; unknown risk is neutral', () => {
    const safe = prioritise({ ...strong, msPerTick: 2, risk: 'low' });
    const risky = prioritise({ ...strong, msPerTick: 2, risk: 'high' });
    const unknown = prioritise({ ...strong, msPerTick: 2 });
    assert.ok(risky.winBack < safe.winBack);
    assert.equal(unknown.winBack, safe.winBack);
  });
});

describe('legibility', () => {
  test('small constant costs are expressed as seconds per day', () => {
    const r = prioritise({ ...strong, msPerTick: 0.05 });
    assert.ok(Math.abs(r.secondsPerDay - 86.4) < 0.5);
    assert.match(r.rationale.join(' '), /tick time a day/);
  });

  test('every outlook has a label and a reason', () => {
    for (const outlook of Object.keys(OUTLOOKS)) assert.ok(OUTLOOKS[outlook as keyof typeof OUTLOOKS].label.length > 0);
    assert.ok(prioritise({ ...strong, msPerTick: 1 }).outlookWhy.length > 0);
  });
});
