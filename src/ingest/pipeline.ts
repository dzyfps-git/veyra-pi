/**
 * Ingest pipeline: a `.sparkprofile` becomes queryable history.
 *
 *   read -> sha256 -> decode -> aggregate -> assign environment/season/revision
 *        -> write capture + windows + mods -> intern paths -> daily ledger
 *        -> write sidecar -> archive raw
 *
 * Properties that matter:
 *
 *  - IDEMPOTENT. Captures are keyed by content sha256, so re-ingesting the
 *    same file is a no-op. Backfills and retries are safe.
 *  - TRANSACTIONAL. Everything for one capture commits together or not at all;
 *    a crash mid-ingest cannot leave a half-recorded capture.
 *  - NON-DESTRUCTIVE. This module never deletes or modifies anything on a
 *    monitored server. It only reads.
 *  - HONEST. Where mappings are unavailable the headline figures are left NULL
 *    rather than computed from unmapped names.
 */

import { activityOf } from '../analysis/activity.ts';
import { writeLedger, dayKey, type LedgerRowInput } from './ledger.ts';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { decodeSparkProfile, type SparkProfile } from '../decode/sparkprofile.ts';
import { aggregateProfile, type AggregatedProfile } from '../decode/aggregate.ts';
import { mapFrame, NO_MAPPINGS, type Mappings } from '../decode/mappings.ts';
import {
  extractEnvironment,
  classifyBoundary,
  environmentKey,
  diffRuntimeFlags,
  type EnvironmentFacts,
} from '../model/season.ts';
import { identifyWorld, compareWorlds, type WorldIdentity } from '../model/world.ts';
import { readLevelDat } from '../model/leveldat.ts';
import { encodeSidecar } from '../store/sidecar.ts';
import { bootFor, jvmStartOf, recordKeys } from './identity.ts';
import { computeSplit, saveSplit } from '../analysis/split.ts';
import type { Store } from '../store/db.ts';

export interface IngestOptions {
  /**
   * The live server directory, when it is reachable.
   *
   * Supplying it lets the world be identified by SEED, which is the only
   * definitive answer to "is this still the same world?". Without it the
   * system falls back to level name and datapacks, which cannot detect a
   * reset that kept the same name -- and it says so rather than pretending
   * otherwise.
   */
  serverRoot?: string | undefined;
  store: Store;
  serverId: string;
  /** Yarn mappings for this capture's Minecraft version, if available. */
  mappings?: Mappings;
  /** Root for sidecars and archived raw captures. */
  archiveDir: string;
  /** Copy the raw `.sparkprofile` into the archive. */
  archiveRaw?: boolean;
  /** Treat as a capture the operator took by hand, rather than a harvest. */
  isManual?: boolean;
  /**
   * Evidence floor for the per-path ledger tier. A path below BOTH of these
   * was effectively sampled once; its cost is still recorded against its
   * method in `frame_daily`, and its full detail stays in the sidecar.
   */
  evidenceMinWindows?: number;
  evidenceMinSamples?: number;
}

export type IngestOutcome =
  | { status: 'ingested'; captureId: number; sha256: string; paths: number; seasonId: number; revisionId: number; newSeason: boolean; newRevision: boolean }
  | { status: 'duplicate'; captureId: number; sha256: string };

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** UTC day key, so the ledger does not shift under daylight saving. */

/**
 * spark 1.10.53 omits `sampler_engine` entirely, so absence proves nothing.
 * Native frames only appear under async-profiler, which makes their presence
 * positive evidence. Their absence stays `unknown` rather than becoming "java".
 */
function inferEngine(profile: SparkProfile): 'async' | 'unknown' {
  for (const thread of profile.threads) {
    for (const node of thread.children) {
      const className = node.className ?? '';
      if (className.startsWith('native.') || className.endsWith('.so') || className.includes('.so.')) {
        return 'async';
      }
    }
  }
  return 'unknown';
}

/**
 * Raw captures are archived zstd-compressed: measured 24.5 MB -> 1.8 MB in
 * ~30 ms at level 3, which turns ~1.8 GB/day of archive growth into ~140 MB.
 * The hash, and so a capture's identity, is always of the uncompressed bytes.
 */
export const RAW_EXTENSION = '.sparkprofile.zst';

/** A raw capture's bytes, whether archived compressed or not. */
export function readRawCapture(file: string): Buffer {
  const bytes = readFileSync(file);
  return file.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes;
}

export function compressRaw(bytes: Buffer): Buffer {
  return zstdCompressSync(bytes, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } });
}

export function ingestFile(file: string, options: IngestOptions): IngestOutcome {
  const bytes = readRawCapture(file);
  const sha256 = sha256Of(bytes);

  const existing = options.store.captureBySha(sha256);
  if (existing !== undefined) {
    return { status: 'duplicate', captureId: existing.id, sha256 };
  }

  const mappings = options.mappings ?? NO_MAPPINGS;
  const profile = decodeSparkProfile(bytes);
  const agg = aggregateProfile(profile, {
    renameFrame: (c, m) => mapFrame(c, m, mappings),
    mappingsAvailable: mappings.available,
  });

  const env = extractEnvironment(profile);
  const startedAt = profile.metadata.startTime ?? Date.now();

  return options.store.transaction(() =>
    writeCapture({ file, bytes, sha256, profile, agg, env, startedAt, mappings, options }),
  );
}

interface WriteInput {
  file: string;
  bytes: Buffer;
  sha256: string;
  profile: SparkProfile;
  agg: AggregatedProfile;
  env: EnvironmentFacts;
  startedAt: number;
  mappings: Mappings;
  options: IngestOptions;
}

function writeCapture(input: WriteInput): IngestOutcome {
  const { store, serverId, archiveDir } = input.options;
  const { profile, agg, env, startedAt } = input;
  const db = store.db;

  // --- environment -------------------------------------------------------
  const envKey = environmentKey(env);
  const environmentId = store.upsertEnvironment({
    serverId,
    envKey,
    mcVersion: env.minecraftVersion,
    loaderName: env.loaderName,
    loaderVersion: env.loaderVersion,
    javaMajor: env.javaMajor,
    cpuModel: env.cpuModel,
    cpuThreads: env.cpuThreads,
    osName: env.osName,
    seenAt: startedAt,
  });

  // --- world --------------------------------------------------------------
  //
  // A world reset is the largest uncontrolled change there is: a fresh world
  // has no loaded chunk backlog, no entities, no farms and no stored items.
  // Pooling it with the previous world would compare an empty house to a full
  // one. It therefore starts a new season, exactly as a modpack change does.
  // level.dat only ever answers "which world is loaded RIGHT NOW". Reading it
  // at ingest and attributing the capture to whatever it says would be wrong
  // in a specific and likely way: harvest at 14:00, reset the world at 15:00,
  // ingest the backlog at 16:00, and every one of those captures is filed
  // under a world that did not exist when they were taken.
  //
  // So the current reading is recorded as a timestamped SIGHTING, and the
  // capture is attributed to whichever world was live at its own start time.
  const now = Date.now();
  const currentIdentity = resolveWorld(input, profile);

  let currentWorldId: number | undefined;
  if (currentIdentity.fingerprint !== undefined) {
    currentWorldId = store.upsertWorld({
      serverId,
      fingerprint: currentIdentity.fingerprint,
      strength: currentIdentity.strength,
      seed: currentIdentity.seed,
      levelName: currentIdentity.levelName,
      levelType: currentIdentity.levelType,
      datapackHash: currentIdentity.datapackHash,
      seenAt: now,
    });
    // Stamped with NOW, not with the capture's time: this is a statement
    // about the server as it is at this moment.
    store.recordWorldSighting(serverId, currentWorldId, now, 'ingest');
  }

  // Which world did THIS capture measure?
  const attribution = store.worldAt(serverId, startedAt);
  const worldId = attribution?.confident === true ? attribution.worldId : undefined;

  const previousWorld = latestWorldIdentity(store, serverId, environmentId);
  // Compare against the world this capture is attributed to, falling back to
  // the current reading only when the capture is contemporaneous with it.
  const identityForComparison =
    worldId !== undefined && worldId !== currentWorldId
      ? worldIdentityOf(store, worldId) ?? currentIdentity
      : currentIdentity;
  const worldChange = compareWorlds(previousWorld, identityForComparison);

  // --- season / revision --------------------------------------------------
  // Boundaries are decided against the previous capture IN THE SAME
  // ENVIRONMENT. Comparing against whatever happened to be most recent
  // globally is what invented phantom season rollovers when a test server's
  // captures interleaved with production.
  const previousFacts = latestEnvironmentFacts(store, serverId, environmentId);
  const decision = classifyBoundary(previousFacts, env);

  let seasonRow = store.latestSeason(serverId, environmentId);
  let newSeason = false;

  // Only a CONFIRMED world change splits the history on its own. A seed that
  // differs cannot mean anything else, so it is acted on. A change visible
  // only in the weak signals has innocent explanations -- a rename, a
  // datapack edit -- and splitting on a guess would destroy exactly the
  // continuity this archive exists to provide, so it becomes a question.
  const worldForcesNewSeason = worldChange.kind === 'changed';

  if (seasonRow === undefined || decision.kind === 'season' || worldForcesNewSeason) {
    const reasons = [...decision.reasons];
    if (worldForcesNewSeason) reasons.unshift(worldChange.reason);

    seasonRow = {
      id: store.createSeason({
        serverId,
        environmentId,
        ordinal: (seasonRow?.ordinal ?? 0) + 1,
        startedAt,
        reason: reasons.join('; ') || 'first capture in this environment',
        // A season change near the similarity threshold is a judgement call,
        // so it is recorded unconfirmed and surfaced for a human to accept.
        // A seed change is not a judgement call.
        confirmed: worldForcesNewSeason || !decision.needsConfirmation,
      }),
      ordinal: (seasonRow?.ordinal ?? 0) + 1,
    };
    newSeason = true;
  }

  if (worldId !== undefined) store.setSeasonWorld(seasonRow.id, worldId);

  // A capture that cannot be placed on the world timeline is asked about
  // rather than filed under a guess.
  if (attribution !== undefined && !attribution.confident) {
    store.askBoundaryQuestion({
      serverId,
      seasonId: seasonRow.id,
      kind: 'world-unknown',
      question: 'Which world did this capture measure?',
      detail:
        `${input.file.split(/[\\/]/).pop() ?? 'a capture'}: ${attribution.reason}. It has been recorded ` +
        'without a world rather than attributed to one.',
      options: [
        {
          id: 'current-world',
          label: 'The world running now',
          description: 'Attribute it to the world currently live on the server.',
        },
        {
          id: 'leave-unattributed',
          label: 'Leave it unattributed',
          description:
            'Keep the measurements, but do not claim which world they came from. The safe answer when unsure.',
        },
      ],
    });
  }

  // Anything not confidently decided is asked, never assumed.
  if (worldChange.kind === 'suspected' || worldChange.kind === 'unknown') {
    store.askBoundaryQuestion({
      serverId,
      seasonId: seasonRow.id,
      kind: worldChange.kind === 'suspected' ? 'world-suspected' : 'world-unknown',
      question: 'Is this the same world as before, or a new one?',
      detail: worldChange.reason,
      options: [
        {
          id: 'same-world',
          label: 'Same world',
          description: 'Keep measuring it as one continuous history. Nothing is split.',
        },
        {
          id: 'new-world',
          label: 'New world',
          description:
            'Start a new season from this capture. Earlier history is kept in full and stays queryable, ' +
            'but is no longer pooled with this one.',
        },
      ],
    });
  }


  let revisionRow = store.latestRevision(seasonRow.id);
  let newRevision = false;

  // A revision boundary is a change to the mods OR to the JVM flags. A
  // restart that only adds -XX:+DebugNonSafepoints moves where the profiler
  // attributes time without any mod changing, so it has to be visible --
  // otherwise a before/after comparison straddling it credits a patch with
  // the flag's effect.
  //
  // Flags are only compared when BOTH sides recorded them. A revision from
  // before flag tracking has NULL, meaning unknown, and is filled in rather
  // than treated as "different".
  const previousFlags: string[] | undefined =
    revisionRow?.runtime_flags === null || revisionRow?.runtime_flags === undefined
      ? undefined
      : (JSON.parse(revisionRow.runtime_flags) as string[]);
  const flagChanges =
    previousFlags !== undefined && env.runtimeFlags !== undefined
      ? diffRuntimeFlags(previousFlags, env.runtimeFlags)
      : [];

  if (revisionRow !== undefined && previousFlags === undefined && env.runtimeFlags !== undefined) {
    store.setRevisionRuntimeFlags(revisionRow.id, env.runtimeFlags);
  }

  if (revisionRow === undefined || revisionRow.mod_set_hash !== env.modSetHash || flagChanges.length > 0) {
    const reasons = [...decision.reasons];
    if (flagChanges.length > 0) reasons.push(`JVM flags ${flagChanges.join(', ')}`);

    revisionRow = {
      id: store.createRevision({
        seasonId: seasonRow.id,
        ordinal: (revisionRow?.ordinal ?? 0) + 1,
        modSetHash: env.modSetHash,
        runtimeFlags: env.runtimeFlags,
        heapMaxMb: env.heapMaxMb,
        startedAt,
        reason: reasons.join('; ') || 'initial mod set',
        added: decision.diff.added.length,
        removed: decision.diff.removed.length,
        changed: decision.diff.changed.length,
      }),
      ordinal: (revisionRow?.ordinal ?? 0) + 1,
      mod_set_hash: env.modSetHash,
      runtime_flags: env.runtimeFlags === undefined ? null : JSON.stringify(env.runtimeFlags),
    };
    newRevision = true;
  }

  // --- capture row --------------------------------------------------------
  const ticks = agg.divisorTicks;
  const perTick = (ms: number | undefined): number | null =>
    ms === undefined || ticks === undefined || ticks === 0 ? null : ms / ticks;

  const primary = agg.threads[0];
  // Written to an absolute location, stored relative to the data folder, so
  // the archive survives the data folder being moved.
  const captureDir = path.join(
    path.isAbsolute(archiveDir) ? archiveDir : path.join(store.dataDir, archiveDir.replace(/^data[\\/]/, '')),
    dayKey(startedAt),
  );
  mkdirSync(captureDir, { recursive: true });
  const base = `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}_${input.sha256.slice(0, 12)}`;
  const sidecarPath = path.join(captureDir, `${base}.sidecar.zst`);
  const archivePath = input.options.archiveRaw === true ? path.join(captureDir, `${base}${RAW_EXTENSION}`) : null;

  // The JVM run this came from (ingest/identity.ts); unknown when spark did not say.
  const jvmStartedAt = jvmStartOf(profile);
  const bootId = jvmStartedAt === undefined ? null : bootFor(db, serverId, jvmStartedAt, startedAt);

  db.prepare(
    `INSERT INTO capture (
       server_id, season_id, revision_id, content_sha256, source_name, archive_path, sidecar_path,
       raw_bytes, started_at, ended_at, interval_micros, number_of_ticks, divisor_ticks,
       window_count, path_count, sampler_mode, sampler_engine, engine_inferred, mappings_source,
       tick_ms_per_tick, idle_ms_per_tick, blocked_ms_per_tick, between_tick_ms_per_tick,
       wall_ms_per_tick, unclassified_ms_per_tick, is_manual, ingested_at, boot_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    serverId,
    seasonRow.id,
    revisionRow.id,
    input.sha256,
    path.basename(input.file),
    archivePath === null ? null : store.toStoredPath(archivePath),
    store.toStoredPath(sidecarPath),
    input.bytes.length,
    profile.metadata.startTime ?? null,
    profile.metadata.endTime ?? null,
    profile.metadata.intervalMicros ?? null,
    profile.metadata.numberOfTicks ?? null,
    ticks ?? null,
    profile.timeWindows.length,
    agg.rows.length,
    profile.metadata.samplerMode ?? null,
    profile.metadata.samplerEngine ?? null,
    inferEngine(profile),
    input.mappings.source,
    agg.tickMsPerTick ?? null,
    perTick(primary?.idleMs),
    perTick(primary?.blockedMs),
    primary?.betweenTickMs === undefined ? null : perTick(primary.betweenTickMs),
    perTick(primary?.totalMs),
    perTick(primary?.unclassifiedWaitMs),
    input.options.isManual === true ? 1 : 0,
    Date.now(),
    bootId,
  );
  const captureId = Number(db.prepare('SELECT last_insert_rowid() AS id').get()!['id']);

  // Stamped only when the timeline could place it confidently. A capture with
  // no world is an honest record; a capture attributed to the wrong world is a
  // silent corruption of every comparison that touches it.
  store.setCaptureWorld(captureId, worldId);

  // --- per-minute window statistics ---------------------------------------
  const windowInsert = db.prepare(
    `INSERT INTO capture_window
       (capture_id, window_id, start_time, end_time, ticks, tps, mspt_median, mspt_max,
        players, entities, tile_entities, chunks, cpu_process, cpu_system)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const [windowId, w] of profile.windowStatistics) {
    windowInsert.run(
      captureId,
      windowId,
      w.startTime ?? null,
      w.endTime ?? null,
      w.ticks ?? null,
      w.tps ?? null,
      w.msptMedian ?? null,
      w.msptMax ?? null,
      w.players ?? null,
      w.entities ?? null,
      w.tileEntities ?? null,
      w.chunks ?? null,
      w.cpuProcess ?? null,
      w.cpuSystem ?? null,
    );
  }

  // --- mod set ------------------------------------------------------------
  const modInsert = db.prepare('INSERT INTO mod (mod_id, name) VALUES (?, ?) ON CONFLICT(mod_id) DO NOTHING');
  const modSelect = db.prepare('SELECT id FROM mod WHERE mod_id = ?');
  const captureModInsert = db.prepare(
    'INSERT INTO capture_mod (capture_id, mod, version) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  for (const entry of env.mods) {
    const info = profile.metadata.sources.get(entry.id);
    modInsert.run(entry.id, info?.name ?? null);
    const row = modSelect.get(entry.id) as { id: number } | undefined;
    if (row !== undefined) captureModInsert.run(captureId, row.id, entry.version);
  }

  // --- call-path tree and the permanent daily ledger ----------------------
  //
  // agg.rows is emitted parent-before-child, so a single forward pass can
  // resolve every parent id without a second traversal.
  const day = dayKey(startedAt);
  const pathIdByRow = new Array<number>(agg.rows.length).fill(0);
  const windowsTotal = profile.timeWindows.length;
  const ledgerRows: LedgerRowInput[] = [];

  for (const [index, row] of agg.rows.entries()) {
    const frameId = store.internFrame(row.label, row.className, row.methodName);
    const parentPathId = row.parentIndex < 0 ? 0 : (pathIdByRow[row.parentIndex] ?? 0);
    const pathId = store.internPathEdge({
      parentId: parentPathId,
      frameId,
      depth: row.depth,
      source: row.source,
      seenAt: startedAt,
    });
    pathIdByRow[index] = pathId;

    let present = 0;
    for (let w = 0; w < windowsTotal; w += 1) if ((row.totalMsByWindow[w] ?? 0) !== 0) present += 1;
    ledgerRows.push({
      frameId, pathId, selfMs: row.selfMs, totalMs: row.totalMs, category: row.category, present,
      selfByWindow: row.selfMsByWindow, totalByWindow: row.totalMsByWindow,
    });
  }

  // Tier 1 (per method) is unconditional; tier 2 (per path) has the
  // evidence floor. Both are written by one function, shared with the
  // rebuild, so the two can never disagree about how a capture counts.
  writeLedger(db, {
    serverId,
    seasonId: seasonRow.id,
    day,
    ticks: ticks ?? 0,
    windowsTotal,
    intervalMs: (profile.metadata.intervalMicros ?? 10000) / 1000,
    minWindows: input.options.evidenceMinWindows ?? 2,
    minSamples: input.options.evidenceMinSamples ?? 2,
    rows: ledgerRows,
    // Who was online each minute, so the roll-ups can tell play from idle.
    windowActivity: profile.timeWindows.map((id) => activityOf(profile.windowStatistics.get(id)?.players)),
    windowTicks: profile.timeWindows.map((id) => profile.windowStatistics.get(id)?.ticks ?? null),
  });

  // Exact method keys, indexed under the frames they were counted as. The
  // per-row keys themselves go into the sidecar below.
  recordKeys(
    db,
    agg.rows.map((row, i) => ({ rawClass: row.className, rawMethod: row.methodName, rawDesc: row.methodDesc, frameId: ledgerRows[i]!.frameId })),
    startedAt,
    'capture',
  );

  // Where the tick went, per minute (analysis/split.ts): by part of the
  // game, mod and thing, every sample counted once.
  saveSplit(db, captureId, computeSplit(agg.rows, profile.timeWindows));

  // Path ids in sidecar row order, so time-span queries never re-resolve.
  db.prepare('INSERT OR REPLACE INTO capture_path_ids (capture_id, ids) VALUES (?, ?)').run(
    captureId,
    Buffer.from(Int32Array.from(pathIdByRow).buffer),
  );

  // --- sidecar and raw archive -------------------------------------------
  writeFileSync(sidecarPath, encodeSidecar(input.sha256, profile.timeWindows, agg.rows));
  if (archivePath !== null && !existsSync(archivePath)) {
    // Written aside and renamed, so a crash never leaves a half file under
    // the name the database points at.
    writeFileSync(`${archivePath}.part`, compressRaw(input.bytes));
    renameSync(`${archivePath}.part`, archivePath);
  }

  return {
    status: 'ingested',
    captureId,
    sha256: input.sha256,
    paths: agg.rows.length,
    seasonId: seasonRow.id,
    revisionId: revisionRow.id,
    newSeason,
    newRevision,
  };
}

/**
 * Rebuild the previous capture's environment facts from stored rows.
 *
 * Only the mod set and heap are needed: everything else in the environment is
 * identical by construction, since we already matched on `env_key`.
 */
/**
 * Work out which world this capture measured.
 *
 * Prefers the seed from level.dat, which is definitive. Falls back to what
 * the capture itself carries, which can only detect a rename. The fallback is
 * labelled as weak so that a later comparison knows not to draw a strong
 * conclusion from it.
 */
function resolveWorld(input: WriteInput, profile: SparkProfile): WorldIdentity {
  const properties = readServerProperties(profile);
  const levelName = properties['level-name'];
  const levelType = properties['level-type'];
  const datapacks = readDatapackNames(profile);

  const root = input.options.serverRoot;
  if (root !== undefined && root !== '') {
    const result = readLevelDat(root, levelName ?? 'world');
    if (result.ok && result.facts?.seed !== undefined) {
      return identifyWorld({
        seed: result.facts.seed,
        levelName: result.facts.levelName ?? levelName,
        levelType,
        datapacks,
      });
    }
  }

  return identifyWorld({ levelName, levelType, datapacks });
}

function readServerProperties(profile: SparkProfile): Record<string, string | undefined> {
  const raw = profile.metadata.serverConfigurations?.get('server.properties');
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = value === null || value === undefined ? undefined : String(value);
    }
    return out;
  } catch {
    return {};
  }
}

function readDatapackNames(profile: SparkProfile): string[] {
  const raw = profile.metadata.extraPlatformMetadata?.get('datapacks');
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Rebuild a stored world's identity, for comparison against a new reading. */
function worldIdentityOf(store: Store, worldId: number): WorldIdentity | undefined {
  const row = store.getWorld(worldId);
  if (row === undefined) return undefined;

  const identity: WorldIdentity = {
    fingerprint: row.fingerprint,
    strength: row.strength as WorldIdentity['strength'],
    basis: 'recorded from an earlier reading',
  };
  if (row.seed !== null) identity.seed = row.seed;
  if (row.level_name !== null) identity.levelName = row.level_name;
  if (row.level_type !== null) identity.levelType = row.level_type;
  if (row.datapack_hash !== null) identity.datapackHash = row.datapack_hash;
  return identity;
}

/** The world identity of the most recent capture in this environment. */
function latestWorldIdentity(
  store: Store,
  serverId: string,
  environmentId: number,
): WorldIdentity | undefined {
  const row = store.db
    .prepare(
      `SELECT w.fingerprint, w.strength, w.seed, w.level_name, w.level_type, w.datapack_hash
         FROM season s
         JOIN world w ON w.id = s.world_id
        WHERE s.server_id = ? AND s.environment_id = ?
        ORDER BY s.ordinal DESC LIMIT 1`,
    )
    .get(serverId, environmentId) as
    | {
        fingerprint: string;
        strength: string;
        seed: string | null;
        level_name: string | null;
        level_type: string | null;
        datapack_hash: string | null;
      }
    | undefined;

  if (row === undefined) return undefined;

  const identity: WorldIdentity = {
    fingerprint: row.fingerprint,
    strength: row.strength as WorldIdentity['strength'],
    basis: 'recorded from an earlier capture',
  };
  if (row.seed !== null) identity.seed = row.seed;
  if (row.level_name !== null) identity.levelName = row.level_name;
  if (row.level_type !== null) identity.levelType = row.level_type;
  if (row.datapack_hash !== null) identity.datapackHash = row.datapack_hash;
  return identity;
}

function latestEnvironmentFacts(store: Store, serverId: string, environmentId: number): EnvironmentFacts | undefined {
  const row = store.db
    .prepare(
      `SELECT c.id, r.heap_max_mb, e.mc_version, e.loader_name, e.loader_version,
              e.java_major, e.cpu_model, e.cpu_threads, e.os_name
         FROM capture c
         JOIN season   s ON s.id = c.season_id
         JOIN revision r ON r.id = c.revision_id
         JOIN environment e ON e.id = s.environment_id
        WHERE c.server_id = ? AND s.environment_id = ?
        ORDER BY c.started_at DESC, c.id DESC
        LIMIT 1`,
    )
    .get(serverId, environmentId) as
    | {
        id: number;
        heap_max_mb: number | null;
        mc_version: string;
        loader_name: string;
        loader_version: string;
        java_major: string;
        cpu_model: string;
        cpu_threads: number | null;
        os_name: string;
      }
    | undefined;

  if (row === undefined) return undefined;

  const mods = store.db
    .prepare('SELECT m.mod_id AS id, cm.version AS version FROM capture_mod cm JOIN mod m ON m.id = cm.mod WHERE cm.capture_id = ? ORDER BY m.mod_id')
    .all(row.id) as Array<{ id: string; version: string }>;

  return {
    minecraftVersion: row.mc_version,
    loaderName: row.loader_name,
    loaderVersion: row.loader_version,
    javaVersion: '',
    javaMajor: row.java_major,
    heapMaxMb: row.heap_max_mb ?? undefined,
    cpuModel: row.cpu_model,
    cpuThreads: row.cpu_threads ?? undefined,
    osName: row.os_name,
    mods,
    modCount: mods.length,
    // Recomputed by the caller's comparison, not used for identity here.
    modSetHash: '',
    modIdSetHash: '',
    // Revision boundaries read flags from the revision row, not from here.
    runtimeFlags: undefined,
  };
}
