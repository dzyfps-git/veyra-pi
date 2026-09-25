/**
 * Turns a decoded `SparkProfile` into the flat, per-call-path rows that the
 * ledger stores.
 *
 * Three semantics here are load-bearing, and all three come from mistakes that
 * have already been made by hand on real profiles:
 *
 *  1. SELF vs TOTAL are kept strictly separate and are never summed across
 *     nested rows. (An `entrySet()` / `lambda$entrySet$12` figure once had to
 *     be retracted because a parent and its own nested lambda were added together.)
 *
 *  2. THREAD WALL TIME IS NOT WORK. A server thread that parks waiting for the
 *     next tick reports ~50 ms/tick of wall time. The headline number must be
 *     *sampled active* time, with the park/wait subtree excluded.
 *
 *  3. NOTHING IS THRESHOLDED. Every node in the pool produces a row, however
 *     small. Filtering is a read-time concern; a cost dropped at ingest can
 *     never be recovered, and small recurring costs are the whole point.
 */

import type { SparkProfile, StackNode, ThreadNode } from './sparkprofile.ts';

/**
 * JDK frames where a thread is parked or sleeping.
 *
 * These are JDK classes, so they are never obfuscated and can be matched
 * without mappings. Being parked does NOT by itself mean idle -- see
 * `IDLE_ANCHORS`.
 */
const PARK_FRAMES: ReadonlyArray<{ className: string; methodName: string }> = [
  { className: 'jdk.internal.misc.Unsafe', methodName: 'park' },
  { className: 'sun.misc.Unsafe', methodName: 'park' },
  { className: 'java.util.concurrent.locks.LockSupport', methodName: 'park' },
  { className: 'java.util.concurrent.locks.LockSupport', methodName: 'parkNanos' },
  { className: 'java.lang.Thread', methodName: 'sleep' },
];

/**
 * Mapped method names under which a park means "waiting for the next tick".
 *
 * This distinction is the whole reason mappings matter here. A park reached
 * through `MinecraftServer.waitForTasks` is the server deliberately sleeping
 * out the rest of its 50 ms budget -- not work, and it must be excluded or the
 * headline figure reads ~50 ms/tick on a perfectly healthy server.
 *
 * A park reached ANYWHERE ELSE is the opposite: the tick is stalled on
 * something (a blocking chunk load, lock contention, disk). That time is real
 * lost tick time and is often the most interesting thing in the capture, so it
 * is classified `blocked` and surfaced separately rather than hidden.
 */
const IDLE_ANCHORS: ReadonlySet<string> = new Set([
  // Yarn (Fabric/Quilt, after mappings are applied). Verified.
  'net.minecraft.server.MinecraftServer.waitForTasks',
  // Mojang's official names, which NeoForge 1.20.5+ runs with directly, so
  // they appear in a capture with no mappings applied at all. Added so a
  // rotation to a NeoForge pack does not silently lose the headline
  // figure. NOT YET VERIFIED against a real NeoForge capture -- the first
  // one ingested should be checked against its own published figures, the
  // way the Yarn anchor was checked against kL8mN2pQ4r.
  'net.minecraft.server.MinecraftServer.waitUntilNextTick',
]);

/**
 * Mapped method names whose inclusive time IS the tick.
 *
 * This is the headline figure and the one that lines up with MSPT and with the
 * existing "sampled active MSPT" convention in PATCH_LEADERBOARD.md. Verified
 * against capture kL8mN2pQ4r, where this yields 11.407 ms/tick -- the exact
 * figure published in that capture's analysis.
 *
 * Note it is NOT the same as (wall - idle): the server also runs queued tasks
 * between ticks, which is real work but does not consume the tick budget. That
 * difference is reported as `betweenTickMs` rather than being folded in, per
 * the archive convention of reporting between-tick work separately.
 */
const TICK_ANCHORS: ReadonlySet<string> = new Set([
  // Yarn. Verified: reproduces 11.407 ms/tick on kL8mN2pQ4r exactly.
  'net.minecraft.server.MinecraftServer.tick',
  // Mojang official name (NeoForge 1.20.5+). Not yet verified; see above.
  'net.minecraft.server.MinecraftServer.tickServer',
]);

/**
 * How a frame's time should be interpreted.
 *
 * `waiting` means a park was found but mappings were unavailable, so we could
 * not tell idle from blocked. It is reported as its own category rather than
 * being silently folded into either one.
 */
export type FrameCategory = 'work' | 'idle' | 'blocked' | 'waiting';

export interface PathRow {
  /** Index into `SparkProfile.threads`. */
  threadIndex: number;
  threadName: string;
  /** Depth below the thread root; thread roots are depth 0. */
  depth: number;
  className: string;
  methodName: string;
  methodDesc: string;
  lineNumber: number;
  parentLineNumber: number;
  /** Owning mod/plugin id, or null when spark could not attribute the frame. */
  source: string | null;
  /** `Class.method` for this frame, after mapping. */
  label: string;
  /**
   * `Class.method` exactly as the capture recorded it, before mapping.
   *
   * Kept because the archive contains a mix of naming states: captures taken
   * while StackDeobfuscator is active already carry named frames, while others
   * carry intermediary (`class_2841.method_12331`). Storing both lets the
   * ledger normalise identity across that boundary instead of treating the
   * same method as two different things.
   */
  rawLabel: string;
  /** Full call path from the thread root, joined with " > ". */
  path: string;
  /** Stable identity for this path across captures. */
  pathKey: string;
  /** Row index of this node's parent within the same result, or -1 for a root. */
  parentIndex: number;
  /** Inclusive time: this frame and everything it called. */
  totalMs: number;
  /** Exclusive time: this frame only. Never negative. */
  selfMs: number;
  /** Inclusive time per time window, parallel to `SparkProfile.timeWindows`. */
  totalMsByWindow: number[];
  /** Exclusive time per time window. */
  selfMsByWindow: number[];
  /** Work, deliberate tick-wait, a stall, or an unclassifiable park. */
  category: FrameCategory;
}

export interface ThreadSummary {
  threadIndex: number;
  name: string;
  /** Total sampled wall time on this thread. */
  totalMs: number;
  /** Deliberate waiting for the next tick. Not work, and not a problem. */
  idleMs: number;
  /**
   * Time parked on something other than the tick wait: blocking chunk loads,
   * lock contention, disk. This IS lost tick time and is included in
   * `activeMs`; it is broken out because it is usually worth investigating.
   */
  blockedMs: number;
  /** Parked, but mappings were unavailable so idle/blocked is undetermined. */
  unclassifiedWaitMs: number;
  /**
   * Inclusive time of the tick loop: the headline figure, comparable to MSPT.
   * Undefined when mappings were unavailable, so the anchor could not be found.
   */
  tickMs: number | undefined;
  /**
   * Non-idle work outside the tick loop (queued tasks run between ticks).
   * Real work, but it does not consume the tick budget, so it is reported
   * separately rather than added to the tick figure.
   */
  betweenTickMs: number | undefined;
  /** `totalMs - idleMs`: all non-idle time on the thread. */
  activeMs: number;
}

export interface AggregatedProfile {
  rows: PathRow[];
  threads: ThreadSummary[];
  /** Window ids from the capture, parallel to every `*ByWindow` array. */
  timeWindows: number[];
  /**
   * Tick count used to convert milliseconds to ms/tick.
   *
   * Prefers the ticked aggregator's included-tick count, falling back to the
   * capture's total tick count. Undefined when neither is present, in which
   * case per-tick figures are simply not produced rather than guessed.
   */
  divisorTicks: number | undefined;
  /** Sum of `activeMs` across every sampled thread. */
  totalActiveMs: number;
  /** Active ms per tick across all sampled threads, when a divisor exists. */
  activeMsPerTick: number | undefined;
  /**
   * THE headline number: tick-loop ms per tick, comparable to MSPT and to the
   * existing archive's "sampled active MSPT". Undefined without mappings.
   */
  tickMsPerTick: number | undefined;
}

/** Sum of a node's per-window times, falling back to the legacy scalar. */
function nodeTotal(node: { times: number[]; legacyTime?: number }): number {
  if (node.times.length > 0) {
    let sum = 0;
    for (const value of node.times) sum += value;
    return sum;
  }
  return node.legacyTime ?? 0;
}

/**
 * Resolve a node's direct children.
 *
 * Modern captures use a flat pool with `childrenRefs` indices; older ones nest
 * `children` inline. An archive spanning several spark versions contains both.
 */
function directChildren(thread: ThreadNode, node: StackNode | ThreadNode): StackNode[] {
  const inline = 'inlineChildren' in node ? node.inlineChildren : [];
  if (inline.length > 0 && node.childrenRefs.length === 0) return inline;
  const out: StackNode[] = [];
  for (const ref of node.childrenRefs) {
    const child = thread.children[ref];
    if (child !== undefined) out.push(child);
  }
  return out;
}

function isParkFrame(node: StackNode): boolean {
  const className = node.className ?? '';
  const methodName = node.methodName ?? '';
  return PARK_FRAMES.some((f) => f.className === className && f.methodName === methodName);
}

/**
 * Attribute a frame to the mod that owns it.
 *
 * spark supplies three lookup tables at different granularities. The key
 * shapes below mirror the ones spark's own viewer tries, most specific first.
 */
function sourceForNode(node: StackNode, profile: SparkProfile): string | null {
  const className = node.className ?? '';
  const methodName = node.methodName ?? '';
  const lineNumber = node.lineNumber ?? 0;
  const parentLineNumber = node.parentLineNumber ?? 0;

  const candidates = [
    `${className};${lineNumber}`,
    `${className};${parentLineNumber}`,
    `${className}.${methodName}:${lineNumber}`,
    `${className}.${methodName}`,
    `${className}#${methodName}:${lineNumber}`,
    `${className}#${methodName}`,
  ];
  for (const key of candidates) {
    const line = profile.lineSources.get(key);
    if (line !== undefined) return line;
    const method = profile.methodSources.get(key);
    if (method !== undefined) return method;
  }
  return profile.classSources.get(className) ?? null;
}

function subtract(a: number, b: number): number {
  // Sampling noise and window-boundary rounding can make children marginally
  // exceed their parent. Clamp rather than emit a negative self time.
  const diff = a - b;
  return diff > 0 ? diff : 0;
}

export interface AggregateOptions {
  /** Rename frames, e.g. via Yarn mappings. Applied to the label and path. */
  renameFrame?: (className: string, methodName: string) => string;
  /**
   * Whether `renameFrame` can actually resolve Minecraft names.
   *
   * Without mappings the idle anchor (`MinecraftServer.waitForTasks`) is an
   * unreadable intermediary name, so idle cannot be told from blocked. When
   * false, parks are reported as `waiting` instead of being guessed either way.
   */
  mappingsAvailable?: boolean;
}

export function aggregateProfile(profile: SparkProfile, options: AggregateOptions = {}): AggregatedProfile {
  const windowCount = profile.timeWindows.length;
  const rows: PathRow[] = [];
  const threads: ThreadSummary[] = [];

  const mappingsAvailable = options.mappingsAvailable ?? false;
  const label = (className: string, methodName: string): string =>
    options.renameFrame ? options.renameFrame(className, methodName) : `${className}.${methodName}`;

  profile.threads.forEach((thread, threadIndex) => {
    const threadName = thread.name ?? '<unnamed>';
    let idleMs = 0;
    let blockedMs = 0;
    let unclassifiedWaitMs = 0;
    let tickMs = 0;
    let sawTickAnchor = false;

    // Iterative DFS. The pool can hold tens of thousands of nodes and a
    // pathological capture should not blow the JS stack.
    interface Frame {
      node: StackNode;
      depth: number;
      parentIndex: number;
      pathPrefix: string;
      /** Non-null once an ancestor established a non-work category. */
      inherited: FrameCategory | null;
      underIdleAnchor: boolean;
      underTickAnchor: boolean;
    }

    const visited = new Set<StackNode>();
    const stack: Frame[] = [];
    for (const root of directChildren(thread, thread).reverse()) {
      stack.push({
        node: root,
        depth: 0,
        parentIndex: -1,
        pathPrefix: '',
        inherited: null,
        underIdleAnchor: false,
        underTickAnchor: false,
      });
    }

    while (stack.length > 0) {
      const frame = stack.pop()!;
      const { node } = frame;

      // spark emits a tree, but a corrupt or hand-edited capture could contain
      // a cycle. Visiting each pool node once bounds the walk either way.
      if (visited.has(node)) continue;
      visited.add(node);

      const className = node.className ?? '<unknown>';
      const methodName = node.methodName ?? '<unknown>';
      const frameLabel = label(className, methodName);
      const path = frame.pathPrefix === '' ? frameLabel : `${frame.pathPrefix} > ${frameLabel}`;

      const children = directChildren(thread, node);
      const totalMs = nodeTotal(node);

      let childTotal = 0;
      for (const child of children) childTotal += nodeTotal(child);

      const totalMsByWindow: number[] = new Array(windowCount).fill(0);
      const selfMsByWindow: number[] = new Array(windowCount).fill(0);
      for (let w = 0; w < windowCount; w += 1) {
        const own = node.times[w] ?? 0;
        let kids = 0;
        for (const child of children) kids += child.times[w] ?? 0;
        totalMsByWindow[w] = own;
        selfMsByWindow[w] = subtract(own, kids);
      }

      // Classify. Only the topmost park in a chain is counted, so nested
      // park frames never double-count into the totals.
      let category: FrameCategory;
      if (frame.inherited !== null) {
        category = frame.inherited;
      } else if (isParkFrame(node)) {
        if (!mappingsAvailable) category = 'waiting';
        else category = frame.underIdleAnchor ? 'idle' : 'blocked';
        if (category === 'idle') idleMs += totalMs;
        else if (category === 'blocked') blockedMs += totalMs;
        else unclassifiedWaitMs += totalMs;
      } else {
        category = 'work';
      }

      const rowIndex = rows.length;
      rows.push({
        threadIndex,
        threadName,
        depth: frame.depth,
        className,
        methodName,
        methodDesc: node.methodDesc ?? '',
        lineNumber: node.lineNumber ?? 0,
        parentLineNumber: node.parentLineNumber ?? 0,
        source: sourceForNode(node, profile),
        label: frameLabel,
        rawLabel: `${className}.${methodName}`,
        path,
        pathKey: path,
        parentIndex: frame.parentIndex,
        totalMs,
        selfMs: subtract(totalMs, childTotal),
        totalMsByWindow,
        selfMsByWindow,
        category,
      });

      // Count only the topmost tick anchor, so a recursive or re-entrant tick
      // frame cannot inflate the headline figure.
      if (!frame.underTickAnchor && TICK_ANCHORS.has(frameLabel)) {
        tickMs += totalMs;
        sawTickAnchor = true;
      }

      const underIdleAnchor = frame.underIdleAnchor || IDLE_ANCHORS.has(frameLabel);
      const underTickAnchor = frame.underTickAnchor || TICK_ANCHORS.has(frameLabel);
      const inherited = category === 'work' ? null : category;
      for (const child of children.slice().reverse()) {
        stack.push({
          node: child,
          depth: frame.depth + 1,
          parentIndex: rowIndex,
          pathPrefix: path,
          inherited,
          underIdleAnchor,
          underTickAnchor,
        });
      }
    }

    const totalMs = nodeTotal(thread);
    const activeMs = subtract(totalMs, idleMs);
    threads.push({
      threadIndex,
      name: threadName,
      totalMs,
      idleMs,
      blockedMs,
      unclassifiedWaitMs,
      tickMs: sawTickAnchor ? tickMs : undefined,
      betweenTickMs: sawTickAnchor ? subtract(activeMs, tickMs) : undefined,
      activeMs,
    });
  });

  const aggregator = profile.metadata.dataAggregator;
  const divisorTicks =
    (aggregator?.numberOfIncludedTicks !== undefined && aggregator.numberOfIncludedTicks > 0
      ? aggregator.numberOfIncludedTicks
      : undefined) ??
    (profile.metadata.numberOfTicks !== undefined && profile.metadata.numberOfTicks > 0
      ? profile.metadata.numberOfTicks
      : undefined);

  const totalActiveMs = threads.reduce((sum, t) => sum + t.activeMs, 0);
  const tickThreads = threads.filter((t) => t.tickMs !== undefined);
  const totalTickMs = tickThreads.reduce((sum, t) => sum + (t.tickMs ?? 0), 0);

  return {
    rows,
    threads,
    timeWindows: profile.timeWindows,
    divisorTicks,
    totalActiveMs,
    activeMsPerTick: divisorTicks === undefined ? undefined : totalActiveMs / divisorTicks,
    tickMsPerTick:
      divisorTicks === undefined || tickThreads.length === 0 ? undefined : totalTickMs / divisorTicks,
  };
}

/** Aggregate rows by an arbitrary key, keeping self and total strictly apart. */
export interface RollupEntry {
  key: string;
  selfMs: number;
  totalMs: number;
  /** Number of distinct call paths that contributed. */
  paths: number;
}

export function rollupBy(rows: readonly PathRow[], keyOf: (row: PathRow) => string): RollupEntry[] {
  const map = new Map<string, RollupEntry>();
  for (const row of rows) {
    const key = keyOf(row);
    let entry = map.get(key);
    if (entry === undefined) {
      entry = { key, selfMs: 0, totalMs: 0, paths: 0 };
      map.set(key, entry);
    }
    entry.selfMs += row.selfMs;
    // NOTE: totalMs is only meaningful when the grouped rows are not nested
    // within one another. Callers that group by method must treat it as an
    // upper bound, never as a sum of disjoint work.
    entry.totalMs += row.totalMs;
    entry.paths += 1;
  }
  return [...map.values()];
}
