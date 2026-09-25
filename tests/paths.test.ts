import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ServerFileGuard, PathGuardError, isWithin } from '../src/core/paths.ts';

const MANAGED = /^profile-\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}\.sparkprofile$/;

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'perfint-guard-'));
  mkdirSync(path.join(root, 'config', 'spark'), { recursive: true });
  mkdirSync(path.join(root, 'mods'), { recursive: true });
  mkdirSync(path.join(root, 'world'), { recursive: true });
  writeFileSync(path.join(root, 'world', 'level.dat'), 'precious');
  writeFileSync(path.join(root, 'mods', 'some-mod.jar'), 'precious');
  writeFileSync(path.join(root, 'config', 'spark', 'profile-2026-09-21_22.57.00.sparkprofile'), 'data');
  writeFileSync(path.join(root, 'config', 'spark', 'config.json'), '{}');
  writeFileSync(path.join(root, 'config', 'spark', 'activity.json'), '{}');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function guard(writeScope: string[] = ['config/spark']): ServerFileGuard {
  return new ServerFileGuard({ root, writeScope, managedFilePattern: MANAGED });
}

describe('isWithin', () => {
  test('identical paths are contained', () => {
    assert.equal(isWithin('/a/b', '/a/b'), true);
  });

  test('nested paths are contained', () => {
    assert.equal(isWithin('/a/b', '/a/b/c/d.txt'), true);
  });

  test('sibling prefix is NOT contained (the classic string-prefix bug)', () => {
    assert.equal(isWithin('/a/b', '/a/bc'), false);
  });

  test('parent is not contained in child', () => {
    assert.equal(isWithin('/a/b/c', '/a/b'), false);
  });
});

describe('ServerFileGuard construction', () => {
  test('rejects an absolute writeScope entry', () => {
    assert.throws(() => guard(['C:/Windows']), PathGuardError);
  });

  test('rejects a writeScope entry that escapes the root', () => {
    assert.throws(() => guard(['../elsewhere']), PathGuardError);
  });

  test('empty writeScope means read-only', () => {
    assert.equal(guard([]).isReadOnly, true);
  });
});

describe('deletion guard', () => {
  test('allows a managed file inside writeScope', () => {
    const resolved = guard().resolveForDelete('config/spark/profile-2026-09-21_22.57.00.sparkprofile');
    assert.ok(resolved.endsWith('profile-2026-09-21_22.57.00.sparkprofile'));
  });

  test('refuses traversal out of writeScope', () => {
    assert.throws(
      () => guard().resolveForDelete('config/spark/../../world/level.dat'),
      (e: unknown) => e instanceof PathGuardError && /writeScope/.test(e.reason),
    );
  });

  test('refuses a path inside the root but outside writeScope', () => {
    assert.throws(() => guard().resolveForDelete('mods/some-mod.jar'), PathGuardError);
  });

  test("refuses spark's own config.json -- right directory, unmanaged name", () => {
    assert.throws(
      () => guard().resolveForDelete('config/spark/config.json'),
      (e: unknown) => e instanceof PathGuardError && /managed pattern/.test(e.reason),
    );
  });

  test("refuses spark's activity.json", () => {
    assert.throws(() => guard().resolveForDelete('config/spark/activity.json'), PathGuardError);
  });

  test('refuses an absolute path outside the server entirely', () => {
    assert.throws(() => guard().resolveForDelete('C:/Windows/System32/drivers/etc/hosts'), PathGuardError);
  });

  test('refuses a nonexistent file', () => {
    assert.throws(
      () => guard().resolveForDelete('config/spark/profile-2000-01-01_00.00.00.sparkprofile'),
      (e: unknown) => e instanceof PathGuardError && /does not exist/.test(e.reason),
    );
  });

  test('a read-only server refuses every delete', () => {
    assert.throws(
      () => guard([]).resolveForDelete('config/spark/profile-2026-09-21_22.57.00.sparkprofile'),
      (e: unknown) => e instanceof PathGuardError && /read-only/.test(e.reason),
    );
  });

  test('refuses a symlink planted inside writeScope', (t) => {
    const link = path.join(root, 'config', 'spark', 'profile-2026-09-21_23.00.00.sparkprofile');
    try {
      symlinkSync(path.join(root, 'world', 'level.dat'), link);
    } catch {
      // Windows needs Developer Mode or elevation to create symlinks.
      t.skip('symlink creation not permitted on this host');
      return;
    }
    try {
      assert.throws(
        () => guard().resolveForDelete('config/spark/profile-2026-09-21_23.00.00.sparkprofile'),
        (e: unknown) => e instanceof PathGuardError && /symbolic link/.test(e.reason),
      );
    } finally {
      rmSync(link, { force: true });
    }
  });
});

describe('symlinked-parent escape (directory junction)', () => {
  // File symlinks need elevation on Windows, but directory junctions do not.
  // This exercises the realpath re-check: a *parent* component inside
  // writeScope that redirects out of it.
  test('refuses a managed filename reached through a junction', (t) => {
    const junction = path.join(root, 'config', 'spark', 'sneaky');
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', junction, path.join(root, 'world')], {
      stdio: 'ignore',
    });
    if (r.status !== 0) {
      t.skip('could not create a directory junction on this host');
      return;
    }
    try {
      writeFileSync(path.join(root, 'world', 'profile-2026-09-21_23.30.00.sparkprofile'), 'decoy');
      assert.throws(
        () => guard().resolveForDelete('config/spark/sneaky/profile-2026-09-21_23.30.00.sparkprofile'),
        (e: unknown) => e instanceof PathGuardError && /escapes writeScope/.test(e.reason),
      );
    } finally {
      spawnSync('cmd', ['/c', 'rmdir', junction], { stdio: 'ignore' });
    }
  });
});

describe('read guard', () => {
  test('allows reads anywhere under the root', () => {
    assert.ok(guard().resolveForRead('logs/latest.log'));
    assert.ok(guard().resolveForRead('config/spark/config.json'));
  });

  test('refuses reads outside the root', () => {
    assert.throws(() => guard().resolveForRead('../../../etc/passwd'), PathGuardError);
  });
});
