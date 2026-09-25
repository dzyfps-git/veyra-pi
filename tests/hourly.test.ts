/**
 * Exact time spans, read minute by minute from sidecars.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { encodeSidecar } from '../src/store/sidecar.ts';
import { writeLedger, dayKey } from '../src/ingest/ledger.ts';
import { prepareTimeRange } from '../src/query/hourly.ts';
import { ledger } from '../src/query/queries.ts';
import { resolveRange } from '../src/query/range.ts';
import type { PathRow } from '../src/decode/aggregate.ts';

const T0 = Date.UTC(2026, 8, 22, 12, 0);
let dir: string;
let store: Store;
let seasonId: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-hourly-'));
  store = new Store({ file: path.join(dir, 'perfint.sqlite') });
  store.upsertServer('s', 'main', 'Main');
  const env = store.upsertEnvironment({
    serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
    javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
  });
  seasonId = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
  const revision = store.createRevision({
    seasonId, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0, reason: 'r', added: 0, removed: 0, changed: 0,
  });

  // One capture of four one-minute windows; Mod.work costs 10, 20, 30, 40 ms.
  const perWindow = [10, 20, 30, 40];
  const rows = [
    { path: 'Server.run', label: 'Server.run', parentIndex: -1, depth: 0, self: [0, 0, 0, 0], total: perWindow },
    { path: 'Server.run > Mod.work', label: 'Mod.work', parentIndex: 0, depth: 1, self: perWindow, total: perWindow },
  ];
  const windowIds = [100, 101, 102, 103];
  const full = rows.map((r) => ({
    path: r.path, source: null, parentIndex: r.parentIndex, depth: r.depth, category: 'work',
    selfMs: r.self.reduce((a, b) => a + b, 0), totalMs: r.total.reduce((a, b) => a + b, 0),
    selfMsByWindow: r.self, totalMsByWindow: r.total,
  })) as unknown as PathRow[];
  const sidecar = path.join(dir, 'c.sidecar.zst');
  mkdirSync(dir, { recursive: true });
  writeFileSync(sidecar, encodeSidecar('sha', windowIds, full));

  store.db
    .prepare(
      `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, ended_at,
                            window_count, path_count, raw_bytes, ingested_at, is_manual, divisor_ticks, sidecar_path)
       VALUES ('s',?,?,'c','sha',?,?,4,2,1,1,0,4800,?)`,
    )
    .run(seasonId, revision, T0, T0 + 4 * 60_000, store.toStoredPath(sidecar));
  const captureId = (store.db.prepare('SELECT id FROM capture').get() as { id: number }).id;
  windowIds.forEach((id, i) => {
    store.db
      .prepare('INSERT INTO capture_window (capture_id, window_id, start_time, end_time, ticks) VALUES (?,?,?,?,1200)')
      .run(captureId, id, T0 + i * 60_000, T0 + (i + 1) * 60_000);
  });

  const ids: number[] = [];
  const input = rows.map((r, index) => {
    const frameId = store.internFrame(r.label, r.label.split('.')[0]!, r.label.split('.')[1]!);
    ids[index] = store.internPathEdge({ parentId: r.parentIndex < 0 ? 0 : ids[r.parentIndex]!, frameId, depth: r.depth, source: null, seenAt: T0 });
    return { frameId, pathId: ids[index]!, selfMs: full[index]!.selfMs, totalMs: full[index]!.totalMs, category: 'work', present: 4 };
  });
  writeLedger(store.db, {
    serverId: 's', seasonId, day: dayKey(T0), ticks: 4800, windowsTotal: 4, intervalMs: 10, minWindows: 2, minSamples: 2, rows: input,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const work = (table: string) => ledger(store.db, { seasonId, table, search: 'Mod.work', limit: 1 })[0];

describe('exact time spans', () => {
  test('a span covering the whole capture equals the season total', () => {
    const { table, coverage } = prepareTimeRange(store.db, seasonId, { fromMs: T0 - 60_000, toMs: T0 + 3_600_000 }, (p) => store.resolveDataPath(p));
    assert.equal(coverage.minutes, 4);
    const whole = ledger(store.db, { seasonId, search: 'Mod.work', limit: 1 })[0]!;
    assert.equal(work(table)!.self_ms_per_tick, whole.self_ms_per_tick);
  });

  test('only the minutes inside the span count', () => {
    // Windows 3 and 4: 30 + 40 ms over 2 x 1200 ticks.
    const { table, coverage } = prepareTimeRange(store.db, seasonId, { fromMs: T0 + 2 * 60_000, toMs: T0 + 4 * 60_000 }, (p) => store.resolveDataPath(p));
    assert.equal(coverage.minutes, 2);
    assert.equal(work(table)!.self_ms_per_tick, 70 / 2400);
  });

  test('path ids are remembered after the first span', () => {
    prepareTimeRange(store.db, seasonId, { fromMs: T0, toMs: T0 + 60_000 * 3 }, (p) => store.resolveDataPath(p));
    const stored = store.db.prepare('SELECT length(ids) AS n FROM capture_path_ids').get() as { n: number };
    assert.equal(stored.n, 2 * 4);
  });

  test('hour presets count back from the newest data', () => {
    const bounds = { fromDay: '2026-09-22', toDay: '2026-09-22' };
    const latest = T0 + 4 * 60_000;
    const r = resolveRange(new URLSearchParams({ range: '1h' }), bounds, latest);
    assert.deepEqual(r.time, { fromMs: latest - 3_600_000, toMs: latest });
    const custom = resolveRange(new URLSearchParams({ range: 'custom', from: '2026-09-22T08:00', to: '2026-09-22T09:30' }), bounds, latest);
    assert.equal(custom.time!.toMs - custom.time!.fromMs, 90 * 60_000);
  });
});

describe('a call path spark recorded twice in one capture', () => {
  test('adds its time but counts the capture’s ticks once', () => {
    // spark keeps one node per call line, so the same method under the same
    // caller can appear twice; both are the same path here.
    const revision = (store.db.prepare('SELECT id FROM revision').get() as { id: number }).id;
    const t1 = T0 + 10 * 60_000;
    const rows = [
      { path: 'Server.run', source: null, parentIndex: -1, depth: 0, category: 'work', selfMs: 0, totalMs: 20, selfMsByWindow: [0, 0], totalMsByWindow: [10, 10] },
      { path: 'Server.run > Mod.work', source: null, parentIndex: 0, depth: 1, category: 'work', selfMs: 10, totalMs: 10, selfMsByWindow: [5, 5], totalMsByWindow: [5, 5] },
      { path: 'Server.run > Mod.work', source: null, parentIndex: 0, depth: 1, category: 'work', selfMs: 10, totalMs: 10, selfMsByWindow: [5, 5], totalMsByWindow: [5, 5] },
    ] as unknown as PathRow[];
    const file = path.join(dir, 'twice.sidecar.zst');
    writeFileSync(file, encodeSidecar('sha2', [300, 301], rows));
    const id = Number(
      store.db
        .prepare(
          `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, ended_at,
                                window_count, path_count, raw_bytes, ingested_at, is_manual, divisor_ticks, sidecar_path)
           VALUES ('s',?,?,'c2','sha2',?,?,2,3,1,1,0,2400,?)`,
        )
        .run(seasonId, revision, t1, t1 + 2 * 60_000, store.toStoredPath(file)).lastInsertRowid,
    );
    [300, 301].forEach((w, i) => {
      store.db
        .prepare('INSERT INTO capture_window (capture_id, window_id, start_time, end_time, ticks) VALUES (?,?,?,?,1200)')
        .run(id, w, t1 + i * 60_000, t1 + (i + 1) * 60_000);
    });
    const { table } = prepareTimeRange(store.db, seasonId, { fromMs: t1, toMs: t1 + 2 * 60_000 }, (p) => store.resolveDataPath(p));
    const row = store.db.prepare(`SELECT self_ms, ticks FROM ${table} WHERE self_ms > 0`).get() as { self_ms: number; ticks: number };
    assert.equal(row.self_ms, 20);
    assert.equal(row.ticks, 2400);
  });
});
