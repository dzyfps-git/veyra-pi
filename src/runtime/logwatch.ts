/**
 * Watch the server log for the moment background profiling dies.
 *
 * spark stops its background sampler whenever a TIMED manual profile ends on
 * its timeout, and does not restart it. That has now been observed twice on
 * the live server, both times from a routine two-to-five-minute profile, and
 * both times it silently ended continuous collection -- once for 14.5 hours,
 * once twelve minutes into a brand new world.
 *
 * An hourly harvest cycle would eventually notice and restore it, but "within
 * the hour" means up to an hour lost every time someone profiles. The log
 * says exactly when it happens, so this reads the log instead of waiting.
 *
 * Passive by construction: it reads a file and returns a verdict. It sends
 * nothing and changes nothing. Acting on the verdict is the harvest cycle's
 * job, behind the same switch and the same checks as everything else.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

/** Lines that mean a profiler just finished and background profiling may be gone. */
const ENDED = [
  /The active profiler has completed!/i,
  /Profiler stopped & upload complete!/i,
  /Profiler has been cancelled\./i,
];

/** A line that means background profiling came back on its own. */
const RESTARTED = /Restarted the background profiler/i;

export interface LogScan {
  /** A profiler ended and nothing said background profiling restarted. */
  backgroundLikelyLost: boolean;
  /** The line that triggered it, for the log. */
  evidence?: string;
}

/**
 * Judge a batch of new log lines.
 *
 * A stop issued by the harvester is followed by "Restarted the background
 * profiler", so it cancels out and does not trigger a restore. Only an ending
 * with NO restart after it counts -- which is precisely the timeout path.
 */
export function judgeLogLines(lines: readonly string[]): LogScan {
  let lastEnded = -1;
  let lastRestarted = -1;
  let evidence: string | undefined;

  lines.forEach((line, index) => {
    if (ENDED.some((re) => re.test(line))) {
      lastEnded = index;
      evidence = line.trim();
    }
    if (RESTARTED.test(line)) lastRestarted = index;
  });

  if (lastEnded === -1 || lastRestarted > lastEnded) return { backgroundLikelyLost: false };
  return evidence === undefined ? { backgroundLikelyLost: true } : { backgroundLikelyLost: true, evidence };
}

/**
 * Reads only what was appended since the last call.
 *
 * Remembers a byte offset. If the file shrank, it was rotated, and reading
 * restarts from the top rather than from a position past its end.
 */
export class LogTail {
  readonly #file: string;
  #offset: number | undefined;
  #carry = '';

  constructor(file: string) {
    this.#file = file;
  }

  /** New complete lines since last time. The first call only sets the position. */
  read(maxBytes = 1_048_576): string[] {
    let size: number;
    try {
      size = statSync(this.#file).size;
    } catch {
      return [];
    }

    // First look: start from the end. Replaying the whole historical log
    // would re-trigger on events that were dealt with long ago.
    if (this.#offset === undefined) {
      this.#offset = size;
      return [];
    }

    if (size < this.#offset) {
      this.#offset = 0; // rotated
      this.#carry = '';
    }
    if (size === this.#offset) return [];

    const start = Math.max(this.#offset, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let fd: number | undefined;
    try {
      fd = openSync(this.#file, 'r');
      readSync(fd, buffer, 0, length, start);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    this.#offset = size;

    const text = this.#carry + buffer.toString('utf8');
    const parts = text.split(/\r?\n/);
    // The last fragment may be a line still being written.
    this.#carry = parts.pop() ?? '';
    return parts.filter((l) => l !== '');
  }
}
