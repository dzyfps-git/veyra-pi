/**
 * Attributing a capture to the world it actually measured.
 *
 * `level.dat` only ever answers "which world is loaded RIGHT NOW". The
 * scenario these tests exist for is concrete and about to happen for real:
 *
 *     14:00  harvest a profile
 *     15:00  reset the world
 *     16:00  ingest the backlog
 *
 * Reading level.dat at ingest would file the 14:00 capture under a world that
 * did not exist when it was taken. The measurements would be real and the
 * attribution would be fiction, which is worse than having no attribution at
 * all — a wrong label propagates silently into every comparison that touches
 * it, while a missing one is visible and answerable.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';

let store: Store;
let oldWorld: number;
let newWorld: number;

const HOUR = 3_600_000;
const T14 = Date.UTC(2026, 8, 22, 14);
const T15 = Date.UTC(2026, 8, 22, 15);
const T16 = Date.UTC(2026, 8, 22, 16);

beforeEach(() => {
  store = new Store({ file: ':memory:' });
  store.upsertServer('s1', 'main', 'Main');
  oldWorld = store.upsertWorld({
    serverId: 's1',
    fingerprint: 'old',
    strength: 'seed',
    seed: '-134980110325893125',
    seenAt: T14,
  });
  newWorld = store.upsertWorld({
    serverId: 's1',
    fingerprint: 'new',
    strength: 'seed',
    seed: '777',
    seenAt: T16,
  });
});

describe('the reset scenario', () => {
  test('a capture from before the reset is NOT attributed to the new world', () => {
    // Readings either side of the capture, then the reset, then the ingest.
    store.recordWorldSighting('s1', oldWorld, T14 - HOUR, 'probe');
    store.recordWorldSighting('s1', oldWorld, T14 + 60_000, 'probe');
    store.recordWorldSighting('s1', newWorld, T16, 'ingest');

    const at = store.worldAt('s1', T14)!;
    assert.equal(at.worldId, oldWorld, 'the capture measured the OLD world');
    assert.equal(at.confident, true);
  });

  test('a capture taken inside the change window is not attributed at all', () => {
    // Last reading of the old world at 14:00, first of the new at 16:00.
    // A capture at 15:00 could be either.
    store.recordWorldSighting('s1', oldWorld, T14, 'probe');
    store.recordWorldSighting('s1', newWorld, T16, 'probe');

    const at = store.worldAt('s1', T15)!;
    assert.equal(at.confident, false, 'this must not be claimed confidently');
    assert.match(at.reason, /changed between/);
  });

  test('a capture after the reset is attributed to the new world', () => {
    store.recordWorldSighting('s1', oldWorld, T14, 'probe');
    store.recordWorldSighting('s1', newWorld, T16, 'probe');

    const at = store.worldAt('s1', T16 + HOUR)!;
    assert.equal(at.worldId, newWorld);
    assert.equal(at.confident, true);
  });

  test('a back-filled capture predating every reading is not confident', () => {
    // Importing an old archive: the world live back then was never observed.
    store.recordWorldSighting('s1', newWorld, T16, 'ingest');
    const at = store.worldAt('s1', T14 - 30 * 24 * HOUR)!;
    assert.equal(at.confident, false);
    assert.match(at.reason, /predates every world reading/);
  });

  test('with no readings at all there is no answer, not a default', () => {
    assert.equal(store.worldAt('s1', T14), undefined);
  });
});

describe('recording sightings', () => {
  test('the same world is not recorded repeatedly within a minute', () => {
    for (let i = 0; i < 20; i += 1) {
      store.recordWorldSighting('s1', oldWorld, T14 + i * 1000, 'probe');
    }
    const rows = store.db.prepare('SELECT count(*) AS n FROM world_sighting').get() as { n: number };
    assert.equal(rows.n, 1, 'a probe every few seconds must not fill the table');
  });

  test('but a change is always recorded immediately', () => {
    store.recordWorldSighting('s1', oldWorld, T14, 'probe');
    store.recordWorldSighting('s1', newWorld, T14 + 1000, 'probe');
    const rows = store.db.prepare('SELECT count(*) AS n FROM world_sighting').get() as { n: number };
    assert.equal(rows.n, 2, 'a different world is a different fact and must be recorded at once');
  });

  test('readings resume after the dedupe window', () => {
    store.recordWorldSighting('s1', oldWorld, T14, 'probe');
    store.recordWorldSighting('s1', oldWorld, T14 + 120_000, 'probe');
    const rows = store.db.prepare('SELECT count(*) AS n FROM world_sighting').get() as { n: number };
    assert.equal(rows.n, 2);
  });
});

describe('stamping a capture', () => {
  test('a world can be attached and detached without inventing one', () => {
    const envId = store.upsertEnvironment({
      serverId: 's1',
      envKey: 'e',
      mcVersion: '1.20.1',
      loaderName: 'Fabric',
      loaderVersion: '0.19.3',
      javaMajor: '17',
      cpuModel: 'x',
      cpuThreads: 8,
      osName: 'Ubuntu',
      seenAt: T14,
    });
    const seasonId = store.createSeason({
      serverId: 's1',
      environmentId: envId,
      ordinal: 1,
      startedAt: T14,
      reason: 'test',
      confirmed: true,
    });
    const revisionId = store.createRevision({
      seasonId,
      ordinal: 1,
      modSetHash: 'h',
      heapMaxMb: 14336,
      startedAt: T14,
      reason: 'test',
      added: 0,
      removed: 0,
      changed: 0,
    });
    store.db
      .prepare(
        `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256,
                              started_at, window_count, path_count, raw_bytes, ingested_at, is_manual)
         VALUES ('s1',?,?,'c','sha',?,1,1,1,1,0)`,
      )
      .run(seasonId, revisionId, T14);
    const captureId = Number(
      (store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id,
    );

    const read = (): number | null =>
      (store.db.prepare('SELECT world_id FROM capture WHERE id = ?').get(captureId) as {
        world_id: number | null;
      }).world_id;

    assert.equal(read(), null, 'a capture starts with no world claimed');
    store.setCaptureWorld(captureId, oldWorld);
    assert.equal(read(), oldWorld);
    store.setCaptureWorld(captureId, undefined);
    assert.equal(read(), null, 'an attribution can be withdrawn');
  });
});
