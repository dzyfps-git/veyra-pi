/**
 * Where things are kept, and moving the archive.
 *
 * The move is the one operation here that deletes the user's own history
 * files, so the tests are about the order of things: nothing removed until
 * every copy verified and the database points at the copies; any refusal
 * leaves everything exactly where it was.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { archiveDirOf, moveArchive, storageSummary, diskFloorProblem } from '../src/store/storage.ts';
import { SETTINGS } from '../src/settings/registry.ts';
import { settingsPage } from '../src/web/pages/settings.ts';

let dir: string;
let store: Store;
let settings: SettingsStore;

function seedCapture(day: string, name: string): { raw: string; sidecar: string } {
  const archive = archiveDirOf(store, settings);
  const folder = path.join(archive, day);
  mkdirSync(folder, { recursive: true });
  const raw = path.join(folder, `${name}.sparkprofile`);
  const sidecar = path.join(folder, `${name}.sidecar.zst`);
  writeFileSync(raw, `raw ${name}`);
  writeFileSync(sidecar, `sidecar ${name}`);
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
       VALUES ('s',?,?,?,?,0,1,1,1,1,0,?,?)`,
    )
    .run(season, revision, name, `sha-${name}`, store.toStoredPath(raw), store.toStoredPath(sidecar));
  return { raw, sidecar };
}

const stored = (): Array<{ archive_path: string; sidecar_path: string }> =>
  store.db.prepare('SELECT archive_path, sidecar_path FROM capture ORDER BY id').all() as Array<{
    archive_path: string;
    sidecar_path: string;
  }>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-storage-'));
  store = new Store({ file: path.join(dir, 'data', 'perfint.sqlite') });
  settings = new SettingsStore(store.db);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('where things are', () => {
  test('the archive defaults to a real folder inside the data folder', () => {
    assert.equal(archiveDirOf(store, settings), path.join(store.dataDir, 'archive'));
    assert.ok(path.isAbsolute(archiveDirOf(store, settings)));
  });

  test('the summary counts raw profiles and detail files separately', () => {
    seedCapture('2026-09-20', 'a');
    seedCapture('2026-09-21', 'b');
    const summary = storageSummary(store, settings);
    assert.equal(summary.rawProfiles.files, 2);
    assert.equal(summary.sidecars.files, 2);
    assert.ok(summary.freeBytesAtArchive !== undefined && summary.freeBytesAtArchive > 0);
  });

  test('the disk floor only speaks up when space is actually short', () => {
    assert.equal(diskFloorProblem(store, settings), undefined);
    settings.apply({ 'storage.minFreeGb': 1000 }, { actor: 'test' });
    // A temp folder with a terabyte free would make this vacuous; only assert
    // the message shape when the floor is really crossed.
    const problem = diskFloorProblem(store, settings);
    if (problem !== undefined) assert.match(problem, /the floor is 1000 GB/);
  });
});

describe('moving the archive', () => {
  test('every file moves, the database follows, and the old copies go', () => {
    const a = seedCapture('2026-09-20', 'a');
    const b = seedCapture('2026-09-21', 'b');
    const target = path.join(dir, 'elsewhere', 'archive');

    const result = moveArchive(store, settings, target);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.moved, 4);
    assert.equal(archiveDirOf(store, settings), target);

    for (const row of stored()) {
      assert.ok(path.isAbsolute(row.archive_path), 'outside the data folder, paths are stored in full');
      assert.equal(readFileSync(row.archive_path, 'utf8').startsWith('raw '), true);
      assert.equal(readFileSync(row.sidecar_path, 'utf8').startsWith('sidecar '), true);
    }
    for (const old of [a.raw, a.sidecar, b.raw, b.sidecar]) assert.equal(existsSync(old), false);
    assert.equal(existsSync(path.join(store.dataDir, 'archive')), false, 'empty folders left behind are tidied');
  });

  test('moving back to the default stores "default" again', () => {
    seedCapture('2026-09-20', 'a');
    assert.equal(moveArchive(store, settings, path.join(dir, 'away')).ok, true);
    const back = moveArchive(store, settings, path.join(store.dataDir, 'archive'));
    assert.equal(back.ok, true, back.error);
    assert.equal(settings.getString('storage.archiveDir'), '');
    assert.ok(!path.isAbsolute(stored()[0]!.archive_path), 'inside the data folder, paths are relative again');
  });

  test('refusals leave everything exactly where it was', () => {
    const a = seedCapture('2026-09-20', 'a');
    const busy = path.join(dir, 'busy');
    mkdirSync(busy);
    writeFileSync(path.join(busy, 'someone-elses-file.txt'), 'x');
    const before = stored();

    for (const [target, why] of [
      ['relative\\path', /full folder path/],
      [busy, /not empty/],
      [path.join(archiveDirOf(store, settings), 'inside'), /inside the current archive/],
      [store.dataDir, /cannot contain|data folder itself/],
    ] as const) {
      const result = moveArchive(store, settings, target);
      assert.equal(result.ok, false, String(target));
      assert.match(result.error ?? '', why);
    }
    assert.deepEqual(stored(), before);
    assert.equal(existsSync(a.raw), true);
    assert.deepEqual(readdirSync(busy), ['someone-elses-file.txt']);
    assert.equal(settings.getString('storage.archiveDir'), '');
  });
});

describe('the settings page tells the truth', () => {
  test('no removed or placeholder storage setting survives', () => {
    const keys = SETTINGS.map((s) => s.key);
    assert.ok(!keys.includes('storage.dataDir'), 'the data folder is chosen by the desktop app, not a setting');
    assert.ok(!keys.includes('server.source.transport'));
  });

  test('settings nothing acts on are listed as planned, not shown as controls', () => {
    const html = settingsPage(settings, false, store);
    for (const def of SETTINGS.filter((s) => s.planned !== undefined)) {
      assert.ok(!html.includes(`data-key="${def.key}"`), `${def.key} must not render as a control`);
    }
    assert.match(html, /Planned, not active yet/);
  });

  test('storage shows real, full locations', () => {
    const html = settingsPage(settings, false, store);
    assert.ok(html.includes(path.join(store.dataDir, 'archive').replaceAll('&', '&amp;')));
    assert.doesNotMatch(html, /value="data\/archive"/);
  });
});
