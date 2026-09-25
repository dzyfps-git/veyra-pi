import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ServerLink, DEFAULT_LINK_CONFIG, type Clock } from '../src/runtime/link.ts';

/** Controllable clock so these tests do not depend on wall time. */
class FakeClock implements Clock {
  t = 1_700_000_000_000;
  now(): number { return this.t; }
  advance(seconds: number): void { this.t += seconds * 1000; }
}

function makeServer(opts: { withLog: boolean; logAgeSeconds?: number }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'perfint-link-'));
  mkdirSync(path.join(root, 'config', 'spark'), { recursive: true });
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  if (opts.withLog) {
    const log = path.join(root, 'logs', 'latest.log');
    writeFileSync(log, 'x');
    if (opts.logAgeSeconds !== undefined) {
      const when = new Date(Date.now() - opts.logAgeSeconds * 1000);
      utimesSync(log, when, when);
    }
  }
  return root;
}

/**
 * Liveness is injected, never real. These tests must not depend on a network,
 * and the point under test is the state machine, not the wire protocol.
 */
function link(root: string, clock: FakeClock, id = 's1', mcUp = true) {
  return new ServerLink(
    {
      ...DEFAULT_LINK_CONFIG,
      serverId: id,
      displayName: id,
      root,
      sparkDir: 'config/spark',
      logFile: 'logs/latest.log',
      pingHost: '127.0.0.1',
      pingPort: 25565,
      ping: async () => ({ online: mcUp, latencyMs: 1, ...(mcUp ? { playersOnline: 3 } : { error: 'refused' }) }),
    },
    clock,
  );
}

describe('server link state', () => {
  test('a live server with a fresh log is online', async () => {
    const clock = new FakeClock();
    const root = makeServer({ withLog: true });
    // Align the fake clock with real mtime so the age calculation is sane.
    clock.t = Date.now();
    const l = link(root, clock);
    const r = await l.probe();
    assert.equal(r.reachable, true);
    assert.equal(l.state, 'online');
    assert.equal(l.usable, true);
    rmSync(root, { recursive: true, force: true });
  });

  test('a SILENT but running server stays online (the log-freshness trap)', async () => {
    // An idle server with no players can go hours without writing to
    // latest.log. Liveness must come from the ping, never from log age, or
    // collection would switch off during exactly the quiet baseline periods
    // that are most worth recording.
    const clock = new FakeClock();
    const root = makeServer({ withLog: true, logAgeSeconds: 6 * 3600 });
    clock.t = Date.now();
    const l = link(root, clock, 's1', true);
    const r = await l.probe();
    assert.ok((r.logAgeSeconds ?? 0) > 3600, 'precondition: the log really is stale');
    assert.equal(l.state, 'online', 'a stale log must not mark a live server as down');
    assert.equal(l.usable, true, 'collection must continue through quiet periods');
    rmSync(root, { recursive: true, force: true });
  });

  test('reachable but Minecraft not answering is idle, not offline', async () => {
    const clock = new FakeClock();
    const root = makeServer({ withLog: true });
    clock.t = Date.now();
    const l = link(root, clock, 's1', false);
    await l.probe();
    assert.equal(l.state, 'idle', 'the share is there; Minecraft just is not running');
    assert.equal(l.usable, false);
    rmSync(root, { recursive: true, force: true });
  });

  test('a booting VM is "starting", not an error', async () => {
    const clock = new FakeClock();
    const l = link('Z:/definitely-not-mounted', clock, 's1', false);
    await l.probe();
    assert.equal(l.state, 'starting', 'absence during the grace period is expected');
  });

  test('after the grace period, absence becomes offline', async () => {
    const clock = new FakeClock();
    const l = link('Z:/definitely-not-mounted', clock, 's1', false);
    clock.advance(DEFAULT_LINK_CONFIG.startupGraceSeconds + 10);
    await l.probe();
    assert.equal(l.state, 'offline');
  });

  test('backoff grows and is capped', async () => {
    const clock = new FakeClock();
    const l = link('Z:/definitely-not-mounted', clock, 's1', false);
    clock.advance(DEFAULT_LINK_CONFIG.startupGraceSeconds + 10);

    const waits: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      await l.probe();
      const snap = l.snapshot();
      waits.push((snap.nextProbeAt - clock.now()) / 1000);
      clock.advance((snap.nextProbeAt - clock.now()) / 1000);
    }
    assert.ok(waits[0]! < waits[3]!, 'backoff should grow');
    const cap = DEFAULT_LINK_CONFIG.backoffMaxSeconds;
    for (const w of waits) assert.ok(w <= cap * 1.25, `wait ${w}s must respect the ${cap}s cap`);
    assert.ok(waits.at(-1)! > 300, 'a long outage should settle into infrequent checks');
  });

  test('recovery is automatic and resets backoff', async () => {
    const clock = new FakeClock();
    const root = makeServer({ withLog: true });
    const l = link(path.join(root, 'nope'), clock, 's1', false);
    clock.advance(DEFAULT_LINK_CONFIG.startupGraceSeconds + 10);
    await l.probe();
    await l.probe();
    assert.equal(l.state, 'offline');
    assert.ok(l.snapshot().consecutiveFailures >= 2);

    // The server comes back: point the link at the real root.
    const recovered = link(root, clock);
    clock.t = Date.now();
    await recovered.probe();
    assert.equal(recovered.state, 'online');
    assert.equal(recovered.snapshot().consecutiveFailures, 0);
    rmSync(root, { recursive: true, force: true });
  });

  test('pausing suppresses probing entirely', async () => {
    const clock = new FakeClock();
    const l = link('Z:/nope', clock, 's1', false);
    l.setPaused(true);
    assert.equal(l.state, 'paused');
    assert.equal(l.dueForProbe(), false);
    assert.equal(l.usable, false);
  });
});

describe('isolation between servers', () => {
  test('one dead server does not affect another', async () => {
    const clock = new FakeClock();
    const goodRoot = makeServer({ withLog: true });
    clock.t = Date.now();

    const good = link(goodRoot, clock, 'good');
    const bad = link('Z:/definitely-not-mounted', clock, 'bad', false);

    clock.advance(DEFAULT_LINK_CONFIG.startupGraceSeconds + 10);
    for (let i = 0; i < 5; i += 1) await bad.probe();

    // A running server writes to its log; keep it fresh relative to the
    // advanced clock, otherwise we would be testing log staleness, not
    // isolation.
    const freshness = new Date(clock.now());
    utimesSync(path.join(goodRoot, 'logs', 'latest.log'), freshness, freshness);
    await good.probe();

    assert.equal(bad.state, 'offline');
    assert.equal(good.state, 'online', 'a healthy server must be unaffected by a dead one');
    assert.equal(good.snapshot().consecutiveFailures, 0);
    // And the dead one must not be probed on the healthy cadence.
    assert.ok(
      bad.snapshot().nextProbeAt - good.snapshot().nextProbeAt > 60_000,
      'the offline server should have backed off well beyond the healthy interval',
    );
    rmSync(goodRoot, { recursive: true, force: true });
  });
});
