/**
 * Where the tick went, per minute: every sample counted once, by part of the
 * game, mod and thing; spans divided by the ticks spark counted in exactly
 * those minutes; the things inside a part, and the methods inside a thing.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';
import { writeLedger, dayKey } from '../src/ingest/ledger.ts';
import { classifyPath, pathStep, subjectKey, subjectName, type PathState } from '../src/analysis/subjects.ts';
import { explainWait } from '../src/analysis/systems.ts';
import {
  alignedMinute,
  computeSplit,
  decodeSplit,
  encodeSplit,
  placesOf,
  rebuildSplitDays,
  saveSplit,
  splitFor,
  subjectsOf,
  type SplitSourceRow,
} from '../src/analysis/split.ts';
import { methodsInside } from '../src/analysis/inside.ts';

const RUN = 'java.lang.Thread.run';
const TICK = 'net.minecraft.server.MinecraftServer.tick';
const WORLD = 'net.minecraft.server.world.ServerWorld.tick';
const ENTITIES = 'net.minecraft.world.EntityList.forEach';
const TICK_ENTITY = 'net.minecraft.server.world.ServerWorld.tickEntity';
const NERUINA = 'net.minecraft.world.World.wrapOperation$abc000$neruina$catchTickingEntities';
const VILLAGER = 'net.minecraft.entity.passive.VillagerEntity.tick';
const ZOMBIE = 'net.minecraft.entity.mob.ZombieEntity.tick';
const PATHFIND = 'net.minecraft.entity.ai.pathing.PathNodeNavigator.findPathToAny';
const HOOK = 'net.minecraft.server.world.ServerWorld.handler$cim000$cardinal-components-entity$tick';
const POWER = 'io.github.apace100.apoli.power.ActionOverTimePower.tick';
const DESPAWN = 'net.minecraft.entity.mob.MobEntity.checkDespawn';
const FUNCTIONS = 'net.minecraft.server.function.CommandFunctionManager.tick';
const EXECUTE = 'net.minecraft.server.command.ExecuteCommand.method_13272';
const SELECTOR = 'net.minecraft.command.EntitySelector.getEntities';
const DATA = 'net.minecraft.server.command.DataCommand.executeMerge';
const IDLE = 'net.minecraft.server.MinecraftServer.runTasksTillTickEnd';

function walk(frames: string[]): PathState | undefined {
  let s: PathState | undefined;
  for (const f of frames) s = pathStep(f, s);
  return s;
}

describe('naming the thing inside a part of the game', () => {
  test('an entity is its own tick override, found below mixin wrappers', () => {
    const s = walk([RUN, TICK, WORLD, ENTITIES, TICK_ENTITY, NERUINA, VILLAGER, PATHFIND]);
    assert.equal(s?.system, 'entities');
    assert.equal(subjectKey(s!), 'net.minecraft.entity.passive.VillagerEntity');
    assert.equal(subjectName('entities', subjectKey(s!)), 'Villager');
  });

  test('a mod hook run for every entity is a thing of its own, named after the mod', () => {
    const s = walk([RUN, TICK, WORLD, ENTITIES, TICK_ENTITY, HOOK, POWER]);
    assert.equal(subjectKey(s!), HOOK);
    assert.match(subjectName('entities', HOOK), /Mod hook on every entity/);
  });

  test('time that reaches no type is named after its first real step', () => {
    const s = walk([RUN, TICK, WORLD, ENTITIES, DESPAWN]);
    assert.equal(subjectKey(s!), `~${DESPAWN}`);
    assert.equal(subjectName('entities', subjectKey(s!)), 'Despawn checks');
    // The loop itself is no one thing.
    assert.equal(subjectKey(walk([RUN, TICK, WORLD, ENTITIES])!), '');
  });

  test('a datapack is named by its innermost command; selectors are their own thing', () => {
    assert.equal(subjectName('datapacks', subjectKey(walk([RUN, TICK, FUNCTIONS, EXECUTE])!)), '/execute');
    assert.equal(subjectName('datapacks', subjectKey(walk([RUN, TICK, FUNCTIONS, EXECUTE, DATA])!)), '/data');
    assert.match(subjectName('datapacks', subjectKey(walk([RUN, TICK, FUNCTIONS, EXECUTE, SELECTOR])!)), /Entity selectors/);
  });

  test('waits are named by their cause, idle time by nothing', () => {
    const frames = [RUN, TICK, WORLD, ENTITIES, 'net.minecraft.entity.Entity.getLandingPos', 'net.minecraft.server.world.ServerChunkManager.getChunkBlocking', 'java.util.concurrent.locks.LockSupport.park'];
    assert.deepEqual(classifyPath(frames, 'blocked', explainWait), {
      system: 'waiting',
      subject: 'a player or mob moving into terrain that was not loaded yet',
    });
    assert.equal(classifyPath([RUN, IDLE], 'idle', explainWait).system, undefined);
  });
});

// --- a capture ---------------------------------------------------------------

const T0 = Date.UTC(2026, 8, 22, 12);
const WINDOWS = [100, 101, 102, 103];
const TICKS = [1200, 1200, 1200, 600];

/** Rows parent-first, as captures store them. Values per window, ms. */
function captureRows(): SplitSourceRow[] {
  const rows: SplitSourceRow[] = [];
  const add = (label: string, parent: number, self: number[], category = 'work', source: string | null = null): number => {
    rows.push({ path: parent < 0 ? label : `${rows[parent]!.path} > ${label}`, label, source, parentIndex: parent, category, selfMsByWindow: self });
    return rows.length - 1;
  };
  const z = [0, 0, 0, 0];
  const run = add(RUN, -1, z);
  const tick = add(TICK, run, z);
  const world = add(WORLD, tick, z);
  const list = add(ENTITIES, world, [100, 100, 100, 50]);
  const te = add(TICK_ENTITY, list, z);
  add(VILLAGER, te, [1200, 1200, 1200, 600]);
  const zombie = add(ZOMBIE, te, [600, 0, 600, 0]);
  add(PATHFIND, zombie, [300, 300, 300, 0]);
  add(HOOK, te, [240, 240, 240, 120], 'work', 'cardinal-components-entity');
  add(IDLE, run, [50_000, 50_000, 50_000, 25_000], 'idle');
  return rows;
}

describe('the per-minute split', () => {
  let store: Store;
  let season: number;
  let captureId: number;

  beforeEach(() => {
    store = new Store({ file: ':memory:' });
    store.upsertServer('s', 'main', 'Main');
    const env = store.upsertEnvironment({
      serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
      javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
    });
    season = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
    const revision = store.createRevision({
      seasonId: season, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0, reason: 'r', added: 0, removed: 0, changed: 0,
    });
    captureId = Number(
      store.db
        .prepare(
          `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, ended_at,
                                window_count, path_count, raw_bytes, ingested_at, is_manual, divisor_ticks, interval_micros)
           VALUES ('s',?,?,'c','sha',?,?,4,10,1,1,0,4200,10000)`,
        )
        .run(season, revision, T0, T0 + 4 * 60_000).lastInsertRowid,
    );
    WINDOWS.forEach((w, i) => {
      store.db
        .prepare('INSERT INTO capture_window (capture_id, window_id, start_time, end_time, ticks, mspt_median, mspt_max, players) VALUES (?,?,?,?,?,?,?,?)')
        .run(captureId, w, T0 + i * 60_000, T0 + (i + 1) * 60_000, TICKS[i]!, 1.5, 30, 2);
    });
  });

  afterEach(() => store.close());

  test('every sample is counted once, idle time never', () => {
    const split = computeSplit(captureRows(), WINDOWS);
    const total = split.ms.reduce((s, v) => s + v.reduce((a, b) => a + b, 0), 0);
    // entities loop 350 + villager 4200 + zombie 1200 + pathfinding 900 + hook 840
    assert.equal(total, 350 + 4200 + 1200 + 900 + 840);
    const round = decodeSplit(encodeSplit(split));
    assert.deepEqual(round.cells, split.cells);
    assert.deepEqual(round.ms.map((v) => [...v]), split.ms.map((v) => [...v]));
  });

  test('a span is divided by the ticks spark counted in it, and its parts add up', () => {
    saveSplit(store.db, captureId, computeSplit(captureRows(), WINDOWS));
    const all = splitFor(store.db, season);
    assert.equal(all.ticks, 4200);
    assert.equal(all.minutes, 4);
    assert.ok(Math.abs(all.totalMspt - 7490 / 4200) < 1e-9);
    assert.ok(Math.abs(all.systems.reduce((s, x) => s + x.mspt, 0) - all.totalMspt) < 1e-9);

    // The first two minutes only: exact, not pro-rated.
    const early = splitFor(store.db, season, { time: { fromMs: T0, toMs: T0 + 2 * 60_000 } });
    assert.equal(early.ticks, 2400);
    assert.ok(Math.abs(early.totalMspt - (100 + 1200 + 600 + 300 + 240 + 100 + 1200 + 0 + 300 + 240) / 2400) < 1e-9);

    const days = splitFor(store.db, season, { days: { fromDay: dayKey(T0), toDay: dayKey(T0) } });
    assert.ok(Math.abs(days.totalMspt - all.totalMspt) < 1e-9);
  });

  test('things inside a part, and where a mod’s time goes', () => {
    saveSplit(store.db, captureId, computeSplit(captureRows(), WINDOWS));
    const all = splitFor(store.db, season);
    const things = subjectsOf(all, 'entities');
    assert.deepEqual(things.map((t) => t.name).slice(0, 2), ['Villager', 'Zombie']);
    // Zombie includes the pathfinding it called.
    assert.ok(Math.abs(things.find((t) => t.name === 'Zombie')!.mspt - 2100 / 4200) < 1e-9);
    const hook = placesOf(all, 'cardinal-components-entity');
    assert.equal(hook[0]!.system, 'entities');
  });

  test('saving again replaces, and the daily roll-up rebuilds to the same figures', () => {
    const split = computeSplit(captureRows(), WINDOWS);
    saveSplit(store.db, captureId, split);
    saveSplit(store.db, captureId, split);
    const once = splitFor(store.db, season);
    assert.equal(once.ticks, 4200);
    rebuildSplitDays(store.db);
    const rebuilt = splitFor(store.db, season);
    assert.equal(rebuilt.ticks, once.ticks);
    assert.ok(Math.abs(rebuilt.totalMspt - once.totalMspt) < 1e-9);
  });

  test('minutes whose samples line up with the tick are recognised, busy ones are not', () => {
    const w = { window_id: 1, ticks: 1200, mspt_median: 3, mspt_max: 20 };
    assert.equal(alignedMinute(0, w, 10), true, 'no samples inside a 3 ms tick');
    assert.equal(alignedMinute(12_000, w, 10), true, 'one 10 ms sample every tick of a 3 ms tick');
    assert.equal(alignedMinute(3_800, w, 10), false);
    assert.equal(alignedMinute(0, { ...w, mspt_median: 25 }, 10), false, 'a long tick is always sampled');
  });
});

describe('the methods inside one thing', () => {
  let store: Store;
  let season: number;

  beforeEach(() => {
    store = new Store({ file: ':memory:' });
    store.upsertServer('s', 'main', 'Main');
    const env = store.upsertEnvironment({
      serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
      javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
    });
    season = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
    const rows = captureRows();
    const ids: number[] = [];
    const ledger = rows.map((r, i) => {
      const cls = r.label.split('.').slice(0, -1).join('.');
      const frameId = store.internFrame(r.label, cls, r.label.split('.').pop()!);
      ids[i] = store.internPathEdge({ parentId: r.parentIndex < 0 ? 0 : ids[r.parentIndex]!, frameId, depth: i, source: r.source, seenAt: T0 });
      const self = r.selfMsByWindow.reduce((a, b) => a + b, 0);
      return { frameId, pathId: ids[i]!, selfMs: self, totalMs: self, category: r.category, present: 4 };
    });
    writeLedger(store.db, {
      serverId: 's', seasonId: season, day: dayKey(T0), ticks: 4200, windowsTotal: 4, intervalMs: 10, minWindows: 1, minSamples: 1, rows: ledger,
    });
  });

  afterEach(() => store.close());

  test('a type lists its own methods and nothing from another type', () => {
    const zombie = methodsInside(store.db, season, { kind: 'season' }, 'entities', 'net.minecraft.entity.mob.ZombieEntity', 4200);
    assert.deepEqual(
      zombie?.methods.map((m) => m.method),
      [ZOMBIE, PATHFIND],
    );
    assert.ok(Math.abs(zombie!.listedMspt - 2100 / 4200) < 1e-9);
    const villager = methodsInside(store.db, season, { kind: 'season' }, 'entities', 'net.minecraft.entity.passive.VillagerEntity', 4200);
    assert.deepEqual(villager?.methods.map((m) => m.method), [VILLAGER]);
  });

  test('time that is not one thing has no list', () => {
    assert.equal(methodsInside(store.db, season, { kind: 'season' }, 'entities', '', 4200), undefined);
  });
});

test('a lambda inside a command is named after its command', () => {
  let s: PathState | undefined;
  for (const f of [RUN, TICK, FUNCTIONS, 'net.minecraft.server.command.ExecuteCommand$$Lambda$4412.0x00007e2e6ba94018.run']) s = pathStep(f, s);
  assert.equal(subjectName('datapacks', subjectKey(s!)), '/execute');
});
