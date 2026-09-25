/**
 * Database access.
 *
 * Uses Node's built-in `node:sqlite`, so there is no native dependency to
 * compile or keep working across Node upgrades -- a real consideration for
 * something meant to run untouched for years while modpacks rotate around it.
 *
 * Measured at ~1.8M inserts/second, which is comfortably ahead of what an
 * hourly capture needs.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';
import { ensureRollupTables, hasActivityRollups } from './rollups.ts';

export interface StoreOptions {
  /** Path to the SQLite file. Parent directories are created if needed. */
  file: string;
}

export interface WorldRow {
  id: number;
  server_id: string;
  fingerprint: string;
  strength: string;
  seed: string | null;
  level_name: string | null;
  level_type: string | null;
  datapack_hash: string | null;
  label: string | null;
  first_seen: number;
  last_seen: number;
}

export interface BoundaryQuestionRow {
  id: number;
  server_id: string;
  capture_id: number | null;
  season_id: number | null;
  kind: string;
  question: string;
  detail: string;
  /** JSON array of { id, label, description }. */
  options: string;
  created_at: number;
  answered_at: number | null;
  answer: string | null;
  applied_at: number | null;
}

export class Store {
  readonly db: DatabaseSync;
  /**
   * The folder holding the database. Every file path stored in it is
   * relative to this, so the whole data folder can be moved -- from a
   * checkout into an installed app's AppData, or onto another drive --
   * without any row pointing into the void.
   */
  readonly dataDir: string;
  // Prepared once; these run once per call path per capture.
  #pathInsertStmt: ReturnType<DatabaseSync['prepare']> | undefined;
  #pathSelectStmt: ReturnType<DatabaseSync['prepare']> | undefined;
  #pathTouchStmt: ReturnType<DatabaseSync['prepare']> | undefined;

  get #pathInsert() {
    return (this.#pathInsertStmt ??= this.db.prepare(
      `INSERT INTO path (parent_id, frame_id, depth, source_mod, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(parent_id, frame_id) DO NOTHING`,
    ));
  }

  get #pathSelect() {
    return (this.#pathSelectStmt ??= this.db.prepare('SELECT id FROM path WHERE parent_id = ? AND frame_id = ?'));
  }

  get #pathTouch() {
    return (this.#pathTouchStmt ??= this.db.prepare('UPDATE path SET last_seen = MAX(last_seen, ?) WHERE id = ?'));
  }

  constructor(options: StoreOptions) {
    if (options.file !== ':memory:') {
      mkdirSync(path.dirname(options.file), { recursive: true });
    }
    this.dataDir = options.file === ':memory:' ? process.cwd() : path.dirname(path.resolve(options.file));
    this.db = new DatabaseSync(options.file);
    this.db.exec(SCHEMA_SQL);
    // The day and season roll-ups, split by activity (store/rollups.ts).
    ensureRollupTables(this.db);

    this.#migrate();
    // After migration: an older database gains capture.boot_id there.
    this.db.exec('CREATE INDEX IF NOT EXISTS capture_by_boot ON capture (boot_id)');
  }

  /**
   * Bring an existing database up to the current schema.
   *
   * Re-running SCHEMA_SQL adds new TABLES, because every statement in it is
   * `IF NOT EXISTS`. It does **not** add new COLUMNS to a table that already
   * exists -- `CREATE TABLE IF NOT EXISTS` is a no-op in that case, silently.
   *
   * That distinction cost a broken upgrade once: `season.world_id` was added
   * to the schema, worked perfectly on a fresh database, and did not exist at
   * all on an existing one, so ingest failed with "no such column". Every
   * added column now goes through `#addColumn` below.
   *
   * A database from a NEWER build is refused outright rather than risked.
   */
  #migrate(): void {
    const current = this.getMeta('schema_version');
    if (current === undefined) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      return;
    }

    const from = Number(current);
    if (from === SCHEMA_VERSION) return;
    if (from > SCHEMA_VERSION) {
      throw new Error(
        `database schema is version ${from}, newer than this build (${SCHEMA_VERSION}). ` +
          'Refusing to open it rather than risk corrupting history.',
      );
    }

    // v3 introduced path_rollup, which is pure derived data.
    if (from < 3) this.rebuildRollup();

    // v4 added the optimization register; those are whole tables, so the
    // CREATE statements above made them.

    // v5 added world identity. The `world` and `boundary_question` tables
    // come from the CREATE statements, but `season.world_id` is a new column
    // on an existing table and has to be added explicitly.
    //
    // Existing seasons keep a NULL world_id deliberately: the world they
    // measured is genuinely not known, and backfilling a guess would put a
    // fabrication in the one place this system promises not to. They stay
    // fully queryable.
    if (from < 5) this.#addColumn('season', 'world_id', 'INTEGER REFERENCES world(id)');

    // v6 added world_sighting, which is a whole table, so the CREATE
    // statements made it. Existing captures gain no sightings: when they
    // were taken is known, but which world was live then is not, and that
    // is recorded as not-known rather than inferred.
    if (from < 6) this.#addColumn('capture', 'world_id', 'INTEGER REFERENCES world(id)');

    // v7: stored file paths become relative to the DATA folder rather than to
    // whatever the working directory happened to be at ingest.
    //
    // Found when the archive was moved into an installed app: every path read
    // "data\archive\...", which only resolved because the checkout's working
    // directory happened to contain a "data" folder. From the installed app's
    // directory all thirty were missing, and the A/B validator -- which reads
    // these files -- would have silently found no observations and reported
    // "inconclusive" for every change ever made.
    //
    // The rewrite is deterministic, not a guess: such paths were only ever
    // produced by the default archive location "data/archive", so stripping
    // that one leading "data" segment makes them relative to the folder the
    // database lives in. Absolute paths are left exactly as they are.
    if (from < 7) {
      for (const column of ['sidecar_path', 'archive_path']) {
        this.db.exec(
          `UPDATE capture SET ${column} = substr(${column}, 6)
            WHERE ${column} LIKE 'data\\%' OR ${column} LIKE 'data/%'`,
        );
      }
    }

    // v8: a tracked change can point at the mod-set revision it came from.
    if (from < 8) this.#addColumn('optimization', 'revision_id', 'INTEGER REFERENCES revision(id)');

    // v9: revisions record the JVM flags they ran with, so a flag-only
    // restart becomes a visible boundary. Existing revisions stay NULL
    // (unknown) and are filled in from the next capture that states them.
    if (from < 9) this.#addColumn('revision', 'runtime_flags', 'TEXT');

    // v10: the daily ledger recorded ticks as the MAX of a day's captures
    // while adding their time, overstating ms/tick on any day with more than
    // one capture (see ingest/ledger.ts). No column changes; the ledger is
    // recomputed from each capture's sidecar. That needs the sidecar reader,
    // which the store deliberately does not depend on, so the migration only
    // records that it is owed and the collector performs it at startup,
    // after a backup, before it serves anything.
    if (from < 10) this.setMeta('ledger.rebuildPending', 'v10: daily ticks were MAX, not SUM');

    // v11: restoring background profiling saved a seconds-long file that was
    // archived as a capture. Those are taken out at the next collector start
    // (files kept in backups), followed by a ledger rebuild.
    if (from < 11) this.setMeta('captures.forgetStubsPending', 'v11: restore stubs were archived as captures');

    // v12: each server carries its own configuration and collection mode.
    // Existing servers take over what the global settings said, so nothing
    // changes on upgrade: the server that was being harvested still is.
    if (from < 12) {
      for (const [column, definition] of [
        ['kind', "TEXT NOT NULL DEFAULT 'production'"],
        ['machine', "TEXT NOT NULL DEFAULT ''"],
        ['root', "TEXT NOT NULL DEFAULT ''"],
        ['spark_dir', "TEXT NOT NULL DEFAULT 'config/spark'"],
        ['collection', "TEXT NOT NULL DEFAULT 'off'"],
        ['ssh_host', "TEXT NOT NULL DEFAULT ''"],
        ['tmux_target', "TEXT NOT NULL DEFAULT ''"],
        ['mc_host', "TEXT NOT NULL DEFAULT ''"],
        ['mc_port', 'INTEGER NOT NULL DEFAULT 25565'],
        ['visible', 'INTEGER NOT NULL DEFAULT 1'],
      ] as const) {
        this.#addColumn('server', column, definition);
      }
      this.#carryServerSettings();
    }

    // v13: spark omits a count of zero, so minutes with nobody online were
    // stored with no player count and treated as unknown. A window spark did
    // write (it has a median) with no count had zero. Idempotent.
    if (from < 13) {
      this.db.exec(`UPDATE capture_window SET players = 0 WHERE players IS NULL AND mspt_median IS NOT NULL;
                    UPDATE capture_window SET entities = 0 WHERE entities IS NULL AND mspt_median IS NOT NULL;
                    UPDATE capture_window SET tile_entities = 0 WHERE tile_entities IS NULL AND mspt_median IS NOT NULL;
                    UPDATE capture_window SET chunks = 0 WHERE chunks IS NULL AND mspt_median IS NOT NULL;`);
    }

    // v14: the day and season roll-ups are split by who was online. No change
    // here: the collector rebuilds them in the background and swaps them in
    // (store/rollups.ts). The version stops an older build writing rows of the
    // old shape into the new tables.

    // v15: boots (JVM runs) and exact method keys. The tables come from the
    // CREATE statements; existing captures get their boot and keys in the
    // background from the raw files still kept (ingest/identity.ts), and stay
    // NULL -- unknown -- where there is none.
    if (from < 15) this.#addColumn('capture', 'boot_id', 'INTEGER REFERENCES boot(id)');

    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  /**
   * Copy the old global server settings onto every existing server (there was
   * only ever one). Read straight from the settings table, which may not
   * exist yet on a database that never had settings; defaults apply then.
   */
  #carryServerSettings(): void {
    const read = (key: string, fallback: string | number | boolean): string | number | boolean => {
      try {
        const row = this.db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined;
        return row === undefined ? fallback : (JSON.parse(row.value) as string | number | boolean);
      } catch {
        return fallback;
      }
    };
    const harvesting = read('collection.harvest.enabled', false) === true;
    this.db
      .prepare(
        `UPDATE server SET root = ?, spark_dir = ?, ssh_host = ?, tmux_target = ?, mc_host = ?, mc_port = ?,
                           collection = ?, kind = 'production'`,
      )
      .run(
        String(read('server.source.root', '')),
        String(read('server.source.sparkDir', 'config/spark')),
        String(read('server.control.sshHost', '')),
        String(read('server.control.tmuxTarget', '')),
        String(read('server.minecraft.host', '127.0.0.1')),
        Number(read('server.minecraft.port', 25565)),
        harvesting ? 'automatic' : 'off',
      );
  }

  /**
   * Add a column if it is not already there.
   *
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the column list is checked
   * first. Idempotent, so running a migration twice is harmless -- which
   * matters because a half-applied migration is the worst possible state for
   * an archive meant to outlive several modpack rotations.
   */
  #addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /**
   * Turn a stored file path into one that can be opened.
   *
   * Absolute paths are used as they are. Relative ones are resolved against
   * the data folder -- never against the working directory, which differs
   * between a checkout, an installed app and a test run.
   */
  resolveDataPath(stored: string | null | undefined): string | undefined {
    if (stored === null || stored === undefined || stored === '') return undefined;
    return path.isAbsolute(stored) ? stored : path.join(this.dataDir, stored);
  }

  /** The inverse: how to store a path so the data folder stays portable. */
  toStoredPath(absolute: string): string {
    const relative = path.relative(this.dataDir, absolute);
    // Outside the data folder (a different drive, or ../ upwards) stays absolute.
    return relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative;
  }

  /** Recompute path_rollup from the daily ledger. Safe to run at any time. */
  rebuildRollup(): void {
    this.db.exec('DELETE FROM path_rollup');
    const totals = `sum(self_ms), sum(total_ms), sum(ticks), sum(self_ms) / max(sum(ticks), 1),
             sum(windows_present), sum(windows_total), count(DISTINCT day), max(day), sum(captures_present)`;
    if (!hasActivityRollups(this.db)) {
      this.db.exec(`
        INSERT INTO path_rollup
          (season_id, path_id, category, self_ms, total_ms, ticks, ms_per_tick,
           windows_present, windows_total, days, last_day, captures)
        SELECT season_id, path_id, category, ${totals}
          FROM path_daily GROUP BY season_id, path_id, category`);
      return;
    }
    const columns = `(season_id, path_id, category, activity, self_ms, total_ms, ticks, ms_per_tick,
           windows_present, windows_total, days, last_day, captures)`;
    this.db.exec(`
      INSERT INTO path_rollup ${columns}
      SELECT season_id, path_id, category, activity, ${totals}
        FROM path_daily GROUP BY season_id, path_id, category, activity;
      INSERT INTO path_rollup ${columns}
      SELECT season_id, path_id, category, 'all', ${totals}
        FROM path_daily GROUP BY season_id, path_id, category`);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Runs `fn` inside a transaction, rolling back on any throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    }
  }

  // --- servers -------------------------------------------------------------

  upsertServer(id: string, slug: string, displayName: string): void {
    this.db
      .prepare(
        `INSERT INTO server (id, slug, display_name, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, display_name = excluded.display_name`,
      )
      .run(id, slug, displayName, Date.now());
  }

  /**
   * The server to attribute something to when the caller has not said.
   *
   * Every table is keyed by server from day one, so multi-server costs
   * nothing later, but the interface is single-server until there is a
   * switcher. Undefined means nothing has been ingested yet.
   */
  firstServerId(): string | undefined {
    const row = this.db.prepare('SELECT id FROM server ORDER BY created_at, id LIMIT 1').get() as
      | { id: string }
      | undefined;
    return row?.id;
  }

  // --- worlds --------------------------------------------------------------

  /**
   * Record a world, or refresh what is known about one.
   *
   * Keyed on the fingerprint, so the same seed always resolves to the same
   * row and a reset creates a new one. A weak identity that later gains a
   * seed becomes a DIFFERENT row rather than being upgraded in place: the two
   * cannot be proven to be the same world, and silently merging them would
   * assert something unproven.
   */
  upsertWorld(input: {
    serverId: string;
    fingerprint: string;
    strength: string;
    seed?: string | undefined;
    levelName?: string | undefined;
    levelType?: string | undefined;
    datapackHash?: string | undefined;
    seenAt: number;
  }): number {
    const existing = this.db
      .prepare('SELECT id FROM world WHERE server_id = ? AND fingerprint = ?')
      .get(input.serverId, input.fingerprint) as { id: number } | undefined;

    if (existing !== undefined) {
      this.db
        .prepare('UPDATE world SET first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?) WHERE id = ?')
        .run(input.seenAt, input.seenAt, existing.id);
      return existing.id;
    }

    this.db
      .prepare(
        `INSERT INTO world (server_id, fingerprint, strength, seed, level_name, level_type,
                            datapack_hash, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.serverId,
        input.fingerprint,
        input.strength,
        input.seed ?? null,
        input.levelName ?? null,
        input.levelType ?? null,
        input.datapackHash ?? null,
        input.seenAt,
        input.seenAt,
      );
    return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get()!['id']);
  }

  getWorld(id: number): WorldRow | undefined {
    return this.db.prepare('SELECT * FROM world WHERE id = ?').get(id) as unknown as WorldRow | undefined;
  }

  worlds(serverId?: string): WorldRow[] {
    return (
      serverId === undefined
        ? this.db.prepare('SELECT * FROM world ORDER BY last_seen DESC').all()
        : this.db.prepare('SELECT * FROM world WHERE server_id = ? ORDER BY last_seen DESC').all(serverId)
    ) as unknown as WorldRow[];
  }

  /** Give a world the name its owner calls it. Never generated. */
  nameWorld(id: number, label: string): void {
    this.db.prepare('UPDATE world SET label = ? WHERE id = ?').run(label, id);
  }

  /** Give a season a name. Also never generated. */
  nameSeason(id: number, label: string): void {
    this.db.prepare('UPDATE season SET label = ? WHERE id = ?').run(label, id);
  }

  /** The season currently in progress for one environment and world. */
  latestSeasonForWorld(
    serverId: string,
    environmentId: number,
    worldId: number | undefined,
  ): { id: number; ordinal: number } | undefined {
    return this.db
      .prepare(
        `SELECT id, ordinal FROM season
          WHERE server_id = ? AND environment_id = ?
            AND (world_id IS ? OR ? IS NULL)
          ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(serverId, environmentId, worldId ?? null, worldId ?? null) as
      | { id: number; ordinal: number }
      | undefined;
  }

  setSeasonWorld(seasonId: number, worldId: number): void {
    this.db.prepare('UPDATE season SET world_id = ? WHERE id = ?').run(worldId, seasonId);
  }

  /** Record that a world was observed live at a moment in time. */
  recordWorldSighting(serverId: string, worldId: number, seenAt: number, source: string): void {
    // One reading per world per minute is plenty; a probe every cycle would
    // otherwise fill the table with identical rows.
    const recent = this.db
      .prepare(
        `SELECT id FROM world_sighting
          WHERE server_id = ? AND world_id = ? AND seen_at > ?
          ORDER BY seen_at DESC LIMIT 1`,
      )
      .get(serverId, worldId, seenAt - 60_000) as { id: number } | undefined;
    if (recent !== undefined) return;

    this.db
      .prepare('INSERT INTO world_sighting (server_id, world_id, seen_at, source) VALUES (?,?,?,?)')
      .run(serverId, worldId, seenAt, source);
  }

  /**
   * Which world was live at a given moment.
   *
   * Answers confidently only when readings on BOTH sides of the moment agree,
   * or when the only reading available is on the same side and no change has
   * been observed since. A moment that falls between two different worlds is
   * explicitly unattributable: the capture was taken during a window in which
   * the world changed, and picking either end would be a guess.
   */
  worldAt(serverId: string, at: number): { worldId: number; confident: boolean; reason: string } | undefined {
    const before = this.db
      .prepare(
        `SELECT world_id, seen_at FROM world_sighting
          WHERE server_id = ? AND seen_at <= ? ORDER BY seen_at DESC LIMIT 1`,
      )
      .get(serverId, at) as { world_id: number; seen_at: number } | undefined;

    const after = this.db
      .prepare(
        `SELECT world_id, seen_at FROM world_sighting
          WHERE server_id = ? AND seen_at >= ? ORDER BY seen_at ASC LIMIT 1`,
      )
      .get(serverId, at) as { world_id: number; seen_at: number } | undefined;

    if (before === undefined && after === undefined) return undefined;

    if (before !== undefined && after !== undefined) {
      if (before.world_id === after.world_id) {
        return {
          worldId: before.world_id,
          confident: true,
          reason: 'the same world was observed both before and after this capture',
        };
      }
      return {
        worldId: before.world_id,
        confident: false,
        reason:
          'the world changed between the reading before this capture and the reading after it, ' +
          'so which one it measured cannot be established from the timeline alone',
      };
    }

    if (after !== undefined) {
      // The capture predates every reading. Common for a back-filled archive.
      return {
        worldId: after.world_id,
        confident: false,
        reason:
          'this capture predates every world reading, so the world live at the time was never observed',
      };
    }

    return {
      worldId: before!.world_id,
      confident: true,
      reason: 'the most recent world reading precedes this capture and nothing has changed since',
    };
  }

  /** Record flags on a revision that predates flag tracking. */
  setRevisionRuntimeFlags(revisionId: number, flags: readonly string[]): void {
    this.db.prepare('UPDATE revision SET runtime_flags = ? WHERE id = ?').run(JSON.stringify(flags), revisionId);
  }

  setCaptureWorld(captureId: number, worldId: number | undefined): void {
    this.db.prepare('UPDATE capture SET world_id = ? WHERE id = ?').run(worldId ?? null, captureId);
  }

  // --- questions -----------------------------------------------------------

  /**
   * Record something the system will not decide on its own.
   *
   * Deduplicated on (kind, detail) while unanswered, so a condition that
   * persists across many captures asks once rather than accumulating an
   * unreadable pile of identical questions.
   */
  askBoundaryQuestion(input: {
    serverId: string;
    captureId?: number | undefined;
    seasonId?: number | undefined;
    kind: string;
    question: string;
    detail: string;
    options: ReadonlyArray<{ id: string; label: string; description: string }>;
  }): number {
    const duplicate = this.db
      .prepare(
        `SELECT id FROM boundary_question
          WHERE server_id = ? AND kind = ? AND detail = ? AND answered_at IS NULL`,
      )
      .get(input.serverId, input.kind, input.detail) as { id: number } | undefined;
    if (duplicate !== undefined) return duplicate.id;

    this.db
      .prepare(
        `INSERT INTO boundary_question
           (server_id, capture_id, season_id, kind, question, detail, options, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.serverId,
        input.captureId ?? null,
        input.seasonId ?? null,
        input.kind,
        input.question,
        input.detail,
        JSON.stringify(input.options),
        Date.now(),
      );
    return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get()!['id']);
  }

  openQuestions(serverId?: string): BoundaryQuestionRow[] {
    return (
      serverId === undefined
        ? this.db.prepare('SELECT * FROM boundary_question WHERE answered_at IS NULL ORDER BY created_at').all()
        : this.db
            .prepare('SELECT * FROM boundary_question WHERE server_id = ? AND answered_at IS NULL ORDER BY created_at')
            .all(serverId)
    ) as unknown as BoundaryQuestionRow[];
  }

  answerQuestion(id: number, answer: string): void {
    this.db
      .prepare('UPDATE boundary_question SET answer = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL')
      .run(answer, Date.now(), id);
  }

  markQuestionApplied(id: number): void {
    this.db.prepare('UPDATE boundary_question SET applied_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // --- environments --------------------------------------------------------

  upsertEnvironment(input: {
    serverId: string;
    envKey: string;
    mcVersion: string;
    loaderName: string;
    loaderVersion: string;
    javaMajor: string;
    cpuModel: string;
    cpuThreads: number | undefined;
    osName: string;
    seenAt: number;
  }): number {
    const existing = this.db
      .prepare('SELECT id FROM environment WHERE server_id = ? AND env_key = ?')
      .get(input.serverId, input.envKey) as { id: number } | undefined;

    if (existing !== undefined) {
      this.db
        .prepare(
          `UPDATE environment
             SET first_seen = MIN(first_seen, ?), last_seen = MAX(last_seen, ?)
           WHERE id = ?`,
        )
        .run(input.seenAt, input.seenAt, existing.id);
      return existing.id;
    }

    this.db
      .prepare(
        `INSERT INTO environment
           (server_id, env_key, mc_version, loader_name, loader_version, java_major,
            cpu_model, cpu_threads, os_name, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.serverId,
        input.envKey,
        input.mcVersion,
        input.loaderName,
        input.loaderVersion,
        input.javaMajor,
        input.cpuModel,
        input.cpuThreads ?? null,
        input.osName,
        input.seenAt,
        input.seenAt,
      );
    return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get()!['id']);
  }

  // --- seasons and revisions ----------------------------------------------

  latestSeason(serverId: string, environmentId: number): { id: number; ordinal: number } | undefined {
    return this.db
      .prepare(
        `SELECT id, ordinal FROM season
          WHERE server_id = ? AND environment_id = ?
          ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(serverId, environmentId) as { id: number; ordinal: number } | undefined;
  }

  createSeason(input: {
    serverId: string;
    environmentId: number;
    ordinal: number;
    startedAt: number;
    reason: string;
    confirmed: boolean;
  }): number {
    this.db
      .prepare(
        `INSERT INTO season (server_id, environment_id, ordinal, started_at, reason, confirmed)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.serverId,
        input.environmentId,
        input.ordinal,
        input.startedAt,
        input.reason,
        input.confirmed ? 1 : 0,
      );
    return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get()!['id']);
  }

  latestRevision(
    seasonId: number,
  ): { id: number; ordinal: number; mod_set_hash: string; runtime_flags: string | null } | undefined {
    return this.db
      .prepare(
        'SELECT id, ordinal, mod_set_hash, runtime_flags FROM revision WHERE season_id = ? ORDER BY ordinal DESC LIMIT 1',
      )
      .get(seasonId) as { id: number; ordinal: number; mod_set_hash: string; runtime_flags: string | null } | undefined;
  }

  createRevision(input: {
    seasonId: number;
    ordinal: number;
    modSetHash: string;
    runtimeFlags?: string[] | undefined;
    heapMaxMb: number | undefined;
    startedAt: number;
    reason: string;
    added: number;
    removed: number;
    changed: number;
  }): number {
    this.db
      .prepare(
        `INSERT INTO revision
           (season_id, ordinal, mod_set_hash, runtime_flags, heap_max_mb, started_at, reason,
            mods_added, mods_removed, mods_changed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.seasonId,
        input.ordinal,
        input.modSetHash,
        input.runtimeFlags === undefined ? null : JSON.stringify(input.runtimeFlags),
        input.heapMaxMb ?? null,
        input.startedAt,
        input.reason,
        input.added,
        input.removed,
        input.changed,
      );
    return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get()!['id']);
  }

  // --- captures ------------------------------------------------------------

  captureBySha(sha256: string): { id: number } | undefined {
    return this.db.prepare('SELECT id FROM capture WHERE content_sha256 = ?').get(sha256) as
      | { id: number }
      | undefined;
  }

  // --- frames and the call-path tree --------------------------------------

  /**
   * In-memory caches, held for the lifetime of the Store.
   *
   * Captures overlap heavily -- consecutive hours share nearly all of their
   * call tree -- so caching edge lookups turns most of ingest into pure
   * memory work. Without this, interning was the dominant cost.
   */
  #frameCache = new Map<string, number>();
  #pathCache = new Map<string, number>();

  internFrame(label: string, className: string, methodName: string): number {
    const cached = this.#frameCache.get(label);
    if (cached !== undefined) return cached;

    this.db
      .prepare('INSERT INTO frame (label, class_name, method_name) VALUES (?, ?, ?) ON CONFLICT(label) DO NOTHING')
      .run(label, className, methodName);
    const row = this.db.prepare('SELECT id FROM frame WHERE label = ?').get(label) as { id: number };
    this.#frameCache.set(label, row.id);
    return row.id;
  }

  /**
   * Resolve one edge of the call-path tree, creating it if new.
   *
   * `parentId` is 0 for a thread root. The (parent, frame) pair is the natural
   * identity of a path, which is what makes prefix sharing free.
   */
  internPathEdge(input: {
    parentId: number;
    frameId: number;
    depth: number;
    source: string | null;
    seenAt: number;
  }): number {
    const key = `${input.parentId}:${input.frameId}`;
    const cached = this.#pathCache.get(key);
    if (cached !== undefined) {
      this.#pathTouch.run(input.seenAt, cached);
      return cached;
    }

    this.#pathInsert.run(
      input.parentId,
      input.frameId,
      input.depth,
      input.source,
      input.seenAt,
      input.seenAt,
    );
    const row = this.#pathSelect.get(input.parentId, input.frameId) as { id: number };
    this.#pathCache.set(key, row.id);
    return row.id;
  }

  /** Reconstructs a path's full text by walking parent links. */
  pathText(pathId: number): string {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE up(id, parent_id, frame_id, depth) AS (
           SELECT id, parent_id, frame_id, depth FROM path WHERE id = ?
           UNION ALL
           SELECT p.id, p.parent_id, p.frame_id, p.depth
             FROM path p JOIN up ON p.id = up.parent_id
         )
         SELECT f.label AS label, up.depth AS depth
           FROM up JOIN frame f ON f.id = up.frame_id
          ORDER BY up.depth ASC`,
      )
      .all(pathId) as Array<{ label: string; depth: number }>;
    return rows.map((r) => r.label).join(' > ');
  }

  // --- audit ---------------------------------------------------------------

  recordAction(input: {
    serverId: string;
    action: string;
    target?: string;
    sha256?: string;
    dryRun: boolean;
    outcome: string;
    detail?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO server_action (server_id, at, action, target, sha256, dry_run, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.serverId,
        Date.now(),
        input.action,
        input.target ?? null,
        input.sha256 ?? null,
        input.dryRun ? 1 : 0,
        input.outcome,
        input.detail ?? null,
      );
  }
}
