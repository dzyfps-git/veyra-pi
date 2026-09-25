/**
 * What costs inside one thing: the methods a villager's tick spends its time
 * in, what /execute does, what a mod's hook on every entity runs.
 *
 * The split (split.ts) says how much a thing costs; this says where inside
 * it, from the ledger. The ledger keeps call paths as a tree, so the thing's
 * call paths are found by walking down from where it starts -- the frames
 * that name it, checked against the full classification of their own path --
 * and stopping wherever the time below is handed to a different thing.
 *
 * The ledger keeps paths one by one only above its evidence floor, so the
 * methods listed add up to less than the thing's total; the difference is
 * reported as time in paths too small to list, never spread over the rest.
 */

import type { ActivityFilter } from './activity.ts';
import { hasActivityRollups, rollupActivitySql, storedActivitySql } from '../store/rollups.ts';
import type { DatabaseSync } from 'node:sqlite';

import type { SystemKey } from './systems.ts';
import { leavesThing, pathStep, startsThing, subjectKey, type PathState } from './subjects.ts';
import { isLibraryFrame, ownerStep } from './owner.ts';

export type InsideSource =
  | { kind: 'season'; activity?: ActivityFilter }
  | { kind: 'days'; fromDay: string; toDay: string; activity?: ActivityFilter }
  /** A table with path_rollup's columns (the exact-time range table). */
  | { kind: 'table'; table: string };

export interface InsideMethod {
  /** The frame to name the method by (library code is named after its caller). */
  method: string;
  owner: string;
  /** Own time per tick. */
  mspt: number;
}

export interface Inside {
  methods: InsideMethod[];
  /** What the listed methods add up to, MSPT. */
  listedMspt: number;
}

function ensureTables(db: DatabaseSync): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS inside_roots (id INTEGER PRIMARY KEY);
           CREATE TEMP TABLE IF NOT EXISTS inside_stop (id INTEGER PRIMARY KEY);
           CREATE TEMP TABLE IF NOT EXISTS inside_ids (id INTEGER PRIMARY KEY, parent INTEGER, frame INTEGER);
           DELETE FROM temp.inside_roots; DELETE FROM temp.inside_stop; DELETE FROM temp.inside_ids;`);
}

const cache = new Map<string, Inside | undefined>();

/**
 * The methods inside one thing over a span, biggest first. `ticks` is the
 * span's tick count (the split's), so the figures share its denominator.
 * Undefined when the thing has no single place where it starts (time that is
 * not one thing's, waits, "other game work").
 */
export function methodsInside(
  db: DatabaseSync,
  seasonId: number,
  source: InsideSource,
  system: SystemKey,
  key: string,
  ticks: number,
  cacheKey?: string,
): Inside | undefined {
  if (key === '' || ticks <= 0 || system === 'waiting' || system === 'other' || system === 'gc') return undefined;
  const memo = cacheKey === undefined ? undefined : `${cacheKey}|${system}|${key}`;
  if (memo !== undefined && cache.has(memo)) return cache.get(memo);

  // 1. Frames that could start the thing.
  const prefix = key.startsWith('~') ? key.slice(1) : key;
  const candidates = (db.prepare('SELECT id, label FROM frame WHERE label >= ? AND label < ?').all(prefix, `${prefix}\u{ffff}`) as Array<{ id: number; label: string }>)
    .filter((f) => startsThing(system, key, f.label));
  if (candidates.length === 0) return remember(memo, undefined);

  // 2. Paths through them where the thing really starts, by the full
  //    classification of each path (a villager ticked as a passenger is its
  //    vehicle's time, not the villager's).
  const labelOf = new Map<number, string>();
  const frameLabel = db.prepare('SELECT label FROM frame WHERE id = ?');
  const pathRow = db.prepare('SELECT parent_id, frame_id FROM path WHERE id = ?');
  const states = new Map<number, PathState | undefined>();
  const stateOf = (pathId: number): PathState | undefined => {
    const chain: Array<{ id: number; frame: number }> = [];
    let id = pathId;
    let above: PathState | undefined;
    while (id !== 0) {
      if (states.has(id)) {
        above = states.get(id);
        break;
      }
      const r = pathRow.get(id) as { parent_id: number; frame_id: number } | undefined;
      if (r === undefined) return undefined;
      chain.push({ id, frame: r.frame_id });
      id = r.parent_id;
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const c = chain[i]!;
      let label = labelOf.get(c.frame);
      if (label === undefined) {
        label = (frameLabel.get(c.frame) as { label: string } | undefined)?.label ?? '';
        labelOf.set(c.frame, label);
      }
      above = pathStep(label, above);
      states.set(c.id, above);
    }
    return above;
  };

  ensureTables(db);
  const addRoot = db.prepare('INSERT OR IGNORE INTO temp.inside_roots (id) VALUES (?)');
  let roots = 0;
  for (const f of candidates) {
    for (const p of db.prepare('SELECT id FROM path WHERE frame_id = ?').iterate(f.id) as Iterable<{ id: number }>) {
      const s = stateOf(p.id);
      if (s?.system === system && subjectKey(s) === key) {
        addRoot.run(p.id);
        roots += 1;
      }
    }
  }
  if (roots === 0) return remember(memo, undefined);

  // 3. Where the time below is handed to another thing, the walk stops.
  const addStop = db.prepare('INSERT OR IGNORE INTO temp.inside_stop (id) VALUES (?)');
  for (const f of db.prepare('SELECT id, label FROM frame').iterate() as Iterable<{ id: number; label: string }>) {
    if (leavesThing(system, key, f.label)) addStop.run(f.id);
  }
  db.prepare(
    `INSERT OR IGNORE INTO temp.inside_ids (id, parent, frame)
     WITH RECURSIVE d(id, parent, frame) AS (
       SELECT p.id, p.parent_id, p.frame_id FROM path p WHERE p.id IN (SELECT id FROM temp.inside_roots)
       UNION ALL
       SELECT p.id, p.parent_id, p.frame_id FROM path p JOIN d ON p.parent_id = d.id
        WHERE p.frame_id NOT IN (SELECT id FROM temp.inside_stop)
     )
     SELECT id, parent, frame FROM d`,
  ).run();
  const tree = db
    .prepare(
      `SELECT i.id, i.parent, f.label, p.source_mod AS source
         FROM temp.inside_ids i JOIN path p ON p.id = i.id JOIN frame f ON f.id = i.frame`,
    )
    .all() as Array<{ id: number; parent: number; label: string; source: string | null }>;
  const node = new Map(tree.map((t) => [t.id, t]));

  // 4. Their time over the span.
  const rows = (
    source.kind === 'season'
      ? db.prepare(
          `SELECT path_id, category, self_ms FROM path_rollup
            WHERE season_id = ? AND path_id IN (SELECT id FROM temp.inside_ids)${rollupActivitySql(db, source.activity ?? 'all')}`,
        ).all(seasonId)
      : source.kind === 'days'
        ? db.prepare(
            `SELECT path_id, category, sum(self_ms) AS self_ms FROM path_daily
              WHERE season_id = ? AND day >= ? AND day <= ? AND path_id IN (SELECT id FROM temp.inside_ids)${
                hasActivityRollups(db) ? storedActivitySql(source.activity ?? 'all') : ''
              }
              GROUP BY path_id, category`,
          ).all(seasonId, source.fromDay, source.toDay)
        : db.prepare(
            `SELECT path_id, category, self_ms FROM ${source.table} WHERE season_id = ? AND path_id IN (SELECT id FROM temp.inside_ids)`,
          ).all(seasonId)
  ) as Array<{ path_id: number; category: string; self_ms: number }>;

  // 5. By method: library code is named after its caller, as everywhere else.
  const method = new Map<number, string>();
  const owner = new Map<number, string>();
  const methodOf = (id: number): string => {
    const hit = method.get(id);
    if (hit !== undefined) return hit;
    const t = node.get(id)!;
    const up = node.has(t.parent) ? methodOf(t.parent) : undefined;
    const m = isLibraryFrame(t.label) && up !== undefined ? up : t.label;
    method.set(id, m);
    return m;
  };
  const ownerOf = (id: number): string => {
    const hit = owner.get(id);
    if (hit !== undefined) return hit;
    const t = node.get(id)!;
    const o = ownerStep(t.label, t.source, node.has(t.parent) ? ownerOf(t.parent) : undefined);
    owner.set(id, o);
    return o;
  };
  const by = new Map<string, InsideMethod>();
  let listed = 0;
  for (const r of rows) {
    if (r.category === 'idle' || r.category === 'blocked' || r.category === 'waiting' || r.self_ms <= 0 || !node.has(r.path_id)) continue;
    const m = methodOf(r.path_id);
    const o = ownerOf(r.path_id);
    const k = `${m}|${o}`;
    const hit = by.get(k) ?? { method: m, owner: o, mspt: 0 };
    hit.mspt += r.self_ms / ticks;
    by.set(k, hit);
    listed += r.self_ms / ticks;
  }
  return remember(memo, { methods: [...by.values()].sort((a, b) => b.mspt - a.mspt), listedMspt: listed });
}

function remember(memo: string | undefined, value: Inside | undefined): Inside | undefined {
  if (memo !== undefined) {
    cache.set(memo, value);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  return value;
}
