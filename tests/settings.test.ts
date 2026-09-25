import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SettingsStore, SettingsWatcher, maskSecret } from '../src/settings/store.ts';
import { SETTINGS, validateSetting, settingDef, requiresApproval } from '../src/settings/registry.ts';

let db: DatabaseSync;
let settings: SettingsStore;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  settings = new SettingsStore(db);
});

describe('registry', () => {
  test('every setting has help text and a stated apply time', () => {
    for (const def of SETTINGS) {
      assert.ok(def.help.length > 20, `${def.key} needs real help text`);
      assert.ok(def.appliesAt.length > 0, `${def.key} must say when it takes effect`);
    }
  });

  test('every risky setting carries a warning', () => {
    for (const def of SETTINGS) {
      if (def.risk === 'disruptive' || def.risk === 'needs-mc-restart') {
        assert.ok(def.warning !== undefined, `${def.key} is ${def.risk} and must warn the user`);
      }
    }
  });

  test('keys are unique', () => {
    assert.equal(new Set(SETTINGS.map((s) => s.key)).size, SETTINGS.length);
  });

  test('validation enforces declared bounds', () => {
    assert.equal(validateSetting('retention.rawDays', 12).ok, true);
    assert.equal(validateSetting('retention.rawDays', 0).ok, false);
    assert.equal(validateSetting('retention.rawDays', 'abc').ok, false);
    assert.equal(validateSetting('collection.harvest.intervalMinutes', 90).ok, false,
      'intervals above 60 would leave permanent gaps and must be rejected');
    assert.equal(validateSetting('notifications.discord.mode', 'telnet').ok, false);
    assert.equal(validateSetting('notifications.discord.mode', 'digest').ok, true);
  });
});

describe('persistence and hot reload', () => {
  test('defaults apply before anything is saved', () => {
    assert.equal(settings.getNumber('retention.rawDays'), 15);
    assert.equal(settings.getBoolean('setup.autoFix.sparkConfig'), false);
  });

  test('the retention example: 15 -> 12 applies without a restart', () => {
    const watcher = new SettingsWatcher(settings);
    assert.equal(watcher.changed(), false);

    const result = settings.apply({ 'retention.rawDays': 12 });
    assert.equal(result.changes[0]?.status, 'applied');
    assert.equal(settings.getNumber('retention.rawDays'), 12);
    assert.equal(watcher.changed(), true, 'a running cleanup job must observe the change');
  });

  test('values survive a restart', () => {
    settings.apply({ 'retention.rawDays': 12, 'analysis.thresholds.msptMedianWatch': 25 });
    const reopened = new SettingsStore(db);
    assert.equal(reopened.getNumber('retention.rawDays'), 12);
    assert.equal(reopened.getNumber('analysis.thresholds.msptMedianWatch'), 25);
  });

  test('one bad value does not block the good ones', () => {
    const result = settings.apply({ 'retention.rawDays': 12, 'retention.sidecarDays': -5 });
    assert.equal(settings.getNumber('retention.rawDays'), 12);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.key, 'retention.sidecarDays');
  });

  test('no-op changes do not churn history', () => {
    const result = settings.apply({ 'retention.rawDays': 15 });
    assert.equal(result.changes.length, 0);
  });
});

describe('risky changes are never applied silently', () => {
  test('a change that reaches the server is parked for approval', () => {
    const result = settings.apply({ 'setup.autoFix.sparkConfig': true });
    assert.equal(result.changes[0]?.status, 'pending-approval');
    assert.equal(settings.getBoolean('setup.autoFix.sparkConfig'), false, 'must NOT take effect yet');
    assert.equal(settings.pendingCount(), 1);
  });

  test('enabling server-side deletion is parked for approval', () => {
    settings.apply({ 'cleanup.server.enabled': true });
    assert.equal(settings.getBoolean('cleanup.server.enabled'), false);
  });

  test('approval applies it and clears the pending state', () => {
    settings.apply({ 'setup.autoFix.sparkConfig': true });
    settings.approvePending('setup.autoFix.sparkConfig');
    assert.equal(settings.getBoolean('setup.autoFix.sparkConfig'), true);
    assert.equal(settings.pendingCount(), 0);
  });

  test('discarding leaves the live value untouched', () => {
    settings.apply({ 'setup.autoFix.sparkConfig': true });
    settings.discardPending('setup.autoFix.sparkConfig');
    assert.equal(settings.getBoolean('setup.autoFix.sparkConfig'), false);
    assert.equal(settings.pendingCount(), 0);
  });

  test('a spark interval change is flagged as needing a Minecraft restart', () => {
    const def = settingDef('collection.sparkSamplingIntervalMs')!;
    assert.equal(def.risk, 'needs-mc-restart');
    assert.equal(requiresApproval(def), true);
    const result = settings.apply({ 'collection.sparkSamplingIntervalMs': 5 });
    assert.equal(result.changes[0]?.status, 'pending-approval');
  });

  test('every change is recorded in history', () => {
    settings.apply({ 'retention.rawDays': 12 }, { actor: 'test' });
    const rows = db.prepare('SELECT key, old_value, new_value, actor FROM setting_history').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['actor'], 'test');
    assert.equal(rows[0]?.['new_value'], '12');
  });
});

describe('export and reset', () => {
  test('export contains only non-default values', () => {
    settings.apply({ 'retention.rawDays': 12 });
    const exported = settings.export();
    assert.deepEqual(exported, { 'retention.rawDays': 12 });
  });

  test('reset returns a setting to its default', () => {
    settings.apply({ 'retention.rawDays': 12 });
    settings.reset('retention.rawDays');
    assert.equal(settings.getNumber('retention.rawDays'), 15);
  });
});

describe('secrets never leave the settings table', () => {
  const SECRET = 'https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz';

  test('the apply result does not echo the value back', () => {
    const fresh = new DatabaseSync(':memory:');
    const settings = new SettingsStore(fresh);
    const result = settings.apply({ 'notifications.discord.webhookUrl': SECRET }, { actor: 'test' });

    const serialised = JSON.stringify(result);
    assert.doesNotMatch(serialised, /abcdefghijklmnop/, 'the apply result leaked the credential');
    assert.match(serialised, /redacted/);
    fresh.close();
  });

  test('the audit history records that it changed, not what to', () => {
    const fresh = new DatabaseSync(':memory:');
    const settings = new SettingsStore(fresh);
    settings.apply({ 'notifications.discord.webhookUrl': SECRET }, { actor: 'test' });

    const rows = fresh
      .prepare('SELECT key, old_value, new_value FROM setting_history')
      .all() as Array<{ key: string; old_value: string | null; new_value: string }>;
    const row = rows.find((r) => r.key === 'notifications.discord.webhookUrl');
    assert.ok(row, 'the change should still be audited');
    assert.doesNotMatch(row.new_value, /abcdefghijklmnop/, 'history leaked the credential');
    assert.match(row.new_value, /discord\.com/, 'history should still identify which credential it was');
    fresh.close();
  });

  test('but the application can still read the real value', () => {
    const fresh = new DatabaseSync(':memory:');
    const settings = new SettingsStore(fresh);
    settings.apply({ 'notifications.discord.webhookUrl': SECRET }, { actor: 'test' });
    assert.equal(settings.getString('notifications.discord.webhookUrl'), SECRET);
    fresh.close();
  });

  test('a non-URL secret is masked by length rather than shape', () => {
    assert.match(String(maskSecret('plain-token-value')), /redacted, 17 characters/);
  });

  test('masking leaves ordinary settings alone', () => {
    const fresh = new DatabaseSync(':memory:');
    const settings = new SettingsStore(fresh);
    const result = settings.apply({ 'interface.port': 9123 }, { actor: 'test' });
    assert.match(JSON.stringify(result), /9123/);
    fresh.close();
  });
});

describe('retired values', () => {
  test('a saved releases repo follows the move into veyra-pi; any other choice is kept', () => {
    settings.apply({ 'updates.githubRepo': 'dzyfps-git/veyra-pi-releases' });
    assert.equal(new SettingsStore(db).getString('updates.githubRepo'), 'dzyfps-git/veyra-pi');

    settings.apply({ 'updates.githubRepo': 'someone/fork' });
    assert.equal(new SettingsStore(db).getString('updates.githubRepo'), 'someone/fork');
  });
});
