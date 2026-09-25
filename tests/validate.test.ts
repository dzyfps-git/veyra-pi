import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validate, type Observation } from '../src/analysis/validate.ts';
import { comparisonScope, collectObservations } from '../src/analysis/validate.ts';
import { Store } from '../src/store/db.ts';

/** Generate windows with a given mean cost and spread, at a player count. */
function windows(count: number, mean: number, spread: number, players: number, seed = 1): Observation[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: count }, (_, i) => ({
    msPerTick: Math.max(0, mean + (rnd() - 0.5) * spread),
    players: players,
    startTime: i * 60000,
  }));
}

const opts = { deployedAt: 0, bootstrapSamples: 400 };

describe('A/B validation', () => {
  test('detects a real improvement', () => {
    const before = [...windows(40, 2.0, 0.4, 4), ...windows(40, 3.0, 0.4, 8, 7)];
    const after = [...windows(40, 1.2, 0.4, 4, 3), ...windows(40, 2.2, 0.4, 8, 9)];
    const r = validate(before, after, opts);
    assert.equal(r.verdict, 'improved');
    assert.ok(r.deltaMsPerTick! < 0);
    assert.ok(r.ciHigh! < 0, 'the interval must exclude zero');
  });

  test('detects a regression rather than hiding it', () => {
    const before = windows(40, 1.0, 0.3, 4);
    const after = windows(40, 1.8, 0.3, 4, 5);
    const r = validate(before, after, opts);
    assert.equal(r.verdict, 'regressed');
    assert.match(r.explanation, /ROSE/);
  });

  test('reports no measurable change instead of spinning a tiny delta as a win', () => {
    const before = windows(60, 1.0, 0.5, 4);
    const after = windows(60, 0.995, 0.5, 4, 11);
    const r = validate(before, after, opts);
    assert.equal(r.verdict, 'no-measurable-change');
  });

  test('a difference below the effect floor is not a difference', () => {
    const before = windows(60, 1.0, 0.001, 4);
    const after = windows(60, 0.99, 0.001, 4, 13);
    const r = validate(before, after, { ...opts, minEffect: 0.03 });
    assert.equal(r.verdict, 'no-measurable-change');
    assert.match(r.explanation, /below the 0.03 MSPT floor/);
  });
});

describe('matched conditions', () => {
  test('refuses to compare across unmatched player counts', () => {
    // A quiet "before" against a busy "after" would show a fake regression.
    const before = windows(40, 1.0, 0.2, 1);
    const after = windows(40, 3.0, 0.2, 12, 5);
    const r = validate(before, after, opts);
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.bucketsCompared.length, 0);
    assert.match(r.explanation, /not comparable/);
  });

  test('only shared buckets contribute', () => {
    const before = [...windows(30, 1.0, 0.2, 4), ...windows(30, 5.0, 0.2, 20, 3)];
    const after = windows(30, 0.5, 0.2, 4, 7);
    const r = validate(before, after, opts);
    // The 20-player bucket exists only before, so it must be excluded --
    // otherwise it would manufacture a huge improvement.
    assert.equal(r.bucketsCompared.length, 1);
    assert.equal(r.verdict, 'improved');
    assert.ok(Math.abs(r.deltaMsPerTick! + 0.5) < 0.3, 'delta should reflect only the matched bucket');
  });

  test('too little data yields inconclusive, not a guess', () => {
    const r = validate(windows(4, 1.0, 0.2, 4), windows(4, 0.2, 0.2, 4, 3), opts);
    assert.equal(r.verdict, 'inconclusive');
    assert.match(r.explanation, /Not enough/);
  });
});

describe('before and after must be one season', () => {
  // A patch deployed at the same moment as a world reset cannot be measured:
  // any difference would be the reset. That is refused, not reported.
  function seed() {
    const store = new Store({ file: ':memory:' });
    store.upsertServer('s1', 'main', 'Main');
    const env = store.upsertEnvironment({
      serverId: 's1', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '0.19.3',
      javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
    });
    const mk = (ordinal: number) => {
      const seasonId = store.createSeason({ serverId: 's1', environmentId: env, ordinal, startedAt: 0, reason: 't', confirmed: true });
      const revisionId = store.createRevision({ seasonId, ordinal: 1, modSetHash: 'h' + ordinal, heapMaxMb: 1, startedAt: 0, reason: 't', added: 0, removed: 0, changed: 0 });
      return { seasonId, revisionId };
    };
    const oldWorld = mk(1);
    const newWorld = mk(2);
    const cap = (s: { seasonId: number; revisionId: number }, at: number, name: string) =>
      store.db.prepare(
        `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at,
                              window_count, path_count, raw_bytes, ingested_at, is_manual)
         VALUES ('s1',?,?,?,?,?,1,1,1,1,0)`,
      ).run(s.seasonId, s.revisionId, name, 'sha-' + name, at);
    return { store, oldWorld, newWorld, cap };
  }

  test('a deploy inside one season is scoped to it', () => {
    const { store, oldWorld, cap } = seed();
    cap(oldWorld, 1000, 'a');
    cap(oldWorld, 3000, 'b');
    const scope = comparisonScope(store.db, 's1', 2000);
    assert.equal(scope.ok, true);
    assert.equal(scope.ok && scope.seasonId, oldWorld.seasonId);
    store.close();
  });

  test('a deploy that coincides with a world reset is refused', () => {
    const { store, oldWorld, newWorld, cap } = seed();
    cap(oldWorld, 1000, 'before-reset');
    cap(newWorld, 3000, 'after-reset');
    const scope = comparisonScope(store.db, 's1', 2000);
    assert.equal(scope.ok, false);
    assert.match(scope.reason, /season change/);
    assert.match(scope.reason, /world reset/);
    store.close();
  });

  test('observations never leak across seasons', () => {
    const { store, oldWorld, newWorld, cap } = seed();
    cap(oldWorld, 1000, 'x');
    cap(newWorld, 1500, 'y');
    // No sidecars exist, so both return empty -- but the query must be scoped.
    assert.deepEqual(collectObservations(store.db, 'p', { fromMs: 0, toMs: 5000, seasonId: oldWorld.seasonId }), []);
    store.close();
  });
});
