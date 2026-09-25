/**
 * Keeping the archive and the server's spark folder from growing without end.
 *
 * Both cleanups delete files, so the tests are mostly about what they must
 * never delete: pinned captures, your own profiles, what going back needs,
 * anything not harvested by this app, anything not archived, anything newer
 * than the safety buffer, and anything that changed after it was checked.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { cleanupLocal, compressArchivedRaw, lastCleanup } from '../src/store/retention.ts';
import { cleanupServer } from '../src/runtime/servercleanup.ts';
import { compressRaw, readRawCapture } from '../src/ingest/pipeline.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 23, 12);

let dir: string;
let store: Store;
let settings: SettingsStore;
let season: number;
let revision: number;

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function capture(name: string, options: { ageDays: number; pinned?: boolean; manual?: boolean; ingestedAt?: number; compressed?: boolean }): { id: number; file: string } {
  const folder = path.join(dir, 'archive', 'day');
  mkdirSync(folder, { recursive: true });
  const content = Buffer.from(`raw profile ${name} `.repeat(500));
  const file = path.join(folder, `${name}${options.compressed === true ? '.sparkprofile.zst' : '.sparkprofile'}`);
  writeFileSync(file, options.compressed === true ? compressRaw(content) : content);
  const started = NOW - options.ageDays * DAY;
  const result = store.db
    .prepare(
      `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, window_count,
                            path_count, raw_bytes, ingested_at, is_manual, archive_path, sidecar_path, pinned)
       VALUES ('s',?,?,?,?,?,1,1,1,?,?,?,NULL,?)`,
    )
    .run(season, revision, name, sha(content), started, options.ingestedAt ?? started, options.manual === true ? 1 : 0, store.toStoredPath(file), options.pinned === true ? 1 : 0);
  return { id: Number(result.lastInsertRowid), file };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-retention-'));
  store = new Store({ file: path.join(dir, 'perfint.sqlite') });
  settings = new SettingsStore(store.db);
  store.upsertServer('s', 'main', 'Main');
  const env = store.upsertEnvironment({
    serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '1',
    javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
  });
  season = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
  revision = store.createRevision({
    seasonId: season, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0, reason: 'r', added: 0, removed: 0, changed: 0,
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('compressed raw captures', () => {
  test('read back byte for byte, compressed or not', () => {
    const bytes = Buffer.from('hello spark '.repeat(1000));
    const file = path.join(dir, 'x.sparkprofile.zst');
    writeFileSync(file, compressRaw(bytes));
    assert.deepEqual(readRawCapture(file), bytes);
    writeFileSync(path.join(dir, 'y.sparkprofile'), bytes);
    assert.deepEqual(readRawCapture(path.join(dir, 'y.sparkprofile')), bytes);
  });

  test('an older uncompressed capture is compressed, verified, and the database follows', () => {
    const { id, file } = capture('old', { ageDays: 1 });
    assert.equal(compressArchivedRaw(store, id), 'compressed');
    assert.equal(existsSync(file), false);
    const stored = (store.db.prepare('SELECT archive_path FROM capture WHERE id = ?').get(id) as { archive_path: string }).archive_path;
    assert.ok(stored.endsWith('.sparkprofile.zst'));
    assert.match(readRawCapture(store.resolveDataPath(stored)!).toString(), /raw profile old/);
    assert.equal(compressArchivedRaw(store, id), 'already');
  });

  test('a file that does not match its recorded hash is left alone', () => {
    const { id, file } = capture('bad', { ageDays: 1 });
    writeFileSync(file, 'tampered');
    assert.throws(() => compressArchivedRaw(store, id), /does not match/);
    assert.ok(existsSync(file));
  });
});

describe('local cleanup', () => {
  test('removes only old raw files, keeping pinned, your own, and what going back needs', () => {
    settings.apply({ 'retention.rawDays': 15 }, { actor: 'test' });
    const old = capture('old', { ageDays: 20, compressed: true });
    const recent = capture('recent', { ageDays: 3 });
    const pinned = capture('pinned', { ageDays: 40, pinned: true });
    const mine = capture('mine', { ageDays: 40, manual: true });
    const sinceUpdate = capture('since-update', { ageDays: 16, ingestedAt: NOW - 16 * DAY + 1000 });

    const summary = cleanupLocal(store, settings, { now: NOW, protectSince: NOW - 16 * DAY });
    assert.equal(summary.removed, 1);
    assert.equal(existsSync(old.file), false);
    for (const kept of [recent, pinned, mine, sinceUpdate]) assert.ok(existsSync(kept.file), kept.file);
    assert.deepEqual(
      [summary.keptPinned, summary.keptManual, summary.keptForGoingBack],
      [1, 1, 1],
    );
    const record = store.db.prepare('SELECT archive_path, source_name FROM capture WHERE id = ?').get(old.id) as { archive_path: string | null };
    assert.equal(record.archive_path, null, 'the capture stays; only its raw file goes');
    assert.equal(lastCleanup(store)?.removed, 1);
  });

  function withDetail(c: { id: number; file: string }): string {
    const file = c.file.replace(/\.sparkprofile(\.zst)?$/, '.sidecar.zst');
    writeFileSync(file, 'detail');
    store.db.prepare('UPDATE capture SET sidecar_path = ? WHERE id = ?').run(store.toStoredPath(file), c.id);
    return file;
  }
  const detailOf = (id: number): string | null =>
    (store.db.prepare('SELECT sidecar_path FROM capture WHERE id = ?').get(id) as { sidecar_path: string | null }).sidecar_path;

  test('per-minute detail expires on its own window, keeping pinned and your own', () => {
    settings.apply({ 'retention.rawDays': 15, 'retention.sidecarDays': 90 }, { actor: 'test' });
    const old = capture('old', { ageDays: 100 });
    const recent = capture('recent', { ageDays: 60 });
    const pinned = capture('pinned', { ageDays: 100, pinned: true });
    const mine = capture('mine', { ageDays: 100, manual: true });
    const [oldDetail, recentDetail, pinnedDetail, mineDetail] = [old, recent, pinned, mine].map(withDetail);

    const summary = cleanupLocal(store, settings, { now: NOW });
    assert.equal(summary.detailRemoved, 1);
    assert.equal(existsSync(oldDetail!), false);
    assert.equal(detailOf(old.id), null, 'the record stops pointing at it first');
    for (const kept of [recentDetail, pinnedDetail, mineDetail]) assert.ok(existsSync(kept!), kept);
    assert.equal(summary.removed, 2, 'raw files follow their own, shorter window');
  });

  test('0 keeps per-minute detail forever', () => {
    settings.apply({ 'retention.sidecarDays': 0 }, { actor: 'test' });
    const ancient = capture('ancient', { ageDays: 3000 });
    const detail = withDetail(ancient);
    const summary = cleanupLocal(store, settings, { now: NOW });
    assert.equal(summary.detailRemoved, 0);
    assert.ok(existsSync(detail));
    assert.notEqual(detailOf(ancient.id), null);
  });
});

describe('server cleanup', () => {
  let sparkDir: string;
  const HOUR = 3_600_000;

  function serverFile(name: string, ageHours: number, content = `profile ${name}`): string {
    const file = path.join(sparkDir, name);
    writeFileSync(file, content);
    const t = (NOW - ageHours * HOUR) / 1000;
    utimesSync(file, t, t);
    return file;
  }
  function harvested(name: string, content: string, archived = true): void {
    store.db
      .prepare(`INSERT INTO server_action (server_id, at, action, target, sha256, dry_run, outcome, detail) VALUES ('s', ?, 'verify', ?, ?, 0, 'match', '')`)
      .run(NOW - 50 * HOUR, name, sha(content));
    if (archived) {
      store.db
        .prepare(
          `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, window_count,
                                path_count, raw_bytes, ingested_at, is_manual) VALUES ('s',?,?,?,?,0,1,1,1,0,0)`,
        )
        .run(season, revision, name, sha(content));
    }
  }

  beforeEach(() => {
    sparkDir = path.join(dir, 'server', 'config', 'spark');
    mkdirSync(sparkDir, { recursive: true });
    settings.apply({ 'cleanup.server.retentionHours': 48 }, { actor: 'test' });
  });

  const A = 'profile-2026-09-20_10.00.00.sparkprofile';
  const B = 'profile-2026-09-20_11.00.00.sparkprofile';
  const C = 'profile-2026-09-20_12.00.00.sparkprofile';
  const D = 'profile-2026-09-23_11.00.00.sparkprofile';

  test('a dry run reports and deletes nothing', () => {
    serverFile(A, 72);
    harvested(A, `profile ${A}`);
    const r = cleanupServer(store, settings, { id: 's', sparkDirLocal: sparkDir }, { now: NOW, dryRun: true });
    assert.deepEqual(r.removed, [A]);
    assert.ok(existsSync(path.join(sparkDir, A)));
  });

  test('removes only old files this app harvested and archived', () => {
    serverFile(A, 72);
    harvested(A, `profile ${A}`);
    serverFile(B, 72); // yours: never harvested
    serverFile(C, 72);
    harvested(C, `profile ${C}`, false); // harvested but not in the archive
    serverFile(D, 1);
    harvested(D, `profile ${D}`); // inside the safety buffer
    writeFileSync(path.join(sparkDir, 'config.json'), '{}');
    writeFileSync(path.join(sparkDir, 'activity.json'), '[]');

    const r = cleanupServer(store, settings, { id: 's', sparkDirLocal: sparkDir }, { now: NOW, dryRun: false });
    assert.deepEqual(r.removed, [A]);
    assert.equal(existsSync(path.join(sparkDir, A)), false);
    for (const kept of [B, C, D, 'config.json', 'activity.json']) assert.ok(existsSync(path.join(sparkDir, kept)), kept);
    assert.deepEqual([r.keptNotOurs, r.keptNotArchived, r.keptRecent], [1, 1, 1]);
    const audited = store.db.prepare("SELECT outcome FROM server_action WHERE action = 'cleanup'").all() as Array<{ outcome: string }>;
    assert.deepEqual(audited.map((a) => a.outcome), ['deleted']);
  });

  test('a file whose content changed since the harvest is kept', () => {
    serverFile(A, 72, 'something else now');
    harvested(A, `profile ${A}`);
    const r = cleanupServer(store, settings, { id: 's', sparkDirLocal: sparkDir }, { now: NOW, dryRun: false });
    assert.deepEqual(r.removed, []);
    assert.equal(r.failed.length, 1);
    assert.ok(existsSync(path.join(sparkDir, A)));
  });

  test('server cleanup is off on a fresh install, and deletes for real once switched on', () => {
    assert.equal(settings.getBoolean('cleanup.server.enabled'), false);
    assert.equal(settings.getBoolean('cleanup.server.dryRun'), false);
  });
});
