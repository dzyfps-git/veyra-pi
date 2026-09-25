/**
 * What to ask envx about, and how to recognise an answer again.
 *
 * Each measured method is known by the key the capture recorded (v15,
 * `frame_key`): runtime class, method name and descriptor. Two kinds of name
 * change every server start, so they are normalised for the cache and for
 * de-duplication, while the request still sends a name exactly as recorded
 * (the contract accepts both and does its own normalising):
 *
 *   - hidden lambda classes, `Foo$$Lambda$123/0x…`: the host class `Foo`;
 *   - methods Mixin merged into a target class, `<kind>$<hash>$<modid>$<name>`:
 *     the hash is dropped, since one handler appears under up to 17 of them.
 *
 * The mod set is identified the way envx identifies it, so both sides group
 * captures alike.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { isLibraryCode, parseMixin, withoutHiddenSuffix } from '../analysis/owner.ts';
import type { EnvxKey, EnvxTarget } from './contract.ts';

export interface LookupKey {
  /** Stable across server starts: what the cache is keyed by. */
  cacheKey: string;
  /** A name exactly as recorded, sent to envx. */
  request: EnvxKey;
  hiddenLambda: boolean;
  /** Set for a merged mixin method. */
  mixin?: { kind: string; mod: string; handler: string };
}

const MINECRAFT = /^(net\.minecraft|com\.mojang)\./;

export function lookupKeyOf(raw: EnvxKey): LookupKey {
  const hostClass = withoutHiddenSuffix(raw.class).replace(/\$\$Lambda$/, '');
  const hiddenLambda = hostClass !== raw.class;
  const merged = parseMixin(`x.${raw.method}`);
  const method = merged === undefined ? raw.method : `${merged.kind}$*$${merged.mod}$${merged.method}`;
  const key: LookupKey = { cacheKey: `${hostClass}\t${method}\t${raw.desc}`, request: { ...raw }, hiddenLambda };
  if (merged !== undefined) key.mixin = { kind: merged.kind, mod: merged.mod, handler: merged.method };
  return key;
}

/**
 * Minecraft's own methods, to ask which mixins target them: an @Overwrite
 * replaces the body under the vanilla name, so a hot vanilla frame may be a
 * mod's code with nothing in its name to say so. Merged handlers are already
 * attributed by name.
 */
export function mixinTargetOf(key: LookupKey): { cacheKey: string; target: EnvxTarget } | undefined {
  if (key.mixin !== undefined || key.hiddenLambda) return undefined;
  const [hostClass] = key.cacheKey.split('\t');
  if (hostClass === undefined || !MINECRAFT.test(hostClass)) return undefined;
  return { cacheKey: key.cacheKey, target: { class: hostClass, method: key.request.method, desc: key.request.desc } };
}

/**
 * envx's modset: sha256 over the loaded mods as sorted `<mod id>@<version>`
 * lines, java, minecraft and fabricloader included -- spark's list as it is.
 */
export function modsetOf(mods: ReadonlyArray<readonly [string, string]>): string {
  const lines = mods.map(([id, version]) => `${id}@${version}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The loaded mods of one capture, for `match`. */
export function captureMods(db: DatabaseSync, captureId: number): Array<[string, string]> {
  return (
    db
      .prepare('SELECT m.mod_id AS id, cm.version AS version FROM capture_mod cm JOIN mod m ON m.id = cm.mod WHERE cm.capture_id = ?')
      .all(captureId) as Array<{ id: string; version: string }>
  ).map((r) => [r.id, r.version]);
}

/**
 * The keys measured under these paths' own frames. Only keys recorded from a
 * capture: best-effort backfilled ones have no descriptor, and an owner looked
 * up without one would be a guess about which overload ran. Library code (the
 * JDK, Guava, fastutil...) is left out: it is in no mod jar (a real batch
 * answered 'none' for all of it), and the app already credits it to its caller.
 */
export function keysOfPaths(db: DatabaseSync, pathIds: readonly number[]): Map<number, LookupKey[]> {
  const out = new Map<number, LookupKey[]>();
  const query = db.prepare(
    `SELECT k.raw_class AS c, k.raw_method AS m, k.raw_desc AS d
       FROM path p JOIN frame_key_seen s ON s.frame_id = p.frame_id JOIN frame_key k ON k.id = s.key_id
      WHERE p.id = ? AND k.origin = 'capture' AND k.raw_desc <> ''
      ORDER BY s.last_seen DESC`,
  );
  for (const pathId of pathIds) {
    const seen = new Set<string>();
    const keys: LookupKey[] = [];
    for (const row of query.all(pathId) as Array<{ c: string; m: string; d: string }>) {
      if (isLibraryCode(`${row.c}.${row.m}`)) continue;
      const key = lookupKeyOf({ class: row.c, method: row.m, desc: row.d });
      if (seen.has(key.cacheKey)) continue;
      seen.add(key.cacheKey);
      keys.push(key);
    }
    out.set(pathId, keys);
  }
  return out;
}
