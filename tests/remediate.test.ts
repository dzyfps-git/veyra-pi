/**
 * Fixing setup problems, by tier.
 *
 * Every test runs against a throwaway server directory shaped like the real
 * one: a ServerPackCreator `variables.txt`, `config/spark/config.json`, and
 * the StackDeobfuscator mappings cache. What is being proven is less "the fix
 * works" than "the fix touches exactly what it says and nothing else, and
 * refuses whenever the ground moved under it".
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import {
  applyAutomaticFixes,
  applyJvmFlags,
  applySparkConfig,
  gatherSetup,
  planJvmFlags,
  planSparkConfig,
  recentRemediations,
  runSetupPass,
  sha256,
  tierOf,
  undoRemediation,
  writableServerFile,
  WRITABLE_SERVER_FILES,
} from '../src/runtime/remediate.ts';
import { DIAGNOSTIC_FLAGS, type SetupFinding } from '../src/runtime/setup.ts';

/** The real variables.txt tail, with its comment block shortened. */
const VARIABLES = [
  '###',
  '# JAVA_ARGS are arguments to pass to the JVM / your server.',
  '###',
  'MINECRAFT_VERSION=1.20.1',
  'MODLOADER=Fabric',
  'JAVA=/usr/lib/jvm/temurin-17-jdk-amd64/bin/java',
  'JAVA_ARGS="-Xmx14G -Xms14G -XX:ReservedCodeCacheSize=512M"',
  'ADDITIONAL_ARGS="-Dlog4j2.formatMsgNoLookups=true"',
  '',
].join('\n');

const TINY = gzipSync(
  Buffer.from(
    'tiny\t2\t0\tintermediary\tnamed\n' +
      'c\tnet/minecraft/server/class_1\tnet/minecraft/server/MinecraftServer\n' +
      '\tm\t()V\tmethod_3748\ttick\n',
  ),
);

let dir: string;
let root: string;
let store: Store;
let settings: SettingsStore;
let captures = 0;

function seedEnvironment(mcVersion: string, loader = 'Fabric'): void {
  const serverId = '00000000-0000-0000-0000-000000000001';
  store.upsertServer(serverId, 'main', 'Main');
  const env = store.upsertEnvironment({
    serverId, envKey: `e-${mcVersion}-${loader}`, mcVersion, loaderName: loader, loaderVersion: '1',
    javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
  });
  const season = store.createSeason({
    serverId, environmentId: env, ordinal: 1, startedAt: 0, reason: 'first', confirmed: true,
  });
  const revision = store.createRevision({
    seasonId: season, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0,
    reason: 'first', added: 0, removed: 0, changed: 0,
  });
  captures += 1;
  store.db
    .prepare(
      `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, ended_at,
                            window_count, path_count, raw_bytes, ingested_at, is_manual)
       VALUES (?,?,?,?,?,?,?,1,1,1,1,0)`,
    )
    // Later seeds are newer, so they become "the environment the server runs now".
    .run(serverId, season, revision, `c-${mcVersion}`, `sha-${mcVersion}-${loader}`, captures, captures);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-remediate-'));
  root = path.join(dir, 'server');
  mkdirSync(path.join(root, 'config', 'spark'), { recursive: true });
  mkdirSync(path.join(root, 'mods'), { recursive: true });
  writeFileSync(path.join(root, 'mods', 'spark-1.10.53-fabric.jar'), 'jar');
  writeFileSync(path.join(root, 'variables.txt'), VARIABLES);
  writeFileSync(
    path.join(root, 'config', 'spark', 'config.json'),
    JSON.stringify({ _header: 'spark configuration file', bytebinUrl: 'https://example.invalid/', backgroundProfiler: false }, null, 2),
  );

  store = new Store({ file: path.join(dir, 'data', 'perfint.sqlite') });
  settings = new SettingsStore(store.db);
  settings.apply({ 'server.mappingsFile': '' }, { actor: 'test' });
  seedEnvironment('1.20.1');
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const finding = (id: string): SetupFinding => ({
  id, severity: 'degraded', title: id, observed: '', consequence: '', remedy: { kind: 'manual', action: '' },
});

describe('tiers', () => {
  test('each kind of problem lands in the tier its blast radius allows', () => {
    assert.equal(tierOf(finding('mappings-wrong-version')), 'automatic');
    assert.equal(tierOf(finding('background-profiler-off')), 'opt-in');
    assert.equal(tierOf(finding('jvm-flags-missing'), { jvmArgs: { mechanism: 'variables.txt', file: '', flags: [] } }), 'one-click');
    assert.equal(
      tierOf(finding('jvm-flags-missing'), { jvmArgs: { mechanism: 'start.sh', file: '', flags: [] } }),
      'guidance',
      'a shell script is never edited',
    );
    assert.equal(tierOf(finding('spark-missing')), 'guidance', 'installing a mod is never automatic');
    assert.equal(tierOf(finding('spark-wrong-loader')), 'guidance');
  });

  test('exactly three server files can ever be written', () => {
    assert.deepEqual([...WRITABLE_SERVER_FILES].sort(), ['config/spark/config.json', 'user_jvm_args.txt', 'variables.txt']);
    assert.throws(() => writableServerFile(root, 'server.properties' as never), /not one of the files/);
    assert.throws(() => writableServerFile(root, '../variables.txt' as never), /not one of the files/);
  });

  test('a server mounted at a drive root is still inside itself', () => {
    // A server shared as a drive root (S:/) resolves to a path that already ends in a separator.
    const driveRoot = path.parse(process.cwd()).root;
    assert.equal(writableServerFile(driveRoot, 'variables.txt'), path.join(driveRoot, 'variables.txt'));
    assert.equal(writableServerFile(`${root}${path.sep}`, 'variables.txt'), path.join(root, 'variables.txt'));
  });
});

describe("spark's config (opt-in)", () => {
  test('only the keys monitoring needs change; everything the pack wrote survives, in order', () => {
    const state = gatherSetup(store, settings, root)!;
    const plan = planSparkConfig(state)!;
    assert.deepEqual(plan.changes, ['backgroundProfiler: false -> true']);
    const written = JSON.parse(plan.content) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written), ['_header', 'bytebinUrl', 'backgroundProfiler']);
    assert.equal(written['bytebinUrl'], 'https://example.invalid/');
    assert.equal('backgroundProfilerInterval' in written, false, "spark's default is already 10 ms; say nothing");
  });

  test('a config that is not valid JSON is never rewritten', () => {
    writeFileSync(path.join(root, 'config', 'spark', 'config.json'), '{ "backgroundProfiler": fal');
    assert.equal(planSparkConfig(gatherSetup(store, settings, root)!), undefined);
  });

  test('applying backs up, verifies, and can be undone exactly', () => {
    const file = path.join(root, 'config', 'spark', 'config.json');
    const original = readFileSync(file, 'utf8');
    const result = applySparkConfig(store, planSparkConfig(gatherSetup(store, settings, root)!)!, 'ui');

    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { backgroundProfiler: boolean }).backgroundProfiler, true);
    assert.match(result.summary, /nothing was restarted/);
    assert.equal(existsSync(`${file}.perfint-tmp`), false, 'no temporary file is left behind');
    const backups = readdirSync(path.join(store.dataDir, 'backups', 'server-files'));
    assert.equal(backups.length, 1, 'the backup lives here, not on the server');

    undoRemediation(store, settings, result.remediationId, [root]);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(recentRemediations(store)[0]!.status, 'undone');
  });

  test('a file edited after the plan was made is left alone', () => {
    const plan = planSparkConfig(gatherSetup(store, settings, root)!)!;
    writeFileSync(plan.file, JSON.stringify({ backgroundProfiler: false, edited: true }));
    assert.throws(() => applySparkConfig(store, plan, 'ui'), /changed since/);
    assert.match(readFileSync(plan.file, 'utf8'), /edited/);
  });

  test('undo refuses once someone else has changed the file', () => {
    const result = applySparkConfig(store, planSparkConfig(gatherSetup(store, settings, root)!)!, 'ui');
    const file = path.join(root, 'config', 'spark', 'config.json');
    writeFileSync(file, '{"backgroundProfiler": true, "theirs": 1}');
    assert.throws(() => undoRemediation(store, settings, result.remediationId, [root]), /changed since/);
    assert.match(readFileSync(file, 'utf8'), /theirs/);
  });

  test('automatic repair happens only once switched on, and never while paused', () => {
    const file = path.join(root, 'config', 'spark', 'config.json');
    runSetupPass(store, settings, root);
    assert.match(readFileSync(file, 'utf8'), /"backgroundProfiler": false/, 'off by default');

    settings.apply({ 'setup.autoFix.sparkConfig': true }, { actor: 'test', approveRisky: true });
    settings.apply({ 'limits.paused': true }, { actor: 'test', approveRisky: true });
    runSetupPass(store, settings, root);
    assert.match(readFileSync(file, 'utf8'), /"backgroundProfiler": false/, 'paused means paused');

    settings.apply({ 'limits.paused': false }, { actor: 'test', approveRisky: true });
    const pass = runSetupPass(store, settings, root);
    assert.match(readFileSync(file, 'utf8'), /"backgroundProfiler": true/);
    assert.equal(pass.fixed.length, 1);
    assert.ok(!pass.state!.findings.some((f) => f.id === 'background-profiler-off'), 'the pass re-checks after fixing');
  });
});

describe('JVM flags (one click, shown first)', () => {
  test('the preview changes the JAVA_ARGS line and nothing else', () => {
    const plan = planJvmFlags(root);
    assert.ok(!('refused' in plan));
    assert.equal(plan.before, 'JAVA_ARGS="-Xmx14G -Xms14G -XX:ReservedCodeCacheSize=512M"');
    assert.equal(plan.after, `JAVA_ARGS="-Xmx14G -Xms14G -XX:ReservedCodeCacheSize=512M ${DIAGNOSTIC_FLAGS.join(' ')}"`);
    assert.equal(plan.content, VARIABLES.replace(plan.before, plan.after), 'every other byte is identical');
    assert.match(plan.takesEffect, /does not re-read/, 'says a crash-restart will not pick it up');
  });

  test('Windows line endings are kept', () => {
    writeFileSync(path.join(root, 'variables.txt'), VARIABLES.replace(/\n/g, '\r\n'));
    const plan = planJvmFlags(root);
    assert.ok(!('refused' in plan));
    assert.equal(plan.content.split('\r\n').length, VARIABLES.split('\n').length);
    assert.ok(!/[^\r]\n/.test(plan.content));
  });

  test('applying needs the hash of the file the preview came from', () => {
    const plan = planJvmFlags(root);
    assert.ok(!('refused' in plan));
    assert.throws(() => applyJvmFlags(store, root, 'not-the-hash'), /changed since the preview/);
    assert.equal(readFileSync(path.join(root, 'variables.txt'), 'utf8'), VARIABLES, 'nothing written');

    const result = applyJvmFlags(store, root, plan.beforeSha);
    assert.match(readFileSync(path.join(root, 'variables.txt'), 'utf8'), /DebugNonSafepoints/);
    assert.match(result.summary, /Nothing was restarted/);

    const audit = store.db.prepare("SELECT action, dry_run FROM server_action WHERE action = 'setup:jvm-flags'").get() as
      | { action: string; dry_run: number }
      | undefined;
    assert.equal(audit?.dry_run, 0, 'the write is in the audit trail');

    undoRemediation(store, settings, result.remediationId, [root]);
    assert.equal(readFileSync(path.join(root, 'variables.txt'), 'utf8'), VARIABLES);
  });

  test('flags already present, or a shell launcher, are refused with a reason', () => {
    writeFileSync(
      path.join(root, 'variables.txt'),
      VARIABLES.replace('512M"', `512M ${DIAGNOSTIC_FLAGS.join(' ')}"`),
    );
    assert.match((planJvmFlags(root) as { refused: string }).refused, /already there/);

    rmSync(path.join(root, 'variables.txt'));
    writeFileSync(path.join(root, 'start.sh'), 'java -Xmx4G -jar server.jar nogui\n');
    assert.match((planJvmFlags(root) as { refused: string }).refused, /never edited/);
  });

  test('user_jvm_args.txt gets the flags appended as their own lines', () => {
    rmSync(path.join(root, 'variables.txt'));
    writeFileSync(path.join(root, 'user_jvm_args.txt'), '# comment\n-Xmx8G\n');
    const plan = planJvmFlags(root);
    assert.ok(!('refused' in plan));
    assert.equal(plan.content, `# comment\n-Xmx8G\n${DIAGNOSTIC_FLAGS.join('\n')}\n`);
  });
});

describe("this application's own settings (automatic)", () => {
  test('after a Minecraft change, mappings are taken from the cache already on the server', () => {
    const cache = path.join(root, 'stackdeobf_mappings');
    mkdirSync(cache);
    writeFileSync(path.join(cache, 'yarn_1.21.1+build.2.gz'), TINY);
    writeFileSync(path.join(cache, 'yarn_1.21.1+build.3.gz'), TINY);
    const old = path.join(dir, 'yarn-1.20.1+build.10-tiny.gz');
    writeFileSync(old, TINY);
    settings.apply({ 'server.mappingsFile': old }, { actor: 'test' });

    seedEnvironment('1.21.1');
    const state = gatherSetup(store, settings, root)!;
    assert.ok(state.findings.some((f) => f.id === 'mappings-wrong-version'));
    const fixes = applyAutomaticFixes(store, settings, state);

    const now = settings.getString('server.mappingsFile');
    assert.equal(path.dirname(now), path.join(store.dataDir, 'mappings'), 'a private copy, not the server file');
    assert.match(path.basename(now), /1\.21\.1/);
    assert.equal(fixes.length, 1);
    assert.deepEqual(readdirSync(cache).sort(), ['yarn_1.21.1+build.2.gz', 'yarn_1.21.1+build.3.gz'], 'the server cache is untouched');
  });

  test('going back to an older version finds the copy kept from last time', () => {
    const old = path.join(dir, 'yarn-1.20.1+build.10-tiny.gz');
    writeFileSync(old, TINY);
    settings.apply({ 'server.mappingsFile': old }, { actor: 'test' });
    applyAutomaticFixes(store, settings, gatherSetup(store, settings, root)!); // remembers 1.20.1
    rmSync(old); // the folder it came from is cleaned up

    const state = gatherSetup(store, settings, root)!;
    assert.ok(state.findings.some((f) => f.id === 'mappings-unreadable'));
    applyAutomaticFixes(store, settings, state);
    assert.match(settings.getString('server.mappingsFile'), /mappings[\\/]yarn-1\.20\.1\.tiny\.gz$/);
    assert.equal(gatherSetup(store, settings, root)!.findings.filter((f) => f.id.startsWith('mappings-')).length, 0);
  });

  test('wrong mappings with nothing better are cleared, not kept', () => {
    const old = path.join(dir, 'yarn-1.20.1+build.10-tiny.gz');
    writeFileSync(old, TINY);
    settings.apply({ 'server.mappingsFile': old }, { actor: 'test' });
    seedEnvironment('1.21.1');
    applyAutomaticFixes(store, settings, gatherSetup(store, settings, root)!);
    assert.equal(settings.getString('server.mappingsFile'), '');
  });

  test('a loader that needs no mappings gets the setting cleared, and undo puts it back', () => {
    const old = path.join(dir, 'yarn-1.20.1+build.10-tiny.gz');
    writeFileSync(old, TINY);
    settings.apply({ 'server.mappingsFile': old }, { actor: 'test' });
    seedEnvironment('1.21.1', 'NeoForge');
    const [fix] = applyAutomaticFixes(store, settings, gatherSetup(store, settings, root)!);
    assert.equal(settings.getString('server.mappingsFile'), '');
    undoRemediation(store, settings, fix!.remediationId, [root]);
    assert.equal(settings.getString('server.mappingsFile'), old);
  });

  test('nothing on the server changes during an automatic pass with defaults', () => {
    const before = new Map(
      ['variables.txt', 'config/spark/config.json'].map((f) => [f, sha256(readFileSync(path.join(root, f)))]),
    );
    runSetupPass(store, settings, root);
    for (const [f, hash] of before) assert.equal(sha256(readFileSync(path.join(root, f))), hash, f);
  });
});
