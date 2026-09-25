/**
 * "What happened and why": parts of the game, who owns a piece of time,
 * one minute against normal, freezes and their causes, MSPT by players.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { encodeSidecar, type EncodableRow } from '../src/store/sidecar.ts';
import { explainWait, systemOf } from '../src/analysis/systems.ts';
import { meaningfulFrame, ownersOf, readableMethod } from '../src/analysis/owner.ts';
import { minuteDetail, msptByPlayers, stalls } from '../src/analysis/minute.ts';

const RUN = 'java.lang.Thread.run';
const TICK = 'net.minecraft.server.MinecraftServer.tick';
const WORLDS = 'net.minecraft.server.MinecraftServer.tickWorlds';
const WORLD = 'net.minecraft.server.world.ServerWorld.tick';
const p = (...frames: string[]): string[] => [RUN, TICK, WORLDS, ...frames];

describe('parts of the game', () => {
  test('the outermost specific frame decides', () => {
    assert.equal(systemOf(p(WORLD, 'net.minecraft.world.EntityList.forEach', 'x.Mob.tick', 'net.minecraft.server.world.ServerChunkManager.getChunk'), 'work'), 'entities');
    assert.equal(systemOf(p(WORLD, 'net.minecraft.world.World.tickBlockEntities', 'mod.Machine.tick'), 'work'), 'block-entities');
    assert.equal(systemOf(p('net.minecraft.server.function.CommandFunctionManager.tick', 'x.y'), 'work'), 'datapacks');
    assert.equal(systemOf(p('net.minecraft.server.ServerNetworkIo.tick'), 'work'), 'players');
    assert.equal(systemOf(p(WORLD, 'net.minecraft.server.world.ServerChunkManager.tick', 'net.minecraft.server.world.ServerChunkManager.tickChunks', 'net.minecraft.server.world.ServerWorld.tickChunk'), 'work'), 'random-ticks');
    assert.equal(systemOf([RUN, TICK, 'net.minecraft.server.MinecraftServer.handler$dpa002$fabric-lifecycle-events-v1$onEndTick'], 'work'), 'mod-hooks');
    assert.equal(systemOf(p(WORLD, 'x.Unknown.thing'), 'work'), 'other');
  });

  test('waiting, garbage collection and idle time are told apart', () => {
    assert.equal(systemOf(p(WORLD, 'a'), 'blocked'), 'waiting');
    assert.equal(systemOf(['native.GC_active'], 'work'), 'gc');
    assert.equal(systemOf([RUN, 'net.minecraft.util.thread.ThreadExecutor.waitForTasks'], 'idle'), undefined);
  });

  test('a wait is explained in words, with its trigger', () => {
    const chunk = ['net.minecraft.server.world.ServerChunkManager.getChunkBlocking', 'java.util.concurrent.locks.LockSupport.parkNanos'];
    assert.deepEqual(explainWait(p(WORLD, 'net.minecraft.entity.Entity.getLandingPos', 'net.minecraft.world.World.getChunk', ...chunk)), {
      what: 'waited for a chunk to load or generate',
      cause: 'a player or mob moving into terrain that was not loaded yet',
    });
    assert.match(explainWait(p(WORLD, 'net.minecraft.item.FilledMapItem.updateColors', ...chunk)).cause, /map/);
    assert.match(explainWait(p(WORLD, 'net.minecraft.world.dimension.PortalForcer.createPortal', ...chunk)).cause, /portal/);
    assert.match(explainWait(p(WORLD, 'com.example.cool.Thing.work', ...chunk)).cause, /com\.example\.cool\.Thing/);
  });
});

describe('who owns a piece of time', () => {
  test("spark's tag, then mixins, then Minecraft, then the caller of library code", () => {
    const rows = [
      { path: 'net.minecraft.A.tick', source: null, parentIndex: -1 },
      { path: 'net.minecraft.A.tick > io.coolmod.core.Thing.run', source: 'coolmod', parentIndex: 0 },
      { path: 'net.minecraft.A.tick > io.coolmod.core.Thing.run > java.util.HashMap.get', source: null, parentIndex: 1 },
      { path: 'net.minecraft.A.tick > io.coolmod.core.Other.run', source: null, parentIndex: 0 },
      { path: 'net.minecraft.A.tick > net.minecraft.World.handler$abc000$blockswap$isIncompatible', source: null, parentIndex: 0 },
      { path: 'net.minecraft.A.tick > org.mystery.lib.Stuff.go', source: null, parentIndex: 0 },
    ];
    assert.deepEqual(ownersOf(rows), ['Minecraft', 'coolmod', 'coolmod', 'coolmod', 'blockswap', 'mystery?']);
  });

  test("a lambda's run number does not hide its package", () => {
    const rows = [
      { path: 'artifacts.platform.PlatformHelper.init', source: 'artifacts', parentIndex: -1 },
      { path: 'artifacts.platform.PlatformHelper.init > artifacts.platform.PlatformHelper$$Lambda$36855.0x00007e2e6c022cb0.apply', source: null, parentIndex: 0 },
      { path: 'x > org.mystery.lib.Stuff$$Lambda$9.0x0000000801234567.run', source: null, parentIndex: -1 },
    ];
    // Before: "artifacts?" and "platform?" style guesses from the number splitting the class.
    assert.deepEqual(ownersOf(rows), ['artifacts', 'artifacts', 'mystery?']);
  });

  test('the frame worth naming skips libraries and lambdas', () => {
    assert.equal(meaningfulFrame('net.minecraft.A.tick > x.Mod.work > java.util.HashMap.get'), 'x.Mod.work');
    assert.equal(meaningfulFrame('x.Mod.work > x.Mod$$Lambda$12.0x00007e2e6baceac0.apply > it.unimi.dsi.fastutil.Foo.get'), 'x.Mod.work');
    assert.equal(readableMethod('net.minecraft.world.World.handler$cco000$blockswap$isIncompatibleBlock'), 'World.isIncompatibleBlock (added by blockswap)');
  });
});

describe('one minute against normal', () => {
  const T0 = Date.UTC(2026, 8, 22, 12);
  let dir: string;
  let store: Store;
  let season: number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'perfint-minute-'));
    store = new Store({ file: path.join(dir, 'perfint.sqlite') });
    store.upsertServer('s', 'main', 'Main');
    const env = store.upsertEnvironment({
      serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
      javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
    });
    season = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
    const revision = store.createRevision({
      seasonId: season, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0, reason: 'r', added: 0, removed: 0, changed: 0,
    });

    // Eight minutes. Entities cost 6000 ms a minute (5 MSPT); minute 5 also
    // waits 2400 ms for a chunk, triggered by movement, and entities double.
    const n = 8;
    const spike = 5;
    const entities = Array.from({ length: n }, (_, i) => (i === spike ? 12_000 : 6_000));
    const waitMs = Array.from({ length: n }, (_, i) => (i === spike ? 2_400 : 0));
    const zero = new Array<number>(n).fill(0);
    const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
    const chain = [RUN, TICK, WORLDS, WORLD];
    const rows: EncodableRow[] = [];
    chain.forEach((f, i) => {
      const total = entities.map((e, k) => e + waitMs[k]!);
      rows.push({ path: chain.slice(0, i + 1).join(' > '), label: f, source: null, parentIndex: i - 1, depth: i, selfMs: 0, totalMs: sum(total), category: 'work', selfMsByWindow: zero, totalMsByWindow: total });
    });
    const base = chain.join(' > ');
    rows.push({ path: `${base} > net.minecraft.world.EntityList.forEach`, label: 'net.minecraft.world.EntityList.forEach', source: null, parentIndex: 3, depth: 4, selfMs: sum(entities), totalMs: sum(entities), category: 'work', selfMsByWindow: entities, totalMsByWindow: entities });
    const moveChain = ['net.minecraft.entity.Entity.getLandingPos', 'net.minecraft.server.world.ServerChunkManager.getChunkBlocking', 'java.util.concurrent.locks.LockSupport.parkNanos'];
    moveChain.forEach((f, i) => {
      const parent = i === 0 ? 3 : rows.length - 1;
      rows.push({
        path: `${rows[parent]!.path} > ${f}`, label: f, source: null, parentIndex: parent, depth: rows[parent]!.depth + 1,
        selfMs: i === 2 ? sum(waitMs) : 0, totalMs: sum(waitMs), category: i === 2 ? 'blocked' : 'work',
        selfMsByWindow: i === 2 ? waitMs : zero, totalMsByWindow: waitMs,
      });
    });
    const windowIds = Array.from({ length: n }, (_, i) => 200 + i);
    const file = path.join(dir, 'c.sidecar.zst');
    writeFileSync(file, encodeSidecar('sha', windowIds, rows));
    const capture = store.db
      .prepare(
        `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, ended_at,
                              window_count, path_count, raw_bytes, ingested_at, is_manual, divisor_ticks, sidecar_path)
         VALUES ('s',?,?,'c','sha',?,?,?,?,1,1,0,?,?)`,
      )
      .run(season, revision, T0, T0 + n * 60_000, n, rows.length, n * 1200, store.toStoredPath(file));
    const id = Number(capture.lastInsertRowid);
    windowIds.forEach((w, i) => {
      store.db
        .prepare('INSERT INTO capture_window (capture_id, window_id, start_time, end_time, ticks, mspt_median, mspt_max, players) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, w, T0 + i * 60_000, T0 + (i + 1) * 60_000, i === spike ? 1150 : 1200, i === spike ? 12 : 5, i === spike ? 2600 : 40, i < 4 ? 3 : 5);
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const resolve = (stored: string | null): string | undefined => store.resolveDataPath(stored);

  test('explains a spike: the wait, its trigger, and what grew', () => {
    const d = minuteDetail(store.db, resolve, 's', T0 + 5 * 60_000 + 30_000)!;
    assert.equal(d.evidence, true);
    assert.equal(d.window.msptMax, 2600);
    assert.ok(Math.abs(d.lostSeconds - 2.5) < 1e-9);
    assert.equal(d.waits[0]!.what, 'waited for a chunk to load or generate');
    assert.match(d.waits[0]!.cause, /moving into terrain/);
    const entities = d.systems.find((s) => s.label === 'Entities')!;
    assert.ok(Math.abs(entities.here - 12_000 / 1150) < 1e-6);
    assert.ok(Math.abs(entities.normal - 5) < 1e-6);
    assert.equal(d.systems.find((s) => s.label === 'Waiting')!.normal, 0);
  });

  test('a normal minute has nothing standing out', () => {
    const d = minuteDetail(store.db, resolve, 's', T0 + 60_000)!;
    assert.equal(d.waits.length, 0);
    assert.equal(d.mods.length, 0);
  });

  test('a time with no recording says so', () => {
    assert.equal(minuteDetail(store.db, resolve, 's', T0 - 3_600_000), undefined);
  });

  test('freezes are listed worst first with their cause', () => {
    const list = stalls(store.db, resolve, 's', T0, T0 + 3_600_000);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.worstTick, 2600);
    assert.match(list[0]!.wait!.cause, /moving into terrain/);
  });

  test('MSPT by player count', () => {
    const bands = msptByPlayers(store.db, 's', season, T0, T0 + 3_600_000);
    assert.deepEqual(bands.map((b) => [b.players, b.minutes]), [[3, 4], [5, 4]]);
    assert.equal(bands[0]!.median, 5);
  });
});
