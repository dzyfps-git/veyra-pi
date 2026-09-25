/**
 * Servers as separate things: configuration, the upgrade, and watch mode.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/store/db.ts';
import {
  createServer,
  defaultServerId,
  getServer,
  listServers,
  updateServer,
  validateServer,
} from '../src/store/servers.ts';
import { scanWatchedFolder } from '../src/runtime/watch.ts';
import { NO_MAPPINGS } from '../src/decode/mappings.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perfint-servers-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('upgrading a single-server install', () => {
  test('the server takes over the old settings, so collection carries on unchanged', () => {
    const file = path.join(dir, 'old.sqlite');
    const store = new Store({ file });
    store.upsertServer('s1', 'main', 'Veyra Main');
    store.close();

    // Make it look like v11 with the old global settings saved.
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`);
    for (const [k, v] of [
      ['collection.harvest.enabled', true],
      ['server.source.root', 'S:/'],
      ['server.control.sshHost', 'mc'],
      ['server.control.tmuxTarget', 'mc'],
      ['server.minecraft.host', '192.168.1.20'],
    ] as const) {
      raw.prepare('INSERT INTO setting VALUES (?,?,0,NULL)').run(k, JSON.stringify(v));
    }
    raw.prepare("UPDATE schema_meta SET value = '11' WHERE key = 'schema_version'").run();
    raw.exec("UPDATE server SET collection = 'off', root = ''");
    raw.close();

    const upgraded = new Store({ file });
    const server = getServer(upgraded.db, 's1')!;
    assert.equal(server.collection, 'automatic');
    assert.equal(server.root, 'S:/');
    assert.equal(server.mcHost, '192.168.1.20');
    assert.equal(server.kind, 'production');
    upgraded.close();
  });
});

describe('configuring servers', () => {
  test('a staging server is created switched off and visible', () => {
    const store = new Store({ file: ':memory:' });
    const { id, errors } = createServer(store.db, { displayName: 'Staging', root: 'D:/staging/mypack' });
    assert.deepEqual(errors, []);
    const s = getServer(store.db, id!)!;
    assert.equal(s.collection, 'off');
    assert.equal(s.kind, 'staging');
    assert.equal(s.visible, true);
    assert.equal(s.slug, 'staging');
    store.close();
  });

  test('modes refuse to switch on without what they need', () => {
    assert.match(validateServer({ collection: 'watch', root: '' }).join(' '), /server folder/);
    assert.match(validateServer({ collection: 'automatic', root: 'S:/' }).join(' '), /SSH host and tmux/);
    assert.deepEqual(validateServer({ collection: 'automatic', root: 'S:/', sshHost: 'mc', tmuxTarget: 'mc' }), []);
  });

  test('nothing that reaches a shell can be smuggled in', () => {
    assert.ok(validateServer({ sshHost: 'mc; rm -rf /' }).length > 0);
    assert.ok(validateServer({ tmuxTarget: 'mc$(reboot)' }).length > 0);
  });

  test('hiding a server keeps it, and the default view skips it', () => {
    const store = new Store({ file: ':memory:' });
    const a = createServer(store.db, { displayName: 'Main', kind: 'production' }).id!;
    const b = createServer(store.db, { displayName: 'Staging' }).id!;
    assert.equal(defaultServerId(store.db), a);
    updateServer(store.db, a, { visible: false });
    assert.equal(defaultServerId(store.db), b);
    assert.equal(listServers(store.db).length, 2, 'hidden is not deleted');
    assert.equal(listServers(store.db, { visibleOnly: true }).length, 1);
    store.close();
  });
});

describe('watch mode', () => {
  test('a saved profile is imported once it has settled, and only once', () => {
    const store = new Store({ file: path.join(dir, 'p.sqlite') });
    const id = createServer(store.db, { displayName: 'Staging', root: path.join(dir, 'server') }).id!;
    const spark = path.join(dir, 'server', 'config', 'spark');
    mkdirSync(spark, { recursive: true });
    const file = path.join(spark, 'profile-2026-09-22_20.00.00.sparkprofile');
    writeFileSync(file, 'bytes');
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));

    const imported: string[] = [];
    let clock = 0;
    const deps = {
      store, serverId: id, serverRoot: path.join(dir, 'server'), sparkDir: 'config/spark', mappings: NO_MAPPINGS,
      archiveDir: path.join(dir, 'archive'), archiveRaw: true, pending: new Map(), settleMs: 20_000,
      now: () => clock, log: () => {},
      ingest: (f: string, options: { isManual?: boolean }) => {
        imported.push(path.basename(f));
        assert.equal(options.isManual, true);
        return { status: 'ingested', captureId: 1 };
      },
    };

    scanWatchedFolder(deps as never);
    assert.deepEqual(imported, [], 'first sighting only');
    clock = 10_000;
    scanWatchedFolder(deps as never);
    assert.deepEqual(imported, [], 'not settled yet');
    clock = 30_000;
    scanWatchedFolder(deps as never);
    assert.deepEqual(imported, ['profile-2026-09-22_20.00.00.sparkprofile']);
    clock = 90_000;
    scanWatchedFolder(deps as never);
    scanWatchedFolder(deps as never);
    assert.equal(imported.length, 1, 'never twice');
    store.close();
  });
});
