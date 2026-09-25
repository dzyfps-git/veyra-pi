/**
 * Boots and exact method keys (schema v15, ingest/identity.ts).
 *
 * A boot is one JVM run, derived from endTime - uptime (spark samples uptime
 * when it saves). A key is class + method + descriptor exactly as captured;
 * the sidecar carries one per row, and the database only indexes them.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';

import { Store } from '../src/store/db.ts';
import { BOOT_TOLERANCE_MS, backfillIdentity, bootFor, groupClassOf, jvmStartOf, recordKeys } from '../src/ingest/identity.ts';
import { decodeSidecar, encodeSidecar, sumSidecarWindows, SIDECAR_VERSION, type EncodableRow } from '../src/store/sidecar.ts';
import type { SparkProfile } from '../src/decode/sparkprofile.ts';

const profileWith = (endTime?: number, uptimeMs?: number): SparkProfile =>
  ({ metadata: { endTime, system: uptimeMs === undefined ? undefined : { uptimeMs } } }) as unknown as SparkProfile;

describe('boots', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store({ file: ':memory:' });
    store.upsertServer('s1', 'main', 'Main');
    store.upsertServer('s2', 'test', 'Test');
  });

  test('the JVM start is end time minus uptime, to the second', () => {
    const end = Date.parse('2026-09-23T15:25:46.400Z');
    assert.equal(jvmStartOf(profileWith(end, 69_166_000)), Date.parse('2026-09-22T20:13:00.000Z'));
  });

  test('unknown when spark did not say, never guessed', () => {
    assert.equal(jvmStartOf(profileWith(undefined, 1000)), undefined);
    assert.equal(jvmStartOf(profileWith(Date.now(), undefined)), undefined);
    assert.equal(jvmStartOf(profileWith(1000, 5000)), undefined);
  });

  test('captures of one run share a boot; a restart makes a new one', () => {
    const start = Date.parse('2026-09-22T20:13:00Z');
    const a = bootFor(store.db, 's1', start, start + 600_000);
    const b = bootFor(store.db, 's1', start + BOOT_TOLERANCE_MS, start + 1_200_000);
    const c = bootFor(store.db, 's1', start + BOOT_TOLERANCE_MS + 1000, start + 1_800_000);
    assert.equal(a, b);
    assert.notEqual(a, c);
    const row = store.db.prepare('SELECT first_capture_at, last_capture_at FROM boot WHERE id = ?').get(a) as { first_capture_at: number; last_capture_at: number };
    assert.deepEqual([row.first_capture_at, row.last_capture_at], [start + 600_000, start + 1_200_000]);
  });

  test('another server never shares a boot', () => {
    const start = Date.parse('2026-09-22T20:13:00Z');
    assert.notEqual(bootFor(store.db, 's1', start, start), bootFor(store.db, 's2', start, start));
  });
});

describe('group class', () => {
  test('drops the per-run suffix of a hidden lambda class, and only that', () => {
    assert.equal(groupClassOf('net.minecraft.server.MinecraftServer$$Lambda$36955.0x00007e2e6c022cb0'), 'net.minecraft.server.MinecraftServer$$Lambda');
    assert.equal(groupClassOf('com.mojang.serialization.DataResult$$Lambda/0x0000000801234567'), 'com.mojang.serialization.DataResult$$Lambda');
    assert.equal(groupClassOf('net.minecraft.class_1937'), 'net.minecraft.class_1937');
    assert.equal(groupClassOf('a.B$Inner'), 'a.B$Inner');
  });
});

const row = (i: number, parentIndex: number, label: string, className?: string, methodName?: string, methodDesc?: string): EncodableRow => ({
  path: label,
  label,
  source: null,
  parentIndex,
  depth: parentIndex < 0 ? 0 : 1,
  selfMs: i,
  totalMs: i,
  category: 'work',
  selfMsByWindow: [i],
  totalMsByWindow: [i],
  ...(className === undefined ? {} : { className, methodName: methodName ?? '', methodDesc: methodDesc ?? '' }),
});

describe('sidecar keys', () => {
  // Two overloads under one label, and two lambdas that group together.
  const ROWS: EncodableRow[] = [
    row(1, -1, 'World.setBlockState', 'net.minecraft.class_1937', 'method_8652', '(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z'),
    row(2, -1, 'World.setBlockState', 'net.minecraft.class_1937', 'method_8652', '(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;II)Z'),
    row(3, -1, 'A$$Lambda$1.0x01.apply', 'a.A$$Lambda$1.0x01', 'apply', '(Ljava/lang/Object;)Ljava/lang/Object;'),
    row(4, -1, 'A$$Lambda$2.0x02.apply', 'a.A$$Lambda$2.0x02', 'apply', '(Ljava/lang/Object;)Ljava/lang/Object;'),
    row(5, -1, 'World.setBlockState', 'net.minecraft.class_1937', 'method_8652', '(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;I)Z'),
  ];

  test('every row keeps its own key; the file stays version 2 for older builds', () => {
    const buffer = encodeSidecar('sha', [100], ROWS);
    const decoded = decodeSidecar(buffer);
    assert.equal(decoded.version, SIDECAR_VERSION);
    assert.equal(SIDECAR_VERSION, 2);
    assert.equal(decoded.keys?.length, ROWS.length);
    assert.notEqual(decoded.keys![0]!.rawDesc, decoded.keys![1]!.rawDesc);
    assert.deepEqual(decoded.keys![4], decoded.keys![0]);
    assert.equal(decoded.keys![2]!.rawClass, 'a.A$$Lambda$1.0x01');
    const payload = JSON.parse(zstdDecompressSync(buffer).toString('utf8')) as { keys: string[] };
    assert.equal(payload.keys.length, 4, 'distinct keys are stored once');
  });

  test('the summing reader exposes keys too', () => {
    const sums = sumSidecarWindows(encodeSidecar('sha', [100], ROWS), () => true);
    assert.equal(sums.key(1)?.rawDesc, '(Lnet/minecraft/class_2338;Lnet/minecraft/class_2680;II)Z');
  });

  test('a file without raw names has no keys, and says so', () => {
    const plain = ROWS.map(({ className: _c, methodName: _m, methodDesc: _d, ...rest }) => rest);
    const decoded = decodeSidecar(encodeSidecar('sha', [100], plain));
    assert.equal(decoded.keys, undefined);
    assert.equal(sumSidecarWindows(encodeSidecar('sha', [100], plain), () => true).key(0), undefined);
  });
});

describe('the key index', () => {
  let store: Store;
  let frame: number;
  beforeEach(() => {
    store = new Store({ file: ':memory:' });
    frame = store.internFrame('World.setBlockState', 'net.minecraft.class_1937', 'method_8652');
  });

  const keyRows = (): Array<{ raw_desc: string; origin: string; group_class: string }> =>
    store.db.prepare('SELECT raw_desc, origin, group_class FROM frame_key ORDER BY id').all() as Array<{ raw_desc: string; origin: string; group_class: string }>;

  test('overloads under one frame are separate keys, both indexed to it', () => {
    recordKeys(
      store.db,
      [
        { rawClass: 'net.minecraft.class_1937', rawMethod: 'method_8652', rawDesc: '(I)Z', frameId: frame },
        { rawClass: 'net.minecraft.class_1937', rawMethod: 'method_8652', rawDesc: '(II)Z', frameId: frame },
        { rawClass: 'net.minecraft.class_1937', rawMethod: 'method_8652', rawDesc: '(I)Z', frameId: frame },
      ],
      Date.parse('2026-09-23T10:00:00Z'),
      'capture',
    );
    assert.equal(keyRows().length, 2);
    const seen = store.db.prepare('SELECT count(*) AS n FROM frame_key_seen WHERE frame_id = ?').get(frame) as { n: number };
    assert.equal(seen.n, 2);
  });

  test('lambdas stay exact keys but share a group', () => {
    const f1 = store.internFrame('A$$Lambda$1.0x01.apply', 'a.A$$Lambda$1.0x01', 'apply');
    const f2 = store.internFrame('A$$Lambda$2.0x02.apply', 'a.A$$Lambda$2.0x02', 'apply');
    recordKeys(
      store.db,
      [
        { rawClass: 'a.A$$Lambda$1.0x01', rawMethod: 'apply', rawDesc: '()V', frameId: f1 },
        { rawClass: 'a.A$$Lambda$2.0x02', rawMethod: 'apply', rawDesc: '()V', frameId: f2 },
      ],
      Date.now(),
      'capture',
    );
    const rows = keyRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.group_class), ['a.A$$Lambda', 'a.A$$Lambda']);
  });

  test('first and last seen move by day, and only then', () => {
    const key = { rawClass: 'net.minecraft.class_1937', rawMethod: 'method_8652', rawDesc: '(I)Z', frameId: frame };
    recordKeys(store.db, [key], Date.parse('2026-09-23T10:00:00Z'), 'capture');
    recordKeys(store.db, [key], Date.parse('2026-09-23T23:00:00Z'), 'capture');
    recordKeys(store.db, [key], Date.parse('2026-09-25T01:00:00Z'), 'capture');
    recordKeys(store.db, [key], Date.parse('2026-09-21T01:00:00Z'), 'capture');
    const seen = store.db.prepare('SELECT first_seen, last_seen FROM frame_key_seen').get() as { first_seen: number; last_seen: number };
    assert.equal(new Date(seen.first_seen).toISOString().slice(0, 10), '2026-09-21');
    assert.equal(new Date(seen.last_seen).toISOString().slice(0, 10), '2026-09-25');
  });

  test('a best-effort key becomes a captured one when a capture confirms it', () => {
    const key = { rawClass: 'net.minecraft.class_1937', rawMethod: 'method_8652', rawDesc: '', frameId: frame };
    recordKeys(store.db, [key], Date.now(), 'backfill');
    assert.equal(keyRows()[0]!.origin, 'backfill');
    recordKeys(store.db, [key], Date.now(), 'capture');
    assert.equal(keyRows()[0]!.origin, 'capture');
  });
});

describe('backfill', () => {
  test('frames with no raw file get one best-effort key each, marked as such', async () => {
    const store = new Store({ file: ':memory:' });
    const f = store.internFrame('World.setBlockState', 'net.minecraft.class_1937', 'method_8652');
    store.internPathEdge({ parentId: 0, frameId: f, depth: 0, source: null, seenAt: Date.parse('2026-09-20T12:00:00Z') });
    const ok = await backfillIdentity(
      store,
      () => undefined,
      { allowed: () => true, breathe: async () => {}, stopped: () => false },
      () => {},
    );
    assert.equal(ok, true);
    const keys = store.db.prepare('SELECT raw_class, raw_method, raw_desc, origin FROM frame_key').all() as Array<Record<string, string>>;
    assert.deepEqual(keys.map((k) => ({ ...k })), [{ raw_class: 'net.minecraft.class_1937', raw_method: 'method_8652', raw_desc: '', origin: 'backfill' }]);
    assert.equal(store.getMeta('identity.backfilled'), '1');
  });
});
