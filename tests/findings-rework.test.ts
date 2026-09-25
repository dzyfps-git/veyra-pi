/**
 * Where the tick goes (own time by part of the game and by mod), and
 * investigations: holding a problem without losing it, and noticing when it
 * comes back.
 */

import { rollupSource } from '../src/query/range.ts';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';
import { writeLedger, dayKey } from '../src/ingest/ledger.ts';
import { breakdown } from '../src/analysis/breakdown.ts';
import {
  cameBack,
  costOf,
  createInvestigation,
  listInvestigations,
  matches,
  updateInvestigation,
} from '../src/analysis/investigations.ts';

const T0 = Date.UTC(2026, 8, 22, 12);

describe('where the tick goes', () => {
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

    // run > tick > worlds > world tick > { entities > coolmod work (own 3000), block entities (own 1000) }
    const chain: Array<[string, number, number]> = [
      ['java.lang.Thread.run', -1, 0],
      ['net.minecraft.server.MinecraftServer.tick', 0, 0],
      ['net.minecraft.server.MinecraftServer.tickWorlds', 1, 0],
      ['net.minecraft.server.world.ServerWorld.tick', 2, 0],
      ['net.minecraft.world.EntityList.forEach', 3, 500],
      ['io.coolmod.Thing.work', 4, 3000],
      ['net.minecraft.world.World.tickBlockEntities', 3, 1000],
    ];
    const ids: number[] = [];
    const rows = chain.map(([label, parent, self], i) => {
      const frameId = store.internFrame(label, label.split('.').slice(0, -1).join('.'), label.split('.').pop()!);
      ids[i] = store.internPathEdge({ parentId: parent < 0 ? 0 : ids[parent]!, frameId, depth: i, source: label.startsWith('io.coolmod') ? 'coolmod' : null, seenAt: T0 });
      return { frameId, pathId: ids[i]!, selfMs: self, totalMs: self, category: 'work', present: 4 };
    });
    writeLedger(store.db, {
      serverId: 's', seasonId: season, day: dayKey(T0), ticks: 1000, windowsTotal: 4, intervalMs: 10, minWindows: 1, minSamples: 1, rows,
    });
  });

  afterEach(() => store.close());

  test('own time adds up by part and by mod, over the span’s ticks', () => {
    const b = breakdown(store.db, season, rollupSource(store.db, season, undefined, 'all'));
    assert.equal(b.ticks, 1000);
    assert.ok(Math.abs(b.totalMspt - 4.5) < 1e-9);
    const part = (name: string): number => b.systems.find((s) => s.name === name)?.mspt ?? 0;
    assert.ok(Math.abs(part('Entities') - 3.5) < 1e-9);
    assert.ok(Math.abs(part('Block entities') - 1.0) < 1e-9);
    const mod = (name: string): number => b.mods.find((m) => m.name === name)?.mspt ?? 0;
    assert.ok(Math.abs(mod('coolmod') - 3.0) < 1e-9);
    assert.ok(Math.abs(mod('Minecraft') - 1.5) < 1e-9);
  });
});

describe('investigations', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store({ file: ':memory:' });
    store.upsertServer('s', 'main', 'Main');
  });
  afterEach(() => store.close());

  const list = [
    { label: 'corgitaco.blockswap.Swapper.runRetroGenerator', owner: 'blockswap', msPerTick: 0.05 },
    { label: 'net.minecraft.world.World.handler$cco000$blockswap$isIncompatibleBlock', owner: 'blockswap', msPerTick: 0.12 },
    { label: 'net.minecraft.x.Other.work', owner: 'Minecraft', msPerTick: 0.3 },
  ];

  test('a problem covering two methods is held as one, with its cost then', () => {
    const { id } = createInvestigation(store.db, {
      serverId: 's', name: 'BlockSwap retro-generation', state: 'hold', note: 'Too risky to patch for now.',
      members: [list[0]!.label, list[1]!.label], mspt: 0.17,
    });
    const [inv] = listInvestigations(store.db, 's');
    assert.equal(inv!.id, id);
    assert.equal(inv!.state, 'hold');
    assert.ok(matches(inv!, list[0]!) && matches(inv!, list[1]!) && !matches(inv!, list[2]!));
    assert.ok(Math.abs(costOf(inv!, list) - 0.17) < 1e-9);
    assert.equal(inv!.history.length, 1);
  });

  test('a whole mod can be held, including methods not seen yet', () => {
    createInvestigation(store.db, { serverId: 's', name: 'All of blockswap', state: 'hold', members: ['mod:blockswap'], mspt: 0.17 });
    const [inv] = listInvestigations(store.db, 's');
    assert.ok(matches(inv!, { label: 'corgitaco.blockswap.New.method', owner: 'blockswap' }));
  });

  test('it comes back only when clearly worse', () => {
    createInvestigation(store.db, { serverId: 's', name: 'x', state: 'hold', members: ['a'], mspt: 0.2 });
    const [inv] = listInvestigations(store.db, 's');
    assert.equal(cameBack(inv!, 0.25).back, false);
    assert.equal(cameBack(inv!, 0.31).back, true);
    // Holding it again records today's cost as the new baseline.
    updateInvestigation(store.db, inv!.id, { state: 'hold', mspt: 0.31 });
    const [again] = listInvestigations(store.db, 's');
    assert.equal(again!.baselineMspt, 0.31);
    assert.equal(cameBack(again!, 0.35).back, false);
    assert.equal(again!.history.length, 2);
  });

  test('refuses nameless or empty investigations', () => {
    assert.match(createInvestigation(store.db, { serverId: 's', name: ' ', state: 'hold', members: ['a'], mspt: 0 }).error!, /name/);
    assert.match(createInvestigation(store.db, { serverId: 's', name: 'x', state: 'hold', members: [], mspt: 0 }).error!, /at least one/);
  });
});
