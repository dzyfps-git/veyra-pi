/**
 * Sidecar format 2 stores each path as its parent plus one frame. Format 1
 * files must stay readable and convert without changing a single value.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { encodeSidecar, decodeSidecar, upgradeSidecarFile, SIDECAR_VERSION, type EncodableRow } from '../src/store/sidecar.ts';

const ROWS: EncodableRow[] = [
  { path: 'Thread.run', label: 'Thread.run', source: null, parentIndex: -1, depth: 0, selfMs: 0, totalMs: 30, category: 'work', selfMsByWindow: [0, 0], totalMsByWindow: [10, 20] },
  { path: 'Thread.run > Server.tick', label: 'Server.tick', source: null, parentIndex: 0, depth: 1, selfMs: 5, totalMs: 30, category: 'work', selfMsByWindow: [2, 3], totalMsByWindow: [10, 20] },
  { path: 'Thread.run > Server.tick > Mod.work', label: 'Mod.work', source: 'coolmod', parentIndex: 1, depth: 2, selfMs: 25, totalMs: 25, category: 'work', selfMsByWindow: [8, 17], totalMsByWindow: [8, 17] },
  // A second root, and a row whose path does not extend its parent's.
  { path: 'Worker.run', label: 'Worker.run', source: null, parentIndex: -1, depth: 0, selfMs: 1, totalMs: 1, category: 'idle', selfMsByWindow: [1, 0], totalMsByWindow: [1, 0] },
  { path: 'Odd > path', label: 'path', source: null, parentIndex: 3, depth: 1, selfMs: 0.5, totalMs: 0.5, category: 'work', selfMsByWindow: [0, 0.5], totalMsByWindow: [0, 0.5] },
];

/** The format-1 encoding, as older builds wrote it. */
function encodeV1(rows: EncodableRow[]): Buffer {
  const dict: string[] = [];
  const id = (v: string): number => (dict.includes(v) ? dict.indexOf(v) : dict.push(v) - 1);
  const pairs = (a: readonly number[]): number[] => a.flatMap((v, i) => (v === 0 ? [] : [i, v]));
  const categories = ['work', 'idle', 'blocked', 'waiting'];
  const encoded = rows.map((r) => [
    id(r.path),
    id(r.source ?? ''),
    r.parentIndex,
    r.depth,
    r.selfMs,
    r.totalMs,
    categories.indexOf(r.category),
    pairs(r.selfMsByWindow),
    pairs(r.totalMsByWindow),
  ]);
  return zstdCompressSync(Buffer.from(JSON.stringify({ v: 1, captureSha: 'sha', windows: [100, 101], dict, rows: encoded })));
}

describe('sidecar format', () => {
  test('round-trips every path and value', () => {
    const decoded = decodeSidecar(encodeSidecar('sha', [100, 101], ROWS));
    assert.equal(decoded.version, SIDECAR_VERSION);
    assert.deepEqual(
      decoded.rows.map((r) => r.path),
      ROWS.map((r) => r.path),
    );
    assert.deepEqual(decoded.rows[2]!.selfMsByWindow, [8, 17]);
    assert.equal(decoded.rows[2]!.source, 'coolmod');
    assert.equal(decoded.rows[3]!.category, 'idle');
  });

  test('stores frames, not whole paths', () => {
    const json = zstdDecompressSync(encodeSidecar('sha', [100, 101], ROWS)).toString('utf8');
    assert.ok(!json.includes('Thread.run > Server.tick > Mod.work'));
  });

  test('reads format 1 and upgrades it in place without changing anything', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'perfint-sidecar-'));
    try {
      const file = path.join(dir, 'c.sidecar.zst');
      writeFileSync(file, encodeV1(ROWS));
      const before = decodeSidecar(readFileSync(file));
      assert.equal(before.version, 1);
      assert.equal(upgradeSidecarFile(file), 'upgraded');
      const after = decodeSidecar(readFileSync(file));
      assert.equal(after.version, SIDECAR_VERSION);
      assert.deepEqual(after.rows, before.rows);
      assert.equal(upgradeSidecarFile(file), 'current');
      assert.equal(existsSync(`${file}.upgrading`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
