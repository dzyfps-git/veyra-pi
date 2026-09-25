/**
 * Updating and going back. The installer itself is run by the desktop app;
 * everything that decides whether and what to run lives here and is tested.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { APP_VERSION, CHANGELOG, compareVersions } from '../src/core/changelog.ts';
import {
  checkInstaller,
  findInstallers,
  history,
  keepInstaller,
  keptInstallersDir,
  noteRunningVersion,
  prepareUpdate,
  readReimportList,
  rollbackPlan,
  stageRollback,
  type Installer,
} from '../src/runtime/updates.ts';

let dir: string;
let store: Store;
let settings: SettingsStore;

const PRODUCT = 'Test Product (x64)';
const name = (v: string): string => `${PRODUCT} Setup ${v}.exe`;

function installer(folder: string, version: string, options: { manifest?: boolean; bytes?: number; wrongSha?: boolean } = {}): string {
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name(version));
  const content = Buffer.alloc(options.bytes ?? 11_000_000, version);
  writeFileSync(file, content);
  if (options.manifest !== false) {
    const sha = createHash('sha256').update(options.wrongSha === true ? Buffer.from('other') : content).digest('hex');
    writeFileSync(file.replace(/\.exe$/, '.json'), JSON.stringify({ version, sha256: sha, size: content.length, notes: [{ version, date: 'd', notes: ['n'] }] }));
  }
  return file;
}

function seedCapture(id: string, ingestedAt: number): void {
  store.upsertServer('s', 'main', 'Main');
  const env = store.upsertEnvironment({
    serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
    javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
  });
  const season = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
  const revision = store.createRevision({
    seasonId: season, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0, reason: 'r', added: 0, removed: 0, changed: 0,
  });
  store.db
    .prepare(
      `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, window_count,
                            path_count, raw_bytes, ingested_at, is_manual, archive_path, sidecar_path)
       VALUES ('s',?,?,?,?,0,1,1,1,?,0,?,?)`,
    )
    .run(season, revision, id, `sha-${id}`, ingestedAt, `archive/${id}.sparkprofile`, `archive/${id}.sidecar.zst`);
}

const older = (): string => {
  const [a, b, c] = APP_VERSION.split('.').map(Number);
  return c! > 0 ? `${a}.${b}.${c! - 1}` : `${a}.${b! - 1}.9`;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-updates-'));
  store = new Store({ file: path.join(dir, 'perfint.sqlite') });
  settings = new SettingsStore(store.db);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('finding installers', () => {
  test('only correctly named installers, newest first, preferring one with a checksum file', () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    installer(a, '9.0.1', { manifest: false });
    installer(b, '9.0.1');
    installer(a, '9.0.10');
    installer(a, '9.0.2');
    writeFileSync(path.join(a, 'Something Else Setup 9.9.9.exe'), 'x');
    writeFileSync(path.join(a, 'Test Product (x64) Setup 9.9.9.exe.part'), 'x');
    const found = findInstallers([a, b, path.join(dir, 'missing')], PRODUCT);
    assert.deepEqual(found.map((i) => i.version), ['9.0.10', '9.0.2', '9.0.1']);
    assert.ok(found.find((i) => i.version === '9.0.1')!.manifest !== undefined);
  });

  test('an installer is checked against its checksum file', () => {
    const folder = path.join(dir, 'in');
    installer(folder, '9.0.0');
    installer(folder, '9.0.1', { wrongSha: true });
    installer(folder, '9.0.2', { manifest: false });
    installer(folder, '9.0.3', { manifest: false, bytes: 100 });
    const by = (v: string): Installer => findInstallers([folder], PRODUCT).find((i) => i.version === v)!;
    assert.deepEqual(checkInstaller(by('9.0.0')), { ok: true, verified: true, detail: 'Checksum verified.' });
    assert.equal(checkInstaller(by('9.0.1')).ok, false);
    const unverified = checkInstaller(by('9.0.2'));
    assert.ok(unverified.ok && !unverified.verified);
    assert.equal(checkInstaller(by('9.0.3')).ok, false);
  });

  test('kept installers are limited to the newest three', () => {
    const folder = path.join(dir, 'in');
    for (const v of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) keepInstaller(store, findInstallers([installer(folder, v) && folder], PRODUCT).find((i) => i.version === v)!, PRODUCT);
    assert.deepEqual(findInstallers([keptInstallersDir(store)], PRODUCT).map((i) => i.version), ['1.0.3', '1.0.2', '1.0.1']);
  });
});

describe('the changelog', () => {
  test('has notes for the running version, newest first', () => {
    assert.equal(CHANGELOG[0]!.version, APP_VERSION);
    for (let i = 1; i < CHANGELOG.length; i += 1) assert.ok(compareVersions(CHANGELOG[i - 1]!.version, CHANGELOG[i]!.version) > 0);
  });
});

describe('updating', () => {
  test('backs up the database and remembers the update', () => {
    seedCapture('before', 100);
    const record = prepareUpdate(store, '99.0.0', 1_000);
    assert.ok(existsSync(record.backup));
    assert.equal(record.from, APP_VERSION);
    assert.deepEqual(history(store).map((r) => r.to), ['99.0.0']);
    const copy = new DatabaseSync(record.backup, { readOnly: true });
    assert.equal((copy.prepare('SELECT count(*) AS n FROM capture').get() as { n: number }).n, 1);
    copy.close();
  });

  test('keeps only the three newest update backups', () => {
    for (let i = 0; i < 5; i += 1) prepareUpdate(store, `99.0.${i}`, 1_000 + i * 60_000);
    const backups = readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('before-update-'));
    assert.equal(backups.length, 3);
  });

  test('notices a version change once', () => {
    store.setMeta('app.version', '0.0.1');
    assert.equal(noteRunningVersion(store), '0.0.1');
    assert.equal(store.getMeta('app.changedFrom'), '0.0.1');
    assert.equal(noteRunningVersion(store), undefined);
  });
});

describe('going back', () => {
  /** As if this version had been installed from `older()` through the app. */
  function updatedFromOlder(at: number): void {
    const record = prepareUpdate(store, APP_VERSION, at);
    const all = history(store);
    all[all.length - 1] = { ...record, from: older(), to: APP_VERSION };
    store.setMeta('updates.history', JSON.stringify(all));
  }

  test('is not offered for a version not installed through the app', () => {
    const plan = rollbackPlan(store, PRODUCT);
    assert.equal(plan.possible, false);
    assert.match(plan.reason!, /not installed through the app/);
  });

  test('needs the previous installer to have been kept', () => {
    updatedFromOlder(1_000);
    assert.match(rollbackPlan(store, PRODUCT).reason!, /was not kept/);
    keepInstaller(store, findInstallers([path.dirname(installer(path.join(dir, 'in'), older()))], PRODUCT)[0]!, PRODUCT);
    assert.equal(rollbackPlan(store, PRODUCT).possible, true);
  });

  test('is refused when the previous version could not read what this one writes', () => {
    updatedFromOlder(1_000);
    keepInstaller(store, findInstallers([path.dirname(installer(path.join(dir, 'in'), older()))], PRODUCT)[0]!, PRODUCT);
    const all = history(store);
    all[all.length - 1] = { ...all[all.length - 1]!, fromReads: [1] };
    store.setMeta('updates.history', JSON.stringify(all));
    assert.match(rollbackPlan(store, PRODUCT).reason!, /cannot read the capture files/);
  });

  test('restores the backup, keeps today\'s settings and servers, and lists captures to import again', () => {
    seedCapture('before', 500);
    updatedFromOlder(1_000);
    keepInstaller(store, findInstallers([path.dirname(installer(path.join(dir, 'in'), older()))], PRODUCT)[0]!, PRODUCT);
    // After the update: a new capture, a renamed server, a changed setting.
    seedCapture('after', 2_000);
    store.db.prepare("UPDATE server SET display_name = 'Renamed' WHERE id = 's'").run();
    settings.apply({ 'limits.busyHostPercent': 60 }, { actor: 'test' });

    const plan = rollbackPlan(store, PRODUCT);
    assert.equal(plan.capturesSince, 1);
    const staged = stageRollback(store, PRODUCT);
    assert.equal(staged.reimport, 1);

    const restored = new DatabaseSync(staged.staged, { readOnly: true });
    const captures = restored.prepare('SELECT source_name FROM capture').all() as Array<{ source_name: string }>;
    assert.deepEqual(captures.map((c) => c.source_name), ['before']);
    assert.equal((restored.prepare("SELECT display_name FROM server WHERE id = 's'").get() as { display_name: string }).display_name, 'Renamed');
    assert.equal((restored.prepare("SELECT value FROM setting WHERE key = 'limits.busyHostPercent'").get() as { value: string }).value, '60');
    restored.close();

    const list = readReimportList(store);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.file, path.join(dir, 'archive', 'after.sparkprofile'));
    assert.equal(list[0]!.serverId, 's');
  });
});
