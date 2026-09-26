/**
 * Changes: detection from the mod list, tracking, and the reorganised pages.
 *
 * The archive is seeded with one season holding two mod sets, which is
 * exactly how a deploy appears in real data: one capture before, one after,
 * and a revision boundary between them.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { loadBranding } from '../src/core/brand.ts';
import { createWebServer } from '../src/web/server.ts';
import { detectedChanges, modDiff, presetMs } from '../src/analysis/changes.ts';
import { Register } from '../src/analysis/register.ts';

let store: Store;
let settings: SettingsStore;
let server: Server;
let base: string;
let revisionId: number;
const SERVER = '00000000-0000-0000-0000-000000000001';
const DEPLOY = Date.UTC(2026, 8, 20, 12);

function seed(): void {
  store.upsertServer(SERVER, 'main', 'Main');
  const env = store.upsertEnvironment({
    serverId: SERVER, envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '0.19.3',
    javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
  });
  const season = store.createSeason({
    serverId: SERVER, environmentId: env, ordinal: 1, startedAt: 0, reason: 'first', confirmed: true,
  });
  const rev1 = store.createRevision({
    seasonId: season, ordinal: 1, modSetHash: 'a', heapMaxMb: 14336, startedAt: DEPLOY - 86_400_000,
    reason: 'first', added: 0, removed: 0, changed: 0,
  });
  revisionId = store.createRevision({
    seasonId: season, ordinal: 2, modSetHash: 'b', heapMaxMb: 14336, startedAt: DEPLOY,
    reason: 'mods changed', added: 1, removed: 0, changed: 1,
  });

  const capture = (rev: number, at: number, name: string): number => {
    store.db
      .prepare(
        `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at,
                              ended_at, window_count, path_count, raw_bytes, ingested_at, is_manual)
         VALUES (?,?,?,?,?,?,?,1,1,1,1,0)`,
      )
      .run(SERVER, season, rev, name, 'sha-' + name, at, at + 3_600_000);
    return Number((store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
  };
  const beforeCapture = capture(rev1, DEPLOY - 7_200_000, 'before');
  const afterCapture = capture(revisionId, DEPLOY, 'after');

  const mod = (modId: string): number => {
    store.db.prepare('INSERT OR IGNORE INTO mod (mod_id, name) VALUES (?, ?)').run(modId, modId);
    return (store.db.prepare('SELECT id FROM mod WHERE mod_id = ?').get(modId) as { id: number }).id;
  };
  const has = (captureId: number, modId: string, version: string): void => {
    store.db.prepare('INSERT INTO capture_mod (capture_id, mod, version) VALUES (?,?,?)').run(captureId, mod(modId), version);
  };
  has(beforeCapture, 'lithium', '0.11.2');
  has(beforeCapture, 'mymod_bridge', '1.6.4');
  has(afterCapture, 'lithium', '0.11.2');
  has(afterCapture, 'mymod_bridge', '1.6.5');
  has(afterCapture, 'mymod_entryset_cache', '0.2.0');
  has(afterCapture, 'sodium', '0.5.0');
}

before(async () => {
  store = new Store({ file: ':memory:' });
  seed();
  settings = new SettingsStore(store.db);
  settings.apply({ 'analysis.ownMods': 'mymod' });
  server = createWebServer({ store, settings, branding: loadBranding('config'), host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

after(() => {
  server.close();
  store.close();
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

describe('detecting a deploy from the mod list', () => {
  test('finds the change, with your own mods first', () => {
    const changes = detectedChanges(store.db, { inHousePrefixes: ['mymod_'] });
    assert.equal(changes.length, 1);
    const ids = changes[0]!.changes.map((c) => c.modId);
    assert.deepEqual(ids.slice(0, 2).sort(), ['mymod_bridge', 'mymod_entryset_cache']);
    assert.ok(changes[0]!.changes.find((c) => c.modId === 'mymod_bridge')?.kind === 'updated');
    assert.equal(changes[0]!.changes.find((c) => c.modId === 'sodium')?.inHouse, false);
  });

  test('an unchanged mod is not listed', () => {
    const changes = detectedChanges(store.db, { inHousePrefixes: ['mymod_'] });
    assert.ok(!changes[0]!.changes.some((c) => c.modId === 'lithium'));
  });

  test('modDiff reports versions both ways', () => {
    const [b, a] = (store.db.prepare('SELECT id FROM capture ORDER BY started_at').all() as Array<{ id: number }>).map(
      (r) => r.id,
    );
    const bridge = modDiff(store.db, b!, a!).find((c) => c.modId === 'mymod_bridge');
    assert.deepEqual({ from: bridge?.from, to: bridge?.to }, { from: '1.6.4', to: '1.6.5' });
  });

  test('window presets are durations, independent of retention', () => {
    assert.equal(presetMs('5h'), 5 * 3_600_000);
    assert.equal(presetMs('3d'), 3 * 86_400_000);
    assert.equal(presetMs('nonsense', 42), 42, 'an unknown preset falls back, never guesses');
  });
});

describe('tracking', () => {
  test('tracking a detected change records when it went live', async () => {
    const { status, data } = await post('/api/changes/track', { revisionId });
    assert.equal(status, 200);
    const entry = new Register(store.db).get(data['id'] as number)!;
    assert.equal(entry.deployed_at, DEPLOY);
    assert.equal(entry.revision_id, revisionId);
    assert.equal(entry.status, 'implemented', 'a detected change already went live');
    assert.match(entry.title, /mymod_/);
    assert.match(entry.notes ?? '', /detected from the mod list/);
  });

  test('tracking the same change twice does not duplicate it', async () => {
    const first = await post('/api/changes/track', { revisionId });
    const second = await post('/api/changes/track', { revisionId });
    assert.equal(first.data['id'], second.data['id']);
  });

  test('a manual change needs a title and a time that is not in the future', async () => {
    assert.equal((await post('/api/changes/record', { title: '', at: DEPLOY })).status, 400);
    assert.equal((await post('/api/changes/record', { title: 'x', at: Date.now() + 86_400_000 })).status, 400);
    const ok = await post('/api/changes/record', { title: 'Lowered entity-broadcast-range', at: DEPLOY });
    assert.equal(ok.status, 200);
    assert.equal(new Register(store.db).get(ok.data['id'] as number)!.deployed_at, DEPLOY);
  });

  test('a target can be set on a tracked change', async () => {
    const { data } = await post('/api/changes/record', { title: 'target me', at: DEPLOY });
    const id = data['id'] as number;
    const set = await post('/api/register/target', { id, targetPathText: 'a > b', targetLabel: 'b' });
    assert.equal(set.status, 200);
    assert.equal(new Register(store.db).get(id)!.target_label, 'b');
  });
});

describe('the reorganised pages', () => {
  test('Changes lists the detected change', async () => {
    const body = await (await fetch(`${base}/changes`)).text();
    assert.match(body, /mymod_entryset_cache/);
    assert.match(body, /yours/);
  });

  test('the comparison labels whole-server time as context, never as a verdict', async () => {
    const body = await (await fetch(`${base}/changes?view=compare&change=${revisionId}&before=3d&after=3d`)).text();
    // Either it compares, in which case the context label must be present,
    // or it refuses with a reason. What it may never do is put a verdict
    // word on whole-server tick time.
    if (body.includes('Whole-server tick time')) {
      assert.match(body, /context only/);
      // With data it disclaims a verdict; without, it says why and suggests a wider window.
      assert.match(body, /not<\/strong> a verdict|try a wider window/);
      assert.doesNotMatch(body, /Median — ms/, 'an empty window explains itself instead of showing dashes');
    } else {
      assert.match(body, /can(?:'|&#39;)t be made|No target call path/);
    }
  });

  test('the old /register address still works, as the Tracked tab', async () => {
    const res = await fetch(`${base}/register`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Implemented is not the same as proven/);
  });

  test('history lives on the server page, and the old addresses still lead there', async () => {
    for (const path of ['/history', '/seasons', '/server']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      const body = await res.text();
      assert.match(body, /machine → world → season/, `${path} should show the server timeline`);
    }
    for (const path of ['/history?tab=captures', '/captures']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /Every archived profile for this server/);
    }
  });

  test('the rail groups this server pages, then the app', async () => {
    const body = await (await fetch(`${base}/`)).text();
    const nav = /<nav class="rail"[\s\S]*?<\/nav>/.exec(body)?.[0] ?? '';
    assert.ok(nav !== '', 'the page should have a rail');
    // Each item's full name is its title; the rail shows a short label under the icon.
    const labels = [...nav.matchAll(/<a class="rail-item[^"]*"[^>]*title="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(labels, [
      'Overview', 'Findings', 'Changes', 'Server &amp; history', 'Reports',
      'All servers', 'Settings', 'How it works',
    ]);
    assert.equal((nav.match(/class="rail-gap"/g) ?? []).length, 1, 'one gap, between this server and the app');
    const bar = /<header class="topbar"[\s\S]*?<\/header>/.exec(body)?.[0] ?? '';
    assert.match(bar, /class="focus-switch"/, 'the server switcher is in the top bar');
  });

  test('Overview says what collection being off costs', async () => {
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, /class="focus-title">Main</);
    assert.match(body, /Collection is off/);
    assert.match(body, /last hour/);
  });
});

describe('findings and the register', () => {
  test('the same method through several paths is one finding, and a tracked one links to its entry', async () => {
    const { groupFindings } = await import('../src/analysis/findings.ts');
    const base = {
      label: 'm.Mod.work', category: 'work', tracked: [], msPerTick: 0.1, secondsPerDay: 1,
    } as unknown as import('../src/analysis/findings.ts').Finding;
    const groups = groupFindings([
      { ...base, path: 'a > m.Mod.work', msPerTick: 0.3, tracked: [{ id: 7, title: 't', status: 'proposed', verdict: null, deltaMsPerTick: null, exact: true }] },
      { ...base, path: 'b > m.Mod.work', msPerTick: 0.1 },
      { ...base, label: 'other.Thing', path: 'c > other.Thing' },
    ] as never);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.paths.length, 2);
    assert.ok(Math.abs(groups[0]!.msPerTick - 0.4) < 1e-12, 'own times of distinct paths add');
    assert.equal(groups[0]!.tracked[0]!.id, 7);
  });

  test('the register entry has an anchor the findings link can reach', async () => {
    const body = await (await fetch(`${base}/changes?view=tracked`)).text();
    assert.match(body, /id="entry-\d+"/);
  });
});

describe('the Ledger lives in Findings now', () => {
  test('old Ledger links land on Findings’ every-call-path view, keeping their search and filter', async () => {
    const res = await fetch(`${base}/ledger?preset=small&q=zombie`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get('location')!, base);
    assert.equal(to.pathname, '/findings');
    assert.equal(to.searchParams.get('view'), 'paths');
    assert.equal(to.searchParams.get('only'), 'small');
    assert.equal(to.searchParams.get('q'), 'zombie');
  });
  test('the every-call-path view renders', async () => {
    const res = await fetch(`${base}/findings?view=paths`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Every call path/);
  });
});
