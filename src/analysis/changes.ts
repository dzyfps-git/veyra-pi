/**
 * Changes: what was deployed, when, and whether it helped.
 *
 * ## Detection is free, because the archive already sees it
 *
 * Every capture carries the full mod list with versions. When that list
 * differs from the previous capture in the same season, the archive has
 * already recorded a revision. A revision IS a deploy -- a mod added,
 * removed or updated -- so detecting patches needs no hook, no watcher and
 * nothing on the server. It was verified against a real archive: a day on
 * which two compatibility patches were deployed shows exactly those two mods
 * arriving.
 *
 * What detection cannot know is WHICH change was meant to fix WHAT, or when a
 * config-only change went live. Those are recorded by hand, and both kinds
 * end up in the same register.
 *
 * ## Comparison is deliberately narrow
 *
 * Before and after must be the same season -- one machine, one Minecraft,
 * one world. Windows are matched on player count. Two views are offered, and
 * they are not the same quality of evidence, so they are never presented as
 * one number:
 *
 *   overall tick time   Always available, from the per-minute statistics
 *                       kept permanently. Honest but blunt: it moves with
 *                       load, and a 0.2 ms/tick patch is below its noise.
 *
 *   target call path    Only when a target is recorded. Reads per-window
 *                       detail from sidecars, so it is limited by how long
 *                       sidecars are kept. This is the view that can see a
 *                       small improvement.
 *
 * The comparison window is chosen per comparison and is completely separate
 * from retention: retention decides how long raw files are kept, the window
 * decides how much of what is kept to look at.
 */

import type { DatabaseSync } from 'node:sqlite';

import { validate, collectObservations, comparisonScope, type Observation, type ValidationResult } from './validate.ts';
import { diffRuntimeFlags } from '../model/season.ts';

export interface ModChange {
  modId: string;
  kind: 'added' | 'removed' | 'updated';
  from?: string;
  to?: string;
  /** One of your own mods, by the configured prefixes. */
  inHouse: boolean;
}

export interface DetectedChange {
  revisionId: number;
  seasonId: number;
  ordinal: number;
  /** When the new mod set was first seen. The deploy happened at or before this. */
  at: number;
  /** When the previous mod set was last seen, bounding the deploy from below. */
  previousSeenAt: number | undefined;
  changes: ModChange[];
  /** JVM flag differences, e.g. "+ -XX:+DebugNonSafepoints". Empty when unchanged or unknown. */
  runtimeChanges: string[];
  /** Register entry already tracking this change, if any. */
  trackedId?: number;
}

function isInHouse(modId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => p !== '' && modId.startsWith(p));
}

/** Mods added, removed and updated between two captures. */
export function modDiff(
  db: DatabaseSync,
  beforeCaptureId: number,
  afterCaptureId: number,
  inHousePrefixes: readonly string[] = [],
): ModChange[] {
  const mods = (captureId: number): Map<string, string> =>
    new Map(
      (
        db
          .prepare(
            `SELECT m.mod_id, cm.version FROM capture_mod cm JOIN mod m ON m.id = cm.mod WHERE cm.capture_id = ?`,
          )
          .all(captureId) as Array<{ mod_id: string; version: string }>
      ).map((r) => [r.mod_id, r.version]),
    );

  const before = mods(beforeCaptureId);
  const after = mods(afterCaptureId);
  const out: ModChange[] = [];

  for (const [id, version] of after) {
    if (!before.has(id)) out.push({ modId: id, kind: 'added', to: version, inHouse: isInHouse(id, inHousePrefixes) });
    else if (before.get(id) !== version) {
      out.push({ modId: id, kind: 'updated', from: before.get(id)!, to: version, inHouse: isInHouse(id, inHousePrefixes) });
    }
  }
  for (const [id, version] of before) {
    if (!after.has(id)) out.push({ modId: id, kind: 'removed', from: version, inHouse: isInHouse(id, inHousePrefixes) });
  }

  // Your own mods first, then by kind, then by name: the thing most likely to
  // be the patch should be the first thing read.
  const order = { added: 0, updated: 1, removed: 2 };
  return out.sort(
    (a, b) =>
      Number(b.inHouse) - Number(a.inHouse) || order[a.kind] - order[b.kind] || a.modId.localeCompare(b.modId),
  );
}

/**
 * Every mod-set change inside a season, newest first.
 *
 * The first revision of a season is skipped: it is the season boundary
 * itself -- a new world, pack or machine -- and comparing across it is the
 * one comparison this system refuses to make.
 */
export function detectedChanges(
  db: DatabaseSync,
  options: { seasonId?: number; serverId?: string; inHousePrefixes?: readonly string[]; limit?: number } = {},
): DetectedChange[] {
  const revisions = db
    .prepare(
      `SELECT r.id, r.season_id, r.ordinal, r.started_at, r.runtime_flags,
              (SELECT p.runtime_flags FROM revision p
                WHERE p.season_id = r.season_id AND p.ordinal = r.ordinal - 1) AS previous_flags
         FROM revision r
        WHERE r.ordinal > 1 ${options.seasonId === undefined ? '' : 'AND r.season_id = ?'}
          ${options.serverId === undefined ? '' : 'AND r.season_id IN (SELECT id FROM season WHERE server_id = ?)'}
        ORDER BY r.started_at DESC
        LIMIT ?`,
    )
    .all(
      ...(options.seasonId === undefined ? [] : [options.seasonId]),
      ...(options.serverId === undefined ? [] : [options.serverId]),
      options.limit ?? 50,
    ) as Array<{
    id: number;
    season_id: number;
    ordinal: number;
    started_at: number;
    runtime_flags: string | null;
    previous_flags: string | null;
  }>;

  const out: DetectedChange[] = [];
  for (const revision of revisions) {
    const after = db
      .prepare('SELECT id, started_at FROM capture WHERE revision_id = ? ORDER BY started_at LIMIT 1')
      .get(revision.id) as { id: number; started_at: number } | undefined;
    const before = db
      .prepare(
        `SELECT id, started_at, ended_at FROM capture
          WHERE season_id = ? AND started_at < ? AND revision_id != ?
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(revision.season_id, revision.started_at, revision.id) as
      | { id: number; started_at: number; ended_at: number | null }
      | undefined;
    if (after === undefined || before === undefined) continue;

    const tracked = db
      .prepare('SELECT id FROM optimization WHERE revision_id = ? ORDER BY id LIMIT 1')
      .get(revision.id) as { id: number } | undefined;

    const change: DetectedChange = {
      revisionId: revision.id,
      seasonId: revision.season_id,
      ordinal: revision.ordinal,
      at: revision.started_at,
      previousSeenAt: before.ended_at ?? before.started_at,
      changes: modDiff(db, before.id, after.id, options.inHousePrefixes ?? []),
      runtimeChanges:
        revision.runtime_flags === null || revision.previous_flags === null
          ? []
          : diffRuntimeFlags(
              JSON.parse(revision.previous_flags) as string[],
              JSON.parse(revision.runtime_flags) as string[],
            ),
    };
    if (tracked !== undefined) change.trackedId = tracked.id;
    out.push(change);
  }
  return out;
}

/** Duration presets offered for "how much either side of the change". */
export const WINDOW_PRESETS: ReadonlyArray<{ id: string; label: string; ms: number }> = [
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '3h', label: '3 hours', ms: 3 * 3_600_000 },
  { id: '5h', label: '5 hours', ms: 5 * 3_600_000 },
  { id: '12h', label: '12 hours', ms: 12 * 3_600_000 },
  { id: '24h', label: '24 hours', ms: 24 * 3_600_000 },
  { id: '2d', label: '2 days', ms: 2 * 86_400_000 },
  { id: '3d', label: '3 days', ms: 3 * 86_400_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { id: '14d', label: '14 days', ms: 14 * 86_400_000 },
];

export function presetMs(id: string | null | undefined, fallback = 3 * 86_400_000): number {
  return WINDOW_PRESETS.find((p) => p.id === id)?.ms ?? fallback;
}

export interface ComparisonGate {
  minEffect: number;
  minWindowsPerSide: number;
  playerBucketSize: number;
}

export interface ChangeComparison {
  ok: boolean;
  /** Why no comparison was possible, when it was not. */
  refused?: string;
  seasonId?: number;
  before: { fromMs: number; toMs: number };
  after: { fromMs: number; toMs: number };
  overall?: ValidationResult;
  target?: ValidationResult;
  targetPath?: string;
}

/** Per-minute whole-server tick time, from statistics kept permanently. */
function overallObservations(db: DatabaseSync, seasonId: number, fromMs: number, toMs: number): Observation[] {
  return (
    db
      .prepare(
        `SELECT w.mspt_median AS m, w.players AS p, w.start_time AS t
           FROM capture_window w JOIN capture c ON c.id = w.capture_id
          WHERE c.season_id = ? AND w.start_time >= ? AND w.start_time < ?
            AND w.mspt_median IS NOT NULL`,
      )
      .all(seasonId, fromMs, toMs) as Array<{ m: number; p: number | null; t: number }>
  ).map((r) => ({ msPerTick: r.m, players: r.p ?? 0, startTime: r.t }));
}

/**
 * Compare the time either side of a change.
 *
 * Refuses rather than reports when the change coincides with a season
 * boundary, because then the comparison would measure the reset or rotation
 * and label it as the patch.
 */
export function compareAround(
  db: DatabaseSync,
  input: {
    serverId: string;
    at: number;
    beforeMs: number;
    afterMs: number;
    targetPath?: string | null;
    gate: ComparisonGate;
    resolvePath?: (stored: string) => string | undefined;
  },
): ChangeComparison {
  const before = { fromMs: input.at - input.beforeMs, toMs: input.at };
  const after = { fromMs: input.at, toMs: input.at + input.afterMs };

  const scope = comparisonScope(db, input.serverId, input.at);
  if (!scope.ok) return { ok: false, refused: scope.reason, before, after };

  const options = {
    deployedAt: input.at,
    minEffect: input.gate.minEffect,
    minWindowsPerSide: input.gate.minWindowsPerSide,
    playerBucketSize: input.gate.playerBucketSize,
  };

  const overall = validate(
    overallObservations(db, scope.seasonId, before.fromMs, before.toMs),
    overallObservations(db, scope.seasonId, after.fromMs, after.toMs),
    options,
  );

  const result: ChangeComparison = { ok: true, seasonId: scope.seasonId, before, after, overall };

  if (input.targetPath !== undefined && input.targetPath !== null && input.targetPath !== '') {
    const resolve = input.resolvePath ?? ((s: string) => s);
    result.targetPath = input.targetPath;
    result.target = validate(
      collectObservations(db, input.targetPath, { ...before, seasonId: scope.seasonId }, resolve),
      collectObservations(db, input.targetPath, { ...after, seasonId: scope.seasonId }, resolve),
      options,
    );
  }
  return result;
}
