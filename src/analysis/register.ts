/**
 * The optimization register.
 *
 * Its main job is to hold a line that is very easy to let slip: the
 * difference between *implemented* and *proven to have helped*. Once those
 * blur, a backlog stops being a record of evidence and becomes a list of
 * things that felt productive.
 *
 * Two rules enforce it:
 *
 *   1. The measured statuses can only be reached through `recordValidation`,
 *      which takes the output of the A/B engine. There is no code path that
 *      lets a human simply declare success.
 *   2. Synthetic benchmark results are stored in their own field and are
 *      explicitly barred from setting a verdict, because a microbenchmark
 *      showing a function got faster says nothing about the tick budget.
 *
 * Resolved entries are archived, never deleted, so a problem that returns
 * finds its own history waiting.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { ValidationResult } from './validate.ts';
import type { Feasibility } from './detectors.ts';
import type { Risk } from './priority.ts';

export type OptimizationStatus =
  | 'proposed'
  | 'investigating'
  | 'implemented'
  | 'measured-improvement'
  | 'no-measurable-change'
  | 'regressed'
  | 'reverted';

/** Statuses only the validation engine may assign. */
const MEASURED_STATUSES: ReadonlySet<OptimizationStatus> = new Set([
  'measured-improvement',
  'no-measurable-change',
  'regressed',
]);

/**
 * Permitted transitions.
 *
 * Deliberately allows going backwards (a validated change can be reverted,
 * a measured non-result can return to investigating) because real work does
 * that. What it does not allow is jumping straight to a measured status.
 */
const TRANSITIONS: Record<OptimizationStatus, readonly OptimizationStatus[]> = {
  proposed: ['investigating', 'implemented', 'reverted'],
  investigating: ['proposed', 'implemented', 'reverted'],
  implemented: ['measured-improvement', 'no-measurable-change', 'regressed', 'reverted', 'investigating'],
  'measured-improvement': ['reverted', 'investigating', 'regressed'],
  'no-measurable-change': ['investigating', 'reverted', 'implemented'],
  regressed: ['reverted', 'investigating'],
  reverted: ['proposed', 'investigating'],
};

export interface OptimizationInput {
  serverId: string;
  title: string;
  targetPathText?: string;
  targetLabel?: string;
  hypothesis?: string;
  approach?: string;
  feasibility?: Feasibility;
  risk?: Risk;
  notes?: string;
  /** The detected mod-set change this tracks, if it came from one. */
  revisionId?: number;
  /** When it went live, if already known. */
  deployedAt?: number;
}

export interface Optimization {
  id: number;
  title: string;
  target_label: string | null;
  target_path_text: string | null;
  status: OptimizationStatus;
  feasibility: string;
  risk: string;
  hypothesis: string | null;
  approach: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  deployed_at: number | null;
  validated_at: number | null;
  verdict: string | null;
  delta_ms_per_tick: number | null;
  ci_low: number | null;
  ci_high: number | null;
  before_median: number | null;
  after_median: number | null;
  before_windows: number | null;
  after_windows: number | null;
  validation_note: string | null;
  synthetic_note: string | null;
  revision_id: number | null;
}

export class Register {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #event(optimizationId: number, kind: string, detail: string, actor = 'ui'): void {
    this.#db
      .prepare('INSERT INTO optimization_event (optimization_id, at, kind, detail, actor) VALUES (?,?,?,?,?)')
      .run(optimizationId, Date.now(), kind, detail, actor);
  }

  create(input: OptimizationInput): number {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO optimization
           (server_id, title, target_path_text, target_label, status, feasibility, risk,
            hypothesis, approach, notes, created_at, updated_at, revision_id)
         VALUES (?,?,?,?,'proposed',?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.serverId,
        input.title,
        input.targetPathText ?? null,
        input.targetLabel ?? null,
        input.feasibility ?? 'unknown',
        input.risk ?? 'unknown',
        input.hypothesis ?? null,
        input.approach ?? null,
        input.notes ?? null,
        now,
        now,
        input.revisionId ?? null,
      );
    const id = Number(this.#db.prepare('SELECT last_insert_rowid() AS id').get()!['id']);
    this.#event(id, 'created', input.title);
    // A change detected from the mod list already went live; record when.
    if (input.deployedAt !== undefined) this.markDeployed(id, input.deployedAt, 'detected');
    return id;
  }

  get(id: number): Optimization | undefined {
    return this.#db.prepare('SELECT * FROM optimization WHERE id = ?').get(id) as unknown as
      | Optimization
      | undefined;
  }

  list(status?: OptimizationStatus): Optimization[] {
    return (
      status === undefined
        ? this.#db.prepare('SELECT * FROM optimization ORDER BY updated_at DESC').all()
        : this.#db.prepare('SELECT * FROM optimization WHERE status = ? ORDER BY updated_at DESC').all(status)
    ) as unknown as Optimization[];
  }

  /**
   * Move an entry along the ladder.
   *
   * Refuses to set a measured status: those are conclusions drawn from data,
   * not states a person can assert.
   */
  setStatus(id: number, next: OptimizationStatus, actor = 'ui'): { ok: boolean; error?: string } {
    const current = this.get(id);
    if (current === undefined) return { ok: false, error: 'no such optimization' };

    if (MEASURED_STATUSES.has(next)) {
      return {
        ok: false,
        error:
          `"${next}" is a measured result and cannot be set by hand. ` +
          'Record a deploy time and run validation; the engine assigns it from the data.',
      };
    }

    const allowed = TRANSITIONS[current.status];
    if (!allowed.includes(next)) {
      return { ok: false, error: `cannot go from ${current.status} to ${next}` };
    }

    this.#db.prepare('UPDATE optimization SET status = ?, updated_at = ? WHERE id = ?').run(next, Date.now(), id);
    this.#event(id, 'status', `${current.status} -> ${next}`, actor);
    return { ok: true };
  }

  /** Say which call path a change was meant to affect. */
  setTarget(id: number, targetPathText: string, targetLabel: string, actor = 'ui'): void {
    this.#db
      .prepare('UPDATE optimization SET target_path_text = ?, target_label = ?, updated_at = ? WHERE id = ?')
      .run(targetPathText, targetLabel, Date.now(), id);
    this.#event(id, 'target', targetLabel, actor);
  }

  /** Record when a change actually went live. Validation needs this. */
  markDeployed(id: number, deployedAt: number, actor = 'ui'): void {
    this.#db
      .prepare('UPDATE optimization SET deployed_at = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(deployedAt, 'implemented', Date.now(), id);
    this.#event(id, 'deployed', new Date(deployedAt).toISOString(), actor);
  }

  /**
   * Attach a synthetic benchmark result.
   *
   * Stored, shown, and explicitly incapable of changing the status. This is
   * the whole reason it has its own column.
   */
  attachSynthetic(id: number, note: string, actor = 'ui'): void {
    this.#db.prepare('UPDATE optimization SET synthetic_note = ?, updated_at = ? WHERE id = ?').run(note, Date.now(), id);
    this.#event(id, 'synthetic-benchmark', note, actor);
  }

  /** The only way a measured status is ever assigned. */
  recordValidation(id: number, result: ValidationResult, actor = 'validator'): OptimizationStatus | undefined {
    const status: OptimizationStatus | undefined =
      result.verdict === 'improved'
        ? 'measured-improvement'
        : result.verdict === 'regressed'
          ? 'regressed'
          : result.verdict === 'no-measurable-change'
            ? 'no-measurable-change'
            : undefined; // inconclusive leaves the status alone

    this.#db
      .prepare(
        `UPDATE optimization SET
           validated_at = ?, verdict = ?, delta_ms_per_tick = ?, ci_low = ?, ci_high = ?,
           before_median = ?, after_median = ?, before_windows = ?, after_windows = ?,
           validation_note = ?, updated_at = ?
           ${status === undefined ? '' : ', status = ?'}
         WHERE id = ?`,
      )
      .run(
        ...[
          Date.now(),
          result.verdict,
          result.deltaMsPerTick ?? null,
          result.ciLow ?? null,
          result.ciHigh ?? null,
          result.beforeMedian ?? null,
          result.afterMedian ?? null,
          result.beforeWindows,
          result.afterWindows,
          result.explanation,
          Date.now(),
          ...(status === undefined ? [] : [status]),
          id,
        ],
      );

    this.#event(id, 'validated', `${result.verdict}: ${result.explanation}`, actor);
    return status;
  }

  events(id: number): Array<{ at: number; kind: string; detail: string | null; actor: string | null }> {
    return this.#db
      .prepare('SELECT at, kind, detail, actor FROM optimization_event WHERE optimization_id = ? ORDER BY at DESC')
      .all(id) as unknown as Array<{ at: number; kind: string; detail: string | null; actor: string | null }>;
  }
}
