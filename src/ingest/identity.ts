/**
 * Boots and exact method keys (schema v15).
 *
 * The foundation for resolving findings against an environment index (EnvX):
 * which jars were loaded, and exactly which method a measured row was.
 *
 *   boot   One JVM run. Fabric loads its jars once, at start, so the loaded
 *          jar set belongs to the boot. spark samples the JVM uptime when it
 *          saves a profile, so the start is `endTime - uptimeMs`: measured
 *          constant to the second across every capture of one boot, while
 *          `startTime - uptimeMs` drifts by minutes.
 *   key    class + method + descriptor exactly as spark recorded them
 *          (intermediary names on a live Fabric server). Stored per row in the
 *          capture's own sidecar; indexed here, never used to split cost.
 *
 * Certainty words for the later EnvX work, fixed here so nothing overstates:
 *   exact     only evidence that verifies the loaded artifacts themselves
 *             (hashes of the bytes the JVM loaded, coverage shown complete).
 *             Nothing in this build produces it.
 *   probable  one snapshot candidate remains (a unique mod id and version
 *             match, or disk observation around the boot). Owners: "likely".
 *   ambiguous several candidates, kept as candidates; never a "best" one.
 *   none      unknown, and said so.
 *
 * Everything here is offline: ingest never waits on anything outside.
 */

import { existsSync, readFileSync } from 'node:fs';

import type { DatabaseSync } from 'node:sqlite';

import type { Store } from '../store/db.ts';
import { decodeSparkProfile, type SparkProfile } from '../decode/sparkprofile.ts';
import { aggregateProfile } from '../decode/aggregate.ts';
import { mapFrame, type Mappings } from '../decode/mappings.ts';
import { decodeSidecar, encodeSidecar, keyString, replaceSidecarFile, type EncodableRow, type RawKey } from '../store/sidecar.ts';
import { readRawCapture } from './pipeline.ts';
import { withoutHiddenSuffix } from '../analysis/owner.ts';

/** Captures of one boot agree to the second; anything this close is the same JVM run. */
export const BOOT_TOLERANCE_MS = 2_000;

/** When the JVM that wrote this profile started, to the second; undefined when it did not say. */
export function jvmStartOf(profile: SparkProfile): number | undefined {
  const end = profile.metadata.endTime;
  const uptime = profile.metadata.system?.uptimeMs;
  if (end === undefined || uptime === undefined || !(end > 0) || !(uptime > 0) || uptime > end) return undefined;
  return Math.round((end - uptime) / 1000) * 1000;
}

/** The boot a capture belongs to: the same server's run within the tolerance, or a new one. */
export function bootFor(db: DatabaseSync, serverId: string, jvmStartedAt: number, capturedAt: number): number {
  const found = db
    .prepare(
      `SELECT id FROM boot WHERE server_id = ? AND jvm_started_at BETWEEN ? AND ?
        ORDER BY abs(jvm_started_at - ?) LIMIT 1`,
    )
    .get(serverId, jvmStartedAt - BOOT_TOLERANCE_MS, jvmStartedAt + BOOT_TOLERANCE_MS, jvmStartedAt) as
    | { id: number }
    | undefined;
  if (found !== undefined) {
    db.prepare('UPDATE boot SET first_capture_at = min(first_capture_at, ?), last_capture_at = max(last_capture_at, ?) WHERE id = ?').run(
      capturedAt,
      capturedAt,
      found.id,
    );
    return found.id;
  }
  const result = db
    .prepare('INSERT INTO boot (server_id, jvm_started_at, first_capture_at, last_capture_at) VALUES (?, ?, ?, ?)')
    .run(serverId, jvmStartedAt, capturedAt, capturedAt);
  return Number(result.lastInsertRowid);
}

/**
 * A class name for grouping: a hidden lambda class loses the suffix the JVM
 * gives it per run. Display and grouping only -- distinct lambdas of one
 * class share this, so it is never an identity.
 */
export function groupClassOf(rawClass: string): string {
  return withoutHiddenSuffix(rawClass);
}

// Per database, what is already known, so a capture only writes what is new.
// Keys: text -> id. Seen: "key/frame" -> [first, last] day starts.
const keyCache = new WeakMap<DatabaseSync, Map<string, { id: number; captured: boolean }>>();
const seenCache = new WeakMap<DatabaseSync, Map<string, [number, number]>>();
const DAY_MS = 86_400_000;

/**
 * Index the keys measured rows had, under the frames they were counted as.
 * Only what is new costs a write: `last_seen` moves at day resolution.
 */
export function recordKeys(
  db: DatabaseSync,
  rows: ReadonlyArray<RawKey & { frameId: number; seenAt?: number }>,
  seenAt: number,
  origin: 'capture' | 'backfill',
): void {
  let keys = keyCache.get(db);
  if (keys === undefined) keyCache.set(db, (keys = new Map()));
  let seen = seenCache.get(db);
  if (seen === undefined) seenCache.set(db, (seen = new Map()));

  const select = db.prepare('SELECT id, origin FROM frame_key WHERE raw_class = ? AND raw_method = ? AND raw_desc = ?');
  const insert = db.prepare('INSERT INTO frame_key (raw_class, raw_method, raw_desc, group_class, origin) VALUES (?, ?, ?, ?, ?)');
  const promote = db.prepare("UPDATE frame_key SET origin = 'capture' WHERE id = ?");
  const seenGet = db.prepare('SELECT first_seen, last_seen FROM frame_key_seen WHERE key_id = ? AND frame_id = ?');
  const seenPut = db.prepare(
    `INSERT INTO frame_key_seen (key_id, frame_id, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT (key_id, frame_id) DO UPDATE SET first_seen = min(first_seen, excluded.first_seen),
                                                  last_seen  = max(last_seen, excluded.last_seen)`,
  );

  const done = new Set<string>();
  for (const row of rows) {
    const day = Math.floor((row.seenAt ?? seenAt) / DAY_MS) * DAY_MS;
    const text = keyString(row);
    let known = keys.get(text);
    if (known === undefined) {
      const found = select.get(row.rawClass, row.rawMethod, row.rawDesc) as { id: number; origin: string } | undefined;
      known =
        found === undefined
          ? { id: Number(insert.run(row.rawClass, row.rawMethod, row.rawDesc, groupClassOf(row.rawClass), origin).lastInsertRowid), captured: origin === 'capture' }
          : { id: found.id, captured: found.origin === 'capture' };
      keys.set(text, known);
    }
    // A capture confirms a best-effort key.
    if (origin === 'capture' && !known.captured) {
      promote.run(known.id);
      known.captured = true;
    }
    const id = known.id;
    const pair = `${id}/${row.frameId}`;
    if (done.has(`${pair}/${day}`)) continue;
    done.add(`${pair}/${day}`);
    let range = seen.get(pair);
    if (range === undefined) {
      const stored = seenGet.get(id, row.frameId) as { first_seen: number; last_seen: number } | undefined;
      if (stored !== undefined) seen.set(pair, (range = [stored.first_seen, stored.last_seen]));
    }
    if (range !== undefined && day >= range[0] && day <= range[1]) continue;
    seenPut.run(id, row.frameId, day, day);
    seen.set(pair, range === undefined ? [day, day] : [Math.min(range[0], day), Math.max(range[1], day)]);
  }
}

export interface IdentityPace {
  allowed(): boolean;
  breathe(ms: number): Promise<void>;
  stopped(): boolean;
}

/**
 * Give captures from before v15 their boot and keys, oldest first, one at a
 * time and only while the PC is calm. From the raw file when it is still
 * kept: the boot, and keys written into the sidecar -- but only when the
 * re-read rows match the sidecar's row for row, so an index keyed by row
 * never shifts. Without a raw file the boot stays unknown. Then, once, a
 * best-effort key per frame from the frame table, marked 'backfill'.
 * Resumable: progress is kept in the database.
 */
export async function backfillIdentity(
  store: Store,
  mappingsFor: (source: string | null) => Mappings | undefined,
  pace: IdentityPace,
  log: (text: string) => void,
): Promise<boolean> {
  if (store.getMeta('identity.backfilled') === '1') return true;
  const db = store.db;
  let lastId = Number(store.getMeta('identity.backfill.lastId') ?? 0);
  const todo = db
    .prepare(
      `SELECT id, server_id, started_at, archive_path, sidecar_path, mappings_source FROM capture
        WHERE id > ? AND boot_id IS NULL ORDER BY id`,
    )
    .all(lastId) as Array<{
    id: number;
    server_id: string;
    started_at: number | null;
    archive_path: string | null;
    sidecar_path: string | null;
    mappings_source: string | null;
  }>;

  let boots = 0;
  let keyed = 0;
  let noRaw = 0;
  let mismatched = 0;
  for (const capture of todo) {
    while (!pace.allowed()) {
      await pace.breathe(15_000);
      if (pace.stopped()) return false;
    }
    if (pace.stopped()) return false;
    try {
      const raw = store.resolveDataPath(capture.archive_path);
      if (raw === undefined || !existsSync(raw)) noRaw += 1;
      else {
        const profile = decodeSparkProfile(readRawCapture(raw));
        const started = jvmStartOf(profile);
        if (started !== undefined) {
          store.transaction(() => {
            const bootId = bootFor(db, capture.server_id, started, capture.started_at ?? started);
            db.prepare('UPDATE capture SET boot_id = ? WHERE id = ?').run(bootId, capture.id);
          });
          boots += 1;
        }
        const outcome = addKeysToSidecar(store, capture, profile, mappingsFor(capture.mappings_source));
        if (outcome === 'keyed') keyed += 1;
        else if (outcome === 'mismatch') mismatched += 1;
      }
    } catch (error) {
      log(`method keys: capture ${capture.id}: ${(error as Error).message}`);
    }
    lastId = capture.id;
    store.setMeta('identity.backfill.lastId', String(lastId));
    await pace.breathe(500);
  }

  // Captures with no raw file left: one best-effort key per frame.
  store.transaction(() => {
    const frames = db
      .prepare(
        `SELECT f.id, f.class_name, f.method_name, min(p.first_seen) AS first_seen, max(p.last_seen) AS last_seen
           FROM frame f JOIN path p ON p.frame_id = f.id
          WHERE NOT EXISTS (SELECT 1 FROM frame_key_seen s WHERE s.frame_id = f.id)
          GROUP BY f.id`,
      )
      .all() as Array<{ id: number; class_name: string; method_name: string; first_seen: number; last_seen: number }>;
    recordKeys(
      db,
      frames.flatMap((f) => [
        { rawClass: f.class_name, rawMethod: f.method_name, rawDesc: '', frameId: f.id, seenAt: f.first_seen },
        { rawClass: f.class_name, rawMethod: f.method_name, rawDesc: '', frameId: f.id, seenAt: f.last_seen },
      ]),
      Date.now(),
      'backfill',
    );
  });

  store.setMeta('identity.backfilled', '1');
  log(
    `boots and method keys: ${boots} capture(s) placed on a boot, ${keyed} sidecar(s) given method keys` +
      (noRaw === 0 ? '' : `, ${noRaw} without a raw file (boot unknown)`) +
      (mismatched === 0 ? '' : `, ${mismatched} left without keys (rows did not match)`),
  );
  return true;
}

/**
 * Write method keys into an existing sidecar from its raw capture. The rows
 * are re-derived and must match the sidecar's exactly (label, parent, depth)
 * before anything is written; the file is replaced atomically.
 */
function addKeysToSidecar(
  store: Store,
  capture: { id: number; sidecar_path: string | null },
  profile: SparkProfile,
  mappings: Mappings | undefined,
): 'keyed' | 'already' | 'mismatch' | 'missing' {
  const file = store.resolveDataPath(capture.sidecar_path);
  if (file === undefined || !existsSync(file) || mappings === undefined) return 'missing';
  const sidecar = decodeSidecar(readFileSync(file));
  if (sidecar.keys !== undefined) return 'already';
  const agg = aggregateProfile(profile, { renameFrame: (c, m) => mapFrame(c, m, mappings), mappingsAvailable: mappings.available });
  if (agg.rows.length !== sidecar.rows.length) return 'mismatch';
  for (let i = 0; i < agg.rows.length; i += 1) {
    const a = agg.rows[i]!;
    const s = sidecar.rows[i]!;
    if (a.label !== s.label || a.parentIndex !== s.parentIndex || a.depth !== s.depth) return 'mismatch';
  }
  const rows: EncodableRow[] = sidecar.rows.map((row, i) => {
    const a = agg.rows[i]!;
    return { ...row, className: a.className, methodName: a.methodName, methodDesc: a.methodDesc };
  });
  const fresh = encodeSidecar(sidecar.captureSha, sidecar.windows, rows);
  const check = decodeSidecar(fresh);
  if (check.rows.length !== sidecar.rows.length || check.keys === undefined) return 'mismatch';
  replaceSidecarFile(file, fresh);
  const frameOf = store.db.prepare('SELECT id FROM frame WHERE label = ?');
  const frameIds = new Map<string, number>();
  const keyed = sidecar.rows.flatMap((row, i) => {
    let frameId = frameIds.get(row.label);
    if (frameId === undefined) {
      frameId = (frameOf.get(row.label) as { id: number } | undefined)?.id ?? -1;
      frameIds.set(row.label, frameId);
    }
    return frameId < 0 ? [] : [{ ...check.keys![i]!, frameId }];
  });
  const when = Number(
    (store.db.prepare('SELECT started_at FROM capture WHERE id = ?').get(capture.id) as { started_at: number | null } | undefined)?.started_at ??
      Date.now(),
  );
  store.transaction(() => recordKeys(store.db, keyed, when, 'capture'));
  return 'keyed';
}
