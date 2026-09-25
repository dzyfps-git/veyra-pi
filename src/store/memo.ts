/**
 * Reusing page computations until the database changes.
 *
 * Several pages recompute the same derived figures on every load (the
 * findings list, where the tick went), each taking tens of milliseconds of
 * CPU on the PC that also runs the server. Their inputs are all in the
 * database, so a result stays valid exactly until something is written.
 *
 * SQLite's `total_changes()` counts every row this connection has inserted,
 * updated or deleted. The collector and the web pages share one connection
 * (store/db.ts), so any write -- an ingest, a setting, a register entry --
 * moves it, and everything cached before is simply not used again. Nothing
 * time-dependent may be memoised this way: only functions of the database
 * and their arguments.
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

const versionQuery = new WeakMap<DatabaseSync, StatementSync>();
const caches = new WeakMap<DatabaseSync, Map<string, { version: number; value: unknown }>>();

/** Changes written through this connection so far; moves on every write. */
export function dataVersion(db: DatabaseSync): number {
  let query = versionQuery.get(db);
  if (query === undefined) {
    query = db.prepare('SELECT total_changes() AS n');
    versionQuery.set(db, query);
  }
  return (query.get() as { n: number }).n;
}

/**
 * `compute()` once per database version and key. Keeps the most recent
 * `max` results; an entry from an older version is recomputed, never served.
 */
export function memo<T>(db: DatabaseSync, key: string, compute: () => T, max = 24): T {
  let cache = caches.get(db);
  if (cache === undefined) {
    cache = new Map();
    caches.set(db, cache);
  }
  const version = dataVersion(db);
  const hit = cache.get(key);
  if (hit !== undefined && hit.version === version) {
    // Most recently used last, so the oldest is the first to go.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value as T;
  }
  const value = compute();
  cache.delete(key);
  cache.set(key, { version, value });
  while (cache.size > max) cache.delete(cache.keys().next().value!);
  return value;
}
