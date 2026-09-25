/**
 * Where the tick goes: every piece of recorded own time, summed by part of
 * the game and by mod, in MSPT over the same span.
 *
 * Own time is additive -- each sample is counted in exactly one frame -- so
 * these totals add up to the sampled tick, and nothing is counted twice.
 * Paths below the ledger's evidence floor are not kept one by one; their
 * time is reported as a separate "small scattered costs" line rather than
 * silently dropped.
 *
 * The denominator is the span's ticks (the tick anchor is in every capture,
 * so its tick count is the span's), not each path's own: a cost that only
 * appeared in some captures must not look as if it ran every tick.
 */

import type { DatabaseSync } from 'node:sqlite';

import { SYSTEMS, systemStep, type SystemKey } from './systems.ts';
import { ownerStep } from './owner.ts';

export interface Slice {
  key: string;
  name: string;
  about?: string;
  mspt: number;
}

export interface Breakdown {
  ticks: number;
  /** Sampled work plus waiting, MSPT: what the slices add up to. */
  totalMspt: number;
  systems: Slice[];
  mods: Slice[];
  /** Own time on paths too small to keep individually, MSPT. */
  tailMspt: number;
}

interface PathState {
  parent: number;
  frame: string;
  inTick: boolean;
  system: SystemKey | undefined;
  owner: string;
}

/**
 * Walks paths up to the root once each, remembering every ancestor, so a
 * whole season classifies in one pass over the shared prefixes.
 */
export class PathClassifier {
  readonly #state = new Map<number, PathState>();
  readonly #frames = new Map<number, string>();
  readonly #row: ReturnType<DatabaseSync['prepare']>;

  constructor(db: DatabaseSync) {
    for (const f of db.prepare('SELECT id, label FROM frame').iterate() as Iterable<{ id: number; label: string }>) {
      this.#frames.set(f.id, f.label);
    }
    this.#row = db.prepare('SELECT parent_id, frame_id, source_mod FROM path WHERE id = ?');
  }

  state(pathId: number): PathState | undefined {
    const known = this.#state.get(pathId);
    if (known !== undefined) return known;
    // Collect the unresolved chain, then resolve root-first (no recursion).
    const chain: Array<{ id: number; frame: string; source: string | null; parent: number }> = [];
    let id = pathId;
    let above: PathState | undefined;
    while (id !== 0) {
      const cached = this.#state.get(id);
      if (cached !== undefined) {
        above = cached;
        break;
      }
      const r = this.#row.get(id) as { parent_id: number; frame_id: number; source_mod: string | null } | undefined;
      if (r === undefined) return undefined;
      chain.push({ id, frame: this.#frames.get(r.frame_id) ?? '', source: r.source_mod, parent: r.parent_id });
      id = r.parent_id;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const c = chain[i]!;
      const step = systemStep(c.frame, above === undefined ? { inTick: false, system: undefined } : { inTick: above.inTick, system: above.system });
      const state: PathState = { parent: c.parent, frame: c.frame, inTick: step.inTick, system: step.system, owner: ownerStep(c.frame, c.source, above?.owner) };
      this.#state.set(c.id, state);
      above = state;
    }
    return above;
  }

  /** The part of the game for a path's own time in a category. */
  systemOf(pathId: number, category: string): SystemKey | undefined {
    if (category === 'idle') return undefined;
    if (category === 'blocked' || category === 'waiting') return 'waiting';
    const s = this.state(pathId);
    if (s === undefined) return undefined;
    if (s.system !== undefined) return s.system;
    return s.inTick ? 'other' : s.frame === 'native.GC_active' ? 'gc' : undefined;
  }

  ownerOf(pathId: number): string | undefined {
    return this.state(pathId)?.owner;
  }

  /** The path's frames, root first. */
  frames(pathId: number): string[] {
    const out: string[] = [];
    let id = pathId;
    while (id !== 0) {
      const s = this.state(id);
      if (s === undefined) break;
      out.push(s.frame);
      id = s.parent;
    }
    return out.reverse();
  }
}

export function breakdown(
  db: DatabaseSync,
  seasonId: number,
  source: { sql: string; params: Array<string | number> },
  options: { tail?: { fromDay?: string; toDay?: string } | false; classifier?: PathClassifier } = {},
): Breakdown {
  const rows = db
    .prepare(`SELECT r.path_id, r.category, r.self_ms, r.ticks FROM ${source.sql} r WHERE r.season_id = ? AND r.self_ms > 0 AND r.category != 'idle'`)
    .all(...source.params, seasonId) as Array<{ path_id: number; category: string; self_ms: number; ticks: number }>;
  const ticks = rows.reduce((m, r) => Math.max(m, r.ticks), 0);
  const classifier = options.classifier ?? new PathClassifier(db);

  const systems = new Map<SystemKey, number>();
  const mods = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const system = classifier.systemOf(r.path_id, r.category);
    if (system === undefined) continue;
    total += r.self_ms;
    systems.set(system, (systems.get(system) ?? 0) + r.self_ms);
    if (system !== 'waiting') {
      const owner = classifier.ownerOf(r.path_id) ?? 'unknown';
      mods.set(owner, (mods.get(owner) ?? 0) + r.self_ms);
    }
  }

  let tailMs = 0;
  if (options.tail !== false) {
    const t = options.tail ?? {};
    const row = db
      .prepare(
        `SELECT COALESCE(sum(self_ms), 0) AS s FROM path_daily_tail WHERE season_id = ?
           AND (? IS NULL OR day >= ?) AND (? IS NULL OR day <= ?)`,
      )
      .get(seasonId, t.fromDay ?? null, t.fromDay ?? null, t.toDay ?? null, t.toDay ?? null) as { s: number };
    tailMs = row.s;
  }

  const per = (ms: number): number => (ticks === 0 ? 0 : ms / ticks);
  return {
    ticks,
    totalMspt: per(total + tailMs),
    systems: [...systems.entries()]
      .map(([key, ms]) => ({ key, name: SYSTEMS[key].name, about: SYSTEMS[key].about, mspt: per(ms) }))
      .sort((a, b) => b.mspt - a.mspt),
    mods: [...mods.entries()].map(([key, ms]) => ({ key, name: key, mspt: per(ms) })).sort((a, b) => b.mspt - a.mspt),
    tailMspt: per(tailMs),
  };
}
