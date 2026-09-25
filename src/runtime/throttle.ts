/**
 * Keeping out of the Minecraft server's way.
 *
 * The server often runs on the same PC as this app (in a VM, say), so any CPU
 * this app burns is CPU the server might have wanted. Two rules:
 *
 *   1. The app runs below normal priority, so the OS prefers everything else.
 *   2. Heavy work (decoding a capture, rebuilding, converting, cleaning up)
 *      waits while the PC is busy, or while the app itself has recently used
 *      more than its budget -- up to a limit, after which it runs anyway at
 *      low priority. Nothing is ever lost by waiting: the harvested file is
 *      already copied and verified before anything waits on this.
 *
 * Harvest commands themselves are never delayed: spark discards anything
 * older than its last hour, so a late harvest is lost history.
 */

import * as os from 'node:os';

export interface Budget {
  /** Share of one core this app may average over the last minute, in %. */
  maxOwnCpuPercent: number;
  /** Heavy work waits while the whole PC is busier than this, in %. */
  busyHostPercent: number;
  /** Heavy work waits while this process holds more memory than this. */
  maxRssMb: number;
  /** Longest heavy work is ever held back. */
  maxWaitMs: number;
}

export interface Load {
  /** How much time the figures cover; under MIN_WINDOW_MS they are not judged. */
  windowMs: number;
  ownCpuPercent: number;
  hostCpuPercent: number;
  rssMb: number;
}

export type Reason = 'host-busy' | 'own-cpu' | 'memory';

/**
 * Load over a few milliseconds is noise: the collector's own start-up alone
 * reads as several hundred percent of a core. Below this, CPU is not judged.
 */
export const MIN_WINDOW_MS = 5_000;

/** Lower this process's scheduling priority. Returns false where the OS refuses. */
export function lowerOwnPriority(): boolean {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch {
    return false;
  }
}

function hostTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total };
}

interface Sample {
  at: number;
  ownCpuUs: number;
  hostIdle: number;
  hostTotal: number;
}

/**
 * Measures load from cheap counters (process CPU time and the OS's per-core
 * totals). Sampling costs microseconds; it is called from the collector's
 * 15-second tick and whenever heavy work asks.
 */
export class Governor {
  private samples: Sample[] = [];
  private readonly budget: () => Budget;
  private readonly clock: () => number;
  private readonly read: () => { ownCpuUs: number; hostIdle: number; hostTotal: number; rssBytes: number };

  constructor(
    budget: () => Budget,
    options: {
      now?: () => number;
      read?: () => { ownCpuUs: number; hostIdle: number; hostTotal: number; rssBytes: number };
    } = {},
  ) {
    this.budget = budget;
    this.clock = options.now ?? Date.now;
    this.read =
      options.read ??
      (() => {
        const cpu = process.cpuUsage();
        const host = hostTimes();
        return { ownCpuUs: cpu.user + cpu.system, hostIdle: host.idle, hostTotal: host.total, rssBytes: process.memoryUsage.rss() };
      });
  }

  /** Record a sample and return the load over roughly the last minute. */
  sample(): Load {
    const now = this.clock();
    const r = this.read();
    this.samples.push({ at: now, ownCpuUs: r.ownCpuUs, hostIdle: r.hostIdle, hostTotal: r.hostTotal });
    // Keep about a minute, but always the oldest sample inside it as a baseline.
    while (this.samples.length > 2 && now - this.samples[1]!.at >= 60_000) this.samples.shift();
    const first = this.samples[0]!;
    const wallMs = now - first.at;
    const hostTotal = r.hostTotal - first.hostTotal;
    return {
      windowMs: wallMs,
      ownCpuPercent: wallMs <= 0 ? 0 : ((r.ownCpuUs - first.ownCpuUs) / 1000 / wallMs) * 100,
      hostCpuPercent: hostTotal <= 0 ? 0 : (1 - (r.hostIdle - first.hostIdle) / hostTotal) * 100,
      rssMb: r.rssBytes / 1048576,
    };
  }

  /** Why heavy work should wait right now, if it should. */
  reason(load: Load = this.sample()): Reason | undefined {
    const b = this.budget();
    if (load.windowMs >= MIN_WINDOW_MS) {
      if (load.hostCpuPercent > b.busyHostPercent) return 'host-busy';
      if (load.ownCpuPercent > b.maxOwnCpuPercent) return 'own-cpu';
    }
    if (load.rssMb > b.maxRssMb) return 'memory';
    return undefined;
  }

  /**
   * Resolve when heavy work may run: now if nothing is busy, else once load
   * drops, and never later than the budget's maximum wait. Reports how long
   * it waited and why, so the wait is visible rather than silent.
   */
  async whenCalm(
    label: string,
    report?: (message: string) => void,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<{ waitedMs: number; reason?: Reason }> {
    const started = this.clock();
    let first: Reason | undefined;
    let capped = false;
    // With no history yet (just started), measure over a few seconds first
    // rather than judge from nothing.
    if (this.sample().windowMs < MIN_WINDOW_MS) await wait(MIN_WINDOW_MS);
    for (;;) {
      const reason = this.reason();
      if (reason === undefined) break;
      first ??= reason;
      if (this.clock() - started >= this.budget().maxWaitMs) {
        capped = true;
        report?.(`${label}: waited ${Math.round((this.clock() - started) / 60_000)} min (${REASON_WORDS[first]}); running now at low priority`);
        break;
      }
      await wait(5_000);
    }
    const waitedMs = this.clock() - started;
    if (first !== undefined && !capped) {
      report?.(`${label}: waited ${Math.round(waitedMs / 1000)} s (${REASON_WORDS[first]})`);
    }
    return first === undefined ? { waitedMs } : { waitedMs, reason: first };
  }
}

export const REASON_WORDS: Record<Reason, string> = {
  'host-busy': 'this PC was busy',
  'own-cpu': 'this app had used its CPU budget',
  memory: 'this app was over its memory budget',
};

/** Give the event loop and the OS a breath between slices of long work. */
export function breathe(ms = 25): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
