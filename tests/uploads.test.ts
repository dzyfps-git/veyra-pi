/**
 * Importing uploads recorded in spark's activity.json.
 *
 * The activity file below has the shape of the real one: saved files from
 * harvests, uploads by the console and by a player, newest first.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { NO_MAPPINGS } from '../src/decode/mappings.ts';
import { readUploads, importUploads, CONTENT_HOST, type UploadDeps } from '../src/runtime/uploads.ts';

const NOW = 1790124600000;

const ACTIVITY = [
  { user: { type: 'other', name: 'Console' }, time: NOW - 60_000, type: 'Profiler', data: { type: 'file', value: './config/spark/profile-x.sparkprofile' } },
  { user: { type: 'other', name: 'Console' }, time: NOW - 120_000, type: 'Profiler', data: { type: 'url', value: 'https://spark.lucko.me/aB3cD4eF5g' } },
  { user: { type: 'player', name: 'PlayerOne' }, time: NOW - 3_600_000, type: 'Profiler', data: { type: 'url', value: 'https://spark.lucko.me/hIjKlMnOpQ' } },
  { user: { type: 'player', name: 'PlayerOne' }, time: NOW - 40 * 86_400_000, type: 'Profiler', data: { type: 'url', value: 'https://spark.lucko.me/oldOLDold1' } },
  { user: { type: 'player', name: 'x' }, time: NOW - 1000, type: 'Profiler', data: { type: 'url', value: 'https://evil.example/abcdefgh' } },
  { user: { type: 'player', name: 'x' }, time: NOW - 1000, type: 'Heap Summary', data: { type: 'url', value: 'https://spark.lucko.me/heapheap01' } },
];

let dir: string;
let root: string;
let store: Store;
let fetched: string[];
let ingested: Array<{ file: string; manual: boolean | undefined }>;

function deps(overrides: Partial<UploadDeps> = {}): UploadDeps {
  return {
    store,
    serverId: 's',
    serverRoot: root,
    mappings: NO_MAPPINGS,
    archiveDir: path.join(dir, 'archive'),
    archiveRaw: true,
    lookbackMs: 30 * 86_400_000,
    log: () => {},
    now: () => NOW,
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, bytes: async () => new Uint8Array([1, 2, 3]) };
    },
    ingest: (file, options) => {
      ingested.push({ file: path.basename(file), manual: options.isManual });
      return { status: 'ingested', captureId: ingested.length };
    },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-uploads-'));
  root = path.join(dir, 'server');
  mkdirSync(path.join(root, 'config', 'spark'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'spark', 'activity.json'), JSON.stringify(ACTIVITY));
  store = new Store({ file: path.join(dir, 'data', 'perfint.sqlite') });
  fetched = [];
  ingested = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('finding uploads', () => {
  test('only profiler uploads on spark.lucko.me are listed, oldest first', () => {
    const uploads = readUploads(root);
    assert.deepEqual(uploads.map((u) => u.code), ['oldOLDold1', 'hIjKlMnOpQ', 'aB3cD4eF5g']);
    assert.equal(uploads[1]!.by, 'PlayerOne');
  });

  test('a missing or broken activity file yields nothing, not an error', () => {
    writeFileSync(path.join(root, 'config', 'spark', 'activity.json'), '{ not json');
    assert.deepEqual(readUploads(root), []);
    assert.deepEqual(readUploads(path.join(dir, 'nowhere')), []);
  });
});

describe('importing', () => {
  test('recent uploads are fetched from spark and archived as manual captures', async () => {
    const result = await importUploads(deps());
    assert.equal(result.imported, 2, 'the 40-day-old link is past the lookback');
    assert.deepEqual(fetched, [CONTENT_HOST + 'hIjKlMnOpQ', CONTENT_HOST + 'aB3cD4eF5g']);
    assert.ok(ingested.every((i) => i.manual === true));
    assert.deepEqual(readdirSync(path.join(store.dataDir, 'incoming')), [], 'the staged copy is removed');
  });

  test('an upload is never fetched twice', async () => {
    await importUploads(deps());
    fetched = [];
    const again = await importUploads(deps());
    assert.equal(again.imported, 0);
    assert.deepEqual(fetched, []);
  });

  test('an expired link is recorded as gone and not retried; a network failure is retried', async () => {
    await importUploads(
      deps({
        fetch: async (url) => {
          fetched.push(url);
          return url.endsWith('hIjKlMnOpQ')
            ? { ok: false, status: 404, bytes: async () => new Uint8Array() }
            : Promise.reject(new Error('socket hang up'));
        },
      }),
    );
    fetched = [];
    await importUploads(deps());
    assert.deepEqual(fetched, [CONTENT_HOST + 'aB3cD4eF5g'], 'only the failed download is tried again');
  });

  test('something that is not a profile is remembered as such', async () => {
    const result = await importUploads(
      deps({
        ingest: () => {
          throw new Error('not a sampler payload');
        },
      }),
    );
    assert.equal(result.skipped, 2);
    const rows = store.db.prepare('SELECT status FROM upload_import').all() as Array<{ status: string }>;
    assert.ok(rows.every((r) => r.status === 'not-a-profile'));
  });
});
