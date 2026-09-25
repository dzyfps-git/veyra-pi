/**
 * Keeping out of the Minecraft server's way: the governor that holds heavy
 * work back while the PC is busy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Governor, type Budget } from '../src/runtime/throttle.ts';

const BUDGET: Budget = { maxOwnCpuPercent: 25, busyHostPercent: 75, maxRssMb: 1024, maxWaitMs: 60_000 };

/** A fake machine: each advance moves the counters by the current load. */
function machine(load: { host: number; own: number; rssMb?: number }) {
  let now = 0;
  let own = 0;
  let idle = 0;
  let total = 0;
  const state = { ...load };
  return {
    state,
    now: () => now,
    advance(ms: number) {
      now += ms;
      own += (state.own / 100) * ms * 1000; // microseconds of one core
      total += ms * 16;
      idle += ms * 16 * (1 - state.host / 100);
    },
    read: () => ({ ownCpuUs: own, hostIdle: idle, hostTotal: total, rssBytes: (state.rssMb ?? 200) * 1048576 }),
  };
}

describe('governor', () => {
  test('measures its own CPU and the whole PC over the last minute', () => {
    const m = machine({ host: 40, own: 10 });
    const g = new Governor(() => BUDGET, { now: m.now, read: m.read });
    g.sample();
    m.advance(30_000);
    const load = g.sample();
    assert.ok(Math.abs(load.hostCpuPercent - 40) < 0.01);
    assert.ok(Math.abs(load.ownCpuPercent - 10) < 0.01);
    assert.equal(g.reason(load), undefined);
  });

  test('a busy PC, its own CPU, or memory each hold heavy work back', () => {
    const m = machine({ host: 90, own: 1 });
    const g = new Governor(() => BUDGET, { now: m.now, read: m.read });
    g.sample();
    m.advance(10_000);
    assert.equal(g.reason(), 'host-busy');
    m.state.host = 10;
    m.state.own = 60;
    m.advance(120_000);
    g.sample();
    m.advance(10_000);
    assert.equal(g.reason(), 'own-cpu');
    m.state.own = 1;
    m.state.rssMb = 2000;
    m.advance(120_000);
    g.sample();
    m.advance(10_000);
    assert.equal(g.reason(), 'memory');
  });

  test('waits until the PC is calm', async () => {
    const m = machine({ host: 95, own: 0 });
    const g = new Governor(() => BUDGET, { now: m.now, read: m.read });
    g.sample();
    m.advance(5_000);
    let waits = 0;
    const messages: string[] = [];
    const result = await g.whenCalm('importing', (msg) => messages.push(msg), async (ms) => {
      waits += 1;
      if (waits === 3) m.state.host = 5;
      // Long enough for the busy minute to leave the window.
      m.advance(waits >= 3 ? 70_000 : ms);
    });
    assert.equal(result.reason, 'host-busy');
    assert.ok(waits >= 3);
    assert.match(messages[0]!, /importing: waited \d+ s \(this PC was busy\)/);
  });

  test('never waits longer than the limit', async () => {
    const m = machine({ host: 100, own: 0 });
    const g = new Governor(() => BUDGET, { now: m.now, read: m.read });
    g.sample();
    m.advance(5_000);
    const messages: string[] = [];
    const result = await g.whenCalm('importing', (msg) => messages.push(msg), async (ms) => m.advance(ms));
    assert.ok(result.waitedMs >= BUDGET.maxWaitMs && result.waitedMs < BUDGET.maxWaitMs + 10_000);
    assert.match(messages[0]!, /running now at low priority/);
  });

  test('does not wait at all when calm', async () => {
    const m = machine({ host: 10, own: 0 });
    const g = new Governor(() => BUDGET, { now: m.now, read: m.read });
    g.sample();
    m.advance(5_000);
    let waited = false;
    const result = await g.whenCalm('importing', undefined, async () => {
      waited = true;
    });
    assert.equal(waited, false);
    assert.equal(result.reason, undefined);
  });
});

describe('governor at start-up', () => {
  test('does not judge CPU from a few milliseconds of history', () => {
    const m = machine({ host: 100, own: 400 });
    const g = new Governor(() => BUDGET, { now: m.now, read: m.read });
    g.sample();
    m.advance(50);
    assert.equal(g.reason(), undefined);
    m.advance(10_000);
    assert.equal(g.reason(), 'host-busy');
  });
});
