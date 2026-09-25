/**
 * SQLite schema.
 *
 * Sizing comes from measuring the real archive (`measure-storage`), not from
 * estimates. At the background profiler's 10 ms interval one hourly capture
 * holds roughly 80-120k distinct call paths. Storing every one of those per
 * capture would be ~2M rows/day and ~170M over a 90-day window, which SQLite
 * would carry but which buys little: the per-capture, per-window detail is
 * only needed for forensics and A/B, and is far better served by a compressed
 * sidecar (measured at ~3 MB/hour, ~27 GB/year).
 *
 * So the split is:
 *
 *   SQLite   -- everything you query: servers, environments, seasons,
 *               revisions, captures, per-minute window statistics, the mod
 *               set over time, and the permanent per-path DAILY ledger.
 *   Sidecar  -- per-capture, per-path, per-window detail, zstd-compressed,
 *               loaded on demand.
 *
 * Naming: no table, column or identifier here contains the product's public
 * name. Renaming the application must never touch stored data.
 *
 * Identity: servers are UUIDs. Display names are cosmetic and live in their
 * own column so they can change freely without orphaning history.
 */

export const SCHEMA_VERSION = 16;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A monitored server. The id is frozen for the lifetime of the history; the
-- server can be renamed, moved to another host, or change transport freely.
CREATE TABLE IF NOT EXISTS server (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  -- Per-server configuration (v12). See store/servers.ts.
  kind         TEXT NOT NULL DEFAULT 'production',
  machine      TEXT NOT NULL DEFAULT '',
  root         TEXT NOT NULL DEFAULT '',
  spark_dir    TEXT NOT NULL DEFAULT 'config/spark',
  collection   TEXT NOT NULL DEFAULT 'off',
  ssh_host     TEXT NOT NULL DEFAULT '',
  tmux_target  TEXT NOT NULL DEFAULT '',
  mc_host      TEXT NOT NULL DEFAULT '',
  mc_port      INTEGER NOT NULL DEFAULT 25565,
  visible      INTEGER NOT NULL DEFAULT 1
);

-- A distinct machine/platform. Captures are grouped by this BEFORE seasons are
-- detected, because production and test servers interleave by date and
-- sequencing them invents season rollovers that never happened.
CREATE TABLE IF NOT EXISTS environment (
  id             INTEGER PRIMARY KEY,
  server_id      TEXT NOT NULL REFERENCES server(id),
  env_key        TEXT NOT NULL,
  mc_version     TEXT NOT NULL,
  loader_name    TEXT NOT NULL,
  loader_version TEXT NOT NULL,
  java_major     TEXT NOT NULL,
  cpu_model      TEXT NOT NULL,
  cpu_threads    INTEGER,
  os_name        TEXT NOT NULL,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  UNIQUE (server_id, env_key)
);

-- A span within which aggregate MSPT is comparable. Crossing a season
-- boundary means the numbers are not comparable and the UI must not compare
-- them. the label column is a human annotation: a capture does NOT record the modpack
-- name or version, so it cannot be derived.
CREATE TABLE IF NOT EXISTS season (
  id             INTEGER PRIMARY KEY,
  server_id      TEXT NOT NULL REFERENCES server(id),
  environment_id INTEGER NOT NULL REFERENCES environment(id),
  -- The world this season measures. NULL for seasons recorded before world
  -- identity was tracked; those stay valid, they simply cannot claim which
  -- world they belonged to.
  world_id       INTEGER REFERENCES world(id),
  ordinal        INTEGER NOT NULL,
  label          TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  reason         TEXT NOT NULL,
  confirmed      INTEGER NOT NULL DEFAULT 0,
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS season_by_server ON season (server_id, started_at);

-- A distinct WORLD.
--
-- The largest uncontrolled variable in a modded server's tick time, and the
-- one spark cannot report. A fresh world has almost no loaded chunks, no
-- entity backlog, no farms and no stored items; measuring it against a world
-- people have lived in for six weeks compares an empty house to a full one.
--
-- Identified by seed where the server directory is readable, and by level
-- name/type/datapacks otherwise. the strength column records which, because the two
-- support very different conclusions: a seed change is a fact, a name change
-- is a question.
CREATE TABLE IF NOT EXISTS world (
  id            INTEGER PRIMARY KEY,
  server_id     TEXT    NOT NULL REFERENCES server(id),
  fingerprint   TEXT    NOT NULL,
  -- seed | name | none
  strength      TEXT    NOT NULL,
  seed          TEXT,
  level_name    TEXT,
  level_type    TEXT,
  datapack_hash TEXT,
  -- What the user calls it, e.g. "Spring World 2". Never invented.
  label         TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  UNIQUE (server_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS world_by_server ON world (server_id, last_seen);

-- When each world was observed to be the live one.
--
-- World identity is read from level.dat, which only ever answers "which world
-- is loaded RIGHT NOW". That is not the same question as "which world did
-- this capture measure", and conflating them is wrong in a specific and
-- likely way: harvest a profile at 14:00, reset the world at 15:00, ingest
-- the backlog at 16:00, and every one of those captures gets filed under the
-- new world. The measurements would be real and attributed to a world that
-- did not exist when they were taken.
--
-- So each reading is stamped with when it was taken, and a capture is
-- attributed to the world that was live at ITS OWN start time. A capture that
-- falls across a change, or before any reading, is not attributed at all --
-- it becomes a question.
CREATE TABLE IF NOT EXISTS world_sighting (
  id        INTEGER PRIMARY KEY,
  server_id TEXT    NOT NULL REFERENCES server(id),
  world_id  INTEGER NOT NULL REFERENCES world(id),
  seen_at   INTEGER NOT NULL,
  -- probe | ingest | harvest
  source    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS sighting_by_time ON world_sighting (server_id, seen_at);

-- Something changed that the system will not act on without being told.
--
-- The whole design prefers "unknown" to a guess, and this is where that
-- preference becomes visible rather than silent: a boundary it cannot
-- confirm is recorded as a question with its evidence and its options, and
-- nothing is split until it is answered. Unanswered questions are surfaced
-- in the interface; they never expire and never resolve themselves.
CREATE TABLE IF NOT EXISTS boundary_question (
  id          INTEGER PRIMARY KEY,
  server_id   TEXT    NOT NULL REFERENCES server(id),
  capture_id  INTEGER REFERENCES capture(id) ON DELETE CASCADE,
  season_id   INTEGER REFERENCES season(id),
  -- world-suspected | world-unknown | season-unconfirmed
  kind        TEXT    NOT NULL,
  question    TEXT    NOT NULL,
  detail      TEXT    NOT NULL,
  -- JSON array of { id, label, description }
  options     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  answered_at INTEGER,
  answer      TEXT,
  -- Set once acted on, so an answer cannot be applied twice.
  applied_at  INTEGER
);
CREATE INDEX IF NOT EXISTS question_open ON boundary_question (server_id, answered_at);

-- The mod set moved within a season. Kept as a covariate so a regression can
-- be attributed to a specific change rather than to "the season".
CREATE TABLE IF NOT EXISTS revision (
  id           INTEGER PRIMARY KEY,
  season_id    INTEGER NOT NULL REFERENCES season(id),
  ordinal      INTEGER NOT NULL,
  mod_set_hash TEXT NOT NULL,
  -- JSON array of the -X JVM flags this revision ran with. NULL when not
  -- recorded, which means unknown -- never "no flags".
  runtime_flags  TEXT,
  heap_max_mb  INTEGER,
  started_at   INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  mods_added   INTEGER NOT NULL DEFAULT 0,
  mods_removed INTEGER NOT NULL DEFAULT 0,
  mods_changed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS revision_by_season ON revision (season_id, ordinal);

-- One harvested or manually taken profile.
CREATE TABLE IF NOT EXISTS capture (
  id                  INTEGER PRIMARY KEY,
  server_id           TEXT NOT NULL REFERENCES server(id),
  season_id           INTEGER NOT NULL REFERENCES season(id),
  revision_id         INTEGER NOT NULL REFERENCES revision(id),

  -- sha256 of the raw file. The dedup key: re-ingesting is a no-op.
  content_sha256      TEXT NOT NULL UNIQUE,
  source_name         TEXT NOT NULL,
  archive_path        TEXT,
  sidecar_path        TEXT,
  raw_bytes           INTEGER NOT NULL,

  started_at          INTEGER,
  ended_at            INTEGER,
  interval_micros     INTEGER,
  number_of_ticks     INTEGER,
  divisor_ticks       INTEGER,
  window_count        INTEGER NOT NULL,
  path_count          INTEGER NOT NULL,

  -- Recorded, never guessed. spark 1.10.53 omits mode/engine entirely, so
  -- NULL here means "the capture did not say", not "Java".
  sampler_mode        TEXT,
  sampler_engine      TEXT,
  -- Heuristic: native frames imply async-profiler even when the field is absent.
  engine_inferred     TEXT,
  mappings_source     TEXT,

  -- Headline figures, all ms/tick. NULL when mappings were unavailable, since
  -- the tick anchor cannot be located and nothing may be invented.
  tick_ms_per_tick         REAL,
  idle_ms_per_tick         REAL,
  blocked_ms_per_tick      REAL,
  between_tick_ms_per_tick REAL,
  wall_ms_per_tick         REAL,
  unclassified_ms_per_tick REAL,

  -- Which world this capture measured, when the timeline could place it
  -- confidently. NULL means "not known", never "the current one".
  world_id            INTEGER REFERENCES world(id),

  -- The JVM run it came from (v15). NULL when the capture did not say
  -- (no uptime), never guessed. Indexed in store/db.ts, after migration.
  boot_id             INTEGER REFERENCES boot(id),

  is_manual           INTEGER NOT NULL DEFAULT 0,
  pinned              INTEGER NOT NULL DEFAULT 0,
  pinned_reason       TEXT,
  ingested_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS capture_by_time   ON capture (server_id, started_at);
CREATE INDEX IF NOT EXISTS capture_by_season ON capture (season_id, started_at);

-- One JVM run of a server (v15).
--
-- Fabric loads its jars once, at JVM start, so "which jars were loaded" is a
-- property of the boot, not of a capture or of a revision (a revision is a run
-- of one mod-id/version set in INGESTION order, and cannot see a jar rebuilt
-- under the same version). spark samples the JVM uptime when it saves a
-- profile, so the start is endTime - uptime; measured constant to the second
-- across every capture of one boot (ingest/identity.ts).
CREATE TABLE IF NOT EXISTS boot (
  id               INTEGER PRIMARY KEY,
  server_id        TEXT    NOT NULL REFERENCES server(id),
  jvm_started_at   INTEGER NOT NULL,
  first_capture_at INTEGER NOT NULL,
  last_capture_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS boot_by_server ON boot (server_id, jvm_started_at);

-- ~1 minute resolution statistics straight from spark's WindowStatistics.
-- This is the metric history; it does not depend on mappings.
CREATE TABLE IF NOT EXISTS capture_window (
  capture_id    INTEGER NOT NULL REFERENCES capture(id) ON DELETE CASCADE,
  window_id     INTEGER NOT NULL,
  start_time    INTEGER,
  end_time      INTEGER,
  ticks         INTEGER,
  tps           REAL,
  mspt_median   REAL,
  mspt_max      REAL,
  players       INTEGER,
  entities      INTEGER,
  tile_entities INTEGER,
  chunks        INTEGER,
  cpu_process   REAL,
  cpu_system    REAL,
  PRIMARY KEY (capture_id, window_id)
);
CREATE INDEX IF NOT EXISTS window_by_time ON capture_window (start_time);

-- Mod set per capture. Drives season detection and lets a cost be attributed
-- to a specific mod version over time.
CREATE TABLE IF NOT EXISTS mod (
  id     INTEGER PRIMARY KEY,
  mod_id TEXT NOT NULL UNIQUE,
  name   TEXT
);
CREATE TABLE IF NOT EXISTS capture_mod (
  capture_id INTEGER NOT NULL REFERENCES capture(id) ON DELETE CASCADE,
  mod        INTEGER NOT NULL REFERENCES mod(id),
  version    TEXT NOT NULL,
  PRIMARY KEY (capture_id, mod)
);

-- Interned "Class.method" labels. Tens of thousands, not millions.
CREATE TABLE IF NOT EXISTS frame (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
  class_name  TEXT NOT NULL,
  method_name TEXT NOT NULL
);

-- Exact method identity (v15): the class, method and descriptor exactly as the
-- capture recorded them (intermediary names on a live Fabric server).
--
-- An INDEX from findings to keys, never a way to split cost: the ledger stays
-- per frame (the mapped label), and one label can cover several keys
-- (overloads; hidden-class lambdas, whose names change every boot). Which key
-- a measured row had is recorded in that capture's own sidecar. group_class
-- drops a hidden class's per-boot suffix, for grouping and display only.
-- origin 'backfill' rows come from frame.class_name/method_name (the first raw
-- form seen per label) and have no descriptor: best effort, never exact.
CREATE TABLE IF NOT EXISTS frame_key (
  id          INTEGER PRIMARY KEY,
  raw_class   TEXT NOT NULL,
  raw_method  TEXT NOT NULL,
  raw_desc    TEXT NOT NULL,
  group_class TEXT NOT NULL,
  origin      TEXT NOT NULL,
  UNIQUE (raw_class, raw_method, raw_desc)
);
-- Which frames a key was seen under, and roughly when (to the day).
CREATE TABLE IF NOT EXISTS frame_key_seen (
  key_id     INTEGER NOT NULL REFERENCES frame_key(id),
  frame_id   INTEGER NOT NULL REFERENCES frame(id),
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (key_id, frame_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS key_seen_by_frame ON frame_key_seen (frame_id);

-- Answers from envx (v16), an optional separate index of the server's mods
-- (envx/). Kept here because envx stores nothing for its callers. Every
-- answer is tied to the envx snapshot it was given for, by fingerprint, so a
-- later envx resync can never change an old answer; the modset is kept with
-- it for grouping. envx_version records which envx gave it.
--
-- envx_match: which envx snapshot ran a mod set (our modset hash -> the
-- fingerprint used for lookups), or 'none'.
CREATE TABLE IF NOT EXISTS envx_match (
  modset        TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  fingerprint   TEXT,
  snapshot_ids  TEXT,
  envx_modset   TEXT,
  envx_version  TEXT NOT NULL,
  checked_at    INTEGER NOT NULL,
  detail        TEXT
);
-- envx_answer: one owner or mixins answer per (key, snapshot).
CREATE TABLE IF NOT EXISTS envx_answer (
  op            TEXT NOT NULL,
  lookup_key    TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  modset        TEXT NOT NULL,
  status        TEXT,
  result        TEXT NOT NULL,
  envx_version  TEXT NOT NULL,
  answered_at   INTEGER NOT NULL,
  PRIMARY KEY (op, lookup_key, fingerprint)
) WITHOUT ROWID;

-- Call paths as a PREFIX TREE, not as strings.
--
-- The first cut of this stored each path as its full text. Measured on the
-- real archive that averaged 2,149 bytes per path (max 18,417) across ~1M
-- paths, producing a 7.8 GB database from four hours of capture -- about
-- 1.8 GB/hour of continuous collection. Unusable.
--
-- Storing one row per tree EDGE shares every prefix: a path is reconstructed
-- by walking parent links. Row cost drops from ~2 KB to ~30 bytes, and deep
-- modded call stacks (depth 40+) share almost all of their prefix anyway.
--
-- parent_id = 0 means "thread root". Using 0 rather than NULL keeps the
-- UNIQUE constraint meaningful, since SQLite treats NULLs as distinct.
CREATE TABLE IF NOT EXISTS path (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER NOT NULL DEFAULT 0,
  frame_id   INTEGER NOT NULL REFERENCES frame(id),
  depth      INTEGER NOT NULL,
  source_mod TEXT,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  UNIQUE (parent_id, frame_id)
);
CREATE INDEX IF NOT EXISTS path_by_frame  ON path (frame_id);
CREATE INDEX IF NOT EXISTS path_by_source ON path (source_mod);

-- LEDGER TIER 1: per (day, season, method). Kept forever, NO threshold of any
-- kind. This is the guarantee that no cost is ever lost: even if a specific
-- call path falls below the evidence floor below, its time is still counted
-- here against the method that incurred it.
CREATE TABLE IF NOT EXISTS frame_daily (
  day              TEXT    NOT NULL,
  server_id        TEXT    NOT NULL REFERENCES server(id),
  season_id        INTEGER NOT NULL REFERENCES season(id),
  frame_id         INTEGER NOT NULL REFERENCES frame(id),
  self_ms          REAL    NOT NULL,
  total_ms         REAL    NOT NULL,
  ticks            INTEGER NOT NULL,
  captures_present INTEGER NOT NULL,
  PRIMARY KEY (day, season_id, frame_id)
);
CREATE INDEX IF NOT EXISTS frame_ledger_by_frame ON frame_daily (frame_id, day);

-- LEDGER TIER 2: per (day, season, call path). Kept forever.
--
-- Carries an EVIDENCE FLOOR (configurable, default: seen in >=2 windows or
-- >=2 samples). This is not a significance threshold and does not discard
-- cost -- a path below the floor was sampled once and carries no statistical
-- content, its time is still recorded in frame_daily, and the full per-window
-- detail remains in the capture's sidecar. It exists because without it the
-- long tail of single-sample paths dominates the table for no analytical gain.

-- Materialised per-(season, path) totals.
--
-- Added after measuring: grouping the 457k-row daily ledger on every page
-- load cost ~500 ms per query, and the Findings page runs two of them. It is
-- not a clause that is slow, it is the grouped scan itself, so no amount of
-- query tweaking fixes it -- the aggregate has to exist already.
--
-- Maintained incrementally at ingest, so it costs one extra upsert per path
-- per capture and never needs a periodic rebuild. ms_per_tick is stored
-- rather than computed so it can be indexed and ordered on directly.

-- How much cost fell below the tier-2 evidence floor, so the omission is
-- visible and quantified rather than silent.
CREATE TABLE IF NOT EXISTS path_daily_tail (
  day        TEXT    NOT NULL,
  season_id  INTEGER NOT NULL REFERENCES season(id),
  paths      INTEGER NOT NULL,
  self_ms    REAL    NOT NULL,
  total_ms   REAL    NOT NULL,
  PRIMARY KEY (day, season_id)
);

-- The optimization register.
--
-- Deliberately separates "we changed something" from "we proved it helped".
-- Those collapse into one another very easily, and once they do a backlog
-- stops being evidence and becomes a list of things someone felt good about.
--
-- Only the validation engine may write the measured_* columns, and a
-- synthetic benchmark result lives in its own column precisely so it can
-- never be mistaken for a measurement of the live server.
CREATE TABLE IF NOT EXISTS optimization (
  id               INTEGER PRIMARY KEY,
  server_id        TEXT NOT NULL REFERENCES server(id),
  title            TEXT NOT NULL,
  -- The detected mod-set change this entry tracks, when it came from one.
  revision_id      INTEGER REFERENCES revision(id),
  target_path_text TEXT,
  target_label     TEXT,

  -- proposed | investigating | implemented | measured-improvement
  -- | no-measurable-change | regressed | reverted
  status           TEXT NOT NULL,
  feasibility      TEXT NOT NULL DEFAULT 'unknown',
  risk             TEXT NOT NULL DEFAULT 'unknown',

  hypothesis       TEXT,
  approach         TEXT,
  notes            TEXT,

  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deployed_at      INTEGER,
  season_id        INTEGER REFERENCES season(id),

  -- Written only by the validation engine.
  validated_at       INTEGER,
  verdict            TEXT,
  delta_ms_per_tick  REAL,
  ci_low             REAL,
  ci_high            REAL,
  before_median      REAL,
  after_median       REAL,
  before_windows     INTEGER,
  after_windows      INTEGER,
  validation_note    TEXT,

  -- Kept apart on purpose. A microbenchmark showing a function got faster is
  -- not evidence that the server's tick budget did.
  synthetic_note     TEXT
);
CREATE INDEX IF NOT EXISTS optimization_by_status ON optimization (status, updated_at);

-- Append-only history of everything that happened to an optimization.
CREATE TABLE IF NOT EXISTS optimization_event (
  id              INTEGER PRIMARY KEY,
  optimization_id INTEGER NOT NULL REFERENCES optimization(id) ON DELETE CASCADE,
  at              INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  detail          TEXT,
  actor           TEXT
);
CREATE INDEX IF NOT EXISTS optimization_event_by_opt ON optimization_event (optimization_id, at);

-- What has already been announced, so nothing is announced twice.
-- Purely additive: adding this table needs no schema version bump, because
-- every statement here runs with IF NOT EXISTS on every open.
CREATE TABLE IF NOT EXISTS notification_log (
  signature TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  sent_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notification_by_kind ON notification_log (kind, sent_at);

-- Audit trail for anything perfint did to a monitored server. Append-only.
CREATE TABLE IF NOT EXISTS server_action (
  id         INTEGER PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES server(id),
  at         INTEGER NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  sha256     TEXT,
  dry_run    INTEGER NOT NULL DEFAULT 1,
  outcome    TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS action_by_time ON server_action (server_id, at);

-- Every fix the setup check applied, automatically or on a click. A whole
-- table, so like notification_log it needs no schema version bump. Kept so
-- each fix can be explained later and undone while nothing has changed since.
CREATE TABLE IF NOT EXISTS remediation (
  id           INTEGER PRIMARY KEY,
  server_id    TEXT,
  at           INTEGER NOT NULL,
  finding_id   TEXT NOT NULL,
  tier         TEXT NOT NULL,              -- automatic | opt-in | one-click
  kind         TEXT NOT NULL,              -- setting | server-file
  target       TEXT NOT NULL,              -- setting key, or absolute file path
  before_value TEXT,                       -- setting value as JSON
  after_value  TEXT,
  before_sha   TEXT,                       -- file hash; NULL when it did not exist
  after_sha    TEXT,
  backup_path  TEXT,                       -- relative to the data folder
  summary      TEXT NOT NULL,
  actor        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'applied',
  undone_at    INTEGER
);
CREATE INDEX IF NOT EXISTS remediation_by_time ON remediation (at);

-- Monitoring state changes per server (see store/health.ts): one row per
-- change, so gaps in coverage can say why they happened. A whole table: no
-- version bump needed.
CREATE TABLE IF NOT EXISTS monitor_event (
  id        INTEGER PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES server(id),
  at        INTEGER NOT NULL,
  state     TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS monitor_by_time ON monitor_event (server_id, at);

-- Investigations: a problem as the person thinks of it ("BlockSwap
-- retro-generation"), covering one or more methods or a whole mod, and
-- whether it is being worked on, on hold, or resolved. Holding hides its
-- findings from the active list without forgetting them; the cost when it
-- was held is kept so a big rise can bring it back to attention. Whole
-- tables: no version bump needed.
CREATE TABLE IF NOT EXISTS investigation (
  id              INTEGER PRIMARY KEY,
  server_id       TEXT NOT NULL REFERENCES server(id),
  name            TEXT NOT NULL,
  state           TEXT NOT NULL,
  note            TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  baseline_mspt   REAL,
  baseline_season INTEGER
);
CREATE TABLE IF NOT EXISTS investigation_member (
  investigation_id INTEGER NOT NULL REFERENCES investigation(id) ON DELETE CASCADE,
  -- A method's frame label, or "mod:<id>" for everything a mod owns.
  member           TEXT NOT NULL,
  PRIMARY KEY (investigation_id, member)
);
CREATE TABLE IF NOT EXISTS investigation_event (
  id               INTEGER PRIMARY KEY,
  investigation_id INTEGER NOT NULL REFERENCES investigation(id) ON DELETE CASCADE,
  at               INTEGER NOT NULL,
  state            TEXT NOT NULL,
  note             TEXT NOT NULL DEFAULT '',
  mspt             REAL
);

-- All-thread profiles (analysis/threads.ts): a few short profiles a day of
-- every thread, kept apart from the server-thread captures so they never
-- enter the tick figures. Summarised on arrival; the raw file is archived.
CREATE TABLE IF NOT EXISTS thread_profile (
  id             INTEGER PRIMARY KEY,
  server_id      TEXT NOT NULL REFERENCES server(id),
  captured_at    INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL UNIQUE,
  archive_path   TEXT,
  summary        TEXT NOT NULL
);

-- Where the tick went, per capture and minute: every sample of tick work by
-- part of the game, mod and thing (analysis/split.ts), zstd JSON. Written at
-- import; older captures are filled in from their sidecars in the background.
CREATE TABLE IF NOT EXISTS capture_split (
  capture_id INTEGER PRIMARY KEY REFERENCES capture(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  data       BLOB    NOT NULL
);

-- The same, summed per day (the day a capture's ledger rows are filed under),
-- for whole days and seasons. Derived from capture_split and rebuilt from it.

-- Files seen in a watched server's spark folder, and what became of them,
-- so each is imported once. A whole table: no version bump needed.
CREATE TABLE IF NOT EXISTS watched_file (
  server_id  TEXT NOT NULL REFERENCES server(id),
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  status     TEXT NOT NULL,
  capture_id INTEGER,
  at         INTEGER NOT NULL,
  PRIMARY KEY (server_id, name)
);

-- Each capture's path ids, in sidecar row order, as a packed Int32Array.
-- Lets an exact time span be summed from sidecars without resolving every
-- call path again (that was ~95% of the cost). Written at ingest; filled in
-- lazily for captures from before it existed. A whole table: no version bump.
CREATE TABLE IF NOT EXISTS capture_path_ids (
  capture_id INTEGER PRIMARY KEY REFERENCES capture(id) ON DELETE CASCADE,
  ids        BLOB NOT NULL
);

-- Profiles people uploaded to spark's viewer, found in activity.json and
-- imported as manual captures. One row per upload code, so nothing is
-- fetched twice. A whole table: no version bump needed.
CREATE TABLE IF NOT EXISTS upload_import (
  code         TEXT PRIMARY KEY,
  uploaded_at  INTEGER NOT NULL,
  uploaded_by  TEXT,
  status       TEXT NOT NULL,           -- imported | duplicate | gone | not-a-profile | download-failed
  capture_id   INTEGER,
  detail       TEXT,
  attempted_at INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 1
);
`;
