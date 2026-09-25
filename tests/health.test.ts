/**
 * Monitoring health and data coverage.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';
import { recordState, currentState, coverage, coverageWords } from '../src/store/health.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 22, 0);
let store: Store;
let seasonId: number;
let revisionId: number;

function captureWithWindows(name: string, fromMs: number, minutes: number): void {
  store.db
    .prepare(
      `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, ended_at,
                            window_count, path_count, raw_bytes, ingested_at, is_manual)
       VALUES ('s',?,?,?,?,?,?,?,1,1,1,0)`,
    )
    .run(seasonId, revisionId, name, `sha-${name}`, fromMs, fromMs + minutes * 60_000, minutes);
  const id = (store.db.prepare('SELECT id FROM capture WHERE source_name = ?').get(name) as { id: number }).id;
  for (let i = 0; i < minutes; i += 1) {
    store.db
      .prepare('INSERT INTO capture_window (capture_id, window_id, start_time, end_time, ticks) VALUES (?,?,?,?,1200)')
      .run(id, i, fromMs + i * 60_000, fromMs + (i + 1) * 60_000);
  }
}

beforeEach(() => {
  store = new Store({ file: ':memory:' });
  store.upsertServer('s', 'main', 'Main');
  const env = store.upsertEnvironment({
    serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
    javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
  });
  seasonId = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
  revisionId = store.createRevision({
    seasonId, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0, reason: 'r', added: 0, removed: 0, changed: 0,
  });
});

afterEach(() => store.close());

describe('monitoring state', () => {
  test('only changes are recorded', () => {
    assert.equal(recordState(store.db, 's', 'collecting', '', T0), true);
    assert.equal(recordState(store.db, 's', 'collecting', '', T0 + 1000), false);
    assert.equal(recordState(store.db, 's', 'offline', 'no answer', T0 + 2000), true);
    const now = currentState(store.db, 's')!;
    assert.equal(now.state, 'offline');
    assert.equal(now.since, T0 + 2000);
  });
});

describe('coverage', () => {
  test('a fully recorded span is 100%, and overlapping captures do not count twice', () => {
    captureWithWindows('a', T0, 60);
    captureWithWindows('manual', T0 + 10 * 60_000, 5); // a manual profile during background collection
    const c = coverage(store.db, { serverId: 's', fromMs: T0, toMs: T0 + H });
    assert.equal(c.recordedMs, H);
    assert.equal(c.fraction, 1);
    assert.equal(c.gaps.length, 0);
  });

  test('a missing stretch is a gap, explained by what monitoring was doing then', () => {
    recordState(store.db, 's', 'collecting', '', T0 - 1000);
    captureWithWindows('a', T0, 60);
    recordState(store.db, 's', 'offline', 'no answer', T0 + H);
    recordState(store.db, 's', 'collecting', '', T0 + 3 * H);
    captureWithWindows('b', T0 + 3 * H, 60);

    const c = coverage(store.db, { serverId: 's', fromMs: T0, toMs: T0 + 4 * H });
    assert.equal(c.recordedMs, 2 * H);
    assert.equal(c.fraction, 0.5);
    assert.equal(c.gaps.length, 1);
    assert.equal(c.gaps[0]!.fromMs, T0 + H);
    assert.equal(c.gaps[0]!.toMs, T0 + 3 * H);
    assert.match(c.gaps[0]!.reason, /not answering/);
    assert.match(coverageWords(c), /2\.0 h of 4\.0 h recorded \(50%\)/);
  });

  test('a gap from before states were recorded says so instead of guessing', () => {
    captureWithWindows('late', T0 + 2 * H, 60);
    const c = coverage(store.db, { serverId: 's', fromMs: T0, toMs: T0 + 3 * H });
    assert.match(c.gaps[0]!.reason, /no record/);
  });

  test('short gaps between harvests are not listed, but are still unrecorded time', () => {
    captureWithWindows('a', T0, 58);
    captureWithWindows('b', T0 + H, 60);
    const c = coverage(store.db, { serverId: 's', fromMs: T0, toMs: T0 + 2 * H });
    assert.equal(c.gaps.length, 0);
    assert.equal(c.recordedMs, 118 * 60_000);
  });
});
