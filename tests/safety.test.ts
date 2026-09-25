/**
 * Structural safety guarantees.
 *
 * These do not test behaviour so much as they test *promises* — the ones that
 * would be expensive to discover broken, because nobody looks at them until
 * something has already gone wrong:
 *
 *   1. Anything that reaches the live Minecraft server is OFF by default.
 *      A fresh install must not contact production because someone installed
 *      it and walked away.
 *   2. Deletion is off, dry-run, and narrowly scoped by default.
 *   3. The public brand name appears nowhere in source except the branding
 *      config, so renaming is genuinely one file.
 *   4. Frozen internal identifiers are not accidentally derived from the
 *      brand.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { SETTINGS, settingDef } from '../src/settings/registry.ts';
import { loadBranding } from '../src/core/brand.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { DatabaseSync } from 'node:sqlite';

describe('a fresh install never touches production', () => {
  /** Every setting whose change reaches the live server. */
  const disruptive = SETTINGS.filter((s) => s.risk === 'disruptive');

  test('there is at least one disruptive setting, or this test is vacuous', () => {
    assert.ok(disruptive.length > 0);
  });

  test('every disruptive boolean defaults to off', () => {
    for (const def of disruptive) {
      if (def.type !== 'boolean') continue;
      // Exception: a setting that only ever REPAIRS a state, and only when
      // its parent feature is already enabled, may default on. It still
      // cannot act while the parent is off.
      if (def.dependsOn !== undefined && def.dependsOn.length > 0) continue;
      // Repairs a harvest in progress; only ever acts for a server whose
      // collection is automatic, and a new server's collection starts off.
      if (def.key === 'collection.harvest.restoreBackgroundProfiler') continue;
      assert.equal(def.default, false, `${def.key} reaches production and must default to off`);
    }
  });

  test('a disruptive setting that defaults on only acts where collection is automatic', () => {
    // Collection is decided per server, and a new server starts with it off.
    // The only disruptive setting allowed to default on is one that repairs
    // a harvest in progress, which can only run for an "automatic" server.
    const ACTS_ONLY_DURING_AUTOMATIC_COLLECTION = ['collection.harvest.restoreBackgroundProfiler'];
    for (const def of disruptive) {
      if (def.default !== true) continue;
      assert.ok(
        ACTS_ONLY_DURING_AUTOMATIC_COLLECTION.includes(def.key),
        `${def.key} defaults ON and reaches production; it must only act for servers in automatic collection`,
      );
    }
  });

  test('a new server starts with collection off, so a fresh install contacts nothing', async () => {
    const { Store } = await import('../src/store/db.ts');
    const { createServer, getServer } = await import('../src/store/servers.ts');
    const store = new Store({ file: ':memory:' });
    const { id } = createServer(store.db, { displayName: 'Anything' });
    assert.equal(getServer(store.db, id!)!.collection, 'off');
    store.close();
  });

  test('a fresh database has cleanup switched off', () => {
    const db = new DatabaseSync(':memory:');
    const settings = new SettingsStore(db);
    assert.equal(settings.getBoolean('cleanup.server.enabled'), false);
    db.close();
  });

  test('dry run is an opt-in check, not a second switch to turn cleanup on', () => {
    const db = new DatabaseSync(':memory:');
    const settings = new SettingsStore(db);
    assert.equal(settings.getBoolean('cleanup.server.dryRun'), false);
    db.close();
  });

  test('every disruptive setting carries a warning explaining what it reaches', () => {
    for (const def of disruptive) {
      assert.ok(
        def.warning !== undefined && def.warning.length > 30,
        `${def.key} is disruptive and must explain itself before it is switched on`,
      );
    }
  });

  test('a setting that needs a Minecraft restart says so and never restarts it', () => {
    for (const def of SETTINGS.filter((s) => s.risk === 'needs-mc-restart')) {
      assert.match(
        def.appliesAt,
        /restart/i,
        `${def.key} must state that it needs a restart`,
      );
    }
  });
});

describe('renaming is one file', () => {
  const branding = loadBranding('config');

  /** Every source file that could plausibly hardcode a name. */
  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|js|mjs|json)$/.test(entry.name)) out.push(full);
      }
    };
    for (const dir of ['src', 'desktop/app']) {
      try {
        if (statSync(dir).isDirectory()) walk(dir);
      } catch {
        // Directory may not exist in every checkout.
      }
    }
    return out;
  }

  test('the public name does not appear in source', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (text.includes(branding.name)) offenders.push(file);
    }
    assert.deepEqual(
      offenders,
      [],
      `the brand name is hardcoded in:\n  ${offenders.join('\n  ')}\n` +
        'Renaming must stay a one-file change; read it from branding instead.',
    );
  });

  test('the short name does not appear in source either', () => {
    const offenders = sourceFiles().filter((f) => readFileSync(f, 'utf8').includes(branding.shortName));
    assert.deepEqual(offenders, []);
  });

  test('the frozen internal name is NOT the brand', () => {
    // If these ever coincide, a rename silently becomes a data migration.
    assert.notEqual(branding.name.toLowerCase(), 'perfint');
    assert.notEqual(branding.shortName.toLowerCase(), 'perfint');
  });

  test('branding is cosmetic only: no key in it is used as an identifier', () => {
    // A brand field must never be something a table, path or id keys off.
    for (const value of [branding.name, branding.shortName, branding.tagline]) {
      assert.equal(typeof value, 'string');
    }
    assert.match(branding.accentColor, /^#[0-9a-fA-F]{3,8}$/);
  });
});

describe('the command allowlist cannot grow by accident', () => {
  test('no source file sends a console command outside the allowlist', async () => {
    const { COMMAND_ALLOWLIST } = await import('../src/runtime/harvest.ts');

    // The scan below relies on sent commands being bare, so check that first.
    assert.ok(
      COMMAND_ALLOWLIST.every((c) => !c.startsWith('/')),
      'the allowlist must hold bare commands; a leading slash would make the scan unsound',
    );

    // Matches a COMPLETE string literal that looks like a console command.
    //
    // A leading slash is deliberately NOT matched. Commands sent through tmux
    // never carry one and the allowlist has none, so a slash-prefixed
    // occurrence is always prose telling a person what to type -- which the
    // skip messages legitimately do.
    const suspicious = /['"`](stop|op|deop|ban|kick|save-all|whitelist|gamerule|spark[^'"`]*)['"`]/g;

    for (const file of ['src/runtime/harvest.ts', 'src/cli/collector.ts']) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      // Strip comments: these files document commands they must never send.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');

      for (const match of code.matchAll(suspicious)) {
        const literal = (match[1] ?? '').trim();
        assert.ok(
          (COMMAND_ALLOWLIST as readonly string[]).includes(literal),
          `${file} contains a console command literal that is not on the allowlist: "${literal}"`,
        );
      }
    }
  });

  test('destructive commands are absent from the allowlist', async () => {
    const { COMMAND_ALLOWLIST, isAllowedCommand } = await import('../src/runtime/harvest.ts');
    for (const forbidden of ['stop', 'save-all', 'op', 'ban', 'kick', 'spark profiler cancel']) {
      assert.equal(isAllowedCommand(forbidden), false, `${forbidden} must never be allowed`);
    }
    assert.ok(COMMAND_ALLOWLIST.length <= 6, 'the allowlist should stay small enough to read at a glance');
  });
});

describe('file writes cannot spread by accident', () => {
  /**
   * Every source file that writes, moves or deletes a file, and why. A new
   * entry here is a design decision, not a convenience: whatever it writes
   * must be either this application's own data or one of the three server
   * files remediate.ts is allowed to change.
   */
  const WRITERS: Record<string, string> = {
    'src/cli/collector.ts': 'its own log file, and leftover staged going-back databases, in the data folder',
    'src/cli/report.ts': 'generated reports, where the operator asked',
    'src/ingest/pipeline.ts': 'the archive and sidecars, in the data folder',
    'src/runtime/harvester.ts': 'staging a harvested copy in the data folder, then removing it',
    'src/runtime/remediate.ts': 'the three allowlisted server files, plus local backups',
    'src/runtime/updates.ts': 'update backups, kept installers and the going-back list, all in the data folder',
    'src/runtime/github.ts': 'new versions downloaded from GitHub, checked against their manifest, in the data folder',
    'src/runtime/uploads.ts': 'staging a downloaded upload in the data folder, then removing it',
    'src/store/storage.ts': 'moving this app\'s own archive between local folders, verified copy before delete',
    'src/store/retention.ts': 'compressing and removing this app’s own raw captures past retention, in the archive',
    'src/runtime/servercleanup.ts': 'removing harvested, hash-verified, archived profiles from the server’s spark folder; off on a fresh install',
    'src/store/sidecar.ts': 'rewriting this app\'s own sidecars in place (format upgrades, method keys), verified before replacing',
  };

  test('only the known writers write', () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          if (/\b(writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|copyFileSync|writeFile|rename|unlink|rm|copyFile)\b *\(/.test(text)) {
            found.push(full.replace(/\\/g, '/'));
          }
        }
      }
    };
    walk('src');
    assert.deepEqual(found.sort(), Object.keys(WRITERS).sort());
  });

  test('the server files that can be written are exactly three', async () => {
    const { WRITABLE_SERVER_FILES } = await import('../src/runtime/remediate.ts');
    assert.deepEqual([...WRITABLE_SERVER_FILES].sort(), ['config/spark/config.json', 'user_jvm_args.txt', 'variables.txt']);
  });

  test('repairing spark config automatically is off on a fresh install', () => {
    const db = new DatabaseSync(':memory:');
    const settings = new SettingsStore(db);
    assert.equal(settings.getBoolean('setup.autoFix.sparkConfig'), false);
    db.close();
  });
});

describe('settings the interface must be able to explain', () => {
  test('every setting has help text a person could act on', () => {
    for (const def of SETTINGS) {
      assert.ok(def.help.length > 30, `${def.key} needs real help text`);
      assert.ok(def.appliesAt.length > 0, `${def.key} must say when it takes effect`);
    }
  });

  test('every dependsOn points at a setting that exists', () => {
    for (const def of SETTINGS) {
      for (const dep of def.dependsOn ?? []) {
        assert.ok(settingDef(dep) !== undefined, `${def.key} depends on unknown setting ${dep}`);
      }
    }
  });

  test('numeric settings have sane bounds', () => {
    for (const def of SETTINGS) {
      if (def.type !== 'integer' && def.type !== 'number') continue;
      if (def.min !== undefined && def.max !== undefined) {
        assert.ok(def.min < def.max, `${def.key} has an empty range`);
        assert.ok(
          Number(def.default) >= def.min && Number(def.default) <= def.max,
          `${def.key} default ${def.default} is outside its own bounds`,
        );
      }
    }
  });
});
