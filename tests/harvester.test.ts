/**
 * The harvest cycle, end to end, against a fake server.
 *
 * The transport is the only thing faked. Everything else -- the decision,
 * the command sequence, file discovery, the stability check, the hash
 * comparison against source truth, the audit trail -- is the real code.
 *
 * The cases here are the ones that cannot safely be produced on production:
 * a file still being written, a copy that does not match, a restore
 * interrupted halfway. They are also the ones most likely to go wrong.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { retryUnread, runAllThreadsCycle, runHarvestCycle, unreadHarvests, type HarvestDeps } from '../src/runtime/harvester.ts';
import type { ConsoleTransport, ConsoleResult, RemoteFileState } from '../src/runtime/console.ts';
import {
  commandScript,
  inspectScript,
  extractOutput,
  parseInspect,
  assertSafe,
  ConsoleInputError,
} from '../src/runtime/console.ts';
import type { AllowedCommand } from '../src/runtime/harvest.ts';
import { NO_MAPPINGS } from '../src/decode/mappings.ts';

const FILE = 'profile-2026-09-22_23.00.00.sparkprofile';
const BYTES = Buffer.from('pretend this is an hour of samples');
const HASH = createHash('sha256').update(BYTES).digest('hex');

const INFO_BACKGROUND_MATURE = [
  '[⚡] Profiler is already running!',
  '[⚡] It was started automatically when spark enabled and has been running in the background for 55m.',
];
const INFO_BACKGROUND_YOUNG = [
  '[⚡] Profiler is already running!',
  '[⚡] It was started automatically when spark enabled and has been running in the background for 40s.',
];
const INFO_FOREGROUND = ['[⚡] Profiler is already running!', '[⚡] It was started by PlayerOne 4m ago.'];
const INFO_STOPPED = ["[⚡] The profiler isn't running!"];
const STOP_SAVED = [
  '[⚡] Profiler stopped & save complete!',
  `[⚡] Data has been written to: ./config/spark/${FILE}`,
  "[⚡] Restarted the background profiler. (If you don't want this to happen, run: /spark profiler cancel)",
];

/** A scripted server. Each command returns the next queued response for it. */
class FakeConsole implements ConsoleTransport {
  sent: AllowedCommand[] = [];
  responses = new Map<string, ConsoleResult[]>();
  inspect: { first: RemoteFileState; second: RemoteFileState } = {
    first: { exists: true, size: BYTES.length, mtime: 100 },
    second: { exists: true, size: BYTES.length, mtime: 100, sha256: HASH },
  };

  on(command: AllowedCommand, lines: string[], ok = true): this {
    const queue = this.responses.get(command) ?? [];
    queue.push(ok ? { ok, lines } : { ok, lines: [], error: 'ssh: connection refused' });
    this.responses.set(command, queue);
    return this;
  }

  async run(command: AllowedCommand): Promise<ConsoleResult> {
    this.sent.push(command);
    const queue = this.responses.get(command) ?? [];
    return queue.shift() ?? { ok: false, lines: [], error: `no scripted response for ${command}` };
  }

  async inspectSparkFile() {
    return this.inspect;
  }

  async serverDir() {
    return '/srv/minecraft';
  }
}

let store: Store;
let sparkDir: string;
let ingested: string[];

function deps(fake: FakeConsole, overrides: Partial<HarvestDeps> = {}): HarvestDeps {
  return {
    console: fake,
    store,
    serverId: 's1',
    decide: { minAgeSeconds: 600, allowRestore: true },
    localSparkDir: sparkDir,
    mappings: NO_MAPPINGS,
    archiveRaw: true,
    serverRoot: path.dirname(path.dirname(sparkDir)),
    log: () => {},
    stabilityWaitMs: 0,
    settleMs: { info: 0, start: 0, stop: 0 },
    readRetryMs: [0],
    ingest: (file) => {
      ingested.push(path.basename(file));
      return { status: 'ingested', captureId: 42 };
    },
    ...overrides,
  };
}

function actions(): Array<{ action: string; outcome: string; target: string | null }> {
  return store.db
    .prepare('SELECT action, outcome, target FROM server_action ORDER BY id')
    .all() as Array<{ action: string; outcome: string; target: string | null }>;
}

beforeEach(() => {
  store = new Store({ file: path.join(mkdtempSync(path.join(tmpdir(), 'perfint-harvest-')), 'perfint.sqlite') });
  store.upsertServer('s1', 'main', 'Main');
  const root = mkdtempSync(path.join(tmpdir(), 'perfint-server-'));
  sparkDir = path.join(root, 'config', 'spark');
  mkdirSync(sparkDir, { recursive: true });
  writeFileSync(path.join(sparkDir, FILE), BYTES);
  ingested = [];
});

describe('the normal hourly harvest', () => {
  test('reads state, stops with save, verifies against the server hash, ingests', async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', STOP_SAVED);

    const outcome = await runHarvestCycle(deps(fake));

    assert.equal(outcome.kind, 'harvested');
    assert.equal(outcome.kind === 'harvested' && outcome.sha256, HASH);
    assert.equal(outcome.kind === 'harvested' && outcome.restarted, true);
    assert.deepEqual(fake.sent, ['spark profiler info', 'spark profiler stop --save-to-file']);
    assert.deepEqual(ingested, [FILE]);
  });

  test('every command sent is audited', async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    await runHarvestCycle(deps(fake));

    const trail = actions();
    const consoleRows = trail.filter((a) => a.action === 'console');
    assert.deepEqual(
      consoleRows.map((r) => r.target),
      ['spark profiler info', 'spark profiler stop --save-to-file'],
    );
    assert.ok(trail.some((a) => a.action === 'verify' && a.outcome === 'match'));
    assert.ok(trail.some((a) => a.action === 'ingest'));
  });
});

describe('what it refuses to touch', () => {
  test("never stops a profiler someone else started", async () => {
    const fake = new FakeConsole().on('spark profiler info', INFO_FOREGROUND);
    const outcome = await runHarvestCycle(deps(fake));
    assert.equal(outcome.kind, 'skipped');
    assert.deepEqual(fake.sent, ['spark profiler info'], 'only the read-only query may be sent');
  });

  test('waits when the background profiler is too young to be worth resetting', async () => {
    const fake = new FakeConsole().on('spark profiler info', INFO_BACKGROUND_YOUNG);
    const outcome = await runHarvestCycle(deps(fake));
    assert.equal(outcome.kind, 'skipped');
    assert.deepEqual(fake.sent, ['spark profiler info']);
  });

  test('an unreachable console is a failure, and nothing else is sent', async () => {
    const fake = new FakeConsole().on('spark profiler info', [], false);
    const outcome = await runHarvestCycle(deps(fake));
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(fake.sent, ['spark profiler info']);
  });
});

describe('verification against source truth', () => {
  test('a file still being written is not copied', async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    fake.inspect = {
      first: { exists: true, size: 1000, mtime: 100 },
      second: { exists: true, size: 2000, mtime: 101, sha256: HASH },
    };
    const outcome = await runHarvestCycle(deps(fake));
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /still being written/);
    assert.deepEqual(ingested, [], 'a half-written file must never be ingested');
  });

  test('a copy that does not match the server hash is discarded', async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    fake.inspect.second = { ...fake.inspect.second, sha256: 'f'.repeat(64) };
    const outcome = await runHarvestCycle(deps(fake));
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /does not match/);
    assert.deepEqual(ingested, []);
    assert.ok(actions().some((a) => a.action === 'verify' && a.outcome === 'mismatch'));
  });

  test('a missed confirmation line falls back to the newest managed file', async () => {
    // Serialising an hour can outlast the settle window.
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', ['[⚡] Stopping the profiler & saving results, please wait...']);
    const outcome = await runHarvestCycle(deps(fake, { now: () => Date.now() }));
    assert.equal(outcome.kind, 'harvested');
    assert.deepEqual(ingested, [FILE]);
  });
});

describe('restoring lost background profiling', () => {
  test('sends start THEN stop, never start alone', async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_STOPPED)
      .on('spark profiler start', ['[⚡] Profiler is now running! (async)'])
      .on('spark profiler stop --save-to-file', STOP_SAVED);

    const outcome = await runHarvestCycle(deps(fake));
    assert.equal(outcome.kind, 'restored');
    assert.equal(outcome.kind === 'restored' && outcome.restarted, true);
    assert.deepEqual(fake.sent, [
      'spark profiler info',
      'spark profiler start',
      'spark profiler stop --save-to-file',
    ]);
    assert.equal(store.getMeta('harvest.restorePendingSince'), '', 'a completed restore clears its marker');
  });

  test('a restore interrupted after start is finished on the next cycle', async () => {
    // Cycle 1: start lands, stop fails. A foreground profiler is now running
    // that WE started.
    const first = new FakeConsole()
      .on('spark profiler info', INFO_STOPPED)
      .on('spark profiler start', ['[⚡] Profiler is now running! (async)'])
      .on('spark profiler stop --save-to-file', [], false);
    const one = await runHarvestCycle(deps(first));
    assert.equal(one.kind, 'failed');
    assert.ok(store.getMeta('harvest.restorePendingSince'), 'the unfinished restore must be remembered');

    // Cycle 2: info shows a foreground profiler. Without the marker this
    // would be skipped forever as "someone else's"; with it, it is finished.
    const second = new FakeConsole()
      .on('spark profiler info', ['[⚡] Profiler is already running!', '[⚡] It was started by console 1m ago.'])
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    const two = await runHarvestCycle(deps(second));
    assert.equal(two.kind, 'harvested');
    assert.deepEqual(second.sent, ['spark profiler info', 'spark profiler stop --save-to-file']);
    assert.equal(store.getMeta('harvest.restorePendingSince'), '');
  });

  test('if start itself fails, no stop is sent', async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_STOPPED)
      .on('spark profiler start', [], false);
    const outcome = await runHarvestCycle(deps(fake));
    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /nothing was left half-done/);
    assert.deepEqual(fake.sent, ['spark profiler info', 'spark profiler start']);
  });

  test('restoring can be switched off', async () => {
    const fake = new FakeConsole().on('spark profiler info', INFO_STOPPED);
    const outcome = await runHarvestCycle(deps(fake, { decide: { minAgeSeconds: 600, allowRestore: false } }));
    assert.equal(outcome.kind, 'skipped');
    assert.deepEqual(fake.sent, ['spark profiler info']);
  });
});

describe('the remote scripts', () => {
  test('refuse anything unsafe before it reaches a shell', () => {
    for (const [kind, value] of [
      ['host', 'mc; rm -rf /'],
      ['tmux', "mc'; stop; '"],
      ['dir', '/srv/minecraft/../../etc'],
      ['dir', 'relative/path'],
      ['file', '../level.dat'],
      ['file', 'profile-2026-09-22_23.00.00.sparkprofile; rm x'],
    ] as const) {
      assert.throws(() => assertSafe(kind, value), ConsoleInputError, `${kind} ${value}`);
    }
  });

  test('only allowlisted commands can be scripted', () => {
    assert.throws(() => commandScript('stop' as AllowedCommand, 'mc', '/srv/mc', 1000), ConsoleInputError);
  });

  test('the command script handles log rotation', () => {
    const script = commandScript('spark profiler info', 'mc', '/srv/minecraft', 4000);
    assert.match(script, /if \[ "\$AFTER" -lt "\$BEFORE" \]; then BEFORE=0; fi/);
    assert.match(script, /send-keys -t 'mc' -l 'spark profiler info'/);
  });

  test('output between the markers is extracted, and missing markers are a failure', () => {
    assert.deepEqual(extractOutput('noise\n__PERFINT_BEGIN__\na\nb\n__PERFINT_END__\n'), ['a', 'b']);
    assert.equal(extractOutput('connection closed'), undefined);
  });

  test('inspection parses a stable file and a vanished one', () => {
    const script = inspectScript(FILE, '/srv/minecraft', 6000);
    assert.match(script, /sha256sum/);
    const parsed = parseInspect(`A 123 456\nB 123 456 ${HASH}\n`);
    assert.deepEqual(parsed.second, { exists: true, size: 123, mtime: 456, sha256: HASH });
    assert.equal(parseInspect('MISSING').first.exists, false);
  });
});

describe('sharing the console with people and other tools', () => {
  const busy = (why: string): ConsoleResult => ({ ok: false, busy: why, lines: [], error: `console in use: ${why}` });

  test('when the console is in use, nothing is sent and the cycle waits', async () => {
    const fake = new FakeConsole();
    fake.responses.set('spark profiler info', [busy('there is unsent text on the console input line')]);
    const outcome = await runHarvestCycle(deps(fake));
    assert.equal(outcome.kind, 'skipped');
    assert.match(outcome.kind === 'skipped' ? outcome.reason : '', /^waiting: there is unsent text/);
    assert.deepEqual(fake.sent, ['spark profiler info']);
    assert.equal(actions().at(-1)?.outcome, 'held');
  });

  test("a restore's stop waits for the console rather than leaving the restore half-done", async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_STOPPED)
      .on('spark profiler start', ['[⚡] Profiler is now running! (async)']);
    fake.responses.set('spark profiler stop --save-to-file', [busy('world saving is switched off, so a backup is probably running'), { ok: true, lines: STOP_SAVED }]);
    let clock = 0;
    const waits: number[] = [];
    const outcome = await runHarvestCycle(
      deps(fake, { now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } }),
    );
    assert.equal(outcome.kind, 'restored');
    assert.deepEqual(waits, [10_000]);
    assert.deepEqual(fake.sent, ['spark profiler info', 'spark profiler start', 'spark profiler stop --save-to-file', 'spark profiler stop --save-to-file']);
  });

  test('the command script checks the console first and types in one step', () => {
    const script = commandScript('spark profiler info', 'mc', '/srv/minecraft', 4000);
    const check = script.indexOf('Automatic saving is now');
    const typed = script.indexOf("send-keys -t 'mc' -l 'spark profiler info'");
    assert.ok(check > 0 && typed > check, 'the checks come before anything is typed');
    assert.match(script, /send-keys -t 'mc' -l 'spark profiler info' \\; send-keys -t 'mc' Enter/);
    assert.match(script, /pane_in_mode/);
    assert.match(script, /unsent text/);
    assert.match(script, /client_activity/);
    assert.doesNotMatch(script, /C-u|C-c|Escape/, 'never clears or interrupts what someone typed');
  });
});

describe('all-thread profiles', () => {
  const INFO_FOREGROUND = ['[⚡] Profiler is already running!', '[⚡] It has been running for 30s.'];

  test('starts over the background profiler, waits, stops, and keeps it apart from captures', async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler start --thread *', ['[⚡] Profiler is now running! (async)'])
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    const kept: string[] = [];
    const waits: number[] = [];
    const outcome = await runAllThreadsCycle({
      ...deps(fake, {
        sleep: async (ms) => {
          waits.push(ms);
        },
        keepThreadProfile: (file) => {
          kept.push(path.basename(file));
          return 7;
        },
      }),
      seconds: 120,
    });
    assert.equal(outcome.kind, 'all-threads');
    assert.equal(outcome.kind === 'all-threads' && outcome.profileId, 7);
    assert.deepEqual(fake.sent, ['spark profiler info', 'spark profiler start --thread *', 'spark profiler stop --save-to-file']);
    assert.deepEqual(waits, [120_000]);
    assert.deepEqual(kept, [FILE]);
    assert.deepEqual(ingested, [], 'never imported as a normal capture');
    assert.equal(store.getMeta('harvest.allThreadsSince'), '');
  });

  test('never starts over someone else’s profiler', async () => {
    const fake = new FakeConsole().on('spark profiler info', INFO_FOREGROUND);
    const outcome = await runAllThreadsCycle({ ...deps(fake), seconds: 120 });
    assert.equal(outcome.kind, 'skipped');
    assert.deepEqual(fake.sent, ['spark profiler info']);
  });

  test('one left running by a restart is finished by the next harvest and kept', async () => {
    store.setMeta('harvest.allThreadsSince', '123');
    const fake = new FakeConsole().on('spark profiler info', INFO_FOREGROUND).on('spark profiler stop --save-to-file', STOP_SAVED);
    const kept: string[] = [];
    const outcome = await runHarvestCycle(deps(fake, { keepThreadProfile: (f) => (kept.push(path.basename(f)), 1) }));
    assert.equal(outcome.kind, 'all-threads');
    assert.deepEqual(kept, [FILE]);
    assert.deepEqual(ingested, []);
    assert.equal(store.getMeta('harvest.allThreadsSince'), '');
  });
});

describe('all-thread profiles that do not start', () => {
  test('back off and forget, so a later profile of yours is never mistaken for one of ours', async () => {
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler start --thread *', ['[⚡] Unknown argument'])
      .on('spark profiler info', INFO_BACKGROUND_MATURE);
    const outcome = await runAllThreadsCycle({ ...deps(fake, { sleep: async () => {} }), seconds: 120 });
    assert.equal(outcome.kind, 'failed');
    assert.deepEqual(fake.sent, ['spark profiler info', 'spark profiler start --thread *', 'spark profiler info']);
    assert.equal(store.getMeta('harvest.allThreadsSince'), '');
  });
});

describe('a verified file Windows briefly cannot see', () => {
  test('is read again after a pause instead of failing the harvest', async () => {
    const hidden = path.join(sparkDir, FILE);
    const { rmSync } = await import('node:fs');
    rmSync(hidden);
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    const waits: number[] = [];
    const outcome = await runHarvestCycle(
      deps(fake, {
        readRetryMs: [0, 2_000, 5_000],
        // The share "catches up" during the first pause.
        sleep: async (ms) => {
          waits.push(ms);
          writeFileSync(hidden, BYTES);
        },
      }),
    );
    assert.equal(outcome.kind, 'harvested');
    assert.deepEqual(waits, [2_000]);
    assert.deepEqual(ingested, [FILE]);
  });

  test('is waited for, not called a failure, when it still does not appear, and says so in the audit', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(path.join(sparkDir, FILE));
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    const outcome = await runHarvestCycle(deps(fake, { readRetryMs: [0, 1, 1], sleep: async () => {} }));
    assert.equal(outcome.kind, 'deferred');
    assert.match((outcome as { reason: string }).reason, /not visible/);
    assert.ok(actions().some((a) => a.action === 'verify' && a.outcome === 'waiting' && a.target === FILE));
    assert.ok(actions().some((a) => a.action === 'recover' && a.outcome === 'waiting' && a.target === FILE));
  });
});

describe('harvests saved but never imported', () => {
  test('are recovered at the start of the next cycle, once', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(path.join(sparkDir, FILE));
    const first = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    assert.equal((await runHarvestCycle(deps(first))).kind, 'deferred');
    assert.deepEqual(ingested, []);

    // The file is readable again by the next cycle, which happens to be skipped.
    writeFileSync(path.join(sparkDir, FILE), BYTES);
    const logs: string[] = [];
    const second = new FakeConsole().on('spark profiler info', INFO_BACKGROUND_YOUNG);
    const outcome = await runHarvestCycle(deps(second, { log: (_l, m) => logs.push(m) }));
    assert.equal(outcome.kind, 'skipped');
    assert.deepEqual(ingested, [FILE]);
    assert.ok(logs.some((m) => /recovered profile-2026-09-22_23\.00\.00/.test(m)));

    // Imported now, so never again.
    const third = new FakeConsole().on('spark profiler info', INFO_BACKGROUND_YOUNG);
    await runHarvestCycle(deps(third));
    assert.deepEqual(ingested, [FILE]);
  });

  test('a file the share never shows is tried for about an hour, then listed, and Try again gives it its tries back', async () => {
    const { rmSync, existsSync } = await import('node:fs');
    rmSync(path.join(sparkDir, FILE));
    const first = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    await runHarvestCycle(deps(first));
    const later = async (): Promise<void> => {
      await runHarvestCycle(deps(new FakeConsole().on('spark profiler info', INFO_BACKGROUND_YOUNG)));
    };
    for (let i = 0; i < 15; i += 1) await later();
    const tries = actions().filter((a) => a.action === 'recover' && a.target === FILE);
    assert.equal(tries.length, 12);
    assert.deepEqual(unreadHarvests(store.db, 's1'), [FILE]);
    assert.equal(existsSync(path.join(sparkDir, FILE)), false, 'nothing was created or touched on the server');

    // Try again: the file shows up now and is read at the next collection.
    assert.equal(retryUnread(store.db, 's1'), 1);
    assert.deepEqual(unreadHarvests(store.db, 's1'), []);
    writeFileSync(path.join(sparkDir, FILE), BYTES);
    await later();
    assert.deepEqual(ingested, [FILE]);
  });

  test('an all-thread profile is never recovered as a capture', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(path.join(sparkDir, FILE));
    const fake = new FakeConsole()
      .on('spark profiler info', INFO_BACKGROUND_MATURE)
      .on('spark profiler start --thread *', ['[⚡] Profiler is now running!'])
      .on('spark profiler stop --save-to-file', STOP_SAVED);
    await runAllThreadsCycle({ ...deps(fake, { sleep: async () => {} }), seconds: 1 });
    writeFileSync(path.join(sparkDir, FILE), BYTES);
    await runHarvestCycle(deps(new FakeConsole().on('spark profiler info', INFO_BACKGROUND_YOUNG)));
    assert.deepEqual(ingested, []);
  });
});
