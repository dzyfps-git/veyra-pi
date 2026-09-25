/**
 * All-thread profiles: what every thread was doing, not just the server
 * thread.
 *
 * Background profiling watches only the server thread, so when the tick
 * waits for a chunk, why that chunk was slow happens out of sight: world
 * generation, chunk loading and disk run on other threads. A few short
 * profiles of every thread a day make that visible.
 *
 * These are kept apart from the normal captures on purpose. They cover other
 * threads and a couple of minutes, so mixing them into the server-thread
 * history would distort every tick figure. Each one is summarised per group
 * of threads (the names threads are given, turned into plain words): how busy
 * the group was, and what it spent that time on.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { SparkProfile } from '../decode/sparkprofile.ts';
import { aggregateProfile } from '../decode/aggregate.ts';
import { mapFrame, type Mappings } from '../decode/mappings.ts';
import { meaningfulFrame, ownersOf, readableMethod } from './owner.ts';

export interface ThreadGroupSummary {
  /** Plain name of what the threads do. */
  group: string;
  about: string;
  threads: number;
  /** Sampled time that was not idle, ms. */
  busyMs: number;
  /** Busy time as a share of the profile's length, per thread on average (0..1). */
  busyShare: number;
  top: Array<{ method: string; owner: string; ms: number }>;
}

export interface ThreadProfileSummary {
  durationMs: number;
  intervalMs: number;
  groups: ThreadGroupSummary[];
}

const GROUPS: ReadonlyArray<[RegExp, string, string]> = [
  [/^Server thread$/i, 'Server thread', 'Runs every tick. Everything else on this page is work it does not have to wait for, unless it asks.'],
  [/^Worker-Main|^Worker-/i, 'World generation and chunk work', 'Generates new terrain and prepares chunks. When this is busy, players exploring new land make the server wait.'],
  [/c2me/i, 'Chunk loading (C2ME)', 'Chunk loading and generation offloaded by C2ME.'],
  [/IO-Worker|Chunk ?IO|IOWorker|Storage|region/i, 'Disk', 'Reading and writing chunks and player data.'],
  [/Netty|Epoll|Network/i, 'Network', 'Sending and receiving packets for players.'],
  [/Async Chat|Chat/i, 'Chat', 'Processing chat messages.'],
  [/GC|G1/i, 'Garbage collection', 'Java freeing memory.'],
  [/spark/i, 'spark itself', 'The profiler’s own work.'],
];

function groupOf(name: string): { group: string; about: string } {
  for (const [re, group, about] of GROUPS) if (re.test(name)) return { group, about };
  return { group: `Other (${name.replace(/[-#]?\d+$/, '')})`, about: 'A thread started by the server or a mod.' };
}

export function summariseThreads(profile: SparkProfile, mappings: Mappings): ThreadProfileSummary {
  const agg = aggregateProfile(profile, { renameFrame: (c, m) => mapFrame(c, m, mappings), mappingsAvailable: mappings.available });
  const durationMs = Math.max(
    1,
    (profile.metadata.endTime ?? 0) - (profile.metadata.startTime ?? 0) || agg.threads.reduce((m, t) => Math.max(m, t.totalMs), 0),
  );
  const intervalMs = (profile.metadata.intervalMicros ?? 4000) / 1000;
  const owners = ownersOf(agg.rows);

  const groups = new Map<string, ThreadGroupSummary & { methods: Map<string, { owner: string; ms: number }> }>();
  const names = new Map<number, string>();
  for (const t of agg.threads) {
    const { group, about } = groupOf(t.name);
    names.set(t.threadIndex, group);
    const g = groups.get(group) ?? { group, about, threads: 0, busyMs: 0, busyShare: 0, top: [], methods: new Map() };
    g.threads += 1;
    g.busyMs += Math.max(0, t.totalMs - t.idleMs);
    groups.set(group, g);
  }
  agg.rows.forEach((row, i) => {
    if (row.category === 'idle' || row.selfMs <= 0) return;
    const g = groups.get(names.get(row.threadIndex) ?? '');
    if (g === undefined) return;
    const method = readableMethod(meaningfulFrame(row.path));
    const m = g.methods.get(method) ?? { owner: owners[i]!, ms: 0 };
    m.ms += row.selfMs;
    g.methods.set(method, m);
  });
  return {
    durationMs,
    intervalMs,
    groups: [...groups.values()]
      .map(({ methods, ...g }) => ({
        ...g,
        busyShare: g.busyMs / (durationMs * Math.max(1, g.threads)),
        top: [...methods.entries()]
          .map(([method, v]) => ({ method, owner: v.owner, ms: v.ms }))
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 12),
      }))
      .sort((a, b) => b.busyMs - a.busyMs),
  };
}

export interface ThreadProfileRow {
  id: number;
  serverId: string;
  capturedAt: number;
  durationMs: number;
  archivePath: string | null;
  summary: ThreadProfileSummary;
}

export function saveThreadProfile(
  db: DatabaseSync,
  input: { serverId: string; capturedAt: number; sha256: string; archivePath: string | null; summary: ThreadProfileSummary },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO thread_profile (server_id, captured_at, duration_ms, content_sha256, archive_path, summary)
         VALUES (?,?,?,?,?,?) ON CONFLICT(content_sha256) DO NOTHING`,
      )
      .run(input.serverId, input.capturedAt, Math.round(input.summary.durationMs), input.sha256, input.archivePath, JSON.stringify(input.summary)).lastInsertRowid,
  );
}

export function threadProfiles(db: DatabaseSync, serverId: string, limit = 10): ThreadProfileRow[] {
  return (
    db
      .prepare('SELECT id, server_id, captured_at, duration_ms, archive_path, summary FROM thread_profile WHERE server_id = ? ORDER BY captured_at DESC LIMIT ?')
      .all(serverId, limit) as Array<{ id: number; server_id: string; captured_at: number; duration_ms: number; archive_path: string | null; summary: string }>
  ).map((r) => ({
    id: r.id,
    serverId: r.server_id,
    capturedAt: r.captured_at,
    durationMs: r.duration_ms,
    archivePath: r.archive_path,
    summary: JSON.parse(r.summary) as ThreadProfileSummary,
  }));
}
