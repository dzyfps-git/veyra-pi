import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';
import { Register } from '../src/analysis/register.ts';
import type { ValidationResult } from '../src/analysis/validate.ts';

let store: Store;
let reg: Register;
let id: number;

beforeEach(() => {
  store = new Store({ file: ':memory:' });
  store.upsertServer('s1', 'main', 'Main');
  reg = new Register(store.db);
  id = reg.create({ serverId: 's1', title: 'Cache the config lookup', targetLabel: 'ConfigManager.get' });
});

const result = (verdict: ValidationResult['verdict'], delta: number): ValidationResult => ({
  verdict,
  deltaMsPerTick: delta,
  ciLow: delta - 0.01,
  ciHigh: delta + 0.01,
  beforeMedian: 0.5,
  afterMedian: 0.5 + delta,
  beforeWindows: 40,
  afterWindows: 40,
  bucketsCompared: [2],
  explanation: 'test',
});

describe('implemented is not the same as proven', () => {
  test('a measured status cannot be set by hand', () => {
    reg.markDeployed(id, Date.now());
    const r = reg.setStatus(id, 'measured-improvement');
    assert.equal(r.ok, false);
    assert.match(r.error!, /cannot be set by hand/);
    assert.equal(reg.get(id)!.status, 'implemented');
  });

  test('only the validation engine assigns a measured status', () => {
    reg.markDeployed(id, Date.now());
    const assigned = reg.recordValidation(id, result('improved', -0.4));
    assert.equal(assigned, 'measured-improvement');
    assert.equal(reg.get(id)!.status, 'measured-improvement');
  });

  test('a synthetic benchmark can never change the status', () => {
    reg.markDeployed(id, Date.now());
    reg.attachSynthetic(id, 'JMH: 40% faster in isolation');
    const after = reg.get(id)!;
    assert.equal(after.status, 'implemented', 'a microbenchmark is not evidence about the server');
    assert.match(after.synthetic_note!, /JMH/);
    assert.equal(after.verdict, null);
  });

  test('an inconclusive validation leaves the status untouched', () => {
    reg.markDeployed(id, Date.now());
    const assigned = reg.recordValidation(id, result('inconclusive', 0));
    assert.equal(assigned, undefined);
    assert.equal(reg.get(id)!.status, 'implemented');
    assert.equal(reg.get(id)!.verdict, 'inconclusive', 'the attempt is still recorded');
  });

  test('a regression is recorded as such, not quietly dropped', () => {
    reg.markDeployed(id, Date.now());
    reg.recordValidation(id, result('regressed', 0.3));
    assert.equal(reg.get(id)!.status, 'regressed');
  });
});

describe('the status ladder', () => {
  test('rejects nonsensical transitions', () => {
    assert.equal(reg.setStatus(id, 'proposed').ok, false, 'already proposed');
    assert.equal(reg.setStatus(id, 'investigating').ok, true);
    assert.equal(reg.setStatus(id, 'implemented').ok, true);
  });

  test('a validated change can still be reverted', () => {
    reg.markDeployed(id, Date.now());
    reg.recordValidation(id, result('improved', -0.4));
    assert.equal(reg.setStatus(id, 'reverted').ok, true);
  });
});

describe('history', () => {
  test('every action is recorded and nothing is deleted', () => {
    reg.markDeployed(id, Date.now());
    reg.attachSynthetic(id, 'bench');
    reg.recordValidation(id, result('improved', -0.2));
    reg.setStatus(id, 'reverted');
    const kinds = reg.events(id).map((e) => e.kind);
    for (const k of ['created', 'deployed', 'synthetic-benchmark', 'validated', 'status']) {
      assert.ok(kinds.includes(k), `expected a ${k} event`);
    }
  });

  test('a reverted entry keeps its measurements for when the problem returns', () => {
    reg.markDeployed(id, Date.now());
    reg.recordValidation(id, result('improved', -0.4));
    reg.setStatus(id, 'reverted');
    const after = reg.get(id)!;
    assert.equal(after.status, 'reverted');
    assert.ok(after.delta_ms_per_tick! < 0, 'the evidence survives the revert');
  });
});
