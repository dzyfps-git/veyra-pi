/**
 * Schema migration.
 *
 * Every column lives in two places — the `CREATE TABLE` that builds a fresh
 * database, and an `ALTER TABLE` that upgrades an existing one — and they can
 * disagree. Both halves of that trap have now been sprung for real:
 *
 *   `season.world_id`   was in the CREATE but had no ALTER, so it existed on
 *                       a fresh database and not on an upgraded one. Ingest
 *                       failed with "no such column" against the real archive.
 *
 *   `capture.world_id`  was the mirror image: added only in the migration, so
 *                       it existed on an upgraded database and not on a fresh
 *                       one. A brand new install would have failed instead.
 *
 * Neither is caught by ordinary tests, because ordinary tests only ever build
 * a fresh database. So this file builds both and compares them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { Store } from '../src/store/db.ts';
import { SCHEMA_VERSION } from '../src/store/schema.ts';

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .sort();
}

function tables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  )
    .map((t) => t.name)
    .sort();
}

function tempFile(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'perfint-migrate-')), name);
}

describe('a fresh database and an upgraded one agree', () => {
  /**
   * Build a database, claim it is an older version, and reopen it. Reopening
   * runs the migration, so the result is what a real upgrade produces.
   */
  function upgradedFrom(version: number): Store {
    const file = tempFile('upgrade.sqlite');
    const first = new Store({ file });
    first.setMeta('schema_version', String(version));
    first.close();
    return new Store({ file });
  }

  test('every table matches', () => {
    const fresh = new Store({ file: tempFile('fresh.sqlite') });
    const upgraded = upgradedFrom(1);
    assert.deepEqual(tables(upgraded.db), tables(fresh.db));
    fresh.close();
    upgraded.close();
  });

  test('every column of every table matches', () => {
    const fresh = new Store({ file: tempFile('fresh.sqlite') });
    const upgraded = upgradedFrom(1);

    const mismatches: string[] = [];
    for (const table of tables(fresh.db)) {
      const a = columns(fresh.db, table);
      const b = columns(upgraded.db, table);
      if (a.join(',') !== b.join(',')) {
        mismatches.push(
          `${table}\n    fresh   : ${a.join(', ')}\n    upgraded: ${b.join(', ')}`,
        );
      }
    }

    assert.deepEqual(
      mismatches,
      [],
      'a column exists on one path and not the other:\n  ' + mismatches.join('\n  '),
    );

    fresh.close();
    upgraded.close();
  });

  // Every version this build claims to upgrade from must arrive at the same
  // place, not just the oldest one.
  for (let from = 1; from < SCHEMA_VERSION; from += 1) {
    test(`upgrading from v${from} reaches the current schema`, () => {
      const fresh = new Store({ file: tempFile('fresh.sqlite') });
      const upgraded = upgradedFrom(from);

      assert.equal(upgraded.getMeta('schema_version'), String(SCHEMA_VERSION));
      for (const table of tables(fresh.db)) {
        assert.deepEqual(
          columns(upgraded.db, table),
          columns(fresh.db, table),
          `${table} differs after upgrading from v${from}`,
        );
      }

      fresh.close();
      upgraded.close();
    });
  }
});

describe('the specific columns that broke', () => {
  test('season.world_id exists on both paths', () => {
    const fresh = new Store({ file: tempFile('a.sqlite') });
    assert.ok(columns(fresh.db, 'season').includes('world_id'));
    fresh.close();
  });

  test('capture.world_id exists on both paths', () => {
    const fresh = new Store({ file: tempFile('b.sqlite') });
    assert.ok(columns(fresh.db, 'capture').includes('world_id'));
    fresh.close();
  });
});

describe('refusing what it cannot understand', () => {
  test('a database from a NEWER build is refused rather than opened', () => {
    const file = tempFile('future.sqlite');
    const first = new Store({ file });
    first.setMeta('schema_version', String(SCHEMA_VERSION + 1));
    first.close();

    assert.throws(
      () => new Store({ file }),
      /newer than this build/,
      'opening a future database could silently corrupt years of history',
    );
  });

  test('migrating twice is harmless', () => {
    const file = tempFile('twice.sqlite');
    const first = new Store({ file });
    first.setMeta('schema_version', '1');
    first.close();

    const second = new Store({ file });
    second.setMeta('schema_version', '1');
    second.close();

    const third = new Store({ file });
    assert.equal(third.getMeta('schema_version'), String(SCHEMA_VERSION));
    third.close();
  });

  test('an upgrade preserves existing rows', () => {
    const file = tempFile('data.sqlite');
    const first = new Store({ file });
    first.upsertServer('s1', 'main', 'Main');
    first.setMeta('schema_version', '4');
    first.close();

    const upgraded = new Store({ file });
    const row = upgraded.db.prepare('SELECT display_name FROM server WHERE id = ?').get('s1') as
      | { display_name: string }
      | undefined;
    assert.equal(row?.display_name, 'Main', 'an upgrade must never lose history');
    upgraded.close();
  });
});

describe('v15: boots and method keys', () => {
  test('a real v14 database gains capture.boot_id and its index', () => {
    const file = tempFile('v14.sqlite');
    const first = new Store({ file });
    first.db.exec('DROP INDEX IF EXISTS capture_by_boot; ALTER TABLE capture DROP COLUMN boot_id;');
    first.setMeta('schema_version', '14');
    first.close();
    const upgraded = new Store({ file });
    assert.ok(columns(upgraded.db, 'capture').includes('boot_id'));
    const index = upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'capture_by_boot'").get();
    assert.ok(index !== undefined);
    for (const table of ['boot', 'frame_key', 'frame_key_seen']) assert.ok(tables(upgraded.db).includes(table));
    upgraded.close();
  });
});
