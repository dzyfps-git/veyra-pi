/**
 * Pattern detectors.
 *
 * These look for shapes in the call tree that have historically turned out to
 * be fixable. Every one of them is a HEURISTIC, and the output says so: a hit
 * can raise feasibility to "likely", never to "proven". The system is allowed
 * to say "this looks like a known bug"; it is not allowed to say "this is a
 * bug" without someone reading the source.
 *
 * The detector set is seeded from bug classes already found and fixed on a
 * real server, because a detector that has caught something real once is
 * worth more than a generic code smell:
 *
 *   collection rebuild   `entrySet()` rebuilding a collection every tick
 *   blocking chunk load  a synchronous chunk load on the server thread
 *   QuestProgress        redundant deep NBT copies
 *   Archon               setter -> sync packet on an unchanged value
 *   Simply Swords        config lookup by string in a hot path
 *   things-0.3.3         exception construction in a tick path (a
 *                        playerabilitylib warning loop)
 */

import type { PathRow } from '../decode/aggregate.ts';

export type Feasibility = 'unknown' | 'likely' | 'unlikely' | 'proven';

export interface DetectorHit {
  detector: string;
  title: string;
  /** What was seen, in terms of the evidence rather than the conclusion. */
  observation: string;
  /** What it might mean, explicitly framed as a hypothesis. */
  hypothesis: string;
  /** What would settle it. Always names a concrete next step. */
  confirmBy: string;
  /** Detectors may suggest 'likely' at most. Never 'proven'. */
  suggests: Exclude<Feasibility, 'proven'>;
  pathId?: number;
  label: string;
  source: string | null;
  selfMs: number;
  totalMs: number;
  msPerTick: number;
}

export interface DetectorContext {
  rows: readonly PathRow[];
  divisorTicks: number | undefined;
  /** Ignore frames cheaper than this when scanning, purely for speed. */
  scanFloorMs?: number;
}

interface Detector {
  id: string;
  title: string;
  /** Matches a single frame in isolation. */
  match: (row: PathRow) => boolean;
  observation: (row: PathRow) => string;
  hypothesis: string;
  confirmBy: string;
  suggests: Exclude<Feasibility, 'proven'>;
  /** Only meaningful inside the tick loop. */
  tickPathOnly?: boolean;
}

const COLLECTION_REBUILD = /^(entrySet|keySet|values|putAll|copyOf|toArray|asList|unmodifiable\w*|of)$/;
const NBT_COPY = /^(copy|deepCopy|clone)$/;

const DETECTORS: Detector[] = [
  {
    id: 'blocking-chunk-load',
    title: 'Blocking chunk load on the server thread',
    match: (r) =>
      /getChunkBlocking|getChunkFutureMainThread|ChunkHolder|getChunkNow/.test(r.methodName) ||
      (r.category === 'blocked' && /chunk/i.test(r.path)),
    observation: (r) => `${r.methodName} appears on the server thread, category "${r.category}".`,
    hypothesis:
      'The tick is stalling while a chunk is loaded synchronously. This is lost tick time, not idle waiting, ' +
      'and is usually caused by code reaching into a chunk that may not be loaded.',
    confirmBy:
      'Read the calling mod\'s source at this frame and check whether the lookup can be made async, cached, ' +
      'or guarded with a loaded-chunk check.',
    suggests: 'likely',
  },
  {
    id: 'per-tick-collection-rebuild',
    title: 'Collection rebuilt every tick',
    match: (r) => COLLECTION_REBUILD.test(r.methodName),
    observation: (r) => `${r.className}.${r.methodName} runs inside the tick loop.`,
    hypothesis:
      'A collection view or copy is being constructed repeatedly rather than cached. A known example is ' +
      'the TCLayer ImmutableDelegatingMap.entrySet() cost.',
    confirmBy:
      'Check whether the underlying collection actually changes between calls. If it does not, a cached view ' +
      'with correct invalidation is usually safe.',
    suggests: 'likely',
    tickPathOnly: true,
  },
  {
    id: 'redundant-deep-copy',
    title: 'Deep copy in a tick path',
    match: (r) => NBT_COPY.test(r.methodName) && /Nbt|Compound|Tag|Stack|ItemStack/i.test(r.className),
    observation: (r) => `${r.className}.${r.methodName} copies a structure inside the tick loop.`,
    hypothesis:
      'A defensive copy may be made where the original is never mutated. Matches the QuestProgress triple ' +
      'deep-copy pattern found here previously.',
    confirmBy: 'Trace whether any caller mutates the copy. If not, the copy can often be elided entirely.',
    suggests: 'likely',
    tickPathOnly: true,
  },
  {
    id: 'reflection-in-tick',
    title: 'Reflection in a tick path',
    match: (r) =>
      /^java\.lang\.reflect\.|^jdk\.internal\.reflect\.|^java\.lang\.invoke\.LambdaMetafactory/.test(r.className) ||
      (r.className === 'java.lang.Class' && /forName|getMethod|getDeclaredMethod|getField/.test(r.methodName)),
    observation: (r) => `${r.className}.${r.methodName} is invoked during ticking.`,
    hypothesis:
      'Reflective lookup per tick. Results are almost always cacheable, and this is one of the few patterns ' +
      'that is nearly always worth fixing.',
    confirmBy: 'Check whether the reflective handle can be resolved once and stored.',
    suggests: 'likely',
    tickPathOnly: true,
  },
  {
    id: 'exception-construction',
    title: 'Exception construction in a hot path',
    match: (r) =>
      /fillInStackTrace|getStackTrace/.test(r.methodName) ||
      (r.methodName === '<init>' && /Exception|Throwable|Error$/.test(r.className)),
    observation: (r) => `${r.className}.${r.methodName} — stack traces are being captured during normal operation.`,
    hypothesis:
      'Exceptions used for control flow, or a warning being logged repeatedly. Capturing a stack trace is ' +
      'expensive. The live playerabilitylib tamper-warning loop from things-0.3.3 is an instance of this.',
    confirmBy: 'Find the throw site. Silencing a repeated warning or avoiding the throw usually removes the cost outright.',
    suggests: 'likely',
  },
  {
    id: 'string-building-in-tick',
    title: 'String formatting in a tick path',
    match: (r) =>
      (/^java\.lang\.String$/.test(r.className) && /format|concat|join|valueOf/.test(r.methodName)) ||
      (/StringBuilder|StringJoiner|MessageFormat/.test(r.className) && /append|toString|format/.test(r.methodName)),
    observation: (r) => `${r.className}.${r.methodName} runs during ticking.`,
    hypothesis:
      'Strings are being built every tick, often for a log line that is discarded, or a key that could be precomputed.',
    confirmBy: 'Check whether the string is actually used, and whether it can be hoisted or guarded by a level check.',
    suggests: 'likely',
    tickPathOnly: true,
  },
  {
    id: 'registry-lookup-by-string',
    title: 'Registry or config lookup by name per tick',
    match: (r) =>
      /Registry|Identifier|ResourceLocation|Config/.test(r.className) &&
      /get|parse|tryParse|of|lookup|getOrDefault|getValue/.test(r.methodName),
    observation: (r) => `${r.className}.${r.methodName} resolves a named entry inside the tick loop.`,
    hypothesis:
      'A lookup by string or identifier that could be resolved once at load. Matches the Simply Swords ' +
      'config-cache pattern already patched here.',
    confirmBy: 'Check whether the key is constant for the lifetime of the object holding it.',
    suggests: 'likely',
    tickPathOnly: true,
  },
  {
    id: 'boxing-and-streams',
    title: 'Stream or boxing churn in a tick path',
    match: (r) =>
      /^java\.util\.stream\./.test(r.className) ||
      (/^java\.lang\.(Integer|Long|Double|Float|Boolean)$/.test(r.className) && r.methodName === 'valueOf'),
    observation: (r) => `${r.className}.${r.methodName} allocates during ticking.`,
    hypothesis:
      'Allocation churn rather than raw CPU. Costs here show up as GC pressure as much as tick time, so the ' +
      'tick figure understates the real impact.',
    confirmBy: 'Run an allocation profile over the same path to see the byte rate, then decide if it is worth a rewrite.',
    suggests: 'unknown',
    tickPathOnly: true,
  },
];

/** Frames belonging to Minecraft or the JDK rather than to a mod. */
function isVanillaOrJdk(row: PathRow): boolean {
  return (
    row.source === null &&
    (row.className.startsWith('net.minecraft.') ||
      row.className.startsWith('java.') ||
      row.className.startsWith('jdk.') ||
      row.className.startsWith('sun.'))
  );
}

export function runDetectors(context: DetectorContext): DetectorHit[] {
  const floor = context.scanFloorMs ?? 0;
  const ticks = context.divisorTicks;
  const hits: DetectorHit[] = [];

  // A frame is "in the tick loop" when the tick anchor appears in its path.
  const inTickPath = (row: PathRow): boolean => row.path.includes('MinecraftServer.tick');

  for (const row of context.rows) {
    if (row.totalMs < floor) continue;
    if (row.category === 'idle') continue; // Deliberate waiting is not a finding.

    for (const detector of DETECTORS) {
      if (detector.tickPathOnly === true && !inTickPath(row)) continue;
      if (!detector.match(row)) continue;

      hits.push({
        detector: detector.id,
        title: detector.title,
        observation: detector.observation(row),
        hypothesis: detector.hypothesis,
        confirmBy: detector.confirmBy,
        suggests: detector.suggests,
        label: row.label,
        source: row.source ?? (isVanillaOrJdk(row) ? 'minecraft/jdk' : null),
        selfMs: row.selfMs,
        totalMs: row.totalMs,
        msPerTick: ticks === undefined || ticks === 0 ? 0 : row.totalMs / ticks,
      });
    }
  }

  // Strongest evidence first, but keep every hit: a small one may be the
  // cheapest thing on the list to actually fix.
  hits.sort((a, b) => b.msPerTick - a.msPerTick);
  return hits;
}

/**
 * Detect one expensive leaf reached from many distinct callers.
 *
 * Reported separately because it is a property of the tree, not of a frame.
 * A memoization candidate: the same work repeated from unrelated places.
 */
export function findFanIn(rows: readonly PathRow[], minParents = 8): DetectorHit[] {
  const byLabel = new Map<string, { parents: Set<number>; selfMs: number; totalMs: number; row: PathRow }>();
  for (const row of rows) {
    if (row.category === 'idle') continue;
    let entry = byLabel.get(row.label);
    if (entry === undefined) {
      entry = { parents: new Set(), selfMs: 0, totalMs: 0, row };
      byLabel.set(row.label, entry);
    }
    entry.parents.add(row.parentIndex);
    entry.selfMs += row.selfMs;
    entry.totalMs += row.totalMs;
  }

  const hits: DetectorHit[] = [];
  for (const [label, entry] of byLabel) {
    if (entry.parents.size < minParents) continue;
    hits.push({
      detector: 'fan-in',
      title: 'Same work reached from many callers',
      observation: `${label} is called from ${entry.parents.size} distinct call sites.`,
      hypothesis:
        'Repeated identical work spread across unrelated callers. If the inputs repeat, one cache can remove ' +
        'the cost from all of them at once — a better return than optimising any single caller.',
      confirmBy: 'Check whether the arguments repeat within a tick, and whether a result is safely cacheable.',
      suggests: 'unknown',
      label,
      source: entry.row.source,
      selfMs: entry.selfMs,
      totalMs: entry.totalMs,
      msPerTick: 0,
    });
  }
  return hits.sort((a, b) => b.selfMs - a.selfMs);
}
