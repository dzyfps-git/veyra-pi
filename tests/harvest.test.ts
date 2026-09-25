/**
 * The harvest decision.
 *
 * Every string parsed here is real output captured from the live server on
 * spark 1.10.53, not invented for the test. The behaviour they encode was
 * verified against the shipped bytecode:
 *
 *   profilerStop  -> calls restartBackgroundSampler() unconditionally
 *   profilerCancel-> does not
 *
 * which is why harvesting is safe and cancelling would be destructive.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProfilerInfo,
  decideHarvest,
  effectiveMinAge,
  parseSavedPath,
  confirmedRestart,
  isAllowedCommand,
  COMMAND_ALLOWLIST,
  SAVED_PROFILE_PATTERN,
  commandsFor,
  staleForegroundWarning,
} from '../src/runtime/harvest.ts';

/** Verbatim from the live server, 2026-09-22. */
const STOPPED = [
  "[11:04:05] [spark-worker-pool-1-thread-1/INFO]: [⚡] The profiler isn't running!",
  '[11:04:05] [spark-worker-pool-1-thread-1/INFO]: [⚡] To start a new one, run:',
  '[11:04:05] [spark-worker-pool-1-thread-1/INFO]: [⚡]   /spark profiler start',
];

const BACKGROUND = [
  '[11:06:34] [spark-worker-pool-1-thread-1/INFO]: [⚡] Profiler is already running!',
  '[11:06:34] [spark-worker-pool-1-thread-1/INFO]: [⚡] It was started automatically when spark enabled and has been running in the background for 23s.',
  '[11:06:34] [spark-worker-pool-1-thread-1/INFO]: [⚡] To view the profiler while it\'s running, run:',
  '[11:06:34] [spark-worker-pool-1-thread-1/INFO]: [⚡]   /spark profiler open',
];

const FOREGROUND = [
  '[20:08:54] [spark-worker-pool-1-thread-3/INFO]: [⚡] Profiler is already running!',
  '[20:08:54] [spark-worker-pool-1-thread-3/INFO]: [⚡] It was started by PlayerOne 4m ago.',
  '[20:08:54] [spark-worker-pool-1-thread-3/INFO]: [⚡] To stop the profiler and upload the results, run:',
];

const SAVED = [
  '[11:06:11] [spark-worker-pool-1-thread-2/INFO]: [⚡] Stopping the profiler & saving results, please wait...',
  '[11:06:11] [spark-worker-pool-1-thread-2/INFO]: [⚡] Profiler stopped & save complete!',
  '[11:06:11] [spark-worker-pool-1-thread-2/INFO]: [⚡] Data has been written to: ./config/spark/profile-2026-09-22_11.06.11.sparkprofile',
  '[11:06:11] [spark-worker-pool-1-thread-2/INFO]: [⚡] Restarted the background profiler. (If you don\'t want this to happen, run: /spark profiler cancel)',
];

const OPTS = { minAgeSeconds: 600, allowRestore: true };

describe('reading the profiler state', () => {
  test('recognises a stopped profiler', () => {
    assert.equal(parseProfilerInfo(STOPPED).state, 'stopped');
  });

  test('recognises a background profiler and how long it has run', () => {
    const status = parseProfilerInfo(BACKGROUND);
    assert.equal(status.state, 'background');
    assert.equal(status.runningForSeconds, 23);
  });

  test('distinguishes a profiler someone started from the background one', () => {
    // Both say "already running". Only the background one says it started
    // automatically, and that distinction decides whether we may touch it.
    assert.equal(parseProfilerInfo(FOREGROUND).state, 'foreground');
  });

  test('converts minutes and hours', () => {
    const mins = parseProfilerInfo([
      '[⚡] Profiler is already running!',
      '[⚡] It was started automatically when spark enabled and has been running in the background for 47m.',
    ]);
    assert.equal(mins.runningForSeconds, 47 * 60);

    const hours = parseProfilerInfo([
      '[⚡] Profiler is already running!',
      '[⚡] It was started automatically when spark enabled and has been running in the background for 2h.',
    ]);
    assert.equal(hours.runningForSeconds, 7200);
  });

  test('unrecognised output is unknown, never assumed', () => {
    assert.equal(parseProfilerInfo([]).state, 'unknown');
    assert.equal(parseProfilerInfo(['something else entirely']).state, 'unknown');
  });
});

describe('deciding what to do', () => {
  test('harvests a mature background profiler', () => {
    const status = parseProfilerInfo([
      '[⚡] Profiler is already running!',
      '[⚡] It was started automatically when spark enabled and has been running in the background for 55m.',
    ]);
    assert.equal(decideHarvest(status, OPTS).action, 'harvest');
  });

  test('waits when the background profiler has barely started', () => {
    // 23s of data is not worth the reset that harvesting causes.
    const decision = decideHarvest(parseProfilerInfo(BACKGROUND), OPTS);
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /only been running 23s/);
  });

  test('NEVER touches a profiler someone else started', () => {
    const decision = decideHarvest(parseProfilerInfo(FOREGROUND), OPTS);
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /started by hand/);
  });

  test('restores background profiling when nothing is running', () => {
    const decision = decideHarvest(parseProfilerInfo(STOPPED), OPTS);
    assert.equal(decision.action, 'restore');
    assert.match(decision.reason, /timed manual profile/);
  });

  test('restoring can be switched off, and then it explains what to do instead', () => {
    const decision = decideHarvest(parseProfilerInfo(STOPPED), { ...OPTS, allowRestore: false });
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /nothing is being collected/);
    assert.match(decision.reason, /profiler start/);
  });

  test('an unreadable state skips rather than guesses', () => {
    const decision = decideHarvest(parseProfilerInfo(['???']), OPTS);
    assert.equal(decision.action, 'skip');
    assert.match(decision.reason, /acting on a guess/);
  });

  test('a background profiler of unknown age is harvested', () => {
    const status = parseProfilerInfo([
      '[⚡] Profiler is already running!',
      '[⚡] It was started automatically when spark enabled.',
    ]);
    assert.equal(decideHarvest(status, OPTS).action, 'harvest');
  });
});

describe('reading the result of a harvest', () => {
  test('extracts the written filename', () => {
    assert.equal(parseSavedPath(SAVED), 'profile-2026-09-22_11.06.11.sparkprofile');
  });

  test('takes only the filename, never a path the server supplied', () => {
    // The server says what it called the file. It does not get to say where.
    const evil = ['[⚡] Data has been written to: ../../../../etc/profile-2026-09-22_11.06.11.sparkprofile'];
    assert.equal(parseSavedPath(evil), 'profile-2026-09-22_11.06.11.sparkprofile');
  });

  test('refuses a filename that is not a managed profile', () => {
    assert.equal(parseSavedPath(['[⚡] Data has been written to: ./config/spark/level.dat']), undefined);
    assert.equal(parseSavedPath(['[⚡] Data has been written to: ./world/session.lock']), undefined);
  });

  test('returns undefined when nothing was written', () => {
    assert.equal(parseSavedPath(STOPPED), undefined);
  });

  test('confirms background profiling resumed', () => {
    assert.equal(confirmedRestart(SAVED), true);
    assert.equal(confirmedRestart(STOPPED), false);
  });
});

describe('the command allowlist', () => {
  test('contains only read and harvest commands', () => {
    assert.deepEqual([...COMMAND_ALLOWLIST].sort(), [
      'spark health',
      'spark profiler info',
      'spark profiler start',
      'spark profiler start --thread *',
      'spark profiler stop --save-to-file',
      'spark tps',
    ]);
  });

  test('rejects anything that could change the game', () => {
    for (const command of [
      'stop',
      'op PlayerOne',
      'ban PlayerOne',
      'say hello',
      'spark profiler cancel',
      'spark profiler stop --save-to-file; stop',
      '/stop',
      'save-all',
    ]) {
      assert.equal(isAllowedCommand(command), false, `${command} must not be allowed`);
    }
  });

  test('cancel is deliberately absent', () => {
    // profilerCancel does NOT call restartBackgroundSampler, so cancelling
    // would leave the server with no profiler at all.
    assert.equal(isAllowedCommand('spark profiler cancel'), false);
  });
});

describe('the managed filename pattern', () => {
  test('matches what spark actually writes', () => {
    assert.ok(SAVED_PROFILE_PATTERN.test('profile-2026-09-22_11.06.11.sparkprofile'));
  });

  test('matches nothing else in the spark directory', () => {
    for (const name of ['activity.json', 'config.json', 'tmp', 'profile.sparkprofile', 'level.dat']) {
      assert.equal(SAVED_PROFILE_PATTERN.test(name), false, `${name} must not match`);
    }
  });
});

describe('restoring takes two commands, not one', () => {
  test('a bare start would leave a foreground profiler running', () => {
    // This is the whole point: `profiler start` does not start a BACKGROUND
    // profiler, so the thing being restored would not be restored.
    assert.deepEqual(commandsFor('restore'), [
      'spark profiler start',
      'spark profiler stop --save-to-file',
    ]);
  });

  test('harvesting is a single stop, which restarts the background profiler', () => {
    assert.deepEqual(commandsFor('harvest'), ['spark profiler stop --save-to-file']);
  });

  test('skipping sends nothing at all', () => {
    assert.deepEqual(commandsFor('skip'), []);
  });

  test('every command a sequence uses is on the allowlist', () => {
    for (const action of ['harvest', 'restore', 'complete-restore', 'skip'] as const) {
      for (const command of commandsFor(action)) {
        assert.ok(isAllowedCommand(command), `${command} must be allowlisted`);
      }
    }
  });
});

describe('a half-finished restore is finished, not abandoned', () => {
  const FOREGROUND_AFTER_RESTORE = [
    '[⚡] Profiler is already running!',
    '[⚡] It was started by console 1m ago.',
  ];

  test('without the pending flag, the collector would skip its own profiler forever', () => {
    // The trap: a bare start makes `profiler info` report a foreground
    // profiler, which normally means "leave it alone" -- so the collector
    // would back away from a condition it created itself, permanently.
    const decision = decideHarvest(parseProfilerInfo(FOREGROUND_AFTER_RESTORE), OPTS);
    assert.equal(decision.action, 'skip');
  });

  test('with the pending flag it completes the stop', () => {
    const decision = decideHarvest(parseProfilerInfo(FOREGROUND_AFTER_RESTORE), {
      ...OPTS,
      restorePending: true,
    });
    assert.equal(decision.action, 'complete-restore');
    assert.match(decision.reason, /this collector started/);
    assert.deepEqual(commandsFor(decision.action), ['spark profiler stop --save-to-file']);
  });

  test('a pending restore never touches a BACKGROUND profiler differently', () => {
    // Once background profiling is back, the restore is over.
    const status = parseProfilerInfo([
      '[⚡] Profiler is already running!',
      '[⚡] It was started automatically when spark enabled and has been running in the background for 55m.',
    ]);
    assert.equal(decideHarvest(status, { ...OPTS, restorePending: true }).action, 'harvest');
  });
});

describe('a profiler left running by hand', () => {
  const longRunning = (hours: number) =>
    parseProfilerInfo([
      '[⚡] Profiler is already running!',
      `[⚡] It was started automatically when spark enabled and has been running in the background for ${hours}h.`,
    ]);

  test('a long BACKGROUND profiler is normal and draws no warning', () => {
    assert.equal(staleForegroundWarning(longRunning(12)), undefined);
  });

  test('a long FOREGROUND profiler is flagged, because nothing is being archived', () => {
    const status = parseProfilerInfo([
      '[⚡] Profiler is already running!',
      '[⚡] It was started by PlayerOne 9h ago.',
    ]);
    // Duration only parses from the background phrasing, so synthesise it.
    const warning = staleForegroundWarning({ ...status, runningForSeconds: 9 * 3600 });
    assert.ok(warning);
    assert.match(warning, /nothing is being archived/);
    assert.match(warning, /profiler stop/);
  });

  test('a short foreground profiler is left alone silently', () => {
    const status = parseProfilerInfo(['[⚡] Profiler is already running!', '[⚡] It was started by PlayerOne 2m ago.']);
    assert.equal(staleForegroundWarning({ ...status, runningForSeconds: 120 }), undefined);
  });
});

describe('minimum data never outlasts the harvest interval', () => {
  test('a 5-minute interval harvests every cycle, not every other', () => {
    assert.equal(effectiveMinAge(600, 5), 180);
    assert.ok(effectiveMinAge(600, 5) < 300, 'a profiler 300s old after one cycle must be harvestable');
  });
  test('a long interval keeps the setting', () => {
    assert.equal(effectiveMinAge(600, 60), 600);
  });
  test('a very short interval still waits a minute', () => {
    assert.equal(effectiveMinAge(600, 1), 60);
  });
});
