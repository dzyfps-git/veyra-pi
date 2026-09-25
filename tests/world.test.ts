/**
 * World identity, and the line between a fact and a question.
 *
 * The rule under test: a **seed** change is acted on automatically, because
 * it cannot mean anything else. Anything weaker produces a question, because
 * splitting history on a guess destroys the continuity the archive exists to
 * provide — and a wrongly-split history is much harder to notice than a
 * wrongly-merged one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { identifyWorld, compareWorlds, suggestSeasonLabel } from '../src/model/world.ts';
import { parseNbt, parseMaybeGzippedNbt, nbtPath, NbtError, TAG } from '../src/decode/nbt.ts';
import { Store } from '../src/store/db.ts';

describe('identifying a world', () => {
  test('a seed is the strongest identity', () => {
    const id = identifyWorld({ seed: '-134980110325893125', levelName: 'world' });
    assert.equal(id.strength, 'seed');
    assert.ok(id.fingerprint);
    assert.match(id.basis, /level\.dat/);
  });

  test('without a seed it falls back and says the fallback is weak', () => {
    const id = identifyWorld({ levelName: 'world', levelType: 'bclib:normal' });
    assert.equal(id.strength, 'name');
    assert.match(id.basis, /NOT detectable/);
  });

  test('with nothing at all it refuses to invent a fingerprint', () => {
    const id = identifyWorld({});
    assert.equal(id.strength, 'none');
    assert.equal(id.fingerprint, undefined);
  });

  test('the same seed always produces the same fingerprint', () => {
    const a = identifyWorld({ seed: '123', levelName: 'world' });
    const b = identifyWorld({ seed: '123', levelName: 'renamed-but-same-world' });
    assert.equal(a.fingerprint, b.fingerprint, 'renaming a world does not make it a different world');
  });

  test('a different seed produces a different fingerprint', () => {
    assert.notEqual(
      identifyWorld({ seed: '123' }).fingerprint,
      identifyWorld({ seed: '124' }).fingerprint,
    );
  });

  test('datapack order does not change the fingerprint', () => {
    const a = identifyWorld({ levelName: 'world', datapacks: ['a', 'b', 'c'] });
    const b = identifyWorld({ levelName: 'world', datapacks: ['c', 'a', 'b'] });
    assert.equal(a.fingerprint, b.fingerprint);
  });
});

describe('comparing worlds', () => {
  const seedA = identifyWorld({ seed: '111', levelName: 'world' });
  const seedB = identifyWorld({ seed: '222', levelName: 'world' });
  const weakA = identifyWorld({ levelName: 'world', levelType: 'normal' });
  const weakB = identifyWorld({ levelName: 'world2', levelType: 'normal' });

  test('same seed is confidently the same world', () => {
    const change = compareWorlds(seedA, seedA);
    assert.equal(change.kind, 'same');
    assert.equal(change.confident, true);
  });

  test('a different seed is confidently a NEW world', () => {
    const change = compareWorlds(seedA, seedB);
    assert.equal(change.kind, 'changed');
    assert.equal(change.confident, true);
    assert.match(change.reason, /seed changed/);
  });

  test('a world reset that keeps the name is invisible without a seed', () => {
    // This is the honest limitation, stated rather than papered over.
    const change = compareWorlds(weakA, weakA);
    assert.equal(change.kind, 'same');
    assert.equal(change.confident, false);
    assert.match(change.reason, /looks identical/);
  });

  test('a weak difference is SUSPECTED, never acted on', () => {
    const change = compareWorlds(weakA, weakB);
    assert.equal(change.kind, 'suspected');
    assert.equal(change.confident, false);
    assert.match(change.reason, /cannot be confirmed/);
  });

  test('gaining or losing seed access is unknown, not a change', () => {
    // The server directory becoming reachable must not look like a world reset.
    const gained = compareWorlds(weakA, seedA);
    assert.equal(gained.kind, 'unknown');
    assert.match(gained.reason, /cannot be compared/);

    const lost = compareWorlds(seedA, weakA);
    assert.equal(lost.kind, 'unknown');
  });

  test('the first capture is never a change', () => {
    assert.equal(compareWorlds(undefined, seedA).kind, 'same');
  });

  test('an unidentifiable world is unknown on both sides', () => {
    const none = identifyWorld({});
    assert.equal(compareWorlds(seedA, none).kind, 'unknown');
    assert.equal(compareWorlds(none, seedA).kind, 'unknown');
  });
});

describe('the NBT reader', () => {
  /** Build a compound { Data: { LevelName: "world", RandomSeed: 42L } }. */
  function buildLevelDat(): Buffer {
    const parts: Buffer[] = [];
    const str = (value: string): Buffer => {
      const body = Buffer.from(value, 'utf8');
      const head = Buffer.alloc(2);
      head.writeUInt16BE(body.length);
      return Buffer.concat([head, body]);
    };

    parts.push(Buffer.from([TAG.Compound]), str(''));       // root
    parts.push(Buffer.from([TAG.Compound]), str('Data'));   // Data {
    parts.push(Buffer.from([TAG.String]), str('LevelName'), str('world'));
    const seed = Buffer.alloc(8);
    seed.writeBigInt64BE(42n);
    parts.push(Buffer.from([TAG.Long]), str('RandomSeed'), seed);
    parts.push(Buffer.from([TAG.End]));                     // }
    parts.push(Buffer.from([TAG.End]));                     // root end
    return Buffer.concat(parts);
  }

  test('parses a compound', () => {
    const root = parseNbt(buildLevelDat());
    assert.equal(nbtPath(root.value, 'Data', 'LevelName'), 'world');
    assert.equal(nbtPath(root.value, 'Data', 'RandomSeed'), 42n);
  });

  test('transparently handles gzip', () => {
    const root = parseMaybeGzippedNbt(gzipSync(buildLevelDat()));
    assert.equal(nbtPath(root.value, 'Data', 'LevelName'), 'world');
  });

  test('nbtPath returns undefined rather than throwing on a missing key', () => {
    const root = parseNbt(buildLevelDat());
    assert.equal(nbtPath(root.value, 'Data', 'Nope'), undefined);
    assert.equal(nbtPath(root.value, 'Nope', 'Deeper'), undefined);
    // Walking THROUGH a non-compound must not throw either.
    assert.equal(nbtPath(root.value, 'Data', 'LevelName', 'further'), undefined);
  });

  test('refuses a truncated file instead of returning junk', () => {
    const full = buildLevelDat();
    assert.throws(() => parseNbt(full.subarray(0, full.length - 6)), NbtError);
  });

  test('refuses a non-compound root', () => {
    assert.throws(() => parseNbt(Buffer.from([TAG.String, 0, 0])), NbtError);
  });

  test('refuses an implausible array length rather than allocating it', () => {
    const parts = [
      Buffer.from([TAG.Compound]),
      Buffer.from([0, 0]),
      Buffer.from([TAG.IntArray]),
      Buffer.from([0, 1, 0x61]), // name "a"
      Buffer.from([0x7f, 0xff, 0xff, 0xff]), // length 2^31-1
    ];
    assert.throws(() => parseNbt(Buffer.concat(parts)), NbtError);
  });
});

describe('the store keeps worlds and questions', () => {
  function fixture(): Store {
    const store = new Store({ file: ':memory:' });
    store.upsertServer('s1', 'main', 'Main');
    return store;
  }

  test('the same fingerprint resolves to the same world', () => {
    const store = fixture();
    const a = store.upsertWorld({ serverId: 's1', fingerprint: 'abc', strength: 'seed', seed: '1', seenAt: 10 });
    const b = store.upsertWorld({ serverId: 's1', fingerprint: 'abc', strength: 'seed', seed: '1', seenAt: 20 });
    assert.equal(a, b);
    assert.equal(store.worlds('s1').length, 1);
    store.close();
  });

  test('a different fingerprint is a different world', () => {
    const store = fixture();
    store.upsertWorld({ serverId: 's1', fingerprint: 'abc', strength: 'seed', seed: '1', seenAt: 10 });
    store.upsertWorld({ serverId: 's1', fingerprint: 'def', strength: 'seed', seed: '2', seenAt: 20 });
    assert.equal(store.worlds('s1').length, 2);
    store.close();
  });

  test('a world can be named, and the name is never generated', () => {
    const store = fixture();
    const id = store.upsertWorld({ serverId: 's1', fingerprint: 'abc', strength: 'seed', seenAt: 1 });
    assert.equal(store.getWorld(id)?.label, null, 'a world starts with no name at all');
    store.nameWorld(id, 'Spring World 2');
    assert.equal(store.getWorld(id)?.label, 'Spring World 2');
    store.close();
  });

  test('an unanswered question is asked once, not once per capture', () => {
    const store = fixture();
    const ask = (): number =>
      store.askBoundaryQuestion({
        serverId: 's1',
        kind: 'world-suspected',
        question: 'Same world?',
        detail: 'level name changed',
        options: [{ id: 'same-world', label: 'Same', description: 'keep' }],
      });
    assert.equal(ask(), ask());
    assert.equal(store.openQuestions('s1').length, 1);
    store.close();
  });

  test('answering closes it', () => {
    const store = fixture();
    const id = store.askBoundaryQuestion({
      serverId: 's1',
      kind: 'world-unknown',
      question: 'Same world?',
      detail: 'no seed',
      options: [{ id: 'same-world', label: 'Same', description: 'keep' }],
    });
    store.answerQuestion(id, 'same-world');
    assert.equal(store.openQuestions('s1').length, 0);
    store.close();
  });

  test('an answer cannot be silently overwritten', () => {
    const store = fixture();
    const id = store.askBoundaryQuestion({
      serverId: 's1',
      kind: 'world-unknown',
      question: 'Same world?',
      detail: 'no seed',
      options: [],
    });
    store.answerQuestion(id, 'same-world');
    store.answerQuestion(id, 'new-world');
    const row = store.db.prepare('SELECT answer FROM boundary_question WHERE id = ?').get(id) as { answer: string };
    assert.equal(row.answer, 'same-world');
    store.close();
  });
});

describe('suggested labels', () => {
  test('describe what is known and invent no modpack name', () => {
    const label = suggestSeasonLabel({
      mcVersion: '1.20.1',
      loaderName: 'Fabric',
      worldName: 'world',
      startedAt: Date.UTC(2026, 8, 22),
      ordinal: 2,
    });
    assert.match(label, /Fabric 1\.20\.1/);
    assert.match(label, /season 2/);
    assert.match(label, /2026-09-22/);
    // spark does not report a modpack, so none may appear.
    assert.doesNotMatch(label, /pack/i);
  });
});
