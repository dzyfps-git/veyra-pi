/**
 * Observable profiles: optional per-entity and per-block cost, read from the
 * files the game client saves on this PC.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { findProfileFolders, importObservable, observableFor, parseObservable, takenAt } from '../src/ingest/observable.ts';

/** Two zombies and a hopper over 200 ticks; rate is nanoseconds per tick. */
const PROFILE = JSON.stringify({
  ticks: 200,
  entities: [
    { entityId: 1, position: { x: 10, y: 64, z: -5, level: 'minecraft:overworld' }, type: 'entity.minecraft.zombie', rate: 50_000, ticks: 200 },
    { entityId: 2, position: { x: 12, y: 64, z: -5, level: 'minecraft:overworld' }, type: 'entity.minecraft.zombie', rate: 20_000, ticks: 100 },
  ],
  blocks: [{ position: { x: 0, y: 70, z: 0, level: 'minecraft:the_nether' }, type: 'block.minecraft.hopper', rate: 1_000_000, ticks: 200 }],
  traces: {},
});

describe('reading an Observable profile', () => {
  test('rate is nanoseconds per tick, weighted by how long each one existed', () => {
    const p = parseObservable(PROFILE);
    assert.equal(p.ticks, 200);
    const [a, b, hopper] = p.entries;
    assert.equal(a!.mspt, 0.05); // 50 µs every tick
    assert.equal(b!.mspt, 0.01); // 20 µs for half the profile
    assert.equal(hopper!.kind, 'block');
    assert.equal(hopper!.mspt, 1);
    assert.deepEqual([a!.x, a!.y, a!.z, a!.level], [10, 64, -5, 'minecraft:overworld']);
  });
  test('something that is not a profile is refused', () => {
    assert.throws(() => parseObservable('{"hello":1}'));
  });
  test('the file name gives the time it was taken', () => {
    assert.equal(takenAt('x/2026-09-23--18.04.11.json', 0), new Date(2026, 8, 23, 18, 4, 11).getTime());
    assert.equal(takenAt('x/other.json', 123), 123);
  });
});

describe('importing', () => {
  test('profiles are found in launcher instance folders, imported once, and summed by type', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'perfint-obs-'));
    const folder = path.join(root, 'My Pack', '.minecraft', 'observable_profiles');
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, '2026-09-23--18.04.11.json');
    writeFileSync(file, PROFILE);
    utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    writeFileSync(path.join(folder, 'notes.json'), '{"not":"a profile"}');
    utimesSync(path.join(folder, 'notes.json'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    assert.deepEqual(findProfileFolders([root]), [folder]);
    const db = new DatabaseSync(':memory:');
    const first = importObservable(db, 's1', [folder]);
    assert.equal(first.imported, 1);
    assert.equal(first.failed.length, 1, 'the non-profile is reported once');
    const again = importObservable(db, 's1', [folder]);
    assert.equal(again.imported, 0);
    assert.equal(again.failed.length, 0, 'and not re-read');

    const entities = observableFor(db, 's1', 'entity')!;
    assert.deepEqual(entities.types.map((t) => [t.type, t.count, Math.round(t.mspt * 1000) / 1000]), [['entity.minecraft.zombie', 2, 0.06]]);
    assert.equal(entities.top[0]!.x, 10);
    assert.equal(observableFor(db, 's1', 'block')!.top[0]!.level, 'minecraft:the_nether');
    assert.equal(observableFor(db, 'other', 'entity'), undefined, 'kept per server');
    db.close();
  });
  test('a file still being written is left for the next pass', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'perfint-obs-'));
    writeFileSync(path.join(folder, '2026-09-23--18.04.11.json'), PROFILE);
    const db = new DatabaseSync(':memory:');
    assert.equal(importObservable(db, 's1', [folder]).imported, 0);
    assert.equal(importObservable(db, 's1', [folder], Date.now() + 60_000).imported, 1);
    db.close();
  });
});
