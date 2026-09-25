/**
 * The knowledge base and the legacy import.
 *
 * The rule under test throughout: prior work is evidence, never proof. A
 * knowledge entry can raise feasibility to `likely`; nothing in this file may
 * produce `proven`, and nothing imported from a markdown file may reach a
 * measured status, because this system did not do the measuring.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { KNOWLEDGE, lookupKnowledge, matchRegister, outcomeText } from '../src/analysis/knowledge.ts';

/** Every entry's own mod at the exact version it was measured on. */
const MEASURED = new Map(KNOWLEDGE.map((k) => [k.mod, k.modVersion]));
import { mixinOwner } from '../src/analysis/findings.ts';
import { Register } from '../src/analysis/register.ts';
import { importLegacy, parseLeaderboard, parseIndex, parseMspt } from '../src/ingest/legacy.ts';

describe('knowledge base integrity', () => {
  test('no entry can claim a new observation is proven', () => {
    for (const entry of KNOWLEDGE) {
      assert.notEqual(
        entry.suggests as string,
        'proven',
        `${entry.id} claims proof; prior work on another mod version is evidence, not proof`,
      );
    }
  });

  test('every entry names how to confirm it is the same problem', () => {
    for (const entry of KNOWLEDGE) {
      assert.ok(entry.confirmBy.length > 20, `${entry.id} has no usable confirmation step`);
      assert.ok(entry.resolution.length > 20, `${entry.id} does not say what was done`);
    }
  });

  test('ids are unique', () => {
    const ids = KNOWLEDGE.map((k) => k.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every outcome renders', () => {
    for (const entry of KNOWLEDGE) assert.ok(outcomeText(entry.outcome).length > 0);
  });
});

describe('matching real frame labels', () => {
  // These are labels taken from the actual archive. A knowledge base that
  // does not match the strings the decoder produces is decoration.
  const cases: Array<[string, string | null, string]> = [
    ['noobanidus.mods.lootr.ticker.TileTicker.onServerTick', 'lootr', 'lootr-tileticker'],
    ['net.minecraft.server.world.ServerWorld.handler$gfk000$openpartiesandclaims$onIsNaturalSpawningAllowed', null, 'opac-spawn-permission'],
    ['net.minecraft.world.SpawnHelper.wrapOperation$jlb000$the_bumblezone$bumblezone$onEntitySpawn', null, 'bumblezone-spawn-event'],
    ['net.minecraft.world.World.handler$cap000$blockswap$isIncompatibleBlock', null, 'blockswap-retrogen'],
  ];

  for (const [label, mod, expected] of cases) {
    test(`${label.split('.').pop()} matches ${expected}`, () => {
      const hits = lookupKnowledge(label, mod, 1, MEASURED);
      assert.ok(
        hits.some((h) => h.entry.id === expected),
        `expected ${expected}, got ${hits.map((h) => h.entry.id).join(', ') || 'nothing'}`,
      );
    });
  }

  test('an unrelated frame matches nothing', () => {
    assert.deepEqual(lookupKnowledge('com.example.Totally.unrelated', null, 1, MEASURED), []);
  });

  test('the mod filter does not reject an unattributed frame', () => {
    // Attribution is frequently missing. Refusing to match on that basis
    // would disable the knowledge base exactly when it is most needed.
    const hits = lookupKnowledge('noobanidus.mods.lootr.ticker.TileTicker.onServerTick', null, 1, MEASURED);
    assert.ok(hits.some((h) => h.entry.id === 'lootr-tileticker'));
  });

  test('the mod filter does reject a different attributed mod', () => {
    const hits = lookupKnowledge('noobanidus.mods.lootr.ticker.TileTicker.onServerTick', 'lithium', 1, MEASURED);
    assert.ok(!hits.some((h) => h.entry.id === 'lootr-tileticker'));
  });
});

describe('only on the version it was measured on', () => {
  const label = 'noobanidus.mods.lootr.ticker.TileTicker.onServerTick';
  test('every entry names its mod and exact version', () => {
    for (const entry of KNOWLEDGE) {
      assert.ok(entry.mod.length > 0 && entry.modVersion.length > 0, `${entry.id} needs a mod and version`);
    }
  });
  test('the measured version matches', () => {
    assert.equal(lookupKnowledge(label, null, 1, new Map([['lootr', '0.7.35.86']])).length, 1);
  });
  test('a newer or older version does not: it may have been fixed', () => {
    assert.deepEqual(lookupKnowledge(label, null, 1, new Map([['lootr', '0.7.35.87']])), []);
    assert.deepEqual(lookupKnowledge(label, null, 1, new Map([['lootr', '0.7.34.0']])), []);
  });
  test('a mod that is not installed does not', () => {
    assert.deepEqual(lookupKnowledge(label, null, 1, new Map()), []);
  });
});

describe('comparison against the last measurement', () => {
  const label = 'noobanidus.mods.lootr.ticker.TileTicker.onServerTick';
  // The entry records 0.5 ms/tick.
  test('a much smaller cost reads as lower', () => {
    assert.equal(lookupKnowledge(label, null, 0.002, MEASURED)[0]!.comparison, 'lower');
  });
  test('a comparable cost reads as similar', () => {
    assert.equal(lookupKnowledge(label, null, 0.5, MEASURED)[0]!.comparison, 'similar');
  });
  test('a much larger cost reads as higher', () => {
    assert.equal(lookupKnowledge(label, null, 6, MEASURED)[0]!.comparison, 'higher');
  });
});

describe('mixin owner extraction', () => {
  test('recovers the mod from an injected handler', () => {
    assert.equal(mixinOwner('handler$zfc000$aaa_particles$fixDfuCrash'), 'aaa_particles');
    assert.equal(mixinOwner('wrapOperation$jlb000$the_bumblezone$bumblezone$onEntitySpawn'), 'the_bumblezone');
    assert.equal(mixinOwner('redirect$abc123$lithium$something'), 'lithium');
  });

  test('returns null rather than guessing on an ordinary method', () => {
    assert.equal(mixinOwner('entrySet'), null);
    assert.equal(mixinOwner('trigger'), null);
    assert.equal(mixinOwner('lambda$entrySet$12'), null);
    assert.equal(mixinOwner('handler$notquiteright'), null);
  });
});

describe('parsing the hand-written leaderboard', () => {
  test('reads a cost cell', () => {
    assert.equal(parseMspt('2.03 MSPT in `aBcDeF1234`; 5.30 MSPT mean'), 2.03);
    assert.equal(parseMspt('0.51–0.67 MSPT when active'), 0.51);
    assert.equal(parseMspt('**Completed:** 0.00217 MSPT live'), 0.00217);
    assert.equal(parseMspt('negligible steady average'), undefined);
  });

  test('reads the priority table and the thresholds', () => {
    const md = [
      '# Leaderboard',
      '',
      '## Current priority',
      '',
      '| Rank | Target | Current | Worst | Priority | Why |',
      '|---:|---|---:|---:|---|---|',
      '| 1 | `Foo.bar` cache | 2.03 MSPT | 6.96 MSPT | P0 | Largest waste. |',
      '| 2 | `Baz.qux` | **Completed:** 0.002 MSPT | 0.01 MSPT | COMPLETE | Done. |',
      '',
      '## Watch thresholds',
      '',
      '| Metric | Normal | Watch | Bad |',
      '|---|---:|---:|---:|',
      '| Median MSPT | below 25 | 30-35 | above 40 |',
      '',
    ].join('\n');

    const { entries, thresholds } = parseLeaderboard(md);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.priority, 'P0');
    assert.equal(thresholds.length, 1);
    assert.equal(thresholds[0]!.metric, 'Median MSPT');
  });

  test('reads the capture index', () => {
    const md = [
      '# Profile index',
      '',
      '| Received | Profile | Capture | Result | Report |',
      '|---|---|---|---|---|',
      '| 2026-08-19 12:27 EDT | `4 player` | 10 min | Healthy | [analysis](a/analysis.md) |',
      '',
    ].join('\n');
    const rows = parseIndex(md);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.profile, '4 player');
    assert.equal(rows[0]!.reportLink, 'a/analysis.md');
  });
});

describe('importing into the register', () => {
  function fixture(): { store: Store; file: string } {
    const store = new Store({ file: ':memory:' });
    store.upsertServer('s1', 'main', 'Main');
    const dir = mkdtempSync(path.join(tmpdir(), 'perfint-legacy-'));
    const file = path.join(dir, 'PATCH_LEADERBOARD.md');
    writeFileSync(
      file,
      [
        '## Current priority',
        '',
        '| Rank | Target | Current | Worst | Priority | Why |',
        '|---:|---|---:|---:|---|---|',
        '| 1 | Inventory criterion dedupe | 2.03 MSPT | 6.96 MSPT | P0 | Largest waste. |',
        '| 2 | TCLayer entrySet cache | **Completed:** 0.002 MSPT | 0.01 MSPT | COMPLETE | Shipped. |',
        '| 3 | Something to look at | 1.11 MSPT | 1.77 MSPT | Investigate | Unclear owner. |',
        '',
      ].join('\n'),
      'utf8',
    );
    return { store, file };
  }

  test('a dry run writes nothing', () => {
    const { store, file } = fixture();
    const result = importLegacy(store.db, { leaderboardPath: file, serverId: 's1', dryRun: true });
    assert.equal(result.created, 3);
    assert.equal(new Register(store.db).list().length, 0);
    store.close();
  });

  test('applying creates one entry per row', () => {
    const { store, file } = fixture();
    importLegacy(store.db, { leaderboardPath: file, serverId: 's1' });
    assert.equal(new Register(store.db).list().length, 3);
    store.close();
  });

  test('a completed row becomes implemented, NEVER measured', () => {
    const { store, file } = fixture();
    importLegacy(store.db, { leaderboardPath: file, serverId: 's1' });
    const done = new Register(store.db).list().find((o) => o.title.includes('TCLayer'));
    assert.equal(done?.status, 'implemented', 'imported evidence is not a measurement this system made');
    assert.equal(done?.verdict, null);
    store.close();
  });

  test('imported entries are marked as imported forever', () => {
    const { store, file } = fixture();
    importLegacy(store.db, { leaderboardPath: file, serverId: 's1' });
    for (const entry of new Register(store.db).list()) {
      assert.match(entry.notes ?? '', /^imported:/m);
    }
    store.close();
  });

  test('re-importing does not duplicate', () => {
    const { store, file } = fixture();
    importLegacy(store.db, { leaderboardPath: file, serverId: 's1' });
    const second = importLegacy(store.db, { leaderboardPath: file, serverId: 's1' });
    assert.equal(second.created, 0);
    assert.equal(second.alreadyPresent, 3);
    assert.equal(new Register(store.db).list().length, 3);
    store.close();
  });

  test('a missing file is reported rather than thrown', () => {
    const store = new Store({ file: ':memory:' });
    store.upsertServer('s1', 'main', 'Main');
    const result = importLegacy(store.db, { leaderboardPath: 'does/not/exist.md', serverId: 's1' });
    assert.equal(result.created, 0);
    assert.match(result.warnings[0]!, /not found/);
    store.close();
  });
});

describe('register matching', () => {
  test('finds an entry tracking the same target', () => {
    const store = new Store({ file: ':memory:' });
    store.upsertServer('s1', 'main', 'Main');
    const reg = new Register(store.db);
    reg.create({ serverId: 's1', title: 'Cache it', targetLabel: 'a.b.C.d' });

    assert.equal(matchRegister(store.db, 'a.b.C.d').length, 1);
    assert.equal(matchRegister(store.db, 'a.b.C.other').length, 0, 'matching must be exact, not fuzzy');
    store.close();
  });
});

describe('comparisons are qualified, not presented as measurements', () => {
  test('every entry with a figure records what it was measured under', () => {
    // Without this, "higher than last time" is the same cross-sampler,
    // cross-player-count comparison the rest of the system refuses to make.
    for (const entry of KNOWLEDGE) {
      if (entry.lastMsPerTick === undefined) continue;
      assert.ok(
        entry.measuredUnder !== undefined && entry.measuredUnder.length > 10,
        `${entry.id} carries a figure with no measurement context`,
      );
    }
  });

  test('a comparison always comes with a caveat', () => {
    const hit = lookupKnowledge('noobanidus.mods.lootr.ticker.TileTicker.onServerTick', null, 6, MEASURED)[0]!;
    assert.equal(hit.comparison, 'higher');
    assert.match(hit.caveat!, /not an earlier point on this series/);
    assert.match(hit.caveat!, /A\/B validator/);
  });

  test('no comparison means no caveat to make', () => {
    const noFigure = KNOWLEDGE.find((k) => k.lastMsPerTick === undefined);
    assert.ok(noFigure, 'expected at least one entry without a recorded figure');
    const hit = lookupKnowledge('java.lang.Throwable.fillInStackTrace', null, 1, MEASURED).find(
      (h) => h.entry.lastMsPerTick === undefined,
    );
    assert.equal(hit?.comparison, 'unknown');
    assert.equal(hit?.caveat, undefined);
  });
});
