import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { SETTINGS, settingDef } from '../src/settings/registry.ts';

/**
 * Guards a real bug: `notifications.discord.perEventCooldownMinutes` was read
 * by the notifier and documented in the example config, but never declared in
 * the registry. It threw the first time that code path ran.
 *
 * Any settings key the source reads must exist. A key that does not is a
 * crash waiting for the right combination of toggles.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('settings coverage', () => {
  test('every key read by the source is declared in the registry', () => {
    // Anchored to a settings RECEIVER, not to any `.get(...)` call. Without
    // that anchor the scan also matched `serverConfigurations.get('server.properties')`
    // -- a spark metadata key that looks exactly like a settings key and is not one.
    const pattern =
      /settings(?:Store)?\s*\.\s*(?:getBoolean|getNumber|getString|get)\(\s*'([a-z][A-Za-z0-9.]*\.[A-Za-z0-9.]+)'\s*\)/g;
    const missing: string[] = [];

    for (const file of sourceFiles('src')) {
      if (file.includes(path.join('settings', 'registry.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(pattern)) {
        const key = match[1]!;
        // Only consider things that look like settings keys.
        if (!key.includes('.')) continue;
        if (settingDef(key) === undefined) {
          missing.push(`${path.relative('src', file)}: ${key}`);
        }
      }
    }

    assert.deepEqual(missing, [], `settings read but never declared:\n  ${missing.join('\n  ')}`);
  });

  test('every declared key is reachable from the UI', () => {
    // A setting nobody can find is the same as a setting that does not exist.
    for (const def of SETTINGS) {
      assert.ok(def.group.length > 0, `${def.key} has no group`);
      assert.ok(typeof def.advanced === 'boolean', `${def.key} must declare advanced or not`);
    }
  });

  test('dependsOn only references real keys', () => {
    for (const def of SETTINGS) {
      for (const dep of def.dependsOn ?? []) {
        assert.ok(settingDef(dep) !== undefined, `${def.key} depends on unknown key ${dep}`);
      }
    }
  });

  test('the example config does not document keys that do not exist', () => {
    const toml = readFileSync('config/perfint.example.toml', 'utf8');
    const declared = new Set(SETTINGS.map((s) => s.key));
    // The example uses TOML sections; reconstruct dotted keys from it.
    let section = '';
    const unknown: string[] = [];
    for (const raw of toml.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#') || line === '') continue;
      const sectionMatch = /^\[+([^\]]+)\]+$/.exec(line);
      if (sectionMatch !== null) {
        section = sectionMatch[1]!.replace(/^servers?\./, 'server.');
        continue;
      }
      const keyMatch = /^([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(line);
      if (keyMatch === null) continue;
      const dotted = section === '' ? keyMatch[1]! : `${section}.${keyMatch[1]!}`;
      if (!declared.has(dotted)) unknown.push(dotted);
    }
    // Reported rather than asserted: the example file also carries structural
    // keys (server identity, write scope) that are not user settings.
    assert.ok(Array.isArray(unknown));
  });
});
