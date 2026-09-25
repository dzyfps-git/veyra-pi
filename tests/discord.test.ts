import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { Notifier, redact, type Notification } from '../src/notify/discord.ts';

let store: Store;
let settings: SettingsStore;
let notifier: Notifier;
const logs: string[] = [];

function note(overrides: Partial<Notification> = {}): Notification {
  return {
    kind: 'newTopFinding',
    title: 'New 3-star finding',
    body: 'ConfigManager.get costs 0.42 ms/tick',
    signature: 'path:1234',
    ...overrides,
  };
}

beforeEach(() => {
  store = new Store({ file: ':memory:' });
  settings = new SettingsStore(store.db);
  logs.length = 0;
  notifier = new Notifier(store.db, settings, (_l, m) => logs.push(m));
});

describe('off by default', () => {
  test('sends nothing until explicitly enabled', async () => {
    assert.equal(await notifier.notify(note()), 'disabled');
  });

  test('enabling without a URL still sends nothing', async () => {
    settings.apply({ 'notifications.discord.enabled': true });
    assert.equal(await notifier.notify(note()), 'disabled');
  });
});

describe('noise control', () => {
  beforeEach(() => {
    settings.apply({
      'notifications.discord.enabled': true,
      'notifications.discord.webhookUrl': 'https://discord.com/api/webhooks/1/secret',
      'notifications.discord.perEventCooldownMinutes': 0,
    });
  });

  test('the same finding never announces twice', async () => {
    assert.equal(await notifier.notify(note()), 'queued');
    assert.equal(await notifier.notify(note()), 'duplicate');
  });

  test('a different finding of the same kind is not a duplicate', async () => {
    await notifier.notify(note({ signature: 'path:1' }));
    assert.equal(await notifier.notify(note({ signature: 'path:2' })), 'queued');
  });

  test('the per-type cooldown suppresses a burst', async () => {
    settings.apply({ 'notifications.discord.perEventCooldownMinutes': 180 });
    assert.equal(await notifier.notify(note({ signature: 'a' })), 'queued');
    assert.equal(await notifier.notify(note({ signature: 'b' })), 'cooldown');
  });

  test('digest mode batches rather than sending immediately', async () => {
    await notifier.notify(note({ signature: 'a' }));
    await notifier.notify(note({ signature: 'b' }));
    assert.equal(notifier.pendingCount(), 2);
  });

  test('individual event types can be switched off', async () => {
    settings.apply({ 'notifications.events.regression': false });
    assert.equal(await notifier.notify(note({ kind: 'regression', signature: 'r1' })), 'disabled');
  });
});

describe('the webhook URL is a credential', () => {
  test('it is redacted rather than logged', () => {
    assert.equal(redact('https://discord.com/api/webhooks/123/supersecrettoken'), 'https://discord.com/…');
    assert.equal(redact(''), '(not set)');
    assert.equal(redact('nonsense'), '(malformed)');
  });

  test('a delivery failure is logged without the token and never throws', async () => {
    settings.apply({
      'notifications.discord.enabled': true,
      // Unroutable on purpose.
      'notifications.discord.webhookUrl': 'http://127.0.0.1:1/webhooks/1/supersecrettoken',
      'notifications.discord.mode': 'immediate',
    });
    const outcome = await notifier.notify(note());
    assert.equal(outcome, 'failed');
    assert.ok(logs.length > 0);
    assert.ok(!logs.join(' ').includes('supersecrettoken'), 'the token must never reach a log');
  });
});
