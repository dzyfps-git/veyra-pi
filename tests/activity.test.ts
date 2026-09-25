/**
 * Idle and playing minutes are told apart, never mixed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { activityFilterOf, activityOf, activitySql, similarLoad } from '../src/analysis/activity.ts';

describe('who was on', () => {
  test('zero is idle, one or more is playing, missing is unknown', () => {
    assert.equal(activityOf(0), 'idle');
    assert.equal(activityOf(3), 'playing');
    assert.equal(activityOf(null), 'unknown');
  });
  test('an idle minute is only ever compared with idle minutes', () => {
    assert.equal(similarLoad(0, 0), true);
    assert.equal(similarLoad(0, 1), false, 'one player is play, not idle');
    assert.equal(similarLoad(1, 0), false);
  });
  test('while playing, within one player', () => {
    assert.equal(similarLoad(3, 4), true);
    assert.equal(similarLoad(3, 5), false);
    assert.equal(similarLoad(3, null), false, 'unknown is never a fair comparison');
  });
  test('the filter maps to one SQL condition', () => {
    assert.equal(activitySql('all'), '');
    assert.equal(activitySql('playing'), ' AND players > 0');
    assert.equal(activitySql('idle'), ' AND players = 0');
    assert.equal(activityFilterOf('nonsense'), 'playing', 'play is the default view');
    assert.equal(activityFilterOf('all'), 'all');
  });
});

import { Store } from '../src/store/db.ts';
import { writeLedger, dayKey } from '../src/ingest/ledger.ts';
import { rollupSource } from '../src/query/range.ts';
import { effectiveActivity, hasActivityRollups } from '../src/store/rollups.ts';

describe('the roll-ups keep play and idle apart', () => {
  test('time and ticks go to the minutes they happened in, and All is their sum', () => {
    const store = new Store({ file: ':memory:' });
    assert.equal(hasActivityRollups(store.db), true, 'a new database is split from the start');
    store.upsertServer('s', 'main', 'Main');
    const env = store.upsertEnvironment({ serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1', javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0 });
    const season = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
    const path = (label: string): { frameId: number; pathId: number } => {
      const frameId = store.internFrame(label, 'a.B', label.split('.').pop()!);
      return { frameId, pathId: store.internPathEdge({ parentId: 0, frameId, depth: 0, source: null, seenAt: 0 }) };
    };
    const a = path('a.B.onlyWhilePlaying');
    const b = path('a.B.always');
    writeLedger(store.db, {
      serverId: 's', seasonId: season, day: dayKey(Date.UTC(2026, 8, 23)), ticks: 401, windowsTotal: 4, intervalMs: 10, minWindows: 1, minSamples: 1,
      windowActivity: ['playing', 'playing', 'idle', 'idle'],
      windowTicks: [100, 100, 100, 100],
      rows: [
        { ...a, selfMs: 20, totalMs: 20, category: 'work', present: 2, selfByWindow: [10, 10, 0, 0], totalByWindow: [10, 10, 0, 0] },
        { ...b, selfMs: 4, totalMs: 4, category: 'work', present: 4, selfByWindow: [1, 1, 1, 1], totalByWindow: [1, 1, 1, 1] },
      ],
    });
    const row = (pathId: number, activity: string) =>
      store.db.prepare('SELECT self_ms, ticks, windows_present, windows_total FROM path_rollup WHERE path_id = ? AND activity = ?').get(pathId, activity) as
        { self_ms: number; ticks: number; windows_present: number; windows_total: number };
    assert.deepEqual({ ...row(a.pathId, 'playing') }, { self_ms: 20, ticks: 201, windows_present: 2, windows_total: 2 }, 'the odd tick goes to one side, never lost');
    assert.deepEqual({ ...row(a.pathId, 'idle') }, { self_ms: 0, ticks: 200, windows_present: 0, windows_total: 2 });
    assert.deepEqual({ ...row(a.pathId, 'all') }, { self_ms: 20, ticks: 401, windows_present: 2, windows_total: 4 });
    assert.equal(row(b.pathId, 'playing').self_ms + row(b.pathId, 'idle').self_ms, row(b.pathId, 'all').self_ms);

    // Days: summing activities gives All; one activity reads alone.
    const day = { fromDay: '2026-09-23', toDay: '2026-09-23' };
    const read = (activity: 'all' | 'playing' | 'idle') => {
      const src = rollupSource(store.db, season, day, activity);
      return store.db.prepare(`SELECT sum(self_ms) AS s, sum(ticks) AS t FROM ${src.sql} r WHERE r.path_id = ?`).get(...src.params, b.pathId) as { s: number; t: number };
    };
    assert.deepEqual({ ...read('all') }, { s: 4, t: 401 });
    assert.deepEqual({ ...read('playing') }, { s: 2, t: 201 });
    assert.deepEqual({ ...read('idle') }, { s: 2, t: 200 });
    assert.equal(effectiveActivity(store.db, season, 'playing'), 'playing');
    store.close();
  });
});
