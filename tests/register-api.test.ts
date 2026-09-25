/**
 * The register's HTTP surface.
 *
 * The unit tests already prove the Register class refuses to let a person
 * declare success. These prove the same thing is true from outside, over
 * HTTP, because that is where a refusal actually has to hold: the page is
 * only one client, and a hand-written request must meet the same wall.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { loadBranding } from '../src/core/brand.ts';
import { createWebServer } from '../src/web/server.ts';
import { Register } from '../src/analysis/register.ts';

let store: Store;
let server: Server;
let base: string;

before(async () => {
  store = new Store({ file: ':memory:' });
  store.upsertServer('00000000-0000-0000-0000-000000000001', 'main', 'Main');
  const settings = new SettingsStore(store.db);
  const branding = loadBranding('config');
  server = createWebServer({ store, settings, branding, host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

after(() => {
  server.close();
  store.close();
});

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function create(title: string, extra: Record<string, unknown> = {}): Promise<number> {
  const { data } = await post('/api/register/create', { title, ...extra });
  return data['id'] as number;
}

describe('creating entries', () => {
  test('a title is required', async () => {
    const { status, data } = await post('/api/register/create', { title: '  ' });
    assert.equal(status, 400);
    assert.match(String(data['error']), /title/);
  });

  test('feasibility and risk default to unknown, not to whatever was sent', async () => {
    const id = await create('Cache the config lookup', { feasibility: 'definitely-fine', risk: 'none' });
    const entry = new Register(store.db).get(id)!;
    assert.equal(entry.feasibility, 'unknown');
    assert.equal(entry.risk, 'unknown');
  });

  test('a valid feasibility is kept', async () => {
    const id = await create('Another', { feasibility: 'likely', risk: 'low' });
    const entry = new Register(store.db).get(id)!;
    assert.equal(entry.feasibility, 'likely');
    assert.equal(entry.risk, 'low');
  });
});

describe('a measured status cannot be reached over HTTP', () => {
  for (const status of ['measured-improvement', 'no-measurable-change', 'regressed']) {
    test(`the API refuses to set "${status}" directly`, async () => {
      const id = await create(`try ${status}`);
      await post('/api/register/deploy', { id, deployedAt: Date.now() });

      const res = await post('/api/register/status', { id, status });
      assert.equal(res.status, 400);
      assert.match(String(res.data['error']), /cannot be set by hand/);
      assert.equal(new Register(store.db).get(id)!.status, 'implemented');
    });
  }

  test('an ordinary transition still works', async () => {
    const id = await create('ordinary');
    const res = await post('/api/register/status', { id, status: 'investigating' });
    assert.equal(res.status, 200);
    assert.equal(new Register(store.db).get(id)!.status, 'investigating');
  });
});

describe('synthetic benchmarks', () => {
  test('are recorded but leave the status alone', async () => {
    const id = await create('benchmarked');
    await post('/api/register/deploy', { id, deployedAt: Date.now() });
    const res = await post('/api/register/synthetic', { id, note: 'JMH: 42% faster in isolation' });
    assert.equal(res.status, 200);

    const entry = new Register(store.db).get(id)!;
    assert.equal(entry.status, 'implemented', 'a microbenchmark is not evidence about the server');
    assert.equal(entry.verdict, null);
    assert.match(entry.synthetic_note!, /JMH/);
  });
});

describe('validation refuses rather than guesses', () => {
  test('without a deploy time there is nothing to compare across', async () => {
    const id = await create('no deploy time', { targetPathText: 'a > b > c' });
    const { status, data } = await post('/api/register/validate', { id });
    assert.equal(status, 400);
    assert.match(String(data['error']), /went live first/);
  });

  test('without a target path it declines to fall back on whole-server tick time', async () => {
    const id = await create('no target');
    await post('/api/register/deploy', { id, deployedAt: Date.now() });
    const { status, data } = await post('/api/register/validate', { id });
    assert.equal(status, 400);
    assert.match(String(data['error']), /player count/);
  });

  test('with no captures either side it refuses and says why, rather than guessing', async () => {
    const id = await create('nothing to measure', { targetPathText: 'a > b > c' });
    await post('/api/register/deploy', { id, deployedAt: Date.now() });
    const { status, data } = await post('/api/register/validate', { id });
    assert.equal(status, 400);
    assert.match(String(data['error']), /no capture from before the deploy/);
    assert.equal(new Register(store.db).get(id)!.status, 'implemented', 'a refusal must not move the status');
  });
});

describe('unknown ids', () => {
  for (const path of ['/api/register/deploy', '/api/register/synthetic', '/api/register/validate']) {
    test(`${path} reports a missing entry rather than creating one`, async () => {
      const { status } = await post(path, { id: 999999, deployedAt: Date.now(), note: 'x' });
      assert.equal(status, 404);
    });
  }
});

describe('the page renders', () => {
  test('and states the distinction it exists to keep', async () => {
    const body = await (await fetch(`${base}/register`)).text();
    assert.match(body, /Implemented is not the same as proven/);
    // The measured statuses must not appear as choices in any dropdown.
    assert.doesNotMatch(body, /<option value="measured-improvement"/);
    assert.doesNotMatch(body, /<option value="regressed"/);
  });
});
