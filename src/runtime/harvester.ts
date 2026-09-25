/**
 * One harvest cycle, end to end.
 *
 * This is the only place the pieces meet: read the profiler state, decide,
 * send the command, find the file spark wrote, wait until it has stopped
 * changing, copy it, prove the copy is byte-identical to the source, ingest
 * it. Every step can fail, and every failure leaves the server exactly as it
 * was -- the source file is never touched here. Deleting it is a separate
 * job, behind a separate switch, and still off.
 *
 * ## The order of verification matters
 *
 *   1. The file must have stopped growing: same size and mtime across two
 *      readings several seconds apart, taken over SSH so the SMB share's
 *      attribute cache cannot report a stale size as stable.
 *   2. Its hash is taken ON THE SERVER, after it stopped growing.
 *   3. The local copy is hashed and compared against that. A mismatch means
 *      the copy is discarded and the attempt counts as a failure.
 *
 * The comparison is always against source truth, never against the copy
 * itself: "I copied a file and it matches itself" proves nothing.
 *
 * ## Why every command is audited
 *
 * Each command sent is written to `server_action` with what it was, when,
 * and what came back. If anything ever looks wrong on the server, the first
 * question is "what did the analyzer do?", and the answer should be a query
 * rather than a reconstruction.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import type { ConsoleTransport } from './console.ts';
import {
  parseProfilerInfo,
  decideHarvest,
  parseSavedPath,
  confirmedRestart,
  staleForegroundWarning,
  commandsFor,
  SAVED_PROFILE_PATTERN,
  type AllowedCommand,
  type DecideOptions,
} from './harvest.ts';
import { ingestFile, type IngestOptions } from '../ingest/pipeline.ts';
import type { Mappings } from '../decode/mappings.ts';
import type { Store } from '../store/db.ts';

export type HarvestOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'harvested'; file: string; sha256: string; captureId?: number; restarted: boolean; duplicate: boolean }
  | { kind: 'restored'; restarted: boolean; file?: string }
  /** An all-thread profile, kept apart from the captures (analysis/threads.ts). */
  | { kind: 'all-threads'; file: string; restarted: boolean; profileId?: number }
  /**
   * Saved and verified on the server, but not visible through the share yet
   * (see verifyAndStage). Nothing is lost: it is read at the next collection.
   */
  | { kind: 'deferred'; file: string; reason: string; restarted: boolean }
  | { kind: 'failed'; reason: string; notVisible?: boolean };

export interface HarvestDeps {
  console: ConsoleTransport;
  store: Store;
  serverId: string;
  decide: DecideOptions;
  /** Where the server's spark directory is readable from here (e.g. S:/config/spark). */
  localSparkDir: string;
  mappings: Mappings;
  archiveRaw: boolean;
  /** Server root as seen from here, so ingest can read level.dat for world identity. */
  serverRoot: string;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  now?: () => number;
  /** Tests replace real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a file to prove it has stopped changing. */
  stabilityWaitMs?: number;
  /** How long to let spark answer each command before reading the log. */
  settleMs?: { info: number; start: number; stop: number };
  /** Where archived captures go. Defaults to "archive" in the data folder. */
  archiveDir?: string;
  /**
   * Why there is no room to archive, if there is none. Checked before
   * anything is sent: a harvest that cannot be stored would only move spark's
   * hour from the server into nowhere.
   */
  diskProblem?: () => string | undefined;
  /**
   * Awaited after the copy is verified and staged, before the (CPU-heavy)
   * ingest: the collector uses it to wait while the PC is busy.
   */
  beforeIngest?: () => Promise<void>;
  /**
   * Keep an all-thread profile (staged locally, verified). Without it, an
   * all-thread profile that turns up is still stopped, so background
   * profiling comes back, but not kept.
   */
  keepThreadProfile?: (file: string, sha256: string) => number | undefined;
  /** Ingest implementation. Defaults to the real pipeline; tests substitute it. */
  ingest?: (file: string, options: IngestOptions) => { status: string; captureId: number };
  /** Waits before each attempt to read a verified file; tests shorten them. */
  readRetryMs?: readonly number[];
}

/** 0 + 2 + 5 + 10 + 15 s: longer than Windows keeps a stale folder listing. */
const READ_RETRY_MS: readonly number[] = [0, 2_000, 5_000, 10_000, 15_000];
/** A later try for a file already waited for: a quick look, so it never holds up a harvest. */
const RECOVER_RETRY_MS: readonly number[] = [0, 3_000];
/** How far back a saved-but-never-imported harvest is looked for, and how often it is retried. */
const RECOVER_WINDOW_MS = 72 * 3_600_000;
const RECOVER_ATTEMPTS = 3;
/**
 * Tries for a file the server has but the share does not show yet: measured
 * to clear within one or two 5-minute collections, so a dozen (about an hour)
 * before it is called a problem.
 */
const NOT_VISIBLE_ATTEMPTS = 12;
const RECOVER_PER_CYCLE = 3;

const RESTORE_META = 'harvest.restorePendingSince';
export const ALL_THREADS_META = 'harvest.allThreadsSince';

function audit(deps: HarvestDeps, action: string, outcome: string, detail: string, target?: string, sha256?: string): void {
  deps.store.db
    .prepare(
      `INSERT INTO server_action (server_id, at, action, target, sha256, dry_run, outcome, detail)
       VALUES (?,?,?,?,?,0,?,?)`,
    )
    .run(deps.serverId, (deps.now ?? Date.now)(), action, target ?? null, sha256 ?? null, outcome, detail.slice(0, 2000));
}

/**
 * Send one command. When the console is in use (see runtime/console.ts), a
 * command in the middle of a sequence waits and tries again -- for up to
 * `busyWaitMs` -- because the steps before it already happened; the first
 * command of a cycle does not wait, and the whole cycle is simply retried.
 */
async function send(deps: HarvestDeps, command: AllowedCommand, settleMs: number, busyWaitMs = 0) {
  const clock = deps.now ?? Date.now;
  const started = clock();
  let result = await deps.console.run(command, settleMs);
  while (result.busy !== undefined && clock() - started < busyWaitMs) {
    await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(10_000);
    result = await deps.console.run(command, settleMs);
  }
  audit(
    deps,
    'console',
    result.ok ? 'sent' : result.busy !== undefined ? 'held' : 'failed',
    result.ok ? result.lines.slice(0, 12).join('\n') : (result.error ?? 'unknown error'),
    command,
  );
  return result;
}

/**
 * Find the file a stop wrote when its confirmation line was missed.
 *
 * Serialising an hour of samples can outlast the settle window, so the
 * "Data has been written to" line may arrive after the log was read. The
 * newest managed file modified since the command was sent is the one --
 * and only a name matching the managed pattern is ever considered.
 */
function newestManagedFileSince(dir: string, sinceMs: number): string | undefined {
  let best: { name: string; mtime: number } | undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!SAVED_PROFILE_PATTERN.test(name)) continue;
    try {
      const mtime = statSync(path.join(dir, name)).mtimeMs;
      if (mtime >= sinceMs - 5_000 && (best === undefined || mtime > best.mtime)) best = { name, mtime };
    } catch {
      // Skip anything that cannot be stat'd.
    }
  }
  return best?.name;
}

/** Stabilise, copy and verify against source truth; stage the copy locally. */
async function verifyAndStage(
  deps: HarvestDeps,
  fileName: string,
  retryMs: readonly number[] = deps.readRetryMs ?? READ_RETRY_MS,
): Promise<{ staged: string; localHash: string } | { kind: 'failed'; reason: string; notVisible?: boolean }> {
  const { first, second } = await deps.console.inspectSparkFile(fileName, deps.stabilityWaitMs ?? 6_000);

  if (!first.exists || !second.exists || second.sha256 === undefined) {
    audit(deps, 'verify', 'failed', 'file vanished or could not be hashed on the server', fileName);
    return { kind: 'failed', reason: `${fileName} could not be inspected on the server` };
  }
  if (first.size !== second.size || first.mtime !== second.mtime) {
    audit(deps, 'verify', 'failed', `still changing: ${first.size}->${second.size} bytes`, fileName);
    return {
      kind: 'failed',
      reason: `${fileName} was still being written (size ${first.size} -> ${second.size}); will retry next cycle`,
    };
  }

  // The server has just shown the file complete and stable, yet Windows can
  // still answer "no such file" for a few seconds: its network-share client
  // keeps one cache of folder listings for every program on the PC, and a
  // listing taken just before spark finished writing hides the new file
  // until that entry expires (10 s by default). So a failed read is retried
  // before it counts, rather than stranding the file. With some servers it can
  // take minutes (the share's cached listing of the folder is only refreshed
  // when the server tells Windows it changed), so a file that is still not
  // there is not visible yet, and is read again at the next collection.
  const source = path.join(deps.localSparkDir, fileName);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let bytes: Buffer | undefined;
  let readError: Error | undefined;
  for (const waitMs of retryMs) {
    if (waitMs > 0) await sleep(waitMs);
    try {
      bytes = readFileSync(source);
      break;
    } catch (error) {
      readError = error as Error;
    }
  }
  if (bytes === undefined) {
    const notVisible = (readError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    audit(deps, 'verify', notVisible ? 'waiting' : 'failed', `could not read the copy: ${readError?.message ?? 'unknown error'}`, fileName);
    return notVisible
      ? { kind: 'failed', notVisible, reason: `${fileName} is saved on the server but not visible through ${deps.localSparkDir} yet` }
      : { kind: 'failed', reason: `could not read ${source}: ${readError?.message ?? 'unknown error'}` };
  }

  const localHash = createHash('sha256').update(bytes).digest('hex');
  if (localHash !== second.sha256) {
    audit(deps, 'verify', 'mismatch', `server ${second.sha256} vs local ${localHash}`, fileName, second.sha256);
    return {
      kind: 'failed',
      reason: `copy of ${fileName} does not match the server's hash; discarded, will retry`,
    };
  }
  audit(deps, 'verify', 'match', `${bytes.length} bytes`, fileName, localHash);

  // Staged inside the data folder, then handed to the normal ingest path,
  // which archives the raw file itself. The stage copy is ours and is
  // removed afterwards; the SERVER's file is never touched here.
  const stageDir = path.join(deps.store.dataDir, 'incoming');
  mkdirSync(stageDir, { recursive: true });
  const staged = path.join(stageDir, fileName);
  writeFileSync(staged, bytes);
  return { staged, localHash };
}

/** Stabilise, copy, verify against source truth, ingest. */
async function collect(deps: HarvestDeps, fileName: string, retryMs?: readonly number[]): Promise<HarvestOutcome> {
  const ready = await verifyAndStage(deps, fileName, retryMs);
  if ('kind' in ready) return ready;
  const { staged, localHash } = ready;

  try {
    await deps.beforeIngest?.();
    const result = (deps.ingest ?? ingestFile)(staged, {
      store: deps.store,
      serverId: deps.serverId,
      mappings: deps.mappings,
      archiveDir: deps.archiveDir ?? path.join(deps.store.dataDir, 'archive'),
      archiveRaw: deps.archiveRaw,
      serverRoot: deps.serverRoot,
    });
    audit(deps, 'ingest', result.status, `capture ${result.captureId}`, fileName, localHash);
    return {
      kind: 'harvested',
      file: fileName,
      sha256: localHash,
      captureId: result.captureId,
      restarted: true,
      duplicate: result.status === 'duplicate',
    };
  } catch (error) {
    audit(deps, 'ingest', 'failed', (error as Error).message, fileName, localHash);
    return { kind: 'failed', reason: `ingest of ${fileName} failed: ${(error as Error).message}` };
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Verify and keep an all-thread profile, never as a normal capture. */
async function collectThreads(deps: HarvestDeps, fileName: string, restarted: boolean): Promise<HarvestOutcome> {
  // Recorded first, so a failure below can never make it look like a missed capture.
  audit(deps, 'threads', 'saved', 'all-thread profile written by spark', fileName);
  const ready = await verifyAndStage(deps, fileName);
  if ('kind' in ready) return ready;
  try {
    await deps.beforeIngest?.();
    const id = deps.keepThreadProfile?.(ready.staged, ready.localHash);
    audit(deps, 'threads', id === undefined ? 'not kept' : 'kept', id === undefined ? 'no keeper' : `thread profile ${id}`, fileName, ready.localHash);
    return id === undefined ? { kind: 'all-threads', file: fileName, restarted } : { kind: 'all-threads', file: fileName, restarted, profileId: id };
  } catch (error) {
    audit(deps, 'threads', 'failed', (error as Error).message, fileName, ready.localHash);
    return { kind: 'failed', reason: `keeping the all-thread profile ${fileName} failed: ${(error as Error).message}` };
  } finally {
    rmSync(ready.staged, { force: true });
  }
}

/**
 * A profile of every thread, a few times a day (analysis/threads.ts explains
 * why). Only started over a running background profiler, straight after a
 * harvest, so what `start` discards is seconds of samples. `stop` saves it
 * and restarts background profiling; if that restart is not confirmed, the
 * next harvest restores it as usual.
 */
export async function runAllThreadsCycle(deps: HarvestDeps & { seconds: number }): Promise<HarvestOutcome> {
  const now = deps.now ?? Date.now;
  const settle = deps.settleMs ?? { info: 4_000, start: 4_000, stop: 12_000 };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const info = await send(deps, 'spark profiler info', settle.info);
  if (info.busy !== undefined) return { kind: 'skipped', reason: `waiting: ${info.busy}` };
  if (!info.ok) return { kind: 'failed', reason: info.error ?? 'profiler info failed' };
  const status = parseProfilerInfo(info.lines);
  if (status.state !== 'background') {
    audit(deps, 'decide', 'skip', `all-thread profile: profiler is ${status.state}`);
    return {
      kind: 'skipped',
      reason: `all-thread profile not started: the profiler is ${status.state === 'foreground' ? 'in use by someone' : status.state}`,
    };
  }

  deps.store.setMeta(ALL_THREADS_META, String(now()));
  const start = await send(deps, 'spark profiler start --thread *', settle.start);
  if (start.busy !== undefined) {
    deps.store.setMeta(ALL_THREADS_META, '');
    return { kind: 'skipped', reason: `waiting: ${start.busy}` };
  }
  if (!start.ok) return { kind: 'failed', reason: `starting the all-thread profile failed: ${start.error ?? 'unknown'}` };
  if (!/now running/i.test(start.lines.join('\n'))) {
    // Not confirmed by its reply: look before going on. If it did not start,
    // the marker must go, or a profile someone starts later would be taken
    // for this one and stopped.
    const check = await send(deps, 'spark profiler info', settle.info);
    if (!check.ok || parseProfilerInfo(check.lines).state !== 'foreground') {
      deps.store.setMeta(ALL_THREADS_META, '');
      return { kind: 'failed', reason: 'the all-thread profile did not start; nothing else was changed' };
    }
  }

  await sleep(deps.seconds * 1000);

  const sentStopAt = now();
  const stop = await send(deps, 'spark profiler stop --save-to-file', settle.stop, 180_000);
  if (!stop.ok) {
    // The marker stays, so the next harvest finishes it.
    return {
      kind: 'failed',
      reason: `stopping the all-thread profile failed: ${stop.error ?? stop.busy ?? 'unknown'}; the next cycle will stop it`,
    };
  }
  deps.store.setMeta(ALL_THREADS_META, '');
  const restarted = confirmedRestart(stop.lines);
  const fileName = parseSavedPath(stop.lines) ?? newestManagedFileSince(deps.localSparkDir, sentStopAt);
  if (fileName === undefined) return { kind: 'failed', reason: 'the all-thread profile was stopped but its file could not be found' };
  return collectThreads(deps, fileName, restarted);
}

/**
 * Harvests saved on the server but never imported -- the read failed, the
 * PC was too busy, the app closed mid-cycle -- found from the audit trail
 * itself: every stop records the file spark wrote, and every import records
 * its name. Each is retried a few times over the following three days; the
 * server's copy is never touched, so waiting loses nothing. All-thread
 * profiles and a restore's seconds-long file are not captures and are left
 * alone. Oldest first.
 */
export function missedHarvests(deps: Pick<HarvestDeps, 'store' | 'serverId' | 'now'>): string[] {
  const db = deps.store.db;
  const since = (deps.now ?? Date.now)() - RECOVER_WINDOW_MS;
  const stops = db
    .prepare(
      `SELECT id, detail FROM server_action
        WHERE server_id = ? AND action = 'console' AND target = 'spark profiler stop --save-to-file'
          AND outcome = 'sent' AND at >= ? ORDER BY at, id`,
    )
    .all(deps.serverId, since) as Array<{ id: number; detail: string | null }>;
  const previous = db.prepare(
    `SELECT target FROM server_action WHERE server_id = ? AND action = 'console' AND id < ? ORDER BY id DESC LIMIT 1`,
  );
  const settled = db.prepare(
    `SELECT 1 FROM server_action WHERE server_id = ? AND target = ?
        AND ((action = 'ingest' AND outcome IN ('ingested', 'duplicate')) OR action IN ('threads', 'restore')) LIMIT 1`,
  );
  const tries = triesOf(db);
  // Imported before imports were recorded in the audit trail.
  const archived = db.prepare('SELECT 1 FROM capture WHERE server_id = ? AND source_name = ? LIMIT 1');
  const names: string[] = [];
  for (const stop of stops) {
    const name = parseSavedPath((stop.detail ?? '').split('\n'));
    if (name === undefined || names.includes(name)) continue;
    const before = previous.get(deps.serverId, stop.id) as { target: string | null } | undefined;
    if (before?.target === 'spark profiler start --thread *') continue;
    if (settled.get(deps.serverId, name) !== undefined || archived.get(deps.serverId, name) !== undefined) continue;
    if (exhausted(tries(deps.serverId, name))) continue;
    names.push(name);
  }
  return names;
}

/** Recovery tries for one file since the last "try again" (outcome 'reset'). */
function triesOf(db: Store['db']): (serverId: string, name: string) => { failed: number; waiting: number } {
  const statement = db.prepare(
    `SELECT COALESCE(sum(outcome = 'failed'), 0) AS failed, COALESCE(sum(outcome = 'waiting'), 0) AS waiting FROM server_action
      WHERE server_id = ? AND target = ? AND action = 'recover'
        AND id > COALESCE((SELECT max(id) FROM server_action WHERE server_id = ? AND target = ? AND action = 'recover' AND outcome = 'reset'), 0)`,
  );
  return (serverId, name) => statement.get(serverId, name, serverId, name) as { failed: number; waiting: number };
}

function exhausted(t: { failed: number; waiting: number }): boolean {
  return t.failed >= RECOVER_ATTEMPTS || t.waiting >= NOT_VISIBLE_ATTEMPTS;
}

/**
 * Saved profiles the app gave up reading (every try used, still within the
 * window): the one case worth a person's attention. Oldest first.
 */
export function unreadHarvests(db: Store['db'], serverId: string, now = Date.now()): string[] {
  const since = now - RECOVER_WINDOW_MS;
  const tries = triesOf(db);
  const settled = db.prepare(
    `SELECT 1 FROM server_action WHERE server_id = ? AND target = ?
        AND ((action = 'ingest' AND outcome IN ('ingested', 'duplicate')) OR action IN ('threads', 'restore')) LIMIT 1`,
  );
  const archived = db.prepare('SELECT 1 FROM capture WHERE server_id = ? AND source_name = ? LIMIT 1');
  const names = db
    .prepare(
      `SELECT DISTINCT target FROM server_action WHERE server_id = ? AND action = 'recover' AND at >= ? AND target IS NOT NULL ORDER BY id`,
    )
    .all(serverId, since) as Array<{ target: string }>;
  return names
    .map((r) => r.target)
    .filter((name) => settled.get(serverId, name) === undefined && archived.get(serverId, name) === undefined && exhausted(tries(serverId, name)));
}

/** "Try again": every given-up file gets its tries back, from the next collection on. */
export function retryUnread(db: Store['db'], serverId: string, now = Date.now()): number {
  const names = unreadHarvests(db, serverId, now);
  for (const name of names) {
    db
      .prepare(
        `INSERT INTO server_action (server_id, at, action, target, sha256, dry_run, outcome, detail)
         VALUES (?, ?, 'recover', ?, NULL, 0, 'reset', 'tried again by hand')`,
      )
      .run(serverId, now, name);
  }
  return names.length;
}

async function recoverMissed(deps: HarvestDeps): Promise<void> {
  for (const name of missedHarvests(deps).slice(0, RECOVER_PER_CYCLE)) {
    const outcome = await collect(deps, name, deps.readRetryMs ?? RECOVER_RETRY_MS);
    if (outcome.kind === 'harvested') {
      deps.log('info', `recovered ${name}, saved earlier but not imported then (capture ${outcome.captureId ?? '?'})`);
    } else if (outcome.kind === 'failed' && outcome.notVisible === true) {
      audit(deps, 'recover', 'waiting', outcome.reason, name);
      deps.log('info', `${name} is still not visible through the share; tried again next collection`);
    } else if (outcome.kind === 'failed') {
      audit(deps, 'recover', 'failed', outcome.reason, name);
      deps.log('warn', `could not recover ${name} yet: ${outcome.reason}`);
    }
  }
}

export async function runHarvestCycle(deps: HarvestDeps): Promise<HarvestOutcome> {
  const now = deps.now ?? Date.now;
  const settle = deps.settleMs ?? { info: 4_000, start: 4_000, stop: 12_000 };

  const disk = deps.diskProblem?.();
  if (disk !== undefined) {
    audit(deps, 'decide', 'skip', disk);
    return { kind: 'skipped', reason: disk };
  }

  // Needs no console, so it runs even when the console is in use.
  try {
    await recoverMissed(deps);
  } catch (error) {
    deps.log('warn', `recovering missed harvests: ${(error as Error).message}`);
  }

  const info = await send(deps, 'spark profiler info', settle.info);
  if (info.busy !== undefined) return { kind: 'skipped', reason: `waiting: ${info.busy}` };
  if (!info.ok) return { kind: 'failed', reason: info.error ?? 'profiler info failed' };

  const status = parseProfilerInfo(info.lines);
  const stale = staleForegroundWarning(status);
  if (stale !== undefined) deps.log('warn', stale);

  const restorePending = deps.store.getMeta(RESTORE_META) !== undefined && deps.store.getMeta(RESTORE_META) !== '';
  const allThreadsPending = (deps.store.getMeta(ALL_THREADS_META) ?? '') !== '';
  const decision = decideHarvest(status, { ...deps.decide, restorePending, allThreadsPending });

  if (decision.action === 'skip') {
    audit(deps, 'decide', 'skip', decision.reason);
    return { kind: 'skipped', reason: decision.reason };
  }

  const commands = commandsFor(decision.action);
  deps.log('info', `harvest: ${decision.action} -- ${decision.reason}`);

  const restoreMetaBefore = deps.store.getMeta(RESTORE_META) ?? '';
  if (decision.action === 'restore') deps.store.setMeta(RESTORE_META, String(now()));

  let lastLines: string[] = [];
  let sentStopAt = 0;
  for (const command of commands) {
    const isStop = command === 'spark profiler stop --save-to-file';
    if (isStop) sentStopAt = now();
    // A later step (a restore's stop after its start) waits a few minutes
    // for the console rather than leaving the sequence half-done.
    const first = command === commands[0];
    const result = await send(deps, command, isStop ? settle.stop : settle.start, first ? 0 : 180_000);
    if (result.busy !== undefined && first) {
      if (decision.action === 'restore') deps.store.setMeta(RESTORE_META, restoreMetaBefore);
      return { kind: 'skipped', reason: `waiting: ${result.busy}` };
    }
    if (!result.ok) {
      return {
        kind: 'failed',
        reason:
          `${command} failed: ${result.error ?? 'unknown'}` +
          (decision.action === 'restore' && !isStop
            ? '. No stop was sent, so nothing was left half-done.'
            : ''),
      };
    }
    lastLines = result.lines;
  }

  const restarted = confirmedRestart(lastLines);
  if (restarted) deps.store.setMeta(RESTORE_META, '');

  if (decision.action === 'complete-all-threads') {
    deps.store.setMeta(ALL_THREADS_META, '');
    const name = parseSavedPath(lastLines) ?? newestManagedFileSince(deps.localSparkDir, sentStopAt);
    if (name === undefined) return { kind: 'failed', reason: 'the unfinished all-thread profile was stopped but its file could not be found' };
    return collectThreads(deps, name, restarted);
  }

  const fileName =
    parseSavedPath(lastLines) ?? newestManagedFileSince(deps.localSparkDir, sentStopAt);

  if (decision.action === 'restore') {
    // The file a restore saves holds the few seconds between its own start
    // and stop. It was archived at first, and three of them turned up as
    // "captures" -- one even pinned as a season's only baseline -- skewing
    // every figure they touched. It is now left alone: nothing in it is
    // history, and the next real harvest starts from the restored profiler.
    audit(deps, 'restore', 'not archived', 'seconds-long file from the restore itself', fileName);
    return fileName === undefined ? { kind: 'restored', restarted } : { kind: 'restored', restarted, file: fileName };
  }

  if (fileName === undefined) {
    return {
      kind: 'failed',
      reason:
        'the stop was sent but no saved profile could be found. Background profiling ' +
        (restarted ? 'did restart.' : 'may not have restarted -- the next cycle will check.'),
    };
  }

  const outcome = await collect(deps, fileName);
  if (outcome.kind === 'harvested') return { ...outcome, restarted };
  if (outcome.kind === 'failed' && outcome.notVisible === true) {
    // Counted as the first recovery try, so the next collections pick it up.
    audit(deps, 'recover', 'waiting', outcome.reason, fileName);
    return { kind: 'deferred', file: fileName, reason: outcome.reason, restarted };
  }
  return outcome;
}
