/**
 * Asking envx, remembering the answers, and reading them back.
 *
 * One refresh:
 *   1. which envx snapshot ran the current mod set (`match`, then `snapshots`
 *      for its fingerprint); kept per modset, and a 'none' is asked again
 *      after a while, since envx only sees a pack when it syncs;
 *   2. the keys of the top findings, and the Minecraft methods among them
 *      for mixins, minus what is already answered for that fingerprint;
 *   3. what is left, in batches, in ONE envx run (a JVM start each).
 *
 * Nothing is asked twice for one snapshot, so after the first run for a mod
 * set a refresh usually costs a few database reads and no process at all.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { EnvxClient } from './client.ts';
import {
  type EnvxDeclaredMixin,
  type EnvxMatch,
  type EnvxOwner,
  type EnvxRequest,
  type EnvxSnapshot,
  type EnvxVersion,
} from './contract.ts';
import { captureMods, keysOfPaths, lookupKeyOf, mixinTargetOf, modsetOf, type LookupKey } from './keys.ts';

/** Keys per request line; well under envx's 5000, so one bad line costs little. */
export const BATCH_SIZE = 500;
/** How long a 'none' match stands before envx is asked again. */
export const NONE_RETRY_MS = 6 * 3_600_000;

export interface MatchRow {
  modset: string;
  status: 'match' | 'none';
  fingerprint: string | null;
  envxVersion: string;
  checkedAt: number;
}

export function matchFor(db: DatabaseSync, modset: string): MatchRow | undefined {
  const row = db
    .prepare('SELECT modset, status, fingerprint, envx_version, checked_at FROM envx_match WHERE modset = ?')
    .get(modset) as { modset: string; status: string; fingerprint: string | null; envx_version: string; checked_at: number } | undefined;
  if (row === undefined) return undefined;
  return {
    modset: row.modset,
    status: row.status === 'match' ? 'match' : 'none',
    fingerprint: row.fingerprint,
    envxVersion: row.envx_version,
    checkedAt: row.checked_at,
  };
}

function saveMatch(
  db: DatabaseSync,
  row: { modset: string; status: string; fingerprint: string | null; snapshotIds: number[]; envxModset: string | null; envxVersion: string; detail?: unknown },
  now: number,
): void {
  db.prepare(
    `INSERT INTO envx_match (modset, status, fingerprint, snapshot_ids, envx_modset, envx_version, checked_at, detail)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(modset) DO UPDATE SET status = excluded.status, fingerprint = excluded.fingerprint,
       snapshot_ids = excluded.snapshot_ids, envx_modset = excluded.envx_modset, envx_version = excluded.envx_version,
       checked_at = excluded.checked_at, detail = excluded.detail`,
  ).run(
    row.modset,
    row.status,
    row.fingerprint,
    JSON.stringify(row.snapshotIds),
    row.envxModset,
    row.envxVersion,
    now,
    row.detail === undefined ? null : JSON.stringify(row.detail),
  );
}

export interface Answer<T> {
  result: T;
  envxVersion: string;
}

export function cachedAnswer<T>(db: DatabaseSync, op: 'owner' | 'mixins', cacheKey: string, fingerprint: string): Answer<T> | undefined {
  const row = db
    .prepare('SELECT result, envx_version FROM envx_answer WHERE op = ? AND lookup_key = ? AND fingerprint = ?')
    .get(op, cacheKey, fingerprint) as { result: string; envx_version: string } | undefined;
  return row === undefined ? undefined : { result: JSON.parse(row.result) as T, envxVersion: row.envx_version };
}

/** The latest capture of a season (default: the latest season): what the server runs now. */
export function currentCapture(db: DatabaseSync, seasonId?: number): number | undefined {
  const row = db
    .prepare('SELECT id FROM capture WHERE season_id = coalesce(?, (SELECT max(id) FROM season)) ORDER BY started_at DESC LIMIT 1')
    .get(seasonId ?? null) as { id: number } | undefined;
  return row?.id;
}

export interface Plan {
  owner: LookupKey[];
  mixins: Array<{ cacheKey: string; target: NonNullable<ReturnType<typeof mixinTargetOf>>['target'] }>;
}

/** What is not yet answered for this fingerprint, de-duplicated. */
export function planLookups(db: DatabaseSync, keys: readonly LookupKey[], fingerprint: string): Plan {
  const plan: Plan = { owner: [], mixins: [] };
  const seenOwner = new Set<string>();
  const seenMixins = new Set<string>();
  for (const key of keys) {
    if (!seenOwner.has(key.cacheKey) && cachedAnswer(db, 'owner', key.cacheKey, fingerprint) === undefined) {
      plan.owner.push(key);
    }
    seenOwner.add(key.cacheKey);
    const target = mixinTargetOf(key);
    if (target !== undefined && !seenMixins.has(target.cacheKey) && cachedAnswer(db, 'mixins', target.cacheKey, fingerprint) === undefined) {
      plan.mixins.push(target);
    }
    if (target !== undefined) seenMixins.add(target.cacheKey);
  }
  return plan;
}

/** One request line and the cache keys of what it asks, in order. */
export interface Batch {
  request: EnvxRequest;
  cacheKeys: string[];
}

/** The plan as request lines of at most BATCH_SIZE items each. */
export function toBatches(plan: Plan, fingerprint: string, env: string | undefined, batchSize = BATCH_SIZE): Batch[] {
  const envPart = env === undefined || env === '' ? {} : { env };
  const out: Batch[] = [];
  for (let i = 0; i < plan.owner.length; i += batchSize) {
    const part = plan.owner.slice(i, i + batchSize);
    out.push({ request: { id: `owner-${i}`, op: 'owner', ...envPart, fingerprint, keys: part.map((k) => k.request) }, cacheKeys: part.map((k) => k.cacheKey) });
  }
  for (let i = 0; i < plan.mixins.length; i += batchSize) {
    const part = plan.mixins.slice(i, i + batchSize);
    out.push({ request: { id: `mixins-${i}`, op: 'mixins', ...envPart, fingerprint, targets: part.map((m) => m.target) }, cacheKeys: part.map((m) => m.cacheKey) });
  }
  return out;
}

/**
 * The per-item answers inside an `owner` or `mixins` result. The draft
 * contract does not yet say how they are wrapped; this reads
 * `{"results": [...]}` (asked of envx, see docs/api.md) and nothing else.
 */
export function itemsOf(result: unknown): unknown[] | undefined {
  const items = (result as { results?: unknown } | null)?.results;
  return Array.isArray(items) ? items : undefined;
}

export interface RefreshSummary {
  at: number;
  state: 'off' | 'unavailable' | 'no-capture' | 'no-snapshot' | 'ready' | 'failed';
  envx?: EnvxVersion;
  modset?: string;
  fingerprint?: string;
  asked: number;
  answered: number;
  mismatches: string[];
  detail?: string;
}

function isOwner(value: unknown): value is EnvxOwner {
  const v = value as EnvxOwner;
  return (
    typeof v === 'object' && v !== null && ['probable', 'ambiguous', 'none'].includes(v.status) && Array.isArray(v.candidates)
  );
}

/**
 * One refresh against envx for the current mod set and these findings' paths.
 * `pathIds` are the findings worth attributing (the top of the list), so the
 * cost stays bounded however long the history is.
 */
export async function refreshEnvx(
  db: DatabaseSync,
  client: EnvxClient,
  pathIds: readonly number[],
  options: { env?: string; now?: number; seasonId?: number } = {},
): Promise<RefreshSummary> {
  const now = options.now ?? Date.now();
  const summary: RefreshSummary = { at: now, state: 'unavailable', asked: 0, answered: 0, mismatches: [] };
  const envPart = options.env === undefined || options.env === '' ? {} : { env: options.env };

  const capture = currentCapture(db, options.seasonId);
  if (capture === undefined) return { ...summary, state: 'no-capture' };
  const mods = captureMods(db, capture);
  const modset = modsetOf(mods);
  summary.modset = modset;

  let match = matchFor(db, modset);
  const stale = match === undefined || (match.status === 'none' && now - match.checkedAt > NONE_RETRY_MS);

  // Nothing new to ask: no process at all.
  const keys = [...keysOfPaths(db, pathIds).values()].flat();
  if (!stale && match?.status === 'match' && match.fingerprint !== null) {
    const plan = planLookups(db, keys, match.fingerprint);
    if (plan.owner.length === 0 && plan.mixins.length === 0) {
      return { ...summary, state: 'ready', fingerprint: match.fingerprint };
    }
  } else if (!stale) {
    return { ...summary, state: 'no-snapshot' };
  }

  const version = await client.version();
  if (version === undefined) return { ...summary, state: 'unavailable', detail: 'envx api did not answer --version' };
  summary.envx = version;

  if (stale) {
    const first = await client.batch([
      { id: 'match', op: 'match', ...envPart, mods },
      { id: 'snapshots', op: 'snapshots', ...envPart },
    ]);
    summary.mismatches.push(...first.mismatches);
    const [matchAnswer, snapshotsAnswer] = first.responses;
    if (matchAnswer === undefined || !matchAnswer.ok) {
      return { ...summary, state: 'failed', detail: matchAnswer?.error?.message ?? 'no answer to match' };
    }
    const result = matchAnswer.result as EnvxMatch;
    if (result.modset !== modset) {
      // Both sides are meant to compute the same hash; a difference is a
      // contract question for envx, not something to paper over here.
      summary.mismatches.push(`modset differs: ours ${modset.slice(0, 12)}…, envx ${String(result.modset).slice(0, 12)}…`);
    }
    if (result.status === 'match') {
      const snapshots = (snapshotsAnswer?.ok === true ? (snapshotsAnswer.result as { snapshots: EnvxSnapshot[] }).snapshots : []) ?? [];
      const byId = new Map(snapshots.map((s) => [s.id, s]));
      // Keep the fingerprint already in use while envx still lists it: the
      // cache stays valid. Otherwise the most recently confirmed one.
      const candidates = result.snapshots.map((id) => byId.get(id)).filter((s): s is EnvxSnapshot => s !== undefined);
      const kept = candidates.find((s) => s.fingerprint === match?.fingerprint);
      const chosen = kept ?? [...candidates].sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
      if (chosen === undefined) {
        summary.mismatches.push(`match named snapshot(s) ${result.snapshots.join(', ')} that snapshots did not list`);
        return { ...summary, state: 'failed', detail: 'matched snapshot not listed' };
      }
      saveMatch(db, { modset, status: 'match', fingerprint: chosen.fingerprint, snapshotIds: result.snapshots, envxModset: result.modset, envxVersion: version.envx }, now);
    } else {
      saveMatch(
        db,
        { modset, status: 'none', fingerprint: null, snapshotIds: [], envxModset: result.modset, envxVersion: version.envx, detail: result.closest ?? null },
        now,
      );
    }
    match = matchFor(db, modset);
  }

  if (match === undefined || match.status !== 'match' || match.fingerprint === null) return { ...summary, state: 'no-snapshot' };
  const fingerprint = match.fingerprint;
  summary.fingerprint = fingerprint;

  const plan = planLookups(db, keys, fingerprint);
  const batches = toBatches(plan, fingerprint, options.env);
  if (batches.length === 0) return { ...summary, state: 'ready' };
  const run = await client.batch(batches.map((b) => b.request));
  summary.mismatches.push(...run.mismatches);

  const store = db.prepare(
    `INSERT INTO envx_answer (op, lookup_key, fingerprint, modset, status, result, envx_version, answered_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(op, lookup_key, fingerprint) DO UPDATE SET status = excluded.status, result = excluded.result,
       envx_version = excluded.envx_version, answered_at = excluded.answered_at`,
  );
  db.exec('BEGIN');
  try {
    batches.forEach(({ request, cacheKeys }, index) => {
      summary.asked += cacheKeys.length;
      const response = run.responses[index];
      if (response === undefined) return;
      if (!response.ok) {
        summary.mismatches.push(`${request.id}: envx error ${response.error?.code ?? '?'}: ${response.error?.message ?? ''}`);
        return;
      }
      const items = itemsOf(response.result);
      if (items === undefined || items.length !== cacheKeys.length) {
        summary.mismatches.push(`${request.id}: ${cacheKeys.length} item(s) asked, ${items === undefined ? 'no results list' : `${items.length} answer(s)`}`);
        return;
      }
      items.forEach((item, i) => {
        if (request.op === 'owner') {
          if (!isOwner(item)) {
            summary.mismatches.push(`${request.id}[${i}]: not an owner answer (status ${JSON.stringify((item as { status?: unknown } | null)?.status)})`);
            return;
          }
          store.run('owner', cacheKeys[i]!, fingerprint, modset, item.status, JSON.stringify(item), version.envx, now);
        } else {
          const mixins = (item as { mixins?: unknown } | null)?.mixins;
          if (!Array.isArray(mixins)) {
            summary.mismatches.push(`${request.id}[${i}]: not a mixins answer`);
            return;
          }
          store.run('mixins', cacheKeys[i]!, fingerprint, modset, null, JSON.stringify(mixins as EnvxDeclaredMixin[]), version.envx, now);
        }
        summary.answered += 1;
      });
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ...summary, state: summary.mismatches.length > 0 && summary.answered === 0 ? 'failed' : 'ready' };
}

export interface Attribution {
  key: LookupKey;
  owner?: EnvxOwner;
  mixins: EnvxDeclaredMixin[];
  envxVersion: string;
}

/** What envx said about one path's methods, for the current mod set; empty without answers. */
export function attributionFor(db: DatabaseSync, pathId: number, seasonId?: number): Attribution[] {
  const capture = currentCapture(db, seasonId);
  if (capture === undefined) return [];
  const match = matchFor(db, modsetOf(captureMods(db, capture)));
  if (match?.status !== 'match' || match.fingerprint === null) return [];
  const out: Attribution[] = [];
  for (const key of keysOfPaths(db, [pathId]).get(pathId) ?? []) {
    const owner = cachedAnswer<EnvxOwner>(db, 'owner', key.cacheKey, match.fingerprint);
    const target = mixinTargetOf(key);
    const mixins = target === undefined ? undefined : cachedAnswer<EnvxDeclaredMixin[]>(db, 'mixins', target.cacheKey, match.fingerprint);
    if (owner === undefined && mixins === undefined) continue;
    const a: Attribution = { key, mixins: mixins?.result ?? [], envxVersion: owner?.envxVersion ?? mixins?.envxVersion ?? '' };
    if (owner !== undefined) a.owner = owner.result;
    out.push(a);
  }
  return out;
}

export { lookupKeyOf };
