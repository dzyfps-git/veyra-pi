/**
 * Spotting the moment background profiling dies, from the log alone.
 *
 * Every line below is real, from the live server. The pattern has now
 * happened twice: a timed manual profile ends on its timeout and nothing
 * restarts the background sampler.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { judgeLogLines, LogTail } from '../src/runtime/logwatch.ts';

describe('judging new log lines', () => {
  test('a timed profile ending on its timeout means background profiling is lost', () => {
    const verdict = judgeLogLines([
      '[16:24:07] [spark-worker-pool-1-thread-3/INFO]: [⚡] Profiler is now running! (async)',
      '[16:26:07] [ForkJoinPool.commonPool-worker-9/INFO]: [⚡] The active profiler has completed! Uploading results...',
      '[16:26:09] [ForkJoinPool.commonPool-worker-9/INFO]: [⚡] Profiler stopped & upload complete!',
    ]);
    assert.equal(verdict.backgroundLikelyLost, true);
  });

  test("the harvester's own stop is followed by a restart, so it does not trigger", () => {
    const verdict = judgeLogLines([
      '[11:06:11] [spark-worker-pool-1-thread-2/INFO]: [⚡] Profiler stopped & save complete!',
      '[11:06:11] [spark-worker-pool-1-thread-2/INFO]: [⚡] Restarted the background profiler.',
    ]);
    assert.equal(verdict.backgroundLikelyLost, false, 'reacting to our own harvest would loop forever');
  });

  test('a cancel is lost too, because cancel never restarts it', () => {
    assert.equal(judgeLogLines(['[⚡] Profiler has been cancelled.']).backgroundLikelyLost, true);
  });

  test('ordinary gameplay lines never trigger', () => {
    const verdict = judgeLogLines([
      '[17:04:17] [Server thread/INFO]: PlayerTwo has completed the challenge [Centennial]',
      '[17:58:55] [Server thread/INFO]: PlayerThree has completed the challenge [Sniper Duel]',
    ]);
    assert.equal(verdict.backgroundLikelyLost, false, '"completed the challenge" must not look like a profiler');
  });

  test('a loss followed later by a restart is not a loss', () => {
    const verdict = judgeLogLines([
      '[⚡] The active profiler has completed! Uploading results...',
      '[⚡] Restarted the background profiler.',
    ]);
    assert.equal(verdict.backgroundLikelyLost, false);
  });
});

describe('tailing the log', () => {
  function tempLog(content: string): string {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'perfint-log-')), 'latest.log');
    writeFileSync(file, content);
    return file;
  }

  test('the first read starts at the end, so old events are not replayed', () => {
    const file = tempLog('[⚡] The active profiler has completed!\n');
    const tail = new LogTail(file);
    assert.deepEqual(tail.read(), []);
  });

  test('later reads return only what was appended', () => {
    const file = tempLog('old line\n');
    const tail = new LogTail(file);
    tail.read();
    appendFileSync(file, 'new one\nnew two\n');
    assert.deepEqual(tail.read(), ['new one', 'new two']);
    assert.deepEqual(tail.read(), []);
  });

  test('a half-written line is held until it is complete', () => {
    const file = tempLog('');
    const tail = new LogTail(file);
    tail.read();
    appendFileSync(file, 'partial');
    assert.deepEqual(tail.read(), []);
    appendFileSync(file, ' line\n');
    assert.deepEqual(tail.read(), ['partial line']);
  });

  test('a rotated log is read from the top', () => {
    const file = tempLog('a long line from before midnight that makes this file larger\n');
    const tail = new LogTail(file);
    tail.read();
    writeFileSync(file, 'fresh\n');
    assert.deepEqual(tail.read(), ['fresh']);
  });

  test('a missing file is simply nothing new', () => {
    assert.deepEqual(new LogTail('Z:/does/not/exist.log').read(), []);
  });
});
