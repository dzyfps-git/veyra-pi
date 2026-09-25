/**
 * The harvest cycle.
 *
 * Everything here was verified against the live server and against spark
 * 1.10.53's actual bytecode, not against its documentation, because the two
 * disagree in a way that matters.
 *
 * ## What the profiler state machine actually does
 *
 * `profilerStop` calls `BackgroundSamplerManager.restartBackgroundSampler()`
 * **unconditionally** after saving, and that method is simply:
 *
 *     if (this.enabled) { startSampler(); return true; }
 *     return false;
 *
 * So `stop --save-to-file` both produces the capture and leaves background
 * profiling running. That is what makes the marginal cost of collection
 * effectively zero: the sampler that gets restarted is the one that was
 * going to be running anyway.
 *
 * `profilerCancel` does **not** call it. Cancelling therefore leaves the
 * server with no profiler at all.
 *
 * ## The failure this exists to repair
 *
 * A timed profile — `/spark profiler start --timeout 300`, the most natural
 * way to take a manual capture — completes through an auto-completion path
 * that never reaches `profilerStop`. Background profiling stops and does not
 * resume until the JVM restarts.
 *
 * This was found live: the background profiler had been dead for 14.5 hours
 * after two timed profiles the previous evening, and every hour of that is
 * simply gone. It will happen again every time someone takes a timed profile,
 * so the collector has to detect and repair it rather than assume the
 * premise holds.
 *
 * ## What `profiler start` actually does, and why restoring takes two commands
 *
 * `spark profiler start` does **not** start a background profiler. It starts
 * a FOREGROUND one that runs until an admin stops it. That matters twice:
 *
 *   1. While it runs, background profiling is not running. The thing being
 *      restored has not been restored.
 *   2. `profiler info` then reports it as started by a person, which this
 *      module treats as "someone is using it, do not touch" -- so a bare
 *      `start` would make the collector skip every subsequent cycle forever,
 *      silently, having created the condition itself.
 *
 * What it does not do is grow without bound. Verified in the shipped
 * bytecode: `AsyncSampler.rotateProfilerJob` calls `pruneData` and
 * `pruneStatistics` through `ProfilingWindowUtils.keepHistoryBefore`, and
 * those calls are not gated on the background flag, so every sampler discards
 * windows older than `spark.continuousProfilingHistorySize` (60 by default).
 * A foreground profiler left running is a correctness problem, not a memory
 * leak.
 *
 * So restoring is `start` followed by `stop --save-to-file`, because **stop**
 * is what calls `restartBackgroundSampler()`. The pair is atomic in intent:
 * leaving a foreground profiler running is the one outcome this must avoid,
 * so a restore that cannot complete its stop is reported rather than left.
 *
 * ## Consequences for the cycle
 *
 * - `profiler info` is read first, every time. Its answer decides everything.
 * - If a profiler is running **in the background**, harvest it.
 * - If a profiler is running and is **not** the background one, someone is
 *   using it. Skip the cycle entirely. Stealing another person's capture is
 *   the one thing this must never do -- unless the collector knows it started
 *   that profiler itself, in which case it must finish what it began.
 * - If nothing is running, background profiling has been lost. Restore it,
 *   and do not harvest this cycle: a sampler started seconds ago holds
 *   nothing worth keeping.
 */

import type { SettingsStore } from '../settings/store.ts';

export type ProfilerState =
  /** A background profiler is running. This is the normal, harvestable state. */
  | 'background'
  /** Someone started a profiler by hand. Leave it alone. */
  | 'foreground'
  /** Nothing is running. Background profiling has been lost. */
  | 'stopped'
  /** The console did not answer in time, or said something unrecognised. */
  | 'unknown';

export interface ProfilerStatus {
  state: ProfilerState;
  /** How long it has been running, when spark reported it. */
  runningForSeconds?: number;
  /** The lines spark actually printed, for the log and for diagnosis. */
  raw: string[];
}

/**
 * Parse `spark profiler info` output.
 *
 * Matched against the exact strings in 1.10.53. Anything unrecognised is
 * `unknown`, which causes the cycle to skip: acting on a misread state is
 * worse than missing one cycle.
 */
export function parseProfilerInfo(lines: readonly string[]): ProfilerStatus {
  const text = lines.join('\n');
  const raw = [...lines];

  if (/The profiler isn't running!/i.test(text)) {
    return { state: 'stopped', raw };
  }

  if (/Profiler is already running!/i.test(text)) {
    // "It was started automatically when spark enabled and has been running
    // in the background for 23s." -- the phrase that distinguishes a
    // background sampler from one a person started.
    const background = /started automatically when spark enabled/i.test(text);
    const duration = /running in the background for (\d+)([smhd])/i.exec(text);

    let seconds: number | undefined;
    if (duration !== null) {
      const value = Number(duration[1]);
      const unit = duration[2]!.toLowerCase();
      seconds = unit === 's' ? value : unit === 'm' ? value * 60 : unit === 'h' ? value * 3600 : value * 86400;
    }

    const status: ProfilerStatus = { state: background ? 'background' : 'foreground', raw };
    return seconds === undefined ? status : { ...status, runningForSeconds: seconds };
  }

  return { state: 'unknown', raw };
}

export type HarvestAction =
  /** Stop the background profiler, saving to a file. Restarts it as a side effect. */
  | { action: 'harvest'; reason: string }
  /**
   * `profiler start` then `profiler stop --save-to-file`, as one sequence.
   * The start alone would leave a foreground profiler running and background
   * profiling still absent.
   */
  | { action: 'restore'; reason: string }
  /**
   * A restore was begun and its stop did not land. Finish it, because the
   * foreground profiler now running is one this collector created.
   */
  | { action: 'complete-restore'; reason: string }
  /**
   * An all-thread profile this collector started is still running (the
   * collector restarted mid-profile). Stop it and keep what it recorded.
   */
  | { action: 'complete-all-threads'; reason: string }
  | { action: 'skip'; reason: string };

export interface DecideOptions {
  /**
   * Minimum time a background sampler must have been running before it is
   * worth harvesting. A sampler started thirty seconds ago holds thirty
   * seconds of data and stopping it would throw away more than it saves.
   */
  minAgeSeconds: number;
  /** Whether the collector may issue `profiler start` to repair a loss. */
  allowRestore: boolean;
  /**
   * True when this collector issued a `profiler start` and has not yet seen
   * its `stop` succeed.
   *
   * Without this the collector cannot distinguish a profiler someone else
   * started from one it started itself, and would back away from its own
   * half-finished work forever.
   */
  restorePending?: boolean;
  /** True while an all-thread profile this collector started has not been stopped. */
  allThreadsPending?: boolean;
}

/**
 * Decide what this cycle should do. Pure, so every branch is testable
 * without a server.
 */
export function decideHarvest(status: ProfilerStatus, options: DecideOptions): HarvestAction {
  switch (status.state) {
    case 'foreground':
      // A foreground profiler is normally someone else's work and is left
      // strictly alone. The exception is one this collector started itself as
      // part of a restore: abandoning that would leave background profiling
      // off indefinitely, having been switched off by us.
      if (options.allThreadsPending === true) {
        return {
          action: 'complete-all-threads',
          reason: 'an all-thread profile this collector started is still running. Stopping it and keeping it.',
        };
      }
      if (options.restorePending === true) {
        return {
          action: 'complete-restore',
          reason:
            'a profiler this collector started during a restore is still running. Stopping it now, ' +
            'which is what actually restarts background profiling.',
        };
      }
      return {
        action: 'skip',
        reason:
          'a profiler is running that was started by hand. Someone is using it, and interrupting ' +
          'it would destroy their capture.',
      };

    case 'unknown':
      return {
        action: 'skip',
        reason:
          'could not read the profiler state. Skipping rather than acting on a guess: ' +
          (status.raw.length === 0 ? 'no response from the console' : status.raw.join(' / ')),
      };

    case 'stopped':
      return options.allowRestore
        ? {
            action: 'restore',
            reason:
              'no profiler is running, so background profiling has been lost -- most likely a timed ' +
              'manual profile ended through its timeout, which does not restart it. Restoring with ' +
              'start followed by stop, because stop is what restarts the background profiler.',
          }
        : {
            action: 'skip',
            reason:
              'no profiler is running and automatic restore is disabled, so nothing is being collected. ' +
              'Run `/spark profiler start` then `/spark profiler stop` on the server, or restart it.',
          };

    case 'background': {
      const age = status.runningForSeconds;
      if (age !== undefined && age < options.minAgeSeconds) {
        return {
          action: 'skip',
          reason: `the background profiler has only been running ${age}s; waiting for at least ${options.minAgeSeconds}s of data.`,
        };
      }
      return {
        action: 'harvest',
        reason:
          age === undefined
            ? 'a background profiler is running.'
            : `a background profiler has been running for ${age}s.`,
      };
    }
  }
}

/**
 * The exact commands an action requires, in order.
 *
 * Expressed as a list rather than left to the caller so the two-command
 * restore cannot be implemented as one command by accident -- which is
 * precisely the mistake that made a bare `profiler start` look sufficient.
 */
export function commandsFor(action: HarvestAction['action']): AllowedCommand[] {
  switch (action) {
    case 'harvest':
      return ['spark profiler stop --save-to-file'];
    case 'restore':
      return ['spark profiler start', 'spark profiler stop --save-to-file'];
    case 'complete-restore':
    case 'complete-all-threads':
      return ['spark profiler stop --save-to-file'];
    case 'skip':
      return [];
  }
}

/**
 * A profiler that has been running far longer than anyone would leave one on
 * purpose.
 *
 * Not acted on -- it may genuinely be someone's long capture -- but worth
 * saying, because while it runs background profiling is not running and
 * nothing is being archived.
 */
export function staleForegroundWarning(status: ProfilerStatus, hours = 6): string | undefined {
  if (status.state !== 'foreground') return undefined;
  const seconds = status.runningForSeconds;
  if (seconds === undefined || seconds < hours * 3600) return undefined;
  return (
    `A profiler started by hand has been running for ${(seconds / 3600).toFixed(1)} hours. ` +
    'While it runs, background profiling is not running and nothing is being archived. ' +
    'Stopping it with `/spark profiler stop` will also restart background profiling.'
  );
}

/** The console commands this module is permitted to send. Nothing else. */
export const COMMAND_ALLOWLIST = [
  'spark profiler info',
  'spark profiler start',
  // A profile of every thread, not just the server thread (see
  // runtime/harvester.ts, runAllThreadsCycle). Off unless switched on.
  'spark profiler start --thread *',
  'spark profiler stop --save-to-file',
  'spark tps',
  'spark health',
] as const;

export type AllowedCommand = (typeof COMMAND_ALLOWLIST)[number];

export function isAllowedCommand(command: string): command is AllowedCommand {
  return (COMMAND_ALLOWLIST as readonly string[]).includes(command);
}

/** Filename spark writes, and the only shape cleanup will ever touch. */
export const SAVED_PROFILE_PATTERN = /^profile-\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}\.sparkprofile$/;

/**
 * Extract the written path from spark's confirmation line.
 *
 *   [⚡] Data has been written to: ./config/spark/profile-2026-09-22_11.06.11.sparkprofile
 *
 * Returns the bare filename, which is then resolved against the configured
 * spark directory rather than trusted as a path. The server tells us what it
 * called the file; it does not get to tell us where to write or delete.
 */
export function parseSavedPath(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /Data has been written to:\s*(\S+)/i.exec(line);
    if (match === null) continue;
    const name = match[1]!.split('/').pop() ?? '';
    if (SAVED_PROFILE_PATTERN.test(name)) return name;
  }
  return undefined;
}

/** Did the stop confirm that background profiling resumed? */
export function confirmedRestart(lines: readonly string[]): boolean {
  return lines.some((line) => /Restarted the background profiler/i.test(line));
}

/**
 * The minimum data age actually used: the setting, but never so long that it
 * vetoes every other harvest. A 10-minute floor with a 5-minute interval made
 * captures land every 12 minutes instead of every 5, because each harvest
 * restarts the profiler and the next cycle found it only 5 minutes old.
 */
export function effectiveMinAge(minAgeSeconds: number, intervalMinutes: number): number {
  return Math.min(minAgeSeconds, Math.max(60, intervalMinutes * 60 - 120));
}

export function harvestOptions(settings: SettingsStore): DecideOptions {
  return {
    minAgeSeconds: effectiveMinAge(
      settings.getNumber('collection.harvest.minProfilerAgeSeconds'),
      settings.getNumber('collection.harvest.intervalMinutes'),
    ),
    allowRestore: settings.getBoolean('collection.harvest.restoreBackgroundProfiler'),
  };
}
