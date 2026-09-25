/**
 * The permanent ledger: how captures add up, and rebuilding it.
 *
 * Pins the bug found when day ranges were compared against season totals:
 * the daily ledger took the MAX of a day's ticks while adding its time, so
 * any day with several captures reported an inflated ms/tick.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/store/db.ts';
import { encodeSidecar } from '../src/store/sidecar.ts';
import { writeLedger, rebuildLedger, dayKey, type LedgerRowInput } from '../src/ingest/ledger.ts';
import { ledger } from '../src/query/queries.ts';
import { resolveRange, seasonDayBounds } from '../src/query/range.ts';
import type { PathRow } from '../src/decode/aggregate.ts';

const SERVER = '00000000-0000-0000-0000-000000000001';
const DAY = Date.UTC(2026, 8, 20, 10);

let dir: string;
let store: Store;
let seasonId: number;
let revisionId: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-ledger-'));
  store = new Store({ file: path.join(dir, 'perfint.sqlite') });
  store.upsertServer(SERVER, 'main', 'Main');
  const env = store.upsertEnvironment({
    serverId: SERVER, envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
    javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
  });
  seasonId = store.createSeason({ serverId: SERVER, environmentId: env, ordinal: 1, startedAt: 0, reason: 'first', confirmed: true });
  revisionId = store.createRevision({
    seasonId, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0, reason: 'first', added: 0, removed: 0, changed: 0,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A capture of a two-level tree: root > tick > work, plus a second path that
 * reaches the same `work` method from elsewhere. Writes the sidecar and the
 * ledger the way ingest does.
 */
function capture(name: string, at: number, ticks: number, workMs: number, options: { sidecar?: boolean } = {}): number {
  const rows = [
    { path: 'Server.run', label: 'Server.run', parentIndex: -1, depth: 0, selfMs: 0, totalMs: workMs * 2 },
    { path: 'Server.run > Server.tick', label: 'Server.tick', parentIndex: 0, depth: 1, selfMs: 0, totalMs: workMs * 2 },
    { path: 'Server.run > Server.tick > Mod.work', label: 'Mod.work', parentIndex: 1, depth: 2, selfMs: workMs, totalMs: workMs },
    { path: 'Server.run > Server.tick > Other.call', label: 'Other.call', parentIndex: 1, depth: 2, selfMs: 0, totalMs: workMs },
    { path: 'Server.run > Server.tick > Other.call > Mod.work', label: 'Mod.work', parentIndex: 3, depth: 3, selfMs: workMs, totalMs: workMs },
  ];
  const windows = [at, at + 60_000, at + 120_000];
  const full = rows.map((r) => ({
    ...r,
    source: null,
    category: 'work',
    selfMsByWindow: [r.selfMs / 3, r.selfMs / 3, r.selfMs / 3],
    totalMsByWindow: [r.totalMs / 3, r.totalMs / 3, r.totalMs / 3],
  })) as unknown as PathRow[];

  const sidecarFile = path.join(dir, 'sidecars', `${name}.json.zst`);
  mkdirSync(path.dirname(sidecarFile), { recursive: true });
  if (options.sidecar !== false) writeFileSync(sidecarFile, encodeSidecar(`sha-${name}`, windows, full));

  store.db
    .prepare(
      `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, ended_at,
                            window_count, path_count, raw_bytes, ingested_at, is_manual, divisor_ticks, interval_micros,
                            sidecar_path)
       VALUES (?,?,?,?,?,?,?,3,5,1,1,0,?,10000,?)`,
    )
    .run(SERVER, seasonId, revisionId, name, `sha-${name}`, at, at + 180_000, ticks, store.toStoredPath(sidecarFile));

  const ids: number[] = [];
  const input: LedgerRowInput[] = full.map((r, index) => {
    const frameId = store.internFrame(r.label, r.label.split('.')[0]!, r.label.split('.')[1]!);
    const parentId = r.parentIndex < 0 ? 0 : ids[r.parentIndex]!;
    ids[index] = store.internPathEdge({ parentId, frameId, depth: r.depth, source: null, seenAt: at });
    return { frameId, pathId: ids[index]!, selfMs: r.selfMs, totalMs: r.totalMs, category: 'work', present: 3 };
  });
  writeLedger(store.db, {
    serverId: SERVER, seasonId, day: dayKey(at), ticks, windowsTotal: 3, intervalMs: 10,
    minWindows: 2, minSamples: 2, rows: input,
  });
  return Number((store.db.prepare('SELECT id FROM capture WHERE source_name = ?').get(name) as { id: number }).id);
}

const frameDay = (label: string) =>
  store.db
    .prepare(
      `SELECT d.self_ms, d.ticks, d.captures_present FROM frame_daily d JOIN frame f ON f.id = d.frame_id WHERE f.label = ?`,
    )
    .get(label) as { self_ms: number; ticks: number; captures_present: number };

describe('how captures add up', () => {
  test('two captures on one day: ticks add up, like time', () => {
    capture('a', DAY, 1000, 50);
    capture('b', DAY + 3_600_000, 3000, 150);
    const work = ledger(store.db, { seasonId, search: 'Mod.work', limit: 1 })[0]!;
    // 50 + 150 ms over 1000 + 3000 ticks. MAX(ticks) would have said 200/3000.
    assert.equal(work.self_ms_per_tick, 200 / 4000);
    const day = store.db.prepare('SELECT ticks FROM path_daily WHERE path_id = ?').get(work.path_id) as { ticks: number };
    assert.equal(day.ticks, 4000);
  });

  test('a method reached by two paths counts its ticks once per capture', () => {
    capture('a', DAY, 1000, 50);
    capture('b', DAY + 3_600_000, 3000, 150);
    const work = frameDay('Mod.work');
    assert.equal(work.self_ms, 2 * 50 + 2 * 150, 'both paths contribute time');
    assert.equal(work.ticks, 4000, 'but the capture covered its ticks once');
    assert.equal(work.captures_present, 2, 'and was one capture each time');
  });

  test('a day range covering the whole season equals the season total', () => {
    capture('a', DAY, 1000, 50);
    capture('b', DAY + 3_600_000, 3000, 150);
    capture('c', DAY + 86_400_000, 2000, 10);
    const bounds = seasonDayBounds(store.db, seasonId)!;
    const whole = ledger(store.db, { seasonId });
    const ranged = ledger(store.db, { seasonId, range: bounds });
    assert.deepEqual(
      ranged.map((r) => [r.path_id, r.self_ms_per_tick]),
      whole.map((r) => [r.path_id, r.self_ms_per_tick]),
    );
    const lastDay = ledger(store.db, { seasonId, range: resolveRange(new URLSearchParams({ range: '1d' }), bounds).range! });
    assert.equal(lastDay.find((r) => r.label === 'Mod.work')?.self_ms_per_tick, 10 / 2000);
  });
});

describe('rebuilding from sidecars', () => {
  test('rebuilding a correct ledger changes nothing', () => {
    capture('a', DAY, 1000, 50);
    capture('b', DAY + 3_600_000, 3000, 150);
    const before = store.db.prepare('SELECT * FROM path_daily ORDER BY path_id').all();
    const result = rebuildLedger(store, { minWindows: 2, minSamples: 2 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedDays, []);
    assert.deepEqual(store.db.prepare('SELECT * FROM path_daily ORDER BY path_id').all(), before);
  });

  test('rows left behind by a removed capture are dropped, and reported', () => {
    const id = capture('a', DAY, 1000, 50);
    // What happened by hand once: the capture row was deleted for re-ingest,
    // its ledger rows were not, and it was ingested again.
    store.db.prepare('DELETE FROM capture WHERE id = ?').run(id);
    capture('a', DAY, 1000, 50);
    assert.equal(frameDay('Mod.work').self_ms, 200, 'double counted');

    const result = rebuildLedger(store, { minWindows: 2, minSamples: 2 });
    assert.equal(result.ok, true);
    assert.equal(frameDay('Mod.work').self_ms, 100);
    assert.equal(result.changedDays?.length, 1);
  });

  test('a missing sidecar refuses the rebuild and changes nothing', () => {
    capture('a', DAY, 1000, 50);
    capture('b', DAY + 3_600_000, 3000, 150, { sidecar: false });
    const before = store.db.prepare('SELECT * FROM frame_daily ORDER BY frame_id').all();
    const result = rebuildLedger(store, { minWindows: 2, minSamples: 2 });
    assert.equal(result.ok, false);
    assert.match(result.refused ?? '', /no sidecar/);
    assert.deepEqual(store.db.prepare('SELECT * FROM frame_daily ORDER BY frame_id').all(), before);
  });
});

describe('ranges', () => {
  const bounds = { fromDay: '2026-09-01', toDay: '2026-09-22' };
  const r = (q: Record<string, string>) => resolveRange(new URLSearchParams(q), bounds);

  test('presets count back from the newest data, not from today', () => {
    assert.deepEqual(r({ range: '3d' }).range, { fromDay: '2026-09-20', toDay: '2026-09-22' });
    assert.deepEqual(r({ range: '1d' }).range, { fromDay: '2026-09-22', toDay: '2026-09-22' });
    assert.deepEqual(r({ range: '14d' }).range, { fromDay: '2026-09-09', toDay: '2026-09-22' });
  });

  test('a preset longer than the season is the whole of it', () => {
    assert.deepEqual(resolveRange(new URLSearchParams({ range: '7d' }), { fromDay: '2026-09-21', toDay: '2026-09-22' }).range, {
      fromDay: '2026-09-21',
      toDay: '2026-09-22',
    });
  });

  test('custom dates are clamped to the season, and bad ones are refused with a reason', () => {
    assert.deepEqual(r({ range: 'custom', from: '2026-08-01', to: '2026-09-05' }).range, { fromDay: '2026-09-01', toDay: '2026-09-05' });
    assert.match(r({ range: 'custom', from: '2026-09-10', to: '2026-09-02' }).problem ?? '', /after the end/);
    assert.match(r({ range: 'custom', from: 'yesterday', to: '2026-09-02' }).problem ?? '', /start and an end/);
    assert.match(r({ range: 'custom', from: '2026-10-01', to: '2026-10-05' }).problem ?? '', /outside/);
    assert.equal(r({ range: 'custom', from: '2026-10-01', to: '2026-10-05' }).range, undefined, 'falls back to the whole season');
  });

  test('no range means the whole season', () => {
    assert.equal(r({}).range, undefined);
    assert.equal(r({ range: '5h' }).range, undefined, 'hours are not offered here; the page points to Compare');
  });
});

describe('upgrading', () => {
  test('a database from before v10 is marked for a ledger rebuild; a fresh one is not', () => {
    const fresh = new Store({ file: path.join(dir, 'fresh.sqlite') });
    assert.equal(fresh.getMeta('ledger.rebuildPending') ?? '', '');
    fresh.close();

    const oldFile = path.join(dir, 'old.sqlite');
    const old = new Store({ file: oldFile });
    old.close();
    const raw = new DatabaseSync(oldFile);
    raw.prepare("UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'").run();
    raw.close();
    const upgraded = new Store({ file: oldFile });
    assert.match(upgraded.getMeta('ledger.rebuildPending') ?? '', /v10/);
    upgraded.close();
  });
});
