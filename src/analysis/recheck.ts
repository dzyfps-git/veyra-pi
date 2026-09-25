/**
 * Re-checking a known issue after its mod is updated.
 *
 * A known issue applies only to the exact mod version it was measured on
 * (knowledge.ts). When that mod is updated, nobody knows whether the new
 * version still has it -- so it is measured, not assumed: the cost of the
 * entry's frames is compared across the update with the same A/B validator
 * the Changes page uses (same season, windows matched on player count, a
 * confidence interval and a minimum effect).
 *
 *   still there / worse   The issue is carried to the new version, so its
 *                         note keeps showing, marked as measured there. An
 *                         update from that version is re-checked in turn.
 *   lower / not seen      The note stops. The result is shown on the change.
 *   unclear               Not enough comparable data; the note stops, since
 *                         nothing was measured on the new version.
 *
 * Each update is measured once, after three days of the new version, and the
 * result is kept. Measuring reads the per-minute detail on either side of the
 * update (about 1-2 minutes of low-priority CPU per update, paced), so it
 * needs that detail to still be kept.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { detectedChanges } from './changes.ts';
import { KNOWLEDGE, type KnowledgeEntry } from './knowledge.ts';
import { comparisonScope, validate, type Observation, type ValidationResult } from './validate.ts';
import { decodeSidecar } from '../store/sidecar.ts';

/** How much of each side of the update is compared. */
export const RECHECK_SPAN_MS = 3 * 86_400_000;

const META_KEY = 'knowledge.rechecks';

export type RecheckState = 'still-there' | 'worse' | 'lower' | 'not-seen' | 'unclear';

export interface Recheck {
  entryId: string;
  mod: string;
  from: string;
  to: string;
  revisionId: number;
  seasonId: number;
  /** When the new version was first seen. */
  at: number;
  /** Other mod changes in the same deploy; they share the credit or blame. */
  otherChanges: number;
  state: RecheckState;
  /** Median cost either side, ms per tick, over matched windows. */
  beforeMsPerTick?: number;
  afterMsPerTick?: number;
  beforeWindows: number;
  afterWindows: number;
  explanation: string;
  checkedAt: number;
}

/** An update of a known issue's mod, from a version it is known on. */
export interface RecheckDue {
  entry: KnowledgeEntry;
  from: string;
  to: string;
  revisionId: number;
  seasonId: number;
  serverId: string;
  at: number;
  otherChanges: number;
  /** When the after side is complete and it can be measured. */
  readyAt: number;
}

export function storedRechecks(db: DatabaseSync): Recheck[] {
  try {
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(META_KEY) as { value: string } | undefined;
    return row === undefined || row.value === '' ? [] : (JSON.parse(row.value) as Recheck[]);
  } catch {
    return [];
  }
}

export function saveRecheck(db: DatabaseSync, result: Recheck): void {
  const all = storedRechecks(db).filter((r) => !(r.entryId === result.entryId && r.revisionId === result.revisionId));
  all.push(result);
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    META_KEY,
    JSON.stringify(all),
  );
}

/**
 * Updates still to be measured, oldest first: each update of an entry's mod
 * away from a version the issue is known on. A chain stops at the first update
 * not yet measured, because whether the next one counts depends on it.
 */
export function pendingRechecks(db: DatabaseSync, rechecks: readonly Recheck[] = storedRechecks(db)): RecheckDue[] {
  const mods = new Set(KNOWLEDGE.map((e) => e.mod));
  const servers = new Map(
    (db.prepare('SELECT id, server_id FROM season').all() as Array<{ id: number; server_id: string }>).map((r) => [r.id, r.server_id]),
  );
  const updates = detectedChanges(db, { limit: 10_000 })
    .flatMap((c) =>
      c.changes
        .filter((m) => m.kind === 'updated' && mods.has(m.modId))
        .map((m) => ({ change: c, mod: m.modId, from: m.from ?? '', to: m.to ?? '' })),
    )
    .sort((a, b) => a.change.at - b.change.at);

  const out: RecheckDue[] = [];
  for (const entry of KNOWLEDGE) {
    const known = new Set([entry.modVersion]);
    for (const u of updates) {
      if (u.mod !== entry.mod || !known.has(u.from)) continue;
      const done = rechecks.find((r) => r.entryId === entry.id && r.revisionId === u.change.revisionId);
      if (done === undefined) {
        out.push({
          entry,
          from: u.from,
          to: u.to,
          revisionId: u.change.revisionId,
          seasonId: u.change.seasonId,
          serverId: servers.get(u.change.seasonId) ?? '',
          at: u.change.at,
          otherChanges: u.change.changes.length - 1,
          readyAt: u.change.at + RECHECK_SPAN_MS,
        });
        break;
      }
      if (done.state === 'still-there' || done.state === 'worse') known.add(u.to);
    }
  }
  return out;
}

export interface Pace {
  allowed: () => boolean;
  breathe: (ms: number) => Promise<void>;
  stopped: () => boolean;
}

/**
 * Per-window cost of the entry's frames over a span: the inclusive time of
 * every matching row whose ancestors do not match (so nested matches are not
 * counted twice), per tick. A window where nothing matches costs 0.
 */
async function entryObservations(
  db: DatabaseSync,
  entry: KnowledgeEntry,
  span: { fromMs: number; toMs: number; seasonId: number },
  resolvePath: (stored: string) => string | undefined,
  pace: Pace | undefined,
): Promise<{ observations: Observation[]; seen: boolean } | undefined> {
  const captures = db
    .prepare(
      `SELECT id, sidecar_path, started_at FROM capture
        WHERE season_id = ? AND started_at >= ? AND started_at < ? AND sidecar_path IS NOT NULL
        ORDER BY started_at`,
    )
    .all(span.seasonId, span.fromMs, span.toMs) as Array<{ id: number; sidecar_path: string; started_at: number }>;
  const windowsOf = db.prepare('SELECT window_id, players, ticks, start_time FROM capture_window WHERE capture_id = ?');

  const observations: Observation[] = [];
  let seen = false;
  for (const capture of captures) {
    if (pace !== undefined) {
      while (!pace.allowed()) {
        await pace.breathe(15_000);
        if (pace.stopped()) return undefined;
      }
    }
    const file = resolvePath(capture.sidecar_path);
    if (file === undefined || !existsSync(file)) continue;
    let sidecar;
    try {
      sidecar = decodeSidecar(readFileSync(file));
    } catch {
      continue; // A damaged sidecar must not abort the whole re-check.
    }
    const cost = new Array<number>(sidecar.windows.length).fill(0);
    const inside: boolean[] = [];
    sidecar.rows.forEach((row, index) => {
      const parentInside = row.parentIndex >= 0 && inside[row.parentIndex] === true;
      const matches =
        entry.match.test(row.label) && (row.source === null || row.source === '' || row.source.includes(entry.mod));
      inside[index] = parentInside || matches;
      if (!matches || parentInside) return;
      seen = true;
      row.totalMsByWindow.forEach((ms, w) => {
        cost[w] = (cost[w] ?? 0) + ms;
      });
    });
    const byId = new Map(
      (windowsOf.all(capture.id) as Array<{ window_id: number; players: number | null; ticks: number | null; start_time: number | null }>).map(
        (w) => [w.window_id, w],
      ),
    );
    sidecar.windows.forEach((id, w) => {
      const window = byId.get(id);
      const ticks = window?.ticks ?? 0;
      if (window === undefined || ticks <= 0) return;
      observations.push({ msPerTick: (cost[w] ?? 0) / ticks, players: window.players ?? 0, startTime: window.start_time ?? capture.started_at });
    });
    if (pace !== undefined) await pace.breathe(500);
  }
  return { observations, seen };
}

/** What a validation says about the issue on the new version. */
export function recheckState(result: ValidationResult, seenBefore: boolean, seenAfter: boolean, afterWindows: number): RecheckState {
  if (!seenBefore) return 'unclear';
  if (!seenAfter && afterWindows > 0) return 'not-seen';
  switch (result.verdict) {
    case 'improved':
      return 'lower';
    case 'regressed':
      return 'worse';
    case 'no-measurable-change':
      return 'still-there';
    default:
      return 'unclear';
  }
}

/** Measure one update. Undefined when stopped part-way (it is measured again later). */
export async function measureRecheck(
  db: DatabaseSync,
  due: RecheckDue,
  gate: { minEffect: number; minWindowsPerSide: number; playerBucketSize: number },
  resolvePath: (stored: string) => string | undefined,
  pace?: Pace,
  now = Date.now(),
): Promise<Recheck | undefined> {
  const base = {
    entryId: due.entry.id,
    mod: due.entry.mod,
    from: due.from,
    to: due.to,
    revisionId: due.revisionId,
    seasonId: due.seasonId,
    at: due.at,
    otherChanges: due.otherChanges,
    checkedAt: now,
  };
  const scope = comparisonScope(db, due.serverId, due.at);
  if (!scope.ok) return { ...base, state: 'unclear', beforeWindows: 0, afterWindows: 0, explanation: scope.reason };

  const before = await entryObservations(db, due.entry, { fromMs: due.at - RECHECK_SPAN_MS, toMs: due.at, seasonId: scope.seasonId }, resolvePath, pace);
  if (before === undefined) return undefined;
  const after = await entryObservations(db, due.entry, { fromMs: due.at, toMs: due.at + RECHECK_SPAN_MS, seasonId: scope.seasonId }, resolvePath, pace);
  if (after === undefined) return undefined;

  const result = validate(before.observations, after.observations, { deployedAt: due.at, ...gate });
  const state = recheckState(result, before.seen, after.seen, after.observations.length);
  const explanation =
    state === 'unclear' && !before.seen
      ? 'The issue was not seen in the days before the update either, so there is nothing to compare.'
      : state === 'not-seen'
        ? 'Nothing matching the issue ran after the update. It may be fixed, or the method may have been renamed or moved.'
        : result.explanation;
  const out: Recheck = { ...base, state, beforeWindows: result.beforeWindows, afterWindows: result.afterWindows, explanation };
  if (result.beforeMedian !== undefined) out.beforeMsPerTick = result.beforeMedian;
  if (result.afterMedian !== undefined) out.afterMsPerTick = result.afterMedian;
  return out;
}

/** One line for a person: what the update did to the issue, MSPT first. */
export function recheckText(r: Recheck, fmt: (msPerTick: number) => string): string {
  const figures =
    r.beforeMsPerTick !== undefined && r.afterMsPerTick !== undefined ? ` (${fmt(r.beforeMsPerTick)} → ${fmt(r.afterMsPerTick)} MSPT)` : '';
  switch (r.state) {
    case 'still-there':
      return `Still there on ${r.to}${figures}`;
    case 'worse':
      return `Worse on ${r.to}${figures}`;
    case 'lower':
      return `Lower on ${r.to}${figures}`;
    case 'not-seen':
      return `Not seen on ${r.to}`;
    default:
      return `Could not be measured on ${r.to}`;
  }
}
