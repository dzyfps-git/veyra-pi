/**
 * Findings: the optimization backlog.
 *
 * A finding is not a row in a table somewhere that got created when something
 * crossed a threshold. It is a VIEW over the permanent ledger, recomputed on
 * read. That matters because it is what lets the system promise never to
 * discard an opportunity: there is no moment at which something is judged
 * insignificant and dropped. Change the question and yesterday's ignored cost
 * appears, with its full history intact.
 *
 * Candidates are drawn from two directions deliberately:
 *
 *   by cost     -- the conventional view, largest self time first
 *   by exposure -- largest total seconds per day, which surfaces the small
 *                  constant costs that a time-sorted profile buries
 *
 * A path that only ever appears in the second list is exactly the kind of
 * finding this system exists to produce.
 */

import { DEFAULT_ACTIVITY, type ActivityFilter } from './activity.ts';
import { effectiveActivity } from '../store/rollups.ts';
import { rollupSource, type DayRange } from '../query/range.ts';
import type { DatabaseSync } from 'node:sqlite';

import { runDetectors, type DetectorHit, type Feasibility } from './detectors.ts';
import { prioritise, type PriorityBreakdown, type Risk, type Actionability, type KnowledgeVerdict, type Outlook } from './priority.ts';
import { isLibraryFrame, ownerStep, parseMixin } from './owner.ts';
import { installedMods, lookupKnowledge, matchRegister, type KnowledgeMatch, type RegisterMatch } from './knowledge.ts';
import { latestSeasonId } from '../query/queries.ts';
import type { PathRow, FrameCategory } from '../decode/aggregate.ts';

export interface Finding {
  pathId: number;
  label: string;
  path: string;
  source: string | null;
  /**
   * How `source` was arrived at. `mixin` and `declared` are facts from the
   * capture; `via-path` is the deepest mod in the call path, which is a
   * weaker claim and frequently a wrapper rather than the cause.
   */
  attribution: 'mixin' | 'declared' | 'via-path' | 'none';
  actionability: Actionability;
  category: FrameCategory;
  /** Time spent in this method itself, per tick. Never summed with a parent's. */
  msPerTick: number;
  /** Time in this method AND everything it calls, per tick ("total"). */
  totalMsPerTick: number;
  secondsPerDay: number;
  persistence: number;
  samples: number;
  days: number;
  priority: PriorityBreakdown;
  detectors: DetectorHit[];
  /** Prior investigations of this exact thing, if there are any. */
  knowledge: KnowledgeMatch[];
  /** Register entries already tracking it. */
  tracked: RegisterMatch[];
  feasibility: Feasibility;
  risk: Risk;
}

export interface FindingsQuery {
  /**
   * Which season to analyse. Defaults to the one holding the most recent
   * capture.
   *
   * There is no "every season at once" mode, for the same reason the ledger
   * has none: the archive spans a Windows test box, where spark falls back to
   * the safepoint-biased ThreadMXBean sampler, and Linux production, which
   * uses async-profiler. An unscoped list interleaves rows from both without
   * saying which is which, so the same path appears twice with different
   * numbers and no way to tell them apart.
   *
   * Scoping is also what makes this fast: with the season fixed, the
   * candidate queries use `rollup_by_pertick` directly instead of sorting
   * every row in the table.
   */
  seasonId?: number;
  /** How many candidates to draw from each direction before ranking. */
  candidates?: number;
  limit?: number;
  /** Only findings worth a look now (priority.ts `top`). */
  topOnly?: boolean;
  /** Which mods are yours (priority.ts ownModMatcher). */
  ownMod?: (mod: string | null | undefined) => boolean;
  /** Only these days. Without it, the whole season. */
  range?: DayRange;
  /** A prepared table with rollup columns (an exact time span); overrides `range`. */
  table?: string;
  /** While playing (the default), nobody online, or all minutes. A prepared table is already filtered. */
  activity?: ActivityFilter;
}

interface CandidateRow {
  path_id: number;
  label: string;
  class_name: string;
  method_name: string;
  source_mod: string | null;
  depth: number;
  category: string;
  self_ms: number;
  total_ms: number;
  ticks: number;
  windows_present: number;
  windows_total: number;
  days: number;
  interval_ms: number;
}

const CANDIDATE_SQL = (order: string, seasonFilter: string, source = 'path_rollup'): string => `
  SELECT r.path_id, f.label, f.class_name, f.method_name, p.source_mod, p.depth, r.category,
         r.self_ms, r.total_ms, r.ticks, r.windows_present, r.windows_total, r.days,
         COALESCE((SELECT c.interval_micros FROM capture c
                    WHERE c.season_id = r.season_id AND c.interval_micros IS NOT NULL
                    ORDER BY c.started_at DESC LIMIT 1), 10000) / 1000.0 AS interval_ms
    FROM ${source} r
    JOIN path  p ON p.id = r.path_id
    JOIN frame f ON f.id = p.frame_id
   WHERE r.ticks > 0 AND r.category != 'idle' ${seasonFilter}
   ORDER BY ${order}
   LIMIT ?`;

/**
 * Frames that are never the subject of a finding.
 *
 * A park is where the thread stopped, not why. Reporting `Unsafe.park` as the
 * finding tells you nothing actionable -- the caller that blocked is the
 * subject, and the detectors already surface that from the path.
 */
const NEVER_THE_SUBJECT = [
  /^jdk\.internal\.misc\.Unsafe\.park$/,
  /^sun\.misc\.Unsafe\.park$/,
  /^java\.util\.concurrent\.locks\.LockSupport\./,
  /^libjvm\.so\./,
  /^libc\.so/,
  /^native\./,
  /^java\.lang\.Thread\.(run|sleep)$/,
];

function isInfrastructure(label: string): boolean {
  return NEVER_THE_SUBJECT.some((re) => re.test(label));
}

/**
 * Code with no mod owner: the engine, the JDK, shared libraries, and the
 * mixin machinery. A cost here is real, but the actionable subject is
 * whichever mod drove it, not the library itself.
 */
const ENGINE_PREFIXES = [
  'net.minecraft.',
  'java.',
  'jdk.',
  'sun.',
  'com.mojang.',
  'it.unimi.dsi.',
  'com.google.',
  'org.apache.',
  'io.netty.',
  'org.spongepowered.',
  'net.fabricmc.fabric.',
  'org.slf4j.',
  'oshi.',
];

function isEngineFrame(className: string): boolean {
  return ENGINE_PREFIXES.some((prefix) => className.startsWith(prefix));
}

/**
 * Recover the owning mod from a Mixin handler method name.
 *
 * Mixin renames injected methods to `handler$<hash><phase>$<modid>$<name>`,
 * so a frame like
 *
 *   net.minecraft.util.Identifier.handler$zfc000$aaa_particles$fixDfuCrash
 *
 * is `aaa_particles` code living inside a vanilla class. spark attributes it
 * by declaring class, which is `net.minecraft`, so without this the frame
 * looks like vanilla and the real owner is lost.
 *
 * Only the documented prefixes are matched, and only when the shape is
 * exactly right. A name that does not match yields null rather than a guess.
 */


export function mixinOwner(methodName: string): string | null {
  return parseMixin(`x.${methodName}`)?.mod ?? null;
}

export interface ResolvedPath {
  text: string;
  /** Every mod appearing anywhere along the path, root-first. */
  mods: string[];
}

/** Crash guards and bridges that only pass a call on; never the mod doing the work. */
const PASSTHROUGH = /mixinextras\$bridge|\.neruina\.handler\.TickHandler\./;

/**
 * The mod a frame is, if it is mod code: spark's tag, a mixin handler's mod
 * (code the mod injected), or an untagged class outside the game and its
 * libraries. Wrapping mixins (redirect, wrapOperation...) pass the original
 * call on, so they do not make the work below them the mod's.
 *
 * Deliberately generous: a mod found here is named as where to look, and
 * missing one would call mod-driven work "the game's own".
 */
function modOfFrame(label: string, source: string | null): string | null {
  // Pass-through first: spark tags a crash guard or a wrapping mixin with its
  // mod, but the work below it is still whatever it wrapped.
  if (PASSTHROUGH.test(label)) return null;
  const cut = label.lastIndexOf('.');
  const mixin = parseMixin(label);
  if (mixin !== undefined) return mixin.kind === 'handler' ? mixin.mod : null;
  if (source !== null && source !== '') return source;
  if (isEngineFrame(label.slice(0, cut)) || isLibraryFrame(label)) return null;
  return ownerStep(label, null, undefined);
}

/**
 * Resolve many paths in ONE query.
 *
 * The first version ran a recursive CTE per candidate, which meant ~400
 * round trips and a 3 second page. Seeding the recursion from every candidate
 * at once and carrying the origin id through turns that into a single query.
 *
 * Paths are not materialised as text in the database on purpose: storing the
 * full string per path is exactly the mistake that produced a 7.8 GB database
 * earlier, since paths average ~2 KB and there are over a million of them.
 */
function resolvePaths(db: DatabaseSync, pathIds: readonly number[]): Map<number, ResolvedPath> {
  const out = new Map<number, ResolvedPath>();
  if (pathIds.length === 0) return out;

  // Chunked to stay well inside SQLite's parameter limit.
  const CHUNK = 400;
  for (let start = 0; start < pathIds.length; start += CHUNK) {
    const chunk = pathIds.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `WITH RECURSIVE up(origin, id, parent_id, frame_id, depth) AS (
           SELECT id, id, parent_id, frame_id, depth FROM path WHERE id IN (${placeholders})
           UNION ALL
           SELECT up.origin, p.id, p.parent_id, p.frame_id, p.depth
             FROM path p JOIN up ON p.id = up.parent_id AND up.parent_id != 0
         )
         SELECT up.origin AS origin, f.label AS label, up.depth AS depth, p2.source_mod AS source_mod
           FROM up
           JOIN frame f ON f.id = up.frame_id
           JOIN path  p2 ON p2.id = up.id
          ORDER BY up.origin, up.depth ASC`,
      )
      .all(...chunk) as Array<{ origin: number; label: string; depth: number; source_mod: string | null }>;

    for (const row of rows) {
      let entry = out.get(row.origin);
      if (entry === undefined) {
        entry = { text: '', mods: [] };
        out.set(row.origin, entry);
      }
      entry.text = entry.text === '' ? row.label : `${entry.text} > ${row.label}`;
      const mod = modOfFrame(row.label, row.source_mod);
      if (mod !== null && mod !== 'Minecraft' && !entry.mods.includes(mod)) entry.mods.push(mod);
    }
  }
  return out;
}

export function findings(db: DatabaseSync, query: FindingsQuery = {}): Finding[] {
  const candidates = query.candidates ?? 200;
  const seasonId = query.seasonId ?? latestSeasonId(db);
  if (seasonId === undefined) return [];

  const seasonFilter = 'AND r.season_id = ?';
  const activity = effectiveActivity(db, seasonId, query.activity ?? DEFAULT_ACTIVITY);
  const source = query.table !== undefined ? { sql: query.table, params: [] } : rollupSource(db, seasonId, query.range, activity);
  const params = [...source.params, seasonId, candidates];

  const byCost = db
    .prepare(CANDIDATE_SQL('r.ms_per_tick DESC', seasonFilter, source.sql))
    .all(...params) as unknown as CandidateRow[];

  // Same ordering expression, but this is the view that matters: total tick
  // budget consumed per day, which ranks a permanent 0.15 ms cost above a
  // rare 2 ms one.
  const byExposure = db
    .prepare(CANDIDATE_SQL('r.self_ms DESC', seasonFilter, source.sql))
    .all(...params) as unknown as CandidateRow[];

  const merged = new Map<number, CandidateRow>();
  for (const row of [...byCost, ...byExposure]) merged.set(row.path_id, row);

  // Resolve every candidate's path up front, in one query.
  const eligible = [...merged.values()].filter((row) => !isInfrastructure(row.label));
  const resolved = resolvePaths(db, eligible.map((row) => row.path_id));

  const installed = installedMods(db, seasonId);
  const out: Finding[] = [];
  for (const row of eligible) {
    const msPerTick = row.self_ms / Math.max(row.ticks, 1);
    const persistence = row.windows_total > 0 ? row.windows_present / row.windows_total : 0;
    const samples = Math.round(row.total_ms / Math.max(row.interval_ms, 1));
    const { text, mods } = resolved.get(row.path_id) ?? { text: row.label, mods: [] };

    // Who could actually act. A mod-owned frame has somewhere to send a
    // patch; engine code reached through a mod points at that mod; engine
    // code with no mod anywhere is recorded but ranked down.
    //
    // A Mixin handler is checked first and beats everything else, because it
    // is the only one of these that is a fact rather than an inference: the
    // mod id is encoded in the method name by Mixin itself. The path-derived
    // fallback is genuinely weaker -- the deepest mod in the call path is
    // often a tick wrapper (neruina, lithium) that is passing through rather
    // than causing the work -- so it is reported as `via` and never as the
    // owner.
    const injected = mixinOwner(row.method_name);
    const declared = row.source_mod !== null && row.source_mod !== '' ? row.source_mod : null;
    const viaPath = mods[mods.length - 1] ?? null;

    const owner = injected ?? declared ?? viaPath;
    const attribution: Finding['attribution'] =
      injected !== null ? 'mixin' : declared !== null ? 'declared' : viaPath !== null ? 'via-path' : 'none';

    const actionability: Actionability =
      injected !== null || declared !== null
        ? 'mod'
        : !isEngineFrame(row.class_name)
          ? 'mod'
          : mods.length > 0
            ? 'mod-driven'
            : 'engine';

    // Detectors want the frame shape used during decoding. Only the fields
    // they actually read are reconstructed.
    const asPathRow: PathRow = {
      threadIndex: 0,
      threadName: 'Server thread',
      depth: row.depth,
      className: row.class_name,
      methodName: row.method_name,
      methodDesc: '',
      lineNumber: 0,
      parentLineNumber: 0,
      source: row.source_mod,
      label: row.label,
      rawLabel: row.label,
      path: text,
      pathKey: text,
      parentIndex: -1,
      totalMs: row.total_ms,
      selfMs: row.self_ms,
      totalMsByWindow: [],
      selfMsByWindow: [],
      category: row.category as FrameCategory,
    };

    const hits = runDetectors({ rows: [asPathRow], divisorTicks: row.ticks });
    const knowledge = lookupKnowledge(row.label, row.source_mod, msPerTick, installed);

    // A detector or a prior investigation may raise feasibility to `likely`,
    // never to `proven`. Anything stronger has to come from a person reading
    // the source: having fixed this once, on a different mod version, is
    // strong evidence it is fixable again -- not proof it is the same bug.
    //
    // A prior finding of `unlikely` (investigated, found necessary) wins over
    // a `likely`, because a conclusion someone actually reached beats a
    // pattern match.
    const suggestions = [...hits.map((h) => h.suggests), ...knowledge.map((k) => k.entry.suggests)];
    const feasibility: Feasibility = suggestions.includes('unlikely')
      ? 'unlikely'
      : suggestions.includes('likely')
        ? 'likely'
        : 'unknown';

    const priority = prioritise({
      msPerTick,
      persistence,
      samples,
      daysObserved: row.days,
      // Only a conclusion someone reached can say "necessary"; a detector
      // can only ever raise the outlook.
      feasibility: feasibility === 'unlikely' ? 'unknown' : feasibility,
      actionability,
      mod: owner,
      ownMod: query.ownMod?.(owner) ?? false,
      verdicts: knowledge.map((k) => k.entry.outcome as KnowledgeVerdict),
    });

    if (query.topOnly === true && !priority.top) continue;

    out.push({
      pathId: row.path_id,
      label: row.label,
      path: text,
      source: owner,
      attribution,
      actionability,
      category: row.category as FrameCategory,
      msPerTick,
      totalMsPerTick: row.total_ms / Math.max(row.ticks, 1),
      secondsPerDay: priority.secondsPerDay,
      persistence,
      samples,
      days: row.days,
      priority,
      detectors: hits,
      knowledge,
      tracked: [],
      feasibility,
      risk: 'unknown',
    });
  }

  out.sort((a, b) => b.priority.winBack - a.priority.winBack || b.msPerTick - a.msPerTick);
  const top = out.slice(0, query.limit ?? 100);

  // Register lookup only for what is actually returned. Doing it inside the
  // loop would be ~450 queries to decorate 100 rows.
  for (const finding of top) finding.tracked = matchRegister(db, finding.label, finding.path);
  return top;
}

export interface FindingsSummary {
  total: number;
  /** Worth a look now. */
  top: number;
  byOutlook: Record<Outlook, number>;
  withDetectorHit: number;
  smallButConstant: number;
  /** Seen and investigated before. The point of keeping history. */
  seenBefore: number;
  /** Already has a register entry. */
  tracked: number;
}

export function summarise(list: readonly Finding[]): FindingsSummary {
  return {
    total: list.length,
    top: list.filter((f) => f.priority.top).length,
    byOutlook: list.reduce(
      (acc, f) => {
        acc[f.priority.outlook] += 1;
        return acc;
      },
      { 'known-fix': 0, 'own-mod': 0, pattern: 0, mod: 0, 'mod-driven': 0, game: 0, 'checked-needed': 0 } as Record<Outlook, number>,
    ),
    withDetectorHit: list.filter((f) => f.detectors.length > 0).length,
    // The category this system exists to surface.
    smallButConstant: list.filter((f) => f.msPerTick < 0.1 && f.persistence > 0.8).length,
    seenBefore: list.filter((f) => f.knowledge.length > 0).length,
    tracked: list.filter((f) => f.tracked.length > 0).length,
  };
}

/**
 * One method, however many call paths reach it.
 *
 * The same method reached from three places used to be three findings with
 * the same name and different numbers, which read as duplicates. They are
 * three genuinely separate costs -- the work is repeated from each caller --
 * so the list shows the method once, with the strongest path leading, the
 * combined cost, and every path underneath. Self time of distinct paths is
 * disjoint, so adding them is sound; totals ("including what it calls") are
 * never added, because they can overlap.
 */
export interface FindingGroup {
  key: string;
  label: string;
  category: FrameCategory;
  lead: Finding;
  paths: Finding[];
  msPerTick: number;
  secondsPerDay: number;
  tracked: RegisterMatch[];
}

export function groupFindings(list: readonly Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of list) {
    const key = `${finding.label}|${finding.category}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key, label: finding.label, category: finding.category, lead: finding, paths: [],
        msPerTick: 0, secondsPerDay: 0, tracked: [],
      };
      groups.set(key, group);
    }
    group.paths.push(finding);
    group.msPerTick += finding.msPerTick;
    group.secondsPerDay += finding.secondsPerDay;
    for (const t of finding.tracked) if (!group.tracked.some((x) => x.id === t.id)) group.tracked.push(t);
  }
  for (const group of groups.values()) {
    group.paths.sort((a, b) => b.msPerTick - a.msPerTick);
  }
  // Input order is priority order, and the first path seen leads.
  return [...groups.values()];
}
