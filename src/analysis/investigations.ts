/**
 * Investigations: what the person has decided about a problem.
 *
 *   active     being considered; its findings show as usual
 *   hold       consciously set aside for now ("not worth it yet"); its
 *              findings leave the active list but keep all their history
 *   resolved   fixed or otherwise dealt with; also leaves the active list
 *
 * An investigation covers methods (by frame label) or a whole mod, so
 * several findings that are pieces of one problem are held together.
 *
 * Held or resolved does not mean forgotten: when its members' own cost rises
 * well past what it was when it was set aside (half again, and at least
 * 0.1 MSPT more), it "came back" and is shown on the active list again with
 * the reason, until someone looks at it.
 */

import type { DatabaseSync } from 'node:sqlite';

export type InvestigationState = 'active' | 'hold' | 'resolved';
export const STATES: readonly InvestigationState[] = ['active', 'hold', 'resolved'];

export const STATE_WORDS: Record<InvestigationState, string> = {
  active: 'Active',
  hold: 'On hold',
  resolved: 'Resolved',
};

export interface Investigation {
  id: number;
  serverId: string;
  name: string;
  state: InvestigationState;
  note: string;
  createdAt: number;
  updatedAt: number;
  baselineMspt: number | null;
  members: string[];
  history: Array<{ at: number; state: InvestigationState; note: string; mspt: number | null }>;
}

/** What a member needs to know about a finding to match it. */
export interface Matchable {
  label: string;
  owner: string;
  msPerTick: number;
}

export function listInvestigations(db: DatabaseSync, serverId: string): Investigation[] {
  const rows = db
    .prepare('SELECT * FROM investigation WHERE server_id = ? ORDER BY updated_at DESC')
    .all(serverId) as Array<{
    id: number;
    server_id: string;
    name: string;
    state: string;
    note: string;
    created_at: number;
    updated_at: number;
    baseline_mspt: number | null;
  }>;
  const members = db.prepare('SELECT member FROM investigation_member WHERE investigation_id = ? ORDER BY member');
  const events = db.prepare('SELECT at, state, note, mspt FROM investigation_event WHERE investigation_id = ? ORDER BY at');
  return rows.map((r) => ({
    id: r.id,
    serverId: r.server_id,
    name: r.name,
    state: (STATES.includes(r.state as InvestigationState) ? r.state : 'active') as InvestigationState,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    baselineMspt: r.baseline_mspt,
    members: (members.all(r.id) as Array<{ member: string }>).map((m) => m.member),
    history: events.all(r.id) as Investigation['history'],
  }));
}

export function matches(inv: Pick<Investigation, 'members'>, f: Pick<Matchable, 'label' | 'owner'>): boolean {
  return inv.members.includes(f.label) || inv.members.includes(`mod:${f.owner}`);
}

/** Own MSPT of everything an investigation covers, from a list of findings. */
export function costOf(inv: Pick<Investigation, 'members'>, list: readonly Matchable[]): number {
  return list.filter((f) => matches(inv, f)).reduce((s, f) => s + f.msPerTick, 0);
}

export function cameBack(inv: Investigation, now: number): { back: boolean; now: number } {
  const base = inv.baselineMspt ?? 0;
  return { back: inv.state !== 'active' && now >= Math.max(base * 1.5, base + 0.1), now };
}

export function createInvestigation(
  db: DatabaseSync,
  input: { serverId: string; name: string; state: InvestigationState; note?: string; members: string[]; mspt: number | null; seasonId?: number },
  now = Date.now(),
): { id?: number; error?: string } {
  const name = input.name.trim();
  if (name === '') return { error: 'Give it a name.' };
  if (input.members.length === 0) return { error: 'Choose at least one finding or mod.' };
  if (!STATES.includes(input.state)) return { error: 'Unknown state.' };
  const id = Number(
    db
      .prepare(
        `INSERT INTO investigation (server_id, name, state, note, created_at, updated_at, baseline_mspt, baseline_season)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(input.serverId, name, input.state, input.note ?? '', now, now, input.mspt, input.seasonId ?? null).lastInsertRowid,
  );
  const add = db.prepare('INSERT OR IGNORE INTO investigation_member (investigation_id, member) VALUES (?,?)');
  for (const m of input.members) add.run(id, m);
  db.prepare('INSERT INTO investigation_event (investigation_id, at, state, note, mspt) VALUES (?,?,?,?,?)').run(id, now, input.state, input.note ?? '', input.mspt);
  return { id };
}

/**
 * Change state or note. Setting it aside again records today's cost as the
 * new baseline, so "came back" compares against the latest decision.
 */
export function updateInvestigation(
  db: DatabaseSync,
  id: number,
  patch: { state?: InvestigationState; note?: string; name?: string; mspt?: number | null; addMembers?: string[] },
  now = Date.now(),
): { error?: string } {
  const current = db.prepare('SELECT state, note FROM investigation WHERE id = ?').get(id) as { state: string; note: string } | undefined;
  if (current === undefined) return { error: 'No such investigation.' };
  if (patch.state !== undefined && !STATES.includes(patch.state)) return { error: 'Unknown state.' };
  if (patch.name !== undefined && patch.name.trim() === '') return { error: 'Give it a name.' };
  const state = patch.state ?? (current.state as InvestigationState);
  db.prepare(
    `UPDATE investigation SET state = ?, note = ?, name = COALESCE(?, name), updated_at = ?,
       baseline_mspt = CASE WHEN ? IS NOT NULL AND ? != 'active' THEN ? ELSE baseline_mspt END
     WHERE id = ?`,
  ).run(state, patch.note ?? current.note, patch.name?.trim() ?? null, now, patch.mspt ?? null, state, patch.mspt ?? null, id);
  const add = db.prepare('INSERT OR IGNORE INTO investigation_member (investigation_id, member) VALUES (?,?)');
  for (const m of patch.addMembers ?? []) add.run(id, m);
  if (patch.state !== undefined || patch.note !== undefined) {
    db.prepare('INSERT INTO investigation_event (investigation_id, at, state, note, mspt) VALUES (?,?,?,?,?)').run(id, now, state, patch.note ?? '', patch.mspt ?? null);
  }
  return {};
}
