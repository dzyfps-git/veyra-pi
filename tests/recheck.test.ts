/**
 * Re-checking a known issue after its mod is updated.
 *
 * One season, three versions of lootr in a row. Each capture holds per-minute
 * detail for the TileTicker frame at a known cost, so the outcome of each
 * update is set by the fixture: the first update leaves the cost unchanged,
 * the second removes most of it.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { encodeSidecar } from '../src/store/sidecar.ts';
import { KNOWLEDGE, lookupKnowledge } from '../src/analysis/knowledge.ts';
import { measureRecheck, pendingRechecks, recheckText, saveRecheck, storedRechecks } from '../src/analysis/recheck.ts';

const SERVER = 's';
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const LABEL = 'noobanidus.mods.lootr.ticker.TileTicker.onServerTick';
const GATE = { minEffect: 0.03, minWindowsPerSide: 10, playerBucketSize: 2 };
const LOOTR = KNOWLEDGE.find((e) => e.id === 'lootr-tileticker')!;

let dir: string;
let store: Store;
let season: number;

/** Hourly captures of 6 one-minute windows each, lootr at `version`, TileTicker at `msPerTick` (undefined: not running). */
function period(revisionOrdinal: number, from: number, to: number, version: string, msPerTick: number | undefined): void {
  const revision = store.createRevision({
    seasonId: season, ordinal: revisionOrdinal, modSetHash: version, heapMaxMb: 1, startedAt: from, reason: 'r', added: 0, removed: 0, changed: 1,
  });
  store.db.prepare('INSERT OR IGNORE INTO mod (mod_id, name) VALUES (?, ?)').run('lootr', 'Lootr');
  const modId = (store.db.prepare("SELECT id FROM mod WHERE mod_id = 'lootr'").get() as { id: number }).id;
  for (let at = from; at < to; at += HOUR) {
    const windows = [0, 1, 2, 3, 4, 5];
    const ticks = 1200;
    const perWindow = windows.map(() => (msPerTick ?? 0) * ticks);
    const rows = [
      { path: 'Server thread', label: 'Server thread', source: null, parentIndex: -1, depth: 0, selfMs: 0, totalMs: 60_000 * 6, category: 'work' as const, selfMsByWindow: [], totalMsByWindow: windows.map(() => 60_000) },
      ...(msPerTick === undefined
        ? []
        : [{ path: `Server thread > ${LABEL}`, label: LABEL, source: 'lootr', parentIndex: 0, depth: 1, selfMs: 0, totalMs: perWindow.reduce((a, b) => a + b, 0), category: 'work' as const, selfMsByWindow: [], totalMsByWindow: perWindow }]),
    ];
    const file = path.join(dir, `${at}.sidecar.zst`);
    writeFileSync(file, encodeSidecar(`sha-${at}`, windows, rows));
    const capture = Number(
      store.db
        .prepare(
          `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, ended_at, window_count,
                                path_count, raw_bytes, ingested_at, is_manual, sidecar_path)
           VALUES (?,?,?,?,?,?,?,6,1,1,1,0,?)`,
        )
        .run(SERVER, season, revision, `c${at}`, `sha-${at}`, at, at + 6 * 60_000, file).lastInsertRowid,
    );
    store.db.prepare('INSERT INTO capture_mod (capture_id, mod, version) VALUES (?,?,?)').run(capture, modId, version);
    for (const w of windows) {
      store.db
        .prepare('INSERT INTO capture_window (capture_id, window_id, start_time, end_time, ticks, players) VALUES (?,?,?,?,?,?)')
        .run(capture, w, at + w * 60_000, at + (w + 1) * 60_000, ticks, 4);
    }
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-recheck-'));
  store = new Store({ file: ':memory:' });
  store.upsertServer(SERVER, 'main', 'Main');
  const env = store.upsertEnvironment({
    serverId: SERVER, envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
    javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
  });
  season = store.createSeason({ serverId: SERVER, environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const measureAll = async (now: number): Promise<void> => {
  for (;;) {
    const due = pendingRechecks(store.db).filter((p) => p.readyAt <= now);
    if (due.length === 0) return;
    for (const p of due) saveRecheck(store.db, (await measureRecheck(store.db, p, GATE, (s) => s, undefined, now))!);
  }
};

describe('re-checking a known issue across an update', () => {
  test('waits for three days of the new version, then measures it once', async () => {
    period(1, T0, T0 + 3 * DAY, LOOTR.modVersion, 0.4);
    period(2, T0 + 3 * DAY, T0 + 6 * DAY, '0.7.36', 0.4);
    const [due] = pendingRechecks(store.db);
    assert.equal(due?.to, '0.7.36');
    assert.equal(due?.readyAt, T0 + 6 * DAY);
    await measureAll(T0 + 6 * DAY);
    assert.deepEqual(pendingRechecks(store.db), []);
    assert.equal(storedRechecks(store.db)[0]?.state, 'still-there');
  });

  test('still there carries the note to the new version, and the next update is checked from it', async () => {
    period(1, T0, T0 + 3 * DAY, LOOTR.modVersion, 0.4);
    period(2, T0 + 3 * DAY, T0 + 6 * DAY, '0.7.36', 0.4);
    period(3, T0 + 6 * DAY, T0 + 9 * DAY, '0.7.37', 0.05);
    await measureAll(T0 + 9 * DAY);
    const results = storedRechecks(store.db);
    assert.deepEqual(results.map((r) => [r.from, r.to, r.state]), [
      [LOOTR.modVersion, '0.7.36', 'still-there'],
      ['0.7.36', '0.7.37', 'lower'],
    ]);
    assert.match(recheckText(results[1]!, (v) => v.toFixed(2)), /^Lower on 0\.7\.37 \(0\.40 → 0\.05 MSPT\)$/);

    const on36 = lookupKnowledge(LABEL, 'lootr', 0.4, new Map([['lootr', '0.7.36']]), results);
    assert.equal(on36.find((k) => k.entry.id === LOOTR.id)?.confirmed?.to, '0.7.36');
    const on37 = lookupKnowledge(LABEL, 'lootr', 0.05, new Map([['lootr', '0.7.37']]), results);
    assert.ok(!on37.some((k) => k.entry.id === LOOTR.id), 'measured lower: the note stops');
  });

  test('a method that no longer runs is "not seen", never "fixed"', async () => {
    period(1, T0, T0 + 3 * DAY, LOOTR.modVersion, 0.4);
    period(2, T0 + 3 * DAY, T0 + 6 * DAY, '0.7.36', undefined);
    await measureAll(T0 + 6 * DAY);
    const [r] = storedRechecks(store.db);
    assert.equal(r?.state, 'not-seen');
    assert.match(r!.explanation, /renamed or moved/);
  });

  test('an update from a version the issue is not known on is not checked', () => {
    period(1, T0, T0 + 3 * DAY, '0.7.30', 0.4);
    period(2, T0 + 3 * DAY, T0 + 6 * DAY, '0.7.31', 0.4);
    assert.deepEqual(pendingRechecks(store.db), []);
  });

  test('no detail before the update is unclear, not a verdict', async () => {
    period(1, T0, T0 + 3 * DAY, LOOTR.modVersion, 0.4);
    period(2, T0 + 3 * DAY, T0 + 6 * DAY, '0.7.36', 0.4);
    store.db.prepare('UPDATE capture SET sidecar_path = NULL WHERE started_at < ?').run(T0 + 3 * DAY);
    await measureAll(T0 + 6 * DAY);
    assert.equal(storedRechecks(store.db)[0]?.state, 'unclear');
    assert.ok(!lookupKnowledge(LABEL, 'lootr', 0.4, new Map([['lootr', '0.7.36']]), storedRechecks(store.db)).some((k) => k.entry.id === LOOTR.id));
  });
});
