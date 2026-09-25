/**
 * The known-fix knowledge base.
 *
 * A detector recognises a *shape*. This recognises a *specific thing that has
 * already been investigated* — which is a much stronger statement, and
 * the reason it is a separate file: when a problem comes back after a modpack
 * rotation, the work already done on it should surface immediately rather
 * than being rediscovered from scratch three seasons later.
 *
 * Two sources feed it:
 *
 *   1. **Curated entries below.** Hand-written, version-controlled, each one
 *      tied to a real prior investigation on a real server. They carry an
 *      outcome, not just a suggestion, so an entry can say "we tried this and
 *      it worked" or "we measured this and it was not worth patching".
 *
 *   2. **The register**, via `matchRegister`. Anything tracked in the
 *      optimization register is matched by target label, so a finding that
 *      corresponds to open or completed work says so on sight.
 *
 * What an entry may NOT do is set feasibility to `proven` for a *new*
 * observation. "We fixed this once, on a different modpack, in a different
 * mod version" is strong evidence that it is fixable again, not proof that
 * this particular cost is the same bug. The strongest it offers is `likely`,
 * same as a detector, and it always names what would confirm it.
 */

import type { Feasibility } from './detectors.ts';
import type { Recheck } from './recheck.ts';
import type { DatabaseSync } from 'node:sqlite';

export type KnowledgeOutcome =
  /** Patched here and measured to have helped. */
  | 'fixed-here'
  /** Patched here and measured to have changed nothing worth keeping. */
  | 'no-benefit-here'
  /** Fixed upstream in a later version of the mod. */
  | 'fixed-upstream'
  /** A configuration switch avoids it; no patch needed. */
  | 'config-switch'
  /** Investigated and found to be necessary work. */
  | 'necessary'
  /** Looked at, not resolved. */
  | 'open';

export interface KnowledgeEntry {
  id: string;
  /** Matched against the frame label, case-insensitively. */
  match: RegExp;
  /** The mod id it belongs to. When a frame is attributed, it must be this mod. */
  mod: string;
  /**
   * The exact version it was measured on. The entry applies only while that
   * version is installed: any other version, older or newer, may already have
   * fixed it, and nobody has measured that.
   */
  modVersion: string;
  title: string;
  outcome: KnowledgeOutcome;
  /** What was found last time, in plain terms. */
  finding: string;
  /** What was done about it, or why nothing was. */
  resolution: string;
  /**
   * Measured cost when it was last seen here, ms/tick. Recorded so a
   * recurrence can be compared against it rather than guessed at.
   */
  lastMsPerTick?: number;
  /**
   * The conditions `lastMsPerTick` was measured under.
   *
   * Required whenever `lastMsPerTick` is set, and not optional politeness:
   * these historical figures come from captures taken on a mix of machines
   * at a mix of player counts, and most of the costs here scale with load.
   * Without the context, "higher than last time" is the same cross-sampler,
   * cross-load comparison the rest of the system refuses to make.
   */
  measuredUnder?: string;
  /** When the prior work happened. Context decays; the date says how much. */
  when: string;
  /** What would establish that this is the same problem again. */
  confirmBy: string;
  /** Never 'proven': prior work on another version is evidence, not proof. */
  suggests: Exclude<Feasibility, 'proven'>;
}

/**
 * Curated entries.
 *
 * Every one of these was measured on a real modded Fabric 1.20.1 server, on
 * one exact version of one public mod, with the conditions it was measured
 * under. Figures are that one server's, not a promise.
 */
export const KNOWLEDGE: readonly KnowledgeEntry[] = [
  {
    id: 'bclib-maxnearby',
    match: /SpawnRuleBuilder.*maxNearby|maxNearby/i,
    mod: 'bclib',
    modVersion: '3.0.14',
    title: 'BCLib maxNearby scans all matches instead of stopping early',
    outcome: 'open',
    finding:
      'Averages 0.51-0.67 ms/tick but reached 5.98 in a single minute. A low average hiding a pathological ' +
      'nearby-entity scan is exactly the shape a time-sorted profile buries.',
    resolution: 'Worth fixing for spike protection: stop after maxNearby + 1 matches rather than collecting all.',
    lastMsPerTick: 0.67,
    measuredUnder: 'across four captures at 8-11 players; the 5.98 peak was a single minute',
    when: '2026-08-29',
    confirmBy: 'Check the worst-minute figure, not the average. This one is only visible in the tail.',
    suggests: 'likely',
  },
  {
    id: 'lootr-tileticker',
    match: /lootr[.$].*(TileTicker|ConfigManager)|TileTicker/i,
    modVersion: '0.7.35.86',
    mod: 'lootr',
    title: 'Lootr rebuilds its tile set every tick',
    outcome: 'open',
    finding: '0.50 ms/tick, from rebuilding or copying the linked tile set each tick.',
    resolution: 'Audit first. Invalidate on registration/removal lifecycle events instead of rebuilding.',
    lastMsPerTick: 0.5,
    measuredUnder: 'a 20-minute capture at 6-8 players',
    when: '2026-08-31',
    confirmBy: 'Check whether the tile set is rebuilt unconditionally or only when membership changed.',
    suggests: 'likely',
  },
  {
    id: 'blockswap-retrogen',
    match: /blockswap|isIncompatibleBlock|runRetroGenerator/i,
    mod: 'blockswap',
    modVersion: '5.0.0.0',
    title: 'BlockSwap retro-generation running after it is needed',
    outcome: 'open',
    finding: '0.70 ms/tick, 0.92 four-capture mean, 2.04 worst minute. Highly workload-dependent.',
    resolution: 'Retire retrogen once complete, or gate on a cheap source-block/palette check.',
    lastMsPerTick: 0.7,
    measuredUnder: 'a 20-minute capture at 6-8 players; highly workload-dependent',
    when: '2026-08-31',
    confirmBy: 'Check whether retro-generation still has work to do in this world, or is scanning for nothing.',
    suggests: 'likely',
  },
  {
    id: 'opac-spawn-permission',
    match: /openpartiesandclaims|onIsNaturalSpawningAllowed/i,
    mod: 'openpartiesandclaims',
    modVersion: '0.25.10',
    title: 'OPAC natural-spawn permission check on every spawn candidate',
    outcome: 'open',
    finding:
      '1.24 ms/tick, with an earlier run in a claimed area reaching 2.81. Situational rather than universally ' +
      'expensive.',
    resolution:
      'Not resolved. Either cache only with complete claim/config/world invalidation, or prove that OPAC ' +
      'spawn-protection settings let the hook be bypassed entirely.',
    lastMsPerTick: 1.24,
    measuredUnder: 'a 15-minute capture at 8-9 players; this cost scales with spawn candidates and claimed area',
    when: '2026-08-29',
    confirmBy:
      'Check whether the hook runs per spawn candidate or per chunk, and whether any claim exists in the area ' +
      'being tested. A large figure here may mean claims changed, not that the code did.',
    suggests: 'likely',
  },
  {
    id: 'bumblezone-spawn-event',
    match: /the_bumblezone|bumblezone/i,
    mod: 'the_bumblezone',
    modVersion: '7.9.10+1.20.1-fabric',
    title: 'Bumblezone natural-spawn event wrapper',
    outcome: 'open',
    finding:
      '0.843 ms/tick, almost entirely self time: event construction and dispatch runs for every natural-spawn ' +
      'candidate.',
    resolution:
      'Not resolved, and audit-first. Every installed listener has to be checked, because a fast path that ' +
      'skips dispatch would change behaviour for any listener that can alter the result.',
    lastMsPerTick: 0.843,
    measuredUnder: 'a 20-minute capture at 6-8 players; this cost scales with natural-spawn candidates',
    when: '2026-08-31',
    confirmBy: 'Enumerate the registered listeners. A fast path is only safe if none of them can change the outcome.',
    suggests: 'likely',
  },
  {
    id: 'archon-mana-sync',
    match: /archon.*(setMana|sync)/i,
    mod: 'archon',
    modVersion: '1.1.5',
    title: 'Archon syncs mana even when it did not change',
    outcome: 'open',
    finding: 'ManaComponent.setMana sends a sync packet on every call: 0.18-0.25 ms/tick.',
    resolution: 'Skip the setter and its packet when the clamped value did not change.',
    lastMsPerTick: 0.25,
    measuredUnder: 'across captures at 6-9 players',
    when: '2026-08-29 to 2026-08-31',
    confirmBy: 'Check whether the setter compares against the current value before syncing.',
    suggests: 'likely',
  },
  {
    id: 'soulsweapons-posture-sync',
    match: /soulsweaponry.*(setPosture|sync)/i,
    mod: 'soulsweapons',
    modVersion: '1.3.1-1.20.1-fabric',
    title: 'Soulslike Weaponry syncs posture even when it did not change',
    outcome: 'open',
    finding: 'Posture data is synced on every update: about 0.15 ms/tick, with a 0.97 sampled burst.',
    resolution: 'Skip the setter and its packet when the value did not change.',
    lastMsPerTick: 0.15,
    measuredUnder: 'across captures at 6-9 players',
    when: '2026-08-29 to 2026-08-31',
    confirmBy: 'Check whether the setter compares against the current value before syncing.',
    suggests: 'likely',
  },
  {
    id: 'exception-in-tick-path',
    match: /fillInStackTrace|Throwable\.<init>|playerabilitylib/i,
    mod: 'things',
    modVersion: '0.3.3+1.20',
    title: 'Exception construction in a tick path',
    outcome: 'open',
    finding:
      'things-0.3.3 trips a playerabilitylib tamper check that logs a stack trace repeatedly. Visible in ' +
      'latest.log as a repeating warning loop.',
    resolution:
      'Not yet addressed. Building a stack trace is expensive and this one is built for a warning nobody acts on.',
    when: '2026-09-21',
    confirmBy: 'Check latest.log for the repeating warning, and whether the mod offers a switch to disable the check.',
    suggests: 'likely',
  },
  {
    id: 'simply-swords-unloaded-chunk',
    match: /simplyswords|stepping.*block/i,
    mod: 'simplyswords',
    modVersion: '1.56.0-1.20.1',
    title: 'Stepping-block query against a possibly-unloaded chunk',
    outcome: 'open',
    finding: 'Negligible steady average, but about 1.69 seconds of blocked tick time in one capture.',
    resolution: 'Stability item. Do not query stepping-block state unless the chunk is already loaded.',
    when: '2026-08-29',
    confirmBy: 'Look at the blocked category rather than the average; this only appears as a stall.',
    suggests: 'likely',
  },
];

export interface KnowledgeMatch {
  entry: KnowledgeEntry;
  /**
   * How the current cost compares to when it was last measured here.
   *
   * Always read alongside `caveat`. These are different measurements taken
   * under different conditions, not two points on one series.
   */
  comparison: 'lower' | 'similar' | 'higher' | 'unknown';
  /**
   * Why the comparison may not mean what it appears to, or undefined when
   * there is no comparison to qualify.
   */
  caveat?: string;
  /** Installed is a newer version, on which a re-check measured the issue still there. */
  confirmed?: Recheck;
}

/** A measured re-check found the issue on this exact version: the entry applies there too. */
export function confirmedOn(entry: KnowledgeEntry, version: string | undefined, rechecks: readonly Recheck[]): Recheck | undefined {
  if (version === undefined) return undefined;
  return rechecks.find((r) => r.entryId === entry.id && r.to === version && (r.state === 'still-there' || r.state === 'worse'));
}

/**
 * Look up prior work for one frame.
 *
 * An entry applies only while the exact mod version it was measured on is
 * installed (`installed`: mod id -> version), or a version a re-check after an
 * update measured it still present on (`rechecks`, see recheck.ts). The mod filter is applied only
 * when the frame is attributed. An unattributed frame still matches on the
 * label, because attribution is frequently missing and refusing to match on
 * that basis would make the knowledge base useless exactly when it is most
 * needed.
 */
export function lookupKnowledge(
  label: string,
  sourceMod: string | null,
  msPerTick: number,
  installed: ReadonlyMap<string, string>,
  rechecks: readonly Recheck[] = [],
): KnowledgeMatch[] {
  const out: KnowledgeMatch[] = [];
  for (const entry of KNOWLEDGE) {
    const version = installed.get(entry.mod);
    const confirmed = version === entry.modVersion ? undefined : confirmedOn(entry, version, rechecks);
    if (version !== entry.modVersion && confirmed === undefined) continue;
    if (!entry.match.test(label)) continue;
    if (sourceMod !== null && sourceMod !== '' && !sourceMod.includes(entry.mod)) {
      continue;
    }

    let comparison: KnowledgeMatch['comparison'] = 'unknown';
    let caveat: string | undefined;
    if (entry.lastMsPerTick !== undefined && entry.lastMsPerTick > 0) {
      const ratio = msPerTick / entry.lastMsPerTick;
      comparison = ratio < 0.5 ? 'lower' : ratio > 1.5 ? 'higher' : 'similar';
      caveat =
        `The earlier figure was measured ${entry.measuredUnder ?? 'under conditions that were not recorded'}. ` +
        'It is a different capture, not an earlier point on this series, so treat the direction as a prompt ' +
        'to look rather than as a measured change. The A/B validator is what measures a change.';
    }
    const match: KnowledgeMatch = { entry, comparison };
    if (caveat !== undefined) match.caveat = caveat;
    if (confirmed !== undefined) match.confirmed = confirmed;
    out.push(match);
  }
  return out;
}

/** Mod id -> version in the season's latest capture: what is installed now, for `lookupKnowledge`. */
export function installedMods(db: DatabaseSync, seasonId: number): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT m.mod_id AS id, cm.version AS version
         FROM capture_mod cm JOIN mod m ON m.id = cm.mod
        WHERE cm.capture_id = (SELECT max(id) FROM capture WHERE season_id = ?)`,
    )
    .all(seasonId) as Array<{ id: string; version: string }>;
  return new Map(rows.map((r) => [r.id, r.version]));
}

export interface RegisterMatch {
  id: number;
  title: string;
  status: string;
  verdict: string | null;
  deltaMsPerTick: number | null;
  /** Tracks this exact call path, not just the same method elsewhere. */
  exact?: boolean;
}

/**
 * Find register entries already tracking this frame.
 *
 * Matched on the stored target label, which is what the "Track in register"
 * action writes. Deliberately exact rather than fuzzy: a wrong link here
 * would attach one investigation's conclusions to a different problem.
 */
export function matchRegister(db: DatabaseSync, label: string, pathText?: string): RegisterMatch[] {
  const rows = db
    .prepare(
      `SELECT id, title, status, verdict, delta_ms_per_tick AS deltaMsPerTick,
              (target_path_text IS NOT NULL AND target_path_text = ?) AS exact
         FROM optimization
        WHERE target_label = ? OR (target_path_text IS NOT NULL AND target_path_text = ?)
        ORDER BY exact DESC, updated_at DESC
        LIMIT 5`,
    )
    .all(pathText ?? '', label, pathText ?? '') as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...(r as unknown as RegisterMatch), exact: r['exact'] === 1 }));
}

/** One-line human summary of an outcome, for the interface. */
export function outcomeText(outcome: KnowledgeOutcome): string {
  switch (outcome) {
    case 'fixed-here':
      return 'fixed here before';
    case 'no-benefit-here':
      return 'patched here, no benefit';
    case 'fixed-upstream':
      return 'fixed upstream';
    case 'config-switch':
      return 'avoidable by configuration';
    case 'necessary':
      return 'investigated — necessary work';
    case 'open':
      return 'investigated, still open';
  }
}
