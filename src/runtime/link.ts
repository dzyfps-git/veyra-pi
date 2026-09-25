/**
 * Per-server connection state.
 *
 * Servers are not reliably present. A VM takes time to boot, a share
 * can drop, Minecraft can be stopped for a modpack change, and eventually
 * there may be several servers with different uptimes. The rules that follow
 * from that:
 *
 *  - **Isolation.** Every server owns its own state and its own schedule.
 *    A failure is contained to one server; it can never delay or disable
 *    monitoring of another. There is no shared cycle to stall.
 *  - **Cheap when absent.** An offline server settles into one inexpensive
 *    check every backoff interval. No retry storms, no work proportional to
 *    how long it has been down.
 *  - **Patience at startup.** A server that has not answered yet is
 *    `starting`, not `offline`. A booting VM is the expected case.
 *  - **Automatic recovery.** Reconnection needs no intervention. The moment a
 *    probe succeeds the server returns to normal cadence.
 *
 * Probing is two-tier:
 *
 *    reachable  -- can the server's filesystem be read at all?
 *    running    -- does the server answer a Server List Ping?
 *
 * The running check originally used the freshness of `latest.log`. That was
 * wrong: an idle server with no players can stay silent for hours, so a
 * healthy quiet server was being classified as stopped, which would have
 * switched collection off during exactly the low-load baseline periods worth
 * recording. Log age is still gathered, but only as a supplementary hint --
 * it never decides liveness on its own.
 */

import { statSync } from 'node:fs';
import * as path from 'node:path';

import { pingServer, type PingResult } from './ping.ts';

export type LinkState =
  /** No probe has completed yet. */
  | 'unknown'
  /** Within the startup grace period, or seen booting. Not an error. */
  | 'starting'
  /** Filesystem reachable and Minecraft appears to be running. */
  | 'online'
  /** Filesystem reachable but Minecraft does not appear to be running. */
  | 'idle'
  /** Not reachable. */
  | 'offline'
  /** Deliberately suspended by the operator. */
  | 'paused';

export interface ProbeResult {
  reachable: boolean;
  running: boolean;
  /**
   * Whether liveness could actually be determined. False when the ping could
   * not be attempted at all, in which case `running` is a guess and callers
   * must not treat it as authoritative.
   */
  livenessKnown: boolean;
  /** Supplementary only. Never used to decide whether the server is running. */
  logAgeSeconds: number | undefined;
  playersOnline: number | undefined;
  versionName: string | undefined;
  error: string | undefined;
  durationMs: number;
}

export interface LinkConfig {
  serverId: string;
  displayName: string;
  root: string;
  sparkDir: string;
  logFile: string;
  /** Host and port to ping for liveness. */
  pingHost: string;
  pingPort: number;
  pingTimeoutMs: number;
  /** Override the liveness probe. Exists so tests never touch the network. */
  ping?: (options: { host: string; port: number; timeoutMs: number }) => Promise<PingResult>;
  /** Normal time between probes while healthy. */
  probeIntervalSeconds: number;
  /** First retry delay after a failure. Doubles from here. */
  backoffBaseSeconds: number;
  /** Ceiling on the retry delay. */
  backoffMaxSeconds: number;
  /** Grace period after start before absence is treated as offline. */
  startupGraceSeconds: number;
}

export const DEFAULT_LINK_CONFIG: Omit<
  LinkConfig,
  'serverId' | 'displayName' | 'root' | 'sparkDir' | 'logFile' | 'pingHost' | 'pingPort'
> = {
  pingTimeoutMs: 4000,
  probeIntervalSeconds: 60,
  backoffBaseSeconds: 30,
  backoffMaxSeconds: 900,
  startupGraceSeconds: 300,
};

export interface LinkSnapshot {
  serverId: string;
  displayName: string;
  state: LinkState;
  since: number;
  lastProbeAt: number | undefined;
  lastOkAt: number | undefined;
  consecutiveFailures: number;
  nextProbeAt: number;
  lastError: string | undefined;
  logAgeSeconds: number | undefined;
  playersOnline: number | undefined;
}

/** Deterministic default clock, overridable so tests do not depend on wall time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ServerLink {
  readonly config: LinkConfig;
  readonly #clock: Clock;
  readonly #createdAt: number;

  #state: LinkState = 'unknown';
  #since: number;
  #lastProbeAt: number | undefined;
  #lastOkAt: number | undefined;
  #failures = 0;
  #nextProbeAt: number;
  #lastError: string | undefined;
  #logAgeSeconds: number | undefined;
  #playersOnline: number | undefined;
  #paused = false;

  constructor(config: LinkConfig, clock: Clock = systemClock) {
    this.config = config;
    this.#clock = clock;
    this.#createdAt = clock.now();
    this.#since = this.#createdAt;
    this.#nextProbeAt = this.#createdAt;
  }

  get state(): LinkState {
    return this.#paused ? 'paused' : this.#state;
  }

  /** True when the server is up and it is sensible to do work against it. */
  get usable(): boolean {
    return !this.#paused && this.#state === 'online';
  }

  setPaused(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    this.#since = this.#clock.now();
  }

  /** Whether a probe is due. Callers poll this; probing itself is explicit. */
  dueForProbe(): boolean {
    if (this.#paused) return false;
    return this.#clock.now() >= this.#nextProbeAt;
  }

  snapshot(): LinkSnapshot {
    return {
      serverId: this.config.serverId,
      displayName: this.config.displayName,
      state: this.state,
      since: this.#since,
      lastProbeAt: this.#lastProbeAt,
      lastOkAt: this.#lastOkAt,
      consecutiveFailures: this.#failures,
      nextProbeAt: this.#nextProbeAt,
      lastError: this.#lastError,
      logAgeSeconds: this.#logAgeSeconds,
      playersOnline: this.#playersOnline,
    };
  }

  /**
   * Cheap, read-only probe.
   *
   * Two independent signals: a filesystem stat for reachability, and a Server
   * List Ping for liveness. Neither touches the game thread and neither
   * writes anything. Log age is collected as context only.
   */
  async probe(): Promise<ProbeResult> {
    const started = this.#clock.now();
    let reachable = false;
    let logAgeSeconds: number | undefined;
    let error: string | undefined;

    try {
      statSync(path.resolve(this.config.root));
      reachable = true;
    } catch (cause) {
      error = `server root unreachable: ${(cause as Error).message}`;
    }

    if (reachable) {
      try {
        const log = statSync(path.resolve(this.config.root, this.config.logFile));
        logAgeSeconds = Math.max(0, (started - log.mtimeMs) / 1000);
      } catch {
        // A missing or unreadable log is not meaningful on its own.
      }
    }

    let ping: PingResult | undefined;
    try {
      const probeFn = this.config.ping ?? pingServer;
      ping = await probeFn({
        host: this.config.pingHost,
        port: this.config.pingPort,
        timeoutMs: this.config.pingTimeoutMs,
      });
    } catch (cause) {
      error ??= `ping failed: ${(cause as Error).message}`;
    }

    const livenessKnown = ping !== undefined;
    const running = ping?.online === true;
    if (!running && ping?.error !== undefined) error ??= ping.error;

    const result: ProbeResult = {
      reachable,
      running,
      livenessKnown,
      logAgeSeconds,
      playersOnline: ping?.playersOnline,
      versionName: ping?.versionName,
      error,
      durationMs: this.#clock.now() - started,
    };
    this.#record(result);
    return result;
  }

  #record(result: ProbeResult): void {
    const now = this.#clock.now();
    this.#lastProbeAt = now;
    this.#logAgeSeconds = result.logAgeSeconds;
    this.#playersOnline = result.playersOnline;
    this.#lastError = result.error;

    // Liveness and reachability are independent. A server answering pings is
    // running even if the file share is momentarily unreadable, and a mounted
    // share proves nothing about whether Minecraft is up.
    let next: LinkState;
    if (result.running) next = 'online';
    else if (result.reachable) next = 'idle';
    else if (now - this.#createdAt < this.config.startupGraceSeconds * 1000) next = 'starting';
    else next = 'offline';

    if (result.reachable || result.running) {
      // Either signal responding counts as contact: backing off would only
      // delay noticing the other one come back.
      this.#failures = 0;
      this.#lastOkAt = now;
      this.#nextProbeAt = now + this.config.probeIntervalSeconds * 1000;
    } else {
      this.#failures += 1;
      this.#nextProbeAt = now + this.#backoffMs();
    }

    if (next !== this.#state) {
      this.#state = next;
      this.#since = now;
    }
  }

  /** Exponential backoff with jitter, so several servers do not sync up. */
  #backoffMs(): number {
    const base = this.config.backoffBaseSeconds * 1000;
    const cap = this.config.backoffMaxSeconds * 1000;
    const grown = Math.min(cap, base * 2 ** Math.max(0, this.#failures - 1));
    const jitter = grown * 0.2 * (Math.random() * 2 - 1);
    return Math.max(1000, Math.round(grown + jitter));
  }

  /** Human-readable state, for the interface and for logs. */
  describe(): string {
    switch (this.state) {
      case 'online':
        return 'Online';
      case 'idle':
        return 'Files reachable, Minecraft not responding';
      case 'starting':
        return 'Waiting for first contact';
      case 'offline': {
        const minutes = Math.round((this.#nextProbeAt - this.#clock.now()) / 60000);
        return `Offline — retrying in ${minutes <= 0 ? 'under a minute' : `~${minutes} min`}`;
      }
      case 'paused':
        return 'Paused';
      default:
        return 'Unknown';
    }
  }
}
