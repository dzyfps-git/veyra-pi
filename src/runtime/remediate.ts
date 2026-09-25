/**
 * Fixing what the setup check finds -- by tier, never beyond it.
 *
 * `setup.ts` says what is wrong. This file is the only place that does
 * anything about it, and what it may do depends on who a fix can hurt:
 *
 *   automatic   Touches only this application's own settings. Nothing on
 *               the server changes, so there is no one to ask. Example: the
 *               Minecraft version changed, and the Yarn mappings for the new
 *               version are already on disk -- switch to them.
 *
 *   opt-in      Edits spark's config file on the server, keeping every key
 *               the pack wrote and changing only the ones monitoring depends
 *               on. Backed up, verified, undoable, never restarts anything.
 *               Automatic only once the operator switches it on; until then
 *               it is one click.
 *
 *   one-click   Edits the file that launches the server (JVM flags). Every
 *               time, the exact before/after is shown first and nothing is
 *               written until the operator presses the button. A launcher
 *               edit that goes wrong stops the server from starting, so this
 *               is never automatic, whatever is switched on.
 *
 *   guidance    Installing or replacing a mod, restarting Minecraft. Never
 *               done here. The finding says what to do and re-checks after.
 *
 * ## The writes, and the only writes
 *
 * Exactly three files on the server can be written, all named relative to the
 * configured server directory and checked after resolving:
 *
 *   config/spark/config.json   spark's config (opt-in)
 *   variables.txt              ServerPackCreator launcher (one-click)
 *   user_jvm_args.txt          Forge/NeoForge launcher (one-click)
 *
 * Each write: re-read and compare against what the plan was made from (so a
 * file someone edited in the meantime is left alone), back up locally, write
 * a temporary file beside it, rename over, read back and verify the hash, and
 * record it. Undo restores the backup only if the file is still exactly what
 * was written -- otherwise someone has changed it since, and undoing would
 * overwrite their work.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

import type { Store } from '../store/db.ts';
import type { SettingsStore } from '../settings/store.ts';
import { loadTinyMappings } from '../decode/mappings.ts';
import { scanServer, findJvmArgs, type ObservedSetup } from './serverscan.ts';
import {
  checkSetup,
  mappingsMatchVersion,
  namingScheme,
  DIAGNOSTIC_FLAGS,
  SPARK_DEFAULT_INTERVAL_MS,
  type DesiredSetup,
  type EnvironmentFactsLite,
  type SetupFinding,
} from './setup.ts';

export type FixTier = 'automatic' | 'opt-in' | 'one-click' | 'guidance';

/** The only server files this application will ever write, relative to the server root. */
export const WRITABLE_SERVER_FILES = ['config/spark/config.json', 'variables.txt', 'user_jvm_args.txt'] as const;

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Which tier a finding's fix belongs to. */
export function tierOf(finding: SetupFinding, observed?: Pick<ObservedSetup, 'jvmArgs'>): FixTier {
  switch (finding.id) {
    case 'mappings-not-needed':
    case 'mappings-wrong-version':
    case 'mappings-missing':
    case 'mappings-unreadable':
      return 'automatic';
    case 'spark-config-missing':
    case 'background-profiler-off':
    case 'sampling-interval-differs':
      return 'opt-in';
    case 'jvm-flags-missing': {
      const mechanism = observed?.jvmArgs?.mechanism;
      return mechanism === 'variables.txt' || mechanism === 'user_jvm_args.txt' ? 'one-click' : 'guidance';
    }
    default:
      return 'guidance';
  }
}

// ---------------------------------------------------------------------------
// Gathering: one check, used by the collector and the page alike.
// ---------------------------------------------------------------------------

export interface SetupState {
  root: string;
  observed: ObservedSetup;
  environment: EnvironmentFactsLite;
  desired: DesiredSetup;
  findings: SetupFinding[];
}

export function desiredSetup(settings: SettingsStore): DesiredSetup {
  return {
    backgroundProfiler: true,
    samplingIntervalMs: settings.getNumber('collection.sparkSamplingIntervalMs'),
    wantDiagnosticFlags: settings.getBoolean('setup.wantDiagnosticFlags'),
    mappingsFile: settings.getString('server.mappingsFile'),
  };
}

/** What the server actually loaded, from the newest capture. */
export function latestEnvironment(store: Pick<Store, 'db'>, serverId?: string): EnvironmentFactsLite {
  // Per server: a staging server on another Minecraft version must be
  // checked against its own captures, not production's.
  const env = store.db
    .prepare(
      `SELECT e.mc_version, e.loader_name, e.java_major, r.runtime_flags, c.interval_micros
         FROM capture c JOIN season s ON s.id = c.season_id
         JOIN environment e ON e.id = s.environment_id
         LEFT JOIN revision r ON r.id = c.revision_id
        ${serverId === undefined ? '' : 'WHERE c.server_id = ?'}
        ORDER BY c.started_at DESC LIMIT 1`,
    )
    .get(...(serverId === undefined ? [] : [serverId])) as
    | { mc_version: string; loader_name: string; java_major: string; runtime_flags: string | null; interval_micros: number | null }
    | undefined;
  let runningFlags: string[] | undefined;
  try {
    runningFlags = env?.runtime_flags == null ? undefined : (JSON.parse(env.runtime_flags) as string[]);
  } catch {
    runningFlags = undefined;
  }
  return {
    minecraftVersion: env?.mc_version,
    loaderName: env?.loader_name,
    javaMajor: env?.java_major,
    runningFlags,
    runningIntervalMs: env?.interval_micros == null ? undefined : env.interval_micros / 1000,
  };
}

/**
 * Recent scans of a server folder. Scanning reads the server's config and
 * mods folders over the network share; a page that only summarises the
 * setup (the Overview, on every load) reuses one for `maxScanAgeMs`.
 */
const scans = new Map<string, { at: number; observed: ReturnType<typeof scanServer> }>();

export function gatherSetup(
  store: Pick<Store, 'db'>,
  settings: SettingsStore,
  root: string,
  serverId?: string,
  options: { maxScanAgeMs?: number } = {},
): SetupState | undefined {
  if (root.trim() === '') return undefined;
  const recent = scans.get(root);
  const observed =
    options.maxScanAgeMs !== undefined && recent !== undefined && Date.now() - recent.at < options.maxScanAgeMs
      ? recent.observed
      : scanServer(root);
  if (observed !== recent?.observed) scans.set(root, { at: Date.now(), observed });
  const environment = latestEnvironment(store, serverId);
  const desired = desiredSetup(settings);
  const findings = checkSetup(observed, desired, environment);

  // A configured mappings file that cannot be read is its own problem: the
  // version in its name can be right while the file itself has gone (it
  // lived in a folder that was moved or cleaned up).
  if (desired.mappingsFile !== '' && !findings.some((f) => f.id.startsWith('mappings-'))) {
    const scheme = namingScheme(environment.loaderName, environment.minecraftVersion);
    if ((scheme === 'intermediary' || scheme === 'unknown') && !mappingsUsable(desired.mappingsFile)) {
      findings.push({
        id: 'mappings-unreadable',
        severity: 'blocking',
        title: 'The mappings file cannot be read',
        observed: `${desired.mappingsFile} is missing or is not a Yarn mappings file.`,
        consequence:
          'New captures would report no tick time, because the anchor method cannot be identified. ' +
          'Existing history is unaffected.',
        remedy: {
          kind: 'perfint-setting',
          action: 'Point the mappings setting at a Yarn tiny mappings file for this Minecraft version.',
        },
      });
    }
  }
  return { root, observed, environment, desired, findings };
}

// ---------------------------------------------------------------------------
// The record of every fix.
// ---------------------------------------------------------------------------

export interface RemediationRow {
  id: number;
  at: number;
  finding_id: string;
  tier: FixTier;
  kind: 'setting' | 'server-file';
  target: string;
  before_value: string | null;
  after_value: string | null;
  before_sha: string | null;
  after_sha: string | null;
  backup_path: string | null;
  summary: string;
  actor: string;
  status: 'applied' | 'undone';
  undone_at: number | null;
}

function record(
  store: Store,
  row: Omit<RemediationRow, 'id' | 'at' | 'status' | 'undone_at'>,
): number {
  store.db
    .prepare(
      `INSERT INTO remediation (server_id, at, finding_id, tier, kind, target, before_value, after_value,
                                before_sha, after_sha, backup_path, summary, actor, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'applied')`,
    )
    .run(
      store.firstServerId() ?? null,
      Date.now(),
      row.finding_id,
      row.tier,
      row.kind,
      row.target,
      row.before_value,
      row.after_value,
      row.before_sha,
      row.after_sha,
      row.backup_path,
      row.summary,
      row.actor,
    );
  return Number((store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

export function recentRemediations(store: Pick<Store, 'db'>, limit = 10): RemediationRow[] {
  return store.db
    .prepare('SELECT * FROM remediation ORDER BY at DESC, id DESC LIMIT ?')
    .all(limit) as unknown as RemediationRow[];
}

// ---------------------------------------------------------------------------
// Tier 1 -- this application's own settings.
// ---------------------------------------------------------------------------

/** A mappings file that loads and actually names Minecraft's server class. */
export function mappingsUsable(file: string): boolean {
  let key: string;
  try {
    const stats = statSync(file);
    key = `${path.resolve(file)}|${stats.size}|${stats.mtimeMs}`;
  } catch {
    return false;
  }
  // The page runs this on every render; loading a megabyte of mappings each
  // time would be wasteful for an answer that only changes with the file.
  const known = usableCache.get(key);
  if (known !== undefined) return known;

  let usable = false;
  try {
    const mappings = loadTinyMappings(file);
    if (mappings.available) {
      for (const named of mappings.classes.values()) {
        if (named === 'net/minecraft/server/MinecraftServer') {
          usable = true;
          break;
        }
      }
    }
  } catch {
    usable = false;
  }
  usableCache.set(key, usable);
  return usable;
}

const usableCache = new Map<string, boolean>();

function libraryName(minecraftVersion: string, source: string): string {
  return `yarn-${minecraftVersion}.tiny${source.endsWith('.gz') ? '.gz' : ''}`;
}

/**
 * Keep a private copy of mappings that are known to work.
 *
 * The configured file may live somewhere this application does not own --
 * another tool's folder -- and a rotation back to an older Minecraft version
 * months later should not depend on that folder still existing.
 */
export function rememberMappings(file: string, minecraftVersion: string, libraryDir: string): string | undefined {
  if (mappingsMatchVersion(file, minecraftVersion) !== true || !mappingsUsable(file)) return undefined;
  mkdirSync(libraryDir, { recursive: true });
  const target = path.join(libraryDir, libraryName(minecraftVersion, file));
  if (!existsSync(target)) copyFileSync(file, target);
  return target;
}

/**
 * Find mappings for a Minecraft version without asking anyone.
 *
 * Looks in this application's own library first, then in the cache that the
 * StackDeobfuscator mod keeps on the server (read only; copied into the
 * library, never used in place). Every candidate must load and name the
 * server class, and must state the right version in its name -- a file of
 * unknown version is not a candidate, because wrong mappings are worse than
 * none.
 */
export function findMappingsFor(
  minecraftVersion: string,
  libraryDir: string,
  serverRoot: string,
): { file: string; from: 'library' | 'server-cache' } | undefined {
  for (const name of [libraryName(minecraftVersion, 'x.gz'), libraryName(minecraftVersion, 'x')]) {
    const file = path.join(libraryDir, name);
    if (existsSync(file) && mappingsUsable(file)) return { file, from: 'library' };
  }

  const cacheDir = path.join(serverRoot, 'stackdeobf_mappings');
  let entries: string[] = [];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return undefined;
  }
  const escaped = minecraftVersion.replace(/\./g, '\\.');
  const pattern = new RegExp(`^yarn_${escaped}\\+build\\.(\\d+)\\.gz$`);
  const candidates = entries
    .map((name) => ({ name, build: Number(pattern.exec(name)?.[1] ?? NaN) }))
    .filter((c) => Number.isFinite(c.build))
    .sort((a, b) => b.build - a.build);

  for (const candidate of candidates) {
    const source = path.join(cacheDir, candidate.name);
    if (!mappingsUsable(source)) continue;
    mkdirSync(libraryDir, { recursive: true });
    const target = path.join(libraryDir, libraryName(minecraftVersion, source));
    copyFileSync(source, target);
    if (mappingsUsable(target)) return { file: target, from: 'server-cache' };
  }
  return undefined;
}

export interface AutomaticFix {
  findingId: string;
  summary: string;
  remediationId: number;
}

function changeSetting(
  store: Store,
  settings: SettingsStore,
  findingId: string,
  key: string,
  value: string,
  summary: string,
): AutomaticFix | undefined {
  const before = settings.getString(key);
  if (before === value) return undefined;
  const result = settings.apply({ [key]: value }, { actor: 'auto-fix' });
  if (result.changes.length === 0) return undefined;
  const id = record(store, {
    finding_id: findingId,
    tier: 'automatic',
    kind: 'setting',
    target: key,
    before_value: JSON.stringify(before),
    after_value: JSON.stringify(value),
    before_sha: null,
    after_sha: null,
    backup_path: null,
    summary,
    actor: 'auto-fix',
  });
  return { findingId, summary, remediationId: id };
}

/**
 * Apply every tier-1 fix that applies. Touches nothing on the server.
 */
export function applyAutomaticFixes(store: Store, settings: SettingsStore, state: SetupState): AutomaticFix[] {
  const fixes: AutomaticFix[] = [];
  const libraryDir = path.join(store.dataDir, 'mappings');
  const version = state.environment.minecraftVersion;
  const current = state.desired.mappingsFile;
  const ids = new Set(state.findings.map((f) => f.id));

  // Whatever works now is worth keeping for later.
  if (version !== undefined && current !== '') {
    try {
      rememberMappings(current, version, libraryDir);
    } catch {
      // Keeping a spare copy is a convenience; failing to is not a fault.
    }
  }

  if (ids.has('mappings-not-needed')) {
    const fix = changeSetting(
      store,
      settings,
      'mappings-not-needed',
      'server.mappingsFile',
      '',
      'Cleared the mappings setting: this loader already uses readable names. A copy is kept, and is ' +
        'picked up again automatically if a pack on that Minecraft version returns.',
    );
    if (fix !== undefined) fixes.push(fix);
  }

  const needsMappings = ['mappings-wrong-version', 'mappings-missing', 'mappings-unreadable'].find((id) => ids.has(id));
  if (needsMappings !== undefined && version !== undefined) {
    const found = findMappingsFor(version, libraryDir, state.root);
    if (found !== undefined) {
      const fix = changeSetting(
        store,
        settings,
        needsMappings,
        'server.mappingsFile',
        found.file,
        `Switched to Yarn mappings for Minecraft ${version}` +
          (found.from === 'library'
            ? ', kept from when this version last ran.'
            : ", copied from the deobfuscation cache already on the server (read only; nothing there changed)."),
      );
      if (fix !== undefined) fixes.push(fix);
    } else if (needsMappings === 'mappings-wrong-version') {
      // No right file anywhere: clear the wrong one. No tick figure is
      // better than a confidently wrong one.
      const fix = changeSetting(
        store,
        settings,
        needsMappings,
        'server.mappingsFile',
        '',
        `Cleared mappings for a different Minecraft version. None for ${version} were found; until some are ` +
          'set, captures report no tick time rather than decoding to the wrong names.',
      );
      if (fix !== undefined) fixes.push(fix);
    }
  }
  return fixes;
}

// ---------------------------------------------------------------------------
// Server files: shared guard and writer.
// ---------------------------------------------------------------------------

/**
 * Resolve one of the writable files, refusing anything else.
 *
 * The relative name must be on the list, the result must still sit inside
 * the root after resolving, and neither the file nor its directory may be a
 * symbolic link -- a link is how "inside the root" quietly stops being true.
 */
export function writableServerFile(root: string, relative: (typeof WRITABLE_SERVER_FILES)[number]): string {
  if (!(WRITABLE_SERVER_FILES as readonly string[]).includes(relative)) {
    throw new Error(`refusing to write ${relative}: not one of the files this application may change`);
  }
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  // A drive root ("S:\") already ends in a separator; adding another would
  // make every file inside it look like it was outside.
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (!full.startsWith(prefix)) throw new Error(`refusing to write outside ${base}`);
  for (const candidate of [full, path.dirname(full)]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error(`refusing to write through a link: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return full;
}

function readIfExists(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Write a server file, safely. Returns the backup path (stored relative to the
 * data folder) and the hash of what was written.
 */
function writeServerFile(
  store: Store,
  file: string,
  content: string,
  expectedBeforeSha: string | null,
  label: string,
): { backupPath: string | null; afterSha: string } {
  const current = readIfExists(file);
  const currentSha = current === undefined ? null : sha256(current);
  if (currentSha !== expectedBeforeSha) {
    throw new Error(
      `${path.basename(file)} changed since this was prepared, so it was left alone. Check again and review the new version.`,
    );
  }

  let backupPath: string | null = null;
  if (current !== undefined) {
    const dir = path.join(store.dataDir, 'backups', 'server-files');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(dir, `${stamp}-${label}-${path.basename(file)}`);
    writeFileSync(backup, current);
    if (sha256(readFileSync(backup)) !== currentSha) throw new Error('the backup did not verify, so nothing was written');
    backupPath = store.toStoredPath(backup);
  }

  const temporary = `${file}.perfint-tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, file);

  const afterSha = sha256(readFileSync(file));
  if (afterSha !== sha256(content)) {
    throw new Error(`${path.basename(file)} did not read back as written. The backup is at ${backupPath ?? '(none)'}.`);
  }
  return { backupPath, afterSha };
}

function audit(store: Store, action: string, target: string, sha: string, outcome: string, detail: string): void {
  const serverId = store.firstServerId();
  if (serverId === undefined) return;
  store.recordAction({ serverId, action, target, sha256: sha, dryRun: false, outcome, detail });
}

// ---------------------------------------------------------------------------
// Tier 2 -- spark's config.
// ---------------------------------------------------------------------------

export interface SparkConfigPlan {
  file: string;
  beforeSha: string | null;
  /** The key changes, as "key: old -> new". */
  changes: string[];
  content: string;
  findingIds: string[];
}

/**
 * The smallest edit to spark's config that restores what monitoring needs.
 *
 * Keys the pack wrote are kept, in their order. The interval is written only
 * when it genuinely differs from what is wanted -- spark's own default is
 * already 10 ms, so a pack that says nothing about it is left saying nothing.
 * A config that could not be parsed is never touched: it may be half-written,
 * or hand-edited, and a rewrite would destroy whatever is in it.
 */
export function planSparkConfig(state: SetupState): SparkConfigPlan | undefined {
  const relevant = state.findings.filter((f) => tierOf(f) === 'opt-in').map((f) => f.id);
  if (relevant.length === 0) return undefined;

  const file = writableServerFile(state.root, 'config/spark/config.json');
  if (!state.observed.sparkDirExists) return undefined;

  const raw = readIfExists(file);
  let existing: Record<string, unknown> = {};
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
      existing = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  const next: Record<string, unknown> = raw === undefined
    ? { _header: 'spark configuration file - https://spark.lucko.me/docs/Configuration' }
    : { ...existing };
  const changes: string[] = [];

  if (existing['backgroundProfiler'] !== true) {
    changes.push(`backgroundProfiler: ${JSON.stringify(existing['backgroundProfiler'] ?? '(unset)')} -> true`);
    next['backgroundProfiler'] = true;
  }

  const want = state.desired.samplingIntervalMs;
  const interval = existing['backgroundProfilerInterval'];
  const effective = typeof interval === 'number' ? interval : SPARK_DEFAULT_INTERVAL_MS;
  if (effective !== want) {
    changes.push(`backgroundProfilerInterval: ${JSON.stringify(interval ?? '(unset)')} -> ${want}`);
    next['backgroundProfilerInterval'] = want;
  }

  if (changes.length === 0) return undefined;
  return {
    file,
    beforeSha: raw === undefined ? null : sha256(raw),
    changes,
    content: JSON.stringify(next, null, 2) + '\n',
    findingIds: relevant,
  };
}

export function applySparkConfig(
  store: Store,
  plan: SparkConfigPlan,
  actor: 'auto-fix' | 'ui',
): { remediationId: number; summary: string } {
  const { backupPath, afterSha } = writeServerFile(store, plan.file, plan.content, plan.beforeSha, 'spark-config');
  const summary =
    `Updated spark's config (${plan.changes.join('; ')}). Every other key was kept. ` +
    'Takes effect the next time the server starts; nothing was restarted.';
  audit(store, 'setup:spark-config', plan.file, afterSha, 'written', plan.changes.join('; '));
  const id = record(store, {
    finding_id: plan.findingIds.join(','),
    tier: 'opt-in',
    kind: 'server-file',
    target: plan.file,
    before_value: null,
    after_value: null,
    before_sha: plan.beforeSha,
    after_sha: afterSha,
    backup_path: backupPath,
    summary,
    actor,
  });
  return { remediationId: id, summary };
}

// ---------------------------------------------------------------------------
// Tier 3 -- JVM flags in the launcher.
// ---------------------------------------------------------------------------

export interface JvmFlagsPlan {
  file: string;
  mechanism: 'variables.txt' | 'user_jvm_args.txt';
  beforeSha: string;
  /** The changed region, before and after, for showing as a diff. */
  before: string;
  after: string;
  added: string[];
  content: string;
  /** When the change takes effect, in the launcher's own terms. */
  takesEffect: string;
}

/**
 * The exact launcher edit that adds the missing flags, or why there isn't one.
 *
 * Only two launcher layouts are edited, both of which keep JVM flags in a
 * line or file of their own. A shell script is never edited: its java line
 * can be built from variables, conditionals and continuations, and a wrong
 * guess means the server does not start.
 */
export function planJvmFlags(root: string, flags: readonly string[] = DIAGNOSTIC_FLAGS): JvmFlagsPlan | { refused: string } {
  const source = findJvmArgs(root);
  if (source === undefined) return { refused: 'No launcher layout this recognises was found.' };
  if (source.mechanism !== 'variables.txt' && source.mechanism !== 'user_jvm_args.txt') {
    return {
      refused: `${source.mechanism} is a script, and scripts are never edited here. Add ${flags.join(' ')} to its java line by hand.`,
    };
  }

  const missing = flags.filter((f) => !source.flags.includes(f));
  if (missing.length === 0) return { refused: 'The flags are already there.' };

  const file = writableServerFile(root, source.mechanism);
  const raw = readFileSync(file);
  const text = raw.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  if (source.mechanism === 'variables.txt') {
    const line = /^JAVA_ARGS[ \t]*=[ \t]*(?:"([^"\r\n]*)"|([^\r\n]*))[ \t]*$/m.exec(text);
    if (line === null) return { refused: 'variables.txt has no JAVA_ARGS line to add to.' };
    const quoted = line[1] !== undefined;
    const current = (quoted ? line[1] : line[2]) ?? '';
    const value = [current.trim(), ...missing].filter((part) => part !== '').join(' ');
    const replacement = quoted || /\s/.test(value) ? `JAVA_ARGS="${value}"` : `JAVA_ARGS=${value}`;
    const content = text.slice(0, line.index) + replacement + text.slice(line.index + line[0].length);
    return {
      file,
      mechanism: 'variables.txt',
      beforeSha: sha256(raw),
      before: line[0],
      after: replacement,
      added: missing,
      content,
      takesEffect:
        'the next time the server is fully stopped and start.sh is run again. The launcher does not re-read ' +
        'variables.txt on its own automatic restarts, so a crash-restart will not pick this up.',
    };
  }

  const trimmed = text.replace(/(\r?\n)*$/, '');
  const content = (trimmed === '' ? '' : trimmed + eol) + missing.join(eol) + eol;
  return {
    file,
    mechanism: 'user_jvm_args.txt',
    beforeSha: sha256(raw),
    before: '',
    after: missing.join('\n'),
    added: missing,
    content,
    takesEffect: 'the next time the server starts.',
  };
}

export function applyJvmFlags(
  store: Store,
  root: string,
  expectedBeforeSha: string,
): { remediationId: number; summary: string } {
  const plan = planJvmFlags(root);
  if ('refused' in plan) throw new Error(plan.refused);
  // The plan is rebuilt from the file as it is NOW; the hash the operator
  // approved must match it, or they approved something else.
  if (plan.beforeSha !== expectedBeforeSha) {
    throw new Error(`${plan.mechanism} changed since the preview was shown, so it was left alone. Review it again.`);
  }
  const { backupPath, afterSha } = writeServerFile(store, plan.file, plan.content, plan.beforeSha, 'jvm-flags');
  const summary =
    `Added ${plan.added.join(' ')} to ${plan.mechanism}. Nothing was restarted; this takes effect ${plan.takesEffect}`;
  audit(store, 'setup:jvm-flags', plan.file, afterSha, 'written', plan.added.join(' '));
  const id = record(store, {
    finding_id: 'jvm-flags-missing',
    tier: 'one-click',
    kind: 'server-file',
    target: plan.file,
    before_value: null,
    after_value: null,
    before_sha: plan.beforeSha,
    after_sha: afterSha,
    backup_path: backupPath,
    summary,
    actor: 'ui',
  });
  return { remediationId: id, summary };
}

// ---------------------------------------------------------------------------
// Undo.
// ---------------------------------------------------------------------------

/**
 * `roots` are the server folders a file fix may belong to; the one whose
 * allowlisted file matches the recorded target is used, and nothing outside
 * those folders can ever be touched by an undo.
 */
export function undoRemediation(store: Store, settings: SettingsStore, id: number, roots: readonly string[]): string {
  const row = store.db.prepare('SELECT * FROM remediation WHERE id = ?').get(id) as unknown as RemediationRow | undefined;
  if (row === undefined) throw new Error('no such fix');
  if (row.status === 'undone') throw new Error('already undone');

  if (row.kind === 'setting') {
    const now = JSON.stringify(settings.getString(row.target));
    if (now !== row.after_value) {
      throw new Error('the setting has been changed since, so undoing would overwrite that change');
    }
    settings.apply({ [row.target]: JSON.parse(row.before_value ?? '""') as string }, { actor: 'undo' });
  } else {
    let match: { root: string; relative: (typeof WRITABLE_SERVER_FILES)[number] } | undefined;
    for (const root of roots) {
      const relative = WRITABLE_SERVER_FILES.find((name) => path.resolve(root, name) === path.resolve(row.target));
      if (relative !== undefined) match = { root, relative };
    }
    if (match === undefined) throw new Error('that file is no longer inside any configured server folder');
    const file = writableServerFile(match.root, match.relative);
    const current = readIfExists(file);
    if (current === undefined || sha256(current) !== row.after_sha) {
      throw new Error(`${path.basename(file)} has been changed since, so undoing would overwrite that change`);
    }
    if (row.backup_path === null) {
      // The file did not exist before this application created it. A copy
      // is kept locally, verified, and only then is it removed -- leaving
      // the directory exactly as the pack had it.
      const dir = path.join(store.dataDir, 'backups', 'server-files');
      mkdirSync(dir, { recursive: true });
      const kept = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-undone-${path.basename(file)}`);
      writeFileSync(kept, current);
      if (sha256(readFileSync(kept)) !== row.after_sha) throw new Error('the copy did not verify, so nothing was changed');
      unlinkSync(file);
    } else {
      const backup = store.resolveDataPath(row.backup_path);
      if (backup === undefined || !existsSync(backup)) throw new Error('the backup is missing, so nothing was changed');
      writeServerFile(store, file, readFileSync(backup, 'utf8'), row.after_sha, 'undo');
    }
    audit(store, 'setup:undo', file, row.before_sha ?? '', 'restored', row.summary);
  }

  store.db.prepare("UPDATE remediation SET status = 'undone', undone_at = ? WHERE id = ?").run(Date.now(), id);
  return row.kind === 'setting' ? 'Restored the previous setting.' : 'Restored the file as it was before.';
}

// ---------------------------------------------------------------------------
// One pass: check, fix what is allowed, check again.
// ---------------------------------------------------------------------------

export interface SetupPass {
  state: SetupState | undefined;
  fixed: string[];
  failed: string[];
}

export function runSetupPass(store: Store, settings: SettingsStore, root: string, serverId?: string): SetupPass {
  const fixed: string[] = [];
  const failed: string[] = [];
  let state = gatherSetup(store, settings, root, serverId);
  if (state === undefined || !state.observed.rootReadable) return { state, fixed, failed };

  if (settings.getBoolean('setup.autoFix.analyzerSettings')) {
    try {
      fixed.push(...applyAutomaticFixes(store, settings, state).map((f) => f.summary));
    } catch (error) {
      failed.push(`mappings: ${(error as Error).message}`);
    }
  }

  if (settings.getBoolean('setup.autoFix.sparkConfig') && !settings.getBoolean('limits.paused')) {
    try {
      const plan = planSparkConfig(state);
      if (plan !== undefined) fixed.push(applySparkConfig(store, plan, 'auto-fix').summary);
    } catch (error) {
      failed.push(`spark config: ${(error as Error).message}`);
    }
  }

  if (fixed.length > 0) state = gatherSetup(store, settings, root, serverId);
  return { state, fixed, failed };
}
