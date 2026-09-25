/**
 * Ledger query behaviour.
 *
 * Two of these guard a bug that was live: the ledger summed `path_daily`
 * across every season at once, so the Windows test box (safepoint-biased
 * ThreadMXBean sampler) and Linux production (async-profiler) were averaged
 * into a single ms/tick figure. Their capture ranges overlap in time, so this
 * was not a longer history of one thing — it was a blend of two incomparable
 * ones, which is exactly what the design says never to do.
 *
 * The rest pin the search rewrite, which resolves matching frames before
 * joining rather than testing LIKE on every row of the season.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';
import * as q from '../src/query/queries.ts';

let store: Store;
let linuxSeason: number;
let windowsSeason: number;

/** One ledger row, plus the rollup entry ingest would have maintained. */
function record(input: {
  seasonId: number;
  day: string;
  label: string;
  sourceMod: string | null;
  selfMs: number;
  ticks: number;
  windowsPresent?: number;
  windowsTotal?: number;
}): number {
  const [className, methodName] = [
    input.label.slice(0, input.label.lastIndexOf('.')),
    input.label.slice(input.label.lastIndexOf('.') + 1),
  ];
  const frameId = store.internFrame(input.label, className!, methodName!);
  const pathId = store.internPathEdge({
    parentId: 0,
    frameId,
    depth: 0,
    source: input.sourceMod,
    seenAt: 1,
  });

  const present = input.windowsPresent ?? 10;
  const total = input.windowsTotal ?? 10;

  store.db
    .prepare(
      `INSERT INTO path_daily
         (day, server_id, season_id, path_id, activity, self_ms, total_ms, ticks,
          windows_present, windows_total, captures_present, category)
       VALUES (?,?,?,?,'playing',?,?,?,?,?,1,'work')
       ON CONFLICT(day, season_id, path_id, activity) DO UPDATE SET
         self_ms = self_ms + excluded.self_ms, ticks = ticks + excluded.ticks`,
    )
    .run(
      input.day,
      's1',
      input.seasonId,
      pathId,
      input.selfMs,
      input.selfMs,
      input.ticks,
      present,
      total,
    );
  return pathId;
}

beforeEach(() => {
  store = new Store({ file: ':memory:' });
  store.upsertServer('s1', 'main', 'Main');

  const env = (envKey: string, osName: string, seenAt: number): number =>
    store.upsertEnvironment({
      serverId: 's1',
      envKey,
      mcVersion: '1.20.1',
      loaderName: 'Fabric',
      loaderVersion: '0.19.3',
      javaMajor: '17',
      cpuModel: 'test',
      cpuThreads: 8,
      osName,
      seenAt,
    });

  const season = (environmentId: number, startedAt: number): number =>
    store.createSeason({
      serverId: 's1',
      environmentId,
      ordinal: 1,
      startedAt,
      reason: 'test',
      confirmed: true,
    });

  windowsSeason = season(env('win', 'Windows 11', 1_000), 1_000);
  linuxSeason = season(env('linux', 'Ubuntu 26.04.1 LTS', 2_000), 2_000);

  // The same method, costing wildly different amounts on the two machines.
  record({ seasonId: windowsSeason, day: '2026-09-01', label: 'a.b.Slow.tick', sourceMod: 'mymod', selfMs: 900, ticks: 100 });
  record({ seasonId: linuxSeason, day: '2026-09-02', label: 'a.b.Slow.tick', sourceMod: 'mymod', selfMs: 100, ticks: 100 });
  // Something only production ever saw.
  record({ seasonId: linuxSeason, day: '2026-09-02', label: 'c.d.LinuxOnly.run', sourceMod: 'other', selfMs: 50, ticks: 100 });

  store.rebuildRollup();

  // A capture per season so `latestSeasonId` has something to point at.
  // The Linux one is newer, so it is the default view.
  for (const [seasonId, startedAt] of [
    [windowsSeason, 1_500],
    [linuxSeason, 2_500],
  ] as const) {
    const revisionId = store.createRevision({
      seasonId,
      ordinal: 1,
      modSetHash: `hash-${seasonId}`,
      heapMaxMb: undefined,
      startedAt,
      reason: 'test',
      added: 0,
      removed: 0,
      changed: 0,
    });
    store.db
      .prepare(
        `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256,
                              started_at, window_count, path_count, raw_bytes, ingested_at, is_manual)
         VALUES (?,?,?,?,?,?,1,1,1,1,0)`,
      )
      .run('s1', seasonId, revisionId, `cap-${seasonId}`, `sha-${seasonId}`, startedAt);
  }
});

describe('the ledger never pools seasons', () => {
  test('defaults to the season holding the most recent capture', () => {
    assert.equal(q.latestSeasonId(store.db), linuxSeason);
    const rows = q.ledger(store.db);
    const slow = rows.find((r) => r.label === 'a.b.Slow.tick');
    assert.ok(slow, 'the path should be present');
    // 100 ms over 100 ticks on Linux. Pooling would give (900+100)/200 = 5.
    assert.equal(slow.self_ms_per_tick, 1);
  });

  test('an explicit season shows only that season', () => {
    const rows = q.ledger(store.db, { seasonId: windowsSeason });
    const slow = rows.find((r) => r.label === 'a.b.Slow.tick');
    assert.equal(slow?.self_ms_per_tick, 9);
    assert.equal(
      rows.find((r) => r.label === 'c.d.LinuxOnly.run'),
      undefined,
      'a path from another season must not leak in',
    );
  });

  test('no combination of arguments pools the two', () => {
    // The union of both seasons read separately is the whole ledger; there is
    // no single call that averages them, which is the point.
    const both = [windowsSeason, linuxSeason].flatMap((id) => q.ledger(store.db, { seasonId: id }));
    assert.equal(both.filter((r) => r.label === 'a.b.Slow.tick').length, 2);
    for (const row of both) {
      assert.ok(row.self_ms_per_tick === 9 || row.self_ms_per_tick === 1 || row.self_ms_per_tick === 0.5);
    }
  });

  test('every season stays queryable, so nothing is lost by scoping', () => {
    const options = q.seasonOptions(store.db);
    assert.equal(options.length, 2);
    assert.deepEqual(
      options.map((o) => o.os_name).sort(),
      ['Ubuntu 26.04.1 LTS', 'Windows 11'],
    );
    assert.equal(options[0]!.id, linuxSeason, 'most recently active first');
  });
});

describe('search', () => {
  /** The predicate the rewrite replaced, run directly, as the oracle. */
  function naive(search: string, seasonId: number): number[] {
    return (
      store.db
        .prepare(
          `SELECT r.path_id FROM path_rollup r
             JOIN path p  ON p.id = r.path_id
             JOIN frame f ON f.id = p.frame_id
            WHERE r.season_id = ? AND r.ticks > 0 AND r.activity = 'playing'
              AND (f.label LIKE ? OR p.source_mod LIKE ?)
            ORDER BY r.ms_per_tick DESC`,
        )
        .all(seasonId, `%${search}%`, `%${search}%`) as Array<{ path_id: number }>
    ).map((r) => r.path_id);
  }

  for (const term of ['Slow', 'mymod', 'a.b', 'nothingmatches', 'other']) {
    test(`"${term}" matches the same rows as the direct predicate`, () => {
      assert.deepEqual(
        q.ledger(store.db, { seasonId: linuxSeason, search: term }).map((r) => r.path_id),
        naive(term, linuxSeason),
      );
    });
  }

  test('matches on the mod name as well as the method', () => {
    const rows = q.ledger(store.db, { seasonId: linuxSeason, search: 'mymod' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.label, 'a.b.Slow.tick');
  });
});

describe('filters', () => {
  test('an upper bound surfaces the small costs a profiler buries', () => {
    const rows = q.ledger(store.db, { seasonId: linuxSeason, maxMsPerTick: 0.6 });
    assert.deepEqual(rows.map((r) => r.label), ['c.d.LinuxOnly.run']);
  });

  test('ordering by seconds per day matches ordering by ms per tick', () => {
    // seconds/day is ms/tick times a constant, so these cannot disagree.
    const bySeconds = q.ledger(store.db, { seasonId: linuxSeason, orderBy: 'seconds' });
    const bySelf = q.ledger(store.db, { seasonId: linuxSeason, orderBy: 'self' });
    assert.deepEqual(bySeconds.map((r) => r.path_id), bySelf.map((r) => r.path_id));
  });
});

describe('cost by mod', () => {
  test('counts distinct call paths, not path-days', () => {
    // The same path on three more days must not make the mod look broader.
    for (const day of ['2026-09-03', '2026-09-04', '2026-09-05']) {
      record({ seasonId: linuxSeason, day, label: 'a.b.Slow.tick', sourceMod: 'mymod', selfMs: 100, ticks: 100 });
    }
    store.rebuildRollup();

    const mymod = q.costByMod(store.db, linuxSeason).find((m) => m.source_mod === 'mymod');
    assert.equal(mymod?.paths, 1, 'one path observed on four days is one path');
  });

  test('is scoped to a season like the ledger', () => {
    const linux = q.costByMod(store.db, linuxSeason).find((m) => m.source_mod === 'mymod');
    const windows = q.costByMod(store.db, windowsSeason).find((m) => m.source_mod === 'mymod');
    assert.equal(linux?.self_ms, 100);
    assert.equal(windows?.self_ms, 900);
  });
});

describe('empty archive', () => {
  test('returns nothing rather than throwing when there are no seasons', () => {
    const empty = new Store({ file: ':memory:' });
    empty.upsertServer('s1', 'main', 'Main');
    assert.equal(q.latestSeasonId(empty.db), undefined);
    assert.deepEqual(q.ledger(empty.db), []);
    assert.deepEqual(q.costByMod(empty.db), []);
    empty.close();
  });
});
