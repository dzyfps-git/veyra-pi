/**
 * Season and revision identity.
 *
 * The server rotates modpacks every 30-45 days, and comparing aggregate MSPT
 * across two different modpacks is meaningless. A "season" is therefore the
 * unit within which numbers are comparable, and it has to be detected
 * automatically -- asking someone to remember to declare a rotation is exactly
 * the kind of manual step that goes wrong once and silently poisons a year of
 * history.
 *
 * Important limitation, established by inspecting real captures: **a capture
 * does not record the modpack name or version.** `extraPlatformMetadata`
 * contains only datapack info. So the pack label is a human-supplied
 * annotation, and everything the system decides automatically is derived from
 * what is actually in the file:
 *
 *   - Minecraft version, loader name and version
 *   - the full mod set with versions
 *   - Java version, JVM args (heap), CPU model and thread count, OS
 *
 * Two distinct ideas:
 *
 *   SEASON  -- a different world to measure in. Minecraft/loader/hardware
 *              changed, or the mod set changed so much it is a different pack.
 *              Aggregate MSPT is never compared across seasons.
 *
 *   REVISION -- same season, but the mod set moved (a mod added, removed, or
 *              version-bumped). Kept as a covariate so a regression can be
 *              attributed to a specific change rather than to "the season".
 */

import { createHash } from 'node:crypto';

import type { SparkProfile } from '../decode/sparkprofile.ts';

export interface ModEntry {
  id: string;
  version: string;
}

export interface EnvironmentFacts {
  minecraftVersion: string;
  loaderName: string;
  loaderVersion: string;
  javaVersion: string;
  /** Major version only, e.g. "17". Patch bumps should not split a season. */
  javaMajor: string;
  /** Max heap in MB parsed from -Xmx, or undefined if not stated. */
  heapMaxMb: number | undefined;
  cpuModel: string;
  cpuThreads: number | undefined;
  osName: string;
  mods: ModEntry[];
  modCount: number;
  /** Hash over sorted `id@version`. Changes whenever any mod version moves. */
  modSetHash: string;
  /** Hash over sorted ids only. Stable across version bumps. */
  modIdSetHash: string;
  /**
   * JVM flags that change how the server runs or how it is profiled:
   * everything starting -X (heap, code cache, GC, diagnostics), sorted.
   * `-D` system properties are left out -- they configure libraries, not the
   * runtime, and would split history over a log4j setting.
   *
   * Undefined when the capture did not record its arguments, which is NOT
   * the same as "no flags" and is never compared as if it were.
   */
  runtimeFlags: string[] | undefined;
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16);
}

/** Parses `-Xmx14G`, `-Xmx14336m`, `-Xmx14680064k` into MB. */
/**
 * The JVM flags that matter for comparing performance.
 *
 * Adding `-XX:+DebugNonSafepoints` changes where the profiler attributes
 * time between a method and its caller; changing the heap or GC changes the
 * server itself. Either can move a figure without any mod changing, so a
 * before/after comparison that straddles one would credit a patch with the
 * flag's effect. They are tracked so that cannot happen silently.
 */
export function runtimeFlagsOf(vmArgs: string | undefined): string[] | undefined {
  if (vmArgs === undefined || vmArgs.trim() === '') return undefined;
  return [...new Set(vmArgs.split(/\s+/).filter((f) => f.startsWith('-X')))].sort();
}

/** Human-readable difference between two flag sets, e.g. ["+ -XX:+DebugNonSafepoints"]. */
export function diffRuntimeFlags(before: readonly string[], after: readonly string[]): string[] {
  const a = new Set(before);
  const b = new Set(after);
  return [
    ...[...b].filter((f) => !a.has(f)).map((f) => `+ ${f}`),
    ...[...a].filter((f) => !b.has(f)).map((f) => `- ${f}`),
  ];
}

export function parseMaxHeapMb(vmArgs: string | undefined): number | undefined {
  if (vmArgs === undefined) return undefined;
  const match = /-Xmx(\d+)\s*([gGmMkK])?/.exec(vmArgs);
  if (match === null) return undefined;
  const value = Number(match[1]);
  switch ((match[2] ?? 'b').toLowerCase()) {
    case 'g': return value * 1024;
    case 'm': return value;
    case 'k': return Math.round(value / 1024);
    default: return Math.round(value / (1024 * 1024));
  }
}

/** `17.0.20.1` -> `17`; `1.8.0_382` -> `8`. */
export function javaMajorOf(version: string): string {
  if (version === '') return '';
  const parts = version.split('.');
  if (parts[0] === '1' && parts[1] !== undefined) return parts[1];
  return parts[0] ?? '';
}

export function extractEnvironment(profile: SparkProfile): EnvironmentFacts {
  const meta = profile.metadata;
  const mods: ModEntry[] = [...meta.sources.entries()]
    .map(([id, info]) => ({ id, version: info.version ?? '' }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const javaVersion = meta.system?.java?.version ?? '';

  return {
    minecraftVersion: meta.platform?.minecraftVersion ?? '',
    loaderName: meta.platform?.name ?? '',
    loaderVersion: meta.platform?.version ?? '',
    javaVersion,
    javaMajor: javaMajorOf(javaVersion),
    heapMaxMb: parseMaxHeapMb(meta.system?.java?.vmArgs),
    cpuModel: meta.system?.cpu?.model ?? '',
    cpuThreads: meta.system?.cpu?.threads,
    osName: meta.system?.os?.name ?? '',
    mods,
    modCount: mods.length,
    modSetHash: sha1(mods.map((m) => `${m.id}@${m.version}`).join('\n')),
    modIdSetHash: sha1(mods.map((m) => m.id).join('\n')),
    runtimeFlags: runtimeFlagsOf(meta.system?.java?.vmArgs),
  };
}

/**
 * Identity of the measurement environment, ignoring mods.
 *
 * Any change here is unambiguously a new season: you cannot meaningfully
 * compare tick times across Minecraft versions, loaders, or hardware.
 */
export function environmentKey(env: EnvironmentFacts): string {
  return sha1(
    [
      env.minecraftVersion,
      env.loaderName,
      env.loaderVersion,
      env.javaMajor,
      env.cpuModel,
      String(env.cpuThreads ?? ''),
      env.osName,
    ].join('|'),
  );
}

/** Fraction of mod ids shared between two sets, ignoring versions. */
export function modSetSimilarity(a: readonly ModEntry[], b: readonly ModEntry[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a.map((m) => m.id));
  const right = new Set(b.map((m) => m.id));
  let intersection = 0;
  for (const id of left) if (right.has(id)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export interface ModSetDiff {
  added: ModEntry[];
  removed: ModEntry[];
  changed: Array<{ id: string; from: string; to: string }>;
  /** True when nothing at all moved. */
  identical: boolean;
}

export function diffModSets(previous: readonly ModEntry[], next: readonly ModEntry[]): ModSetDiff {
  const before = new Map(previous.map((m) => [m.id, m.version]));
  const after = new Map(next.map((m) => [m.id, m.version]));

  const added: ModEntry[] = [];
  const removed: ModEntry[] = [];
  const changed: Array<{ id: string; from: string; to: string }> = [];

  for (const [id, version] of after) {
    const old = before.get(id);
    if (old === undefined) added.push({ id, version });
    else if (old !== version) changed.push({ id, from: old, to: version });
  }
  for (const [id, version] of before) {
    if (!after.has(id)) removed.push({ id, version });
  }

  return {
    added,
    removed,
    changed,
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

/**
 * Captures do NOT form a single timeline.
 *
 * Learned by replaying a real archive: captures from a production server and
 * from a local test server interleave by date. Treating
 * them as one chronological sequence produced three bogus "new season" events
 * in four days, each one really just the timeline hopping between two machines.
 *
 * So captures are bucketed by `environmentKey` FIRST, and seasons are detected
 * within each bucket. A genuinely new environment appearing for a server is a
 * migration or a foreign capture -- either way a question for a human, not a
 * silent season rollover.
 */
export function groupByEnvironment<T>(
  captures: readonly T[],
  envOf: (capture: T) => EnvironmentFacts,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const capture of captures) {
    const key = environmentKey(envOf(capture));
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [capture]);
    else bucket.push(capture);
  }
  return groups;
}

export type BoundaryKind = 'first' | 'same' | 'revision' | 'season';

export interface BoundaryDecision {
  kind: BoundaryKind;
  /** Human-readable justification. Always populated; shown in the UI. */
  reasons: string[];
  similarity: number;
  diff: ModSetDiff;
  /**
   * True when the call is close to the threshold and a human should confirm.
   * Season changes are never committed automatically when this is set.
   */
  needsConfirmation: boolean;
}

export interface SeasonDetectionOptions {
  /**
   * Mod-id overlap below this starts a new season.
   *
   * 0.75 is deliberately permissive: a modpack version bump within a season
   * typically moves a handful of mods out of ~580 (>0.98 similarity), while a
   * genuine pack rotation shares far less. Anything landing between
   * `seasonThreshold` and `confirmBand` above it is flagged for confirmation
   * rather than decided silently.
   */
  seasonThreshold?: number;
  confirmBand?: number;
}

export function classifyBoundary(
  previous: EnvironmentFacts | undefined,
  next: EnvironmentFacts,
  options: SeasonDetectionOptions = {},
): BoundaryDecision {
  const seasonThreshold = options.seasonThreshold ?? 0.75;
  const confirmBand = options.confirmBand ?? 0.1;

  if (previous === undefined) {
    return {
      kind: 'first',
      reasons: ['first capture for this server'],
      similarity: 1,
      diff: { added: [], removed: [], changed: [], identical: true },
      needsConfirmation: false,
    };
  }

  const diff = diffModSets(previous.mods, next.mods);
  const similarity = modSetSimilarity(previous.mods, next.mods);
  const reasons: string[] = [];

  // Hard environment changes. These are not judgement calls.
  if (previous.minecraftVersion !== next.minecraftVersion) {
    reasons.push(`Minecraft ${previous.minecraftVersion} -> ${next.minecraftVersion}`);
  }
  if (previous.loaderName !== next.loaderName) {
    reasons.push(`loader ${previous.loaderName} -> ${next.loaderName}`);
  }
  if (previous.loaderVersion !== next.loaderVersion) {
    reasons.push(`loader version ${previous.loaderVersion} -> ${next.loaderVersion}`);
  }
  if (previous.javaMajor !== next.javaMajor) {
    reasons.push(`Java ${previous.javaMajor} -> ${next.javaMajor}`);
  }
  if (previous.cpuModel !== next.cpuModel || previous.cpuThreads !== next.cpuThreads) {
    reasons.push(`hardware ${previous.cpuModel} (${previous.cpuThreads}t) -> ${next.cpuModel} (${next.cpuThreads}t)`);
  }
  if (previous.osName !== next.osName) {
    reasons.push(`OS ${previous.osName} -> ${next.osName}`);
  }

  if (reasons.length > 0) {
    return { kind: 'season', reasons, similarity, diff, needsConfirmation: false };
  }

  if (similarity < seasonThreshold) {
    return {
      kind: 'season',
      reasons: [`mod set overlap ${(similarity * 100).toFixed(1)}% is below the ${(seasonThreshold * 100).toFixed(0)}% season threshold`],
      similarity,
      diff,
      needsConfirmation: similarity >= seasonThreshold - confirmBand,
    };
  }

  if (diff.identical) {
    // Heap changes do not split a season, but they do change what the numbers
    // mean, so they are surfaced rather than swallowed.
    if (previous.heapMaxMb !== next.heapMaxMb) {
      return {
        kind: 'revision',
        reasons: [`max heap ${previous.heapMaxMb ?? '?'} MB -> ${next.heapMaxMb ?? '?'} MB`],
        similarity,
        diff,
        needsConfirmation: false,
      };
    }
    return { kind: 'same', reasons: [], similarity, diff, needsConfirmation: false };
  }

  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`${diff.added.length} added`);
  if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
  if (diff.changed.length > 0) parts.push(`${diff.changed.length} version-changed`);
  if (previous.heapMaxMb !== next.heapMaxMb) {
    parts.push(`heap ${previous.heapMaxMb ?? '?'} -> ${next.heapMaxMb ?? '?'} MB`);
  }

  return {
    kind: 'revision',
    reasons: [parts.join(', ')],
    similarity,
    diff,
    needsConfirmation: similarity < seasonThreshold + confirmBand,
  };
}
