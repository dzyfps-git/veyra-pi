/**
 * Page computations are reused only while the database is unchanged: any
 * write through the shared connection makes the next call compute again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { memo } from '../src/store/memo.ts';
import { seasonDayBounds } from '../src/query/range.ts';

test('a result is reused until something is written', () => {
  const store = new Store({ file: ':memory:' });
  let runs = 0;
  const compute = (): number => ++runs;
  assert.equal(memo(store.db, 'k', compute), 1);
  assert.equal(memo(store.db, 'k', compute), 1, 'nothing written: reused');
  assert.equal(memo(store.db, 'other', compute), 2, 'another key computes on its own');
  new SettingsStore(store.db).apply({ 'retention.rawDays': 12 }, { actor: 'test' });
  assert.equal(memo(store.db, 'k', compute), 3, 'a settings write invalidates it');
  store.setMeta('x', 'y');
  assert.equal(memo(store.db, 'k', compute), 4, 'so does any other write');
  store.close();
});

test('season day bounds come from the index, first and last day', () => {
  const store = new Store({ file: ':memory:' });
  assert.equal(seasonDayBounds(store.db, 1), undefined);
  // Only day and season matter here; the ledger's references are not the point.
  store.db.exec('PRAGMA foreign_keys = OFF');
  const insert = store.db.prepare(
    `INSERT INTO path_daily (day, server_id, season_id, path_id, activity, self_ms, total_ms, ticks, windows_present, windows_total, captures_present, category)
     VALUES (?, 's', ?, 1, 'all', 1, 1, 1, 1, 1, 1, 'work')`,
  );
  for (const [day, season] of [['2026-09-03', 1], ['2026-09-01', 1], ['2026-09-09', 1], ['2026-08-01', 2], ['2026-10-01', 2]] as const) insert.run(day, season);
  assert.deepEqual(seasonDayBounds(store.db, 1), { fromDay: '2026-09-01', toDay: '2026-09-09' });
  store.close();
});
