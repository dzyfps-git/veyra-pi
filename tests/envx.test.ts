/**
 * The envx link, against a stub of `envx api` (fixtures/envx-stub.mjs) that
 * answers exactly as the draft contract shows. Real envx answers are not
 * needed for any of this: which keys are asked, how they are normalised, what
 * is cached and when, how certainty reads, and that stub answers never show.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store/db.ts';
import { ProcessEnvxClient, readResponses, type EnvxClient } from '../src/envx/client.ts';
import { certaintyLabel, servesApi, type EnvxRequest } from '../src/envx/contract.ts';
import { lookupKeyOf, mixinTargetOf, modsetOf } from '../src/envx/keys.ts';
import { attributionFor, matchFor, planLookups, refreshEnvx, toBatches } from '../src/envx/lookup.ts';
import { envxBlock } from '../src/web/envx.ts';

const STUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'envx-stub.mjs');
const stub = (): ProcessEnvxClient => new ProcessEnvxClient(process.execPath, { prefixArgs: [STUB] });

/** Counts envx runs, to prove a refresh with nothing new starts no process. */
function counting(inner: EnvxClient): EnvxClient & { runs: number } {
  const c = {
    runs: 0,
    version: async () => {
      c.runs += 1;
      return inner.version();
    },
    batch: async (r: readonly EnvxRequest[]) => {
      c.runs += 1;
      return inner.batch(r);
    },
  };
  return c;
}

describe('keys', () => {
  test('a hidden lambda class is its host class; the request keeps the recorded name', () => {
    const key = lookupKeyOf({ class: 'a.b.Foo$$Lambda$36855/0x00007e2e6c022cb0', method: 'apply', desc: '(Ljava/lang/Object;)V' });
    assert.equal(key.cacheKey, 'a.b.Foo\tapply\t(Ljava/lang/Object;)V');
    assert.equal(key.hiddenLambda, true);
    assert.equal(key.request.class, 'a.b.Foo$$Lambda$36855/0x00007e2e6c022cb0');
  });

  test('merged mixin methods ignore the per-run hash', () => {
    const a = lookupKeyOf({ class: 'net.minecraft.class_3218', method: 'wrapOperation$flp000$modernfix$managedBlock', desc: '()V' });
    const b = lookupKeyOf({ class: 'net.minecraft.class_3218', method: 'wrapOperation$fme000$modernfix$managedBlock', desc: '()V' });
    assert.equal(a.cacheKey, b.cacheKey);
    assert.deepEqual(a.mixin, { kind: 'wrapOperation', mod: 'modernfix', handler: 'managedBlock' });
    assert.equal(mixinTargetOf(a), undefined, 'already attributed by its name');
  });

  test('only Minecraft methods are asked for mixins', () => {
    assert.ok(mixinTargetOf(lookupKeyOf({ class: 'net.minecraft.class_1309', method: 'method_5773', desc: '()V' })));
    assert.equal(mixinTargetOf(lookupKeyOf({ class: 'com.example.Thing', method: 'tick', desc: '()V' })), undefined);
  });

  test('modset ignores list order', () => {
    assert.equal(modsetOf([['b', '2'], ['a', '1']]), modsetOf([['a', '1'], ['b', '2']]));
    assert.notEqual(modsetOf([['a', '1']]), modsetOf([['a', '1.0']]));
  });
});

describe('the client', () => {
  test('talks to envx api over JSON lines', async () => {
    const client = stub();
    assert.deepEqual(await client.version(), { api: 1, envx: '1.1.0' });
    const { responses, mismatches } = await client.batch([{ id: 's', op: 'snapshots' }]);
    assert.deepEqual(mismatches, []);
    assert.equal((responses[0]?.result as { snapshots: unknown[] }).snapshots.length, 2);
  });

  test('anything off-contract is reported and dropped, never repaired', () => {
    const requests: EnvxRequest[] = [
      { id: 'a', op: 'snapshots' },
      { id: 'b', op: 'snapshots' },
      { id: 'c', op: 'snapshots' },
    ];
    const out = readResponses(requests, ['{"api":2,"id":"a","ok":true,"result":{}}', '{"api":1,"id":"x","ok":true,"result":{}}', 'not json'].join('\n'));
    assert.deepEqual(out.responses, [undefined, undefined, undefined]);
    assert.equal(out.mismatches.length, 3);
    assert.match(out.mismatches.join('\n'), /api 2/);
    assert.match(out.mismatches.join('\n'), /echoes id "x"/);
  });

  test('only a released envx 1.1 or later serves the interface', () => {
    assert.equal(servesApi({ api: 1, envx: '1.1.0' }), true);
    assert.equal(servesApi({ api: 1, envx: '1.0.0' }), false);
    assert.equal(servesApi({ api: 1, envx: '1.1.0-rc1' }), false);
    assert.equal(servesApi({ api: 2, envx: '2.0.0' }), false);
  });
});

describe('asking and remembering', () => {
  let store: Store;
  let pathIds: number[];
  const LABELS: Array<[string, string, string]> = [
    ['net.minecraft.class_1309', 'method_5773', '()V'],
    ['net.minecraft.class_3218', 'wrapOperation$flp000$modernfix$managedBlock', '()V'],
    ['net.minecraft.class_3218', 'wrapOperation$fme000$modernfix$managedBlock', '()V'],
    ['com.example.AmbigHelper', 'run', '()V'],
    ['com.example.UnknownThing', 'tick', '()V'],
  ];

  beforeEach(() => {
    delete process.env.ENVX_STUB_MATCH;
    store = new Store({ file: ':memory:' });
    store.upsertServer('s', 'main', 'Main');
    const env = store.upsertEnvironment({
      serverId: 's', envKey: 'e', mcVersion: '1.20.1', loaderName: 'Fabric', loaderVersion: '0.19.3',
      javaMajor: '17', cpuModel: 'x', cpuThreads: 8, osName: 'Ubuntu', seenAt: 0,
    });
    const season = store.createSeason({ serverId: 's', environmentId: env, ordinal: 1, startedAt: 0, reason: 'r', confirmed: true });
    const revision = store.createRevision({ seasonId: season, ordinal: 1, modSetHash: 'a', heapMaxMb: 1, startedAt: 0, reason: 'r', added: 0, removed: 0, changed: 0 });
    const capture = Number(
      store.db
        .prepare(
          `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256, started_at, window_count, path_count, raw_bytes, ingested_at, is_manual)
           VALUES ('s',?,?,'c','sha',1000,1,1,1,1,0)`,
        )
        .run(season, revision).lastInsertRowid,
    );
    const loaded: Array<[string, string]> = [['java', '17'], ['minecraft', '1.20.1'], ['fabricloader', '0.19.3'], ['lootr', '0.7.35.86']];
    for (const [id, version] of loaded) {
      store.db.prepare('INSERT OR IGNORE INTO mod (mod_id, name) VALUES (?, ?)').run(id, id);
      const mod = (store.db.prepare('SELECT id FROM mod WHERE mod_id = ?').get(id) as { id: number }).id;
      store.db.prepare('INSERT INTO capture_mod (capture_id, mod, version) VALUES (?,?,?)').run(capture, mod, version);
    }
    pathIds = LABELS.map(([cls, method, desc], i) => {
      const frame = Number(store.db.prepare('INSERT INTO frame (label, class_name, method_name) VALUES (?,?,?)').run(`f${i}`, cls, method).lastInsertRowid);
      const pathId = Number(
        store.db.prepare('INSERT INTO path (parent_id, frame_id, depth, first_seen, last_seen) VALUES (0,?,0,0,0)').run(frame).lastInsertRowid,
      );
      const key = Number(
        store.db
          .prepare(`INSERT INTO frame_key (raw_class, raw_method, raw_desc, group_class, origin) VALUES (?,?,?,?,'capture')`)
          .run(cls, method, desc, cls).lastInsertRowid,
      );
      store.db.prepare('INSERT INTO frame_key_seen (key_id, frame_id, first_seen, last_seen) VALUES (?,?,0,0)').run(key, frame);
      return pathId;
    });
  });

  afterEach(() => store.close());

  test('matches the mod set, asks once per key and snapshot, then starts no process', async () => {
    const client = counting(stub());
    const first = await refreshEnvx(store.db, client, pathIds, { now: 1 });
    assert.equal(first.state, 'ready');
    assert.deepEqual(first.mismatches, []);
    assert.equal(first.fingerprint, 'f'.repeat(64), 'the most recently confirmed matching snapshot');
    // 4 distinct owners (the two modernfix hashes are one handler) + 1 Minecraft method for mixins.
    assert.equal(first.answered, 5);
    assert.equal(matchFor(store.db, first.modset!)?.status, 'match');

    const runs = client.runs;
    const again = await refreshEnvx(store.db, client, pathIds, { now: 2 });
    assert.equal(again.state, 'ready');
    assert.equal(client.runs, runs, 'everything already answered: no envx run');
  });

  test('every answer is kept with its fingerprint and modset', async () => {
    const result = await refreshEnvx(store.db, stub(), pathIds, { now: 1 });
    const rows = store.db.prepare('SELECT DISTINCT fingerprint, modset FROM envx_answer').all() as Array<{ fingerprint: string; modset: string }>;
    assert.deepEqual(rows.map((r) => [r.fingerprint, r.modset]), [['f'.repeat(64), result.modset]]);
  });

  test('batches stay under the limit', () => {
    const keys = Array.from({ length: 1201 }, (_, i) => lookupKeyOf({ class: `com.example.C${i}`, method: 'm', desc: '()V' }));
    const batches = toBatches(planLookups(store.db, keys, 'f'.repeat(64)), 'f'.repeat(64), undefined);
    assert.deepEqual(batches.map((b) => b.cacheKeys.length), [500, 500, 201]);
  });

  test('no snapshot for this mod set is "none", asked again only after a while', async () => {
    process.env.ENVX_STUB_MATCH = 'none';
    const client = counting(stub());
    const first = await refreshEnvx(store.db, client, pathIds, { now: 1 });
    assert.equal(first.state, 'no-snapshot');
    const runs = client.runs;
    assert.equal((await refreshEnvx(store.db, client, pathIds, { now: 2 })).state, 'no-snapshot');
    assert.equal(client.runs, runs, 'not asked again within six hours');
    assert.deepEqual(attributionFor(store.db, pathIds[0]!), [], 'nothing is attributed against a nearest snapshot');
  });

  test('an answer shaped off-contract is reported and not stored', async () => {
    const broken: EnvxClient = {
      version: async () => ({ api: 1, envx: '1.1.0' }),
      batch: async (requests) => ({
        responses: requests.map((r) =>
          r.op === 'match'
            ? { api: 1, id: r.id, ok: true, result: { status: 'match', modset: 'x', snapshots: [12] } }
            : r.op === 'snapshots'
              ? { api: 1, id: r.id, ok: true, result: { snapshots: [{ id: 12, fingerprint: 'f'.repeat(64), checked_at: '2026' }] } }
              : { api: 1, id: r.id, ok: true, result: [{ status: 'exact', candidates: [] }] },
        ),
        mismatches: [],
      }),
    };
    const result = await refreshEnvx(store.db, broken, pathIds, { now: 1 });
    assert.match(result.mismatches.join('\n'), /modset differs/);
    assert.match(result.mismatches.join('\n'), /no results list/);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM envx_answer').get() as { n: number }).n, 0);
  });

  test('certainty reads the same everywhere, never "exact", and stub answers stay hidden', async () => {
    await refreshEnvx(store.db, stub(), pathIds, { now: 1 });
    assert.deepEqual(['probable', 'ambiguous', 'none'].map((s) => certaintyLabel(s as 'probable')), ['Likely', 'Ambiguous', 'Unknown']);

    const all = pathIds.flatMap((id) => attributionFor(store.db, id));
    assert.equal(envxBlock(all), '', 'not live until envx 1.1 is installed and checked');

    const html = envxBlock(all, true);
    assert.match(html, /Likely:<\/b> minecraft 1\.20\.1/);
    assert.match(html, /Ambiguous:<\/b> libone 1\.0 \(inside moda\) · libone 1\.2/);
    assert.match(html, /Unknown:<\/b> not in any indexed jar/);
    assert.match(html, /via Inject in modernfix\.mixin\.TargetMixin/);
    assert.match(html, /replaced by overwriter 3\.1/);
    assert.doesNotMatch(html, /exact/i);

    const old = all.map((a) => ({ ...a, envxVersion: '1.0.0' }));
    assert.equal(envxBlock(old, true), '', 'an envx that does not serve the interface is never shown');
  });
});
