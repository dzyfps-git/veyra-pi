/**
 * Anomaly pinning.
 *
 * The asymmetry being tested: a false positive costs about 40 MB against
 * 5.3 TB free; a false negative destroys the only copy of the evidence for
 * the one hour that actually went wrong. Every case here leans on that.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { applyPins, rawDeletionCandidates, assessCapture, seasonBaseline } from '../src/analysis/anomaly.ts';

let store: Store;
let settings: SettingsStore;
let seasonId: number;
let revisionId: number;

const DAY = 86_400_000;

function addCapture(input: {
  name: string;
  startedAt: number;
  manual?: boolean;
  blocked?: number;
  windows?: Array<{ mspt_median?: number; mspt_max?: number; tps?: number; players?: number }>;
}): number {
  store.db
    .prepare(
      `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256,
                            started_at, window_count, path_count, raw_bytes, ingested_at,
                            is_manual, blocked_ms_per_tick, archive_path)
       VALUES ('s1',?,?,?,?,?,?,0,4096,1,?,?,?)`,
    )
    .run(
      seasonId,
      revisionId,
      input.name,
      `sha-${input.name}`,
      input.startedAt,
      input.windows?.length ?? 0,
      input.manual === true ? 1 : 0,
      input.blocked ?? 0,
      `D:/archive/${input.name}.sparkprofile`,
    );
  const id = Number((store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);

  (input.windows ?? []).forEach((w, index) => {
    store.db
      .prepare(
        `INSERT INTO capture_window (capture_id, window_id, start_time, ticks, players,
                                     tps, mspt_median, mspt_max)
         VALUES (?,?,?,1200,?,?,?,?)`,
      )
      .run(
        id,
        index,
        input.startedAt + index * 60_000,
        w.players ?? 0,
        w.tps ?? 20,
        w.mspt_median ?? 10,
        w.mspt_max ?? 20,
      );
  });
  return id;
}

beforeEach(() => {
  store = new Store({ file: ':memory:' });
  store.upsertServer('s1', 'main', 'Main');
  settings = new SettingsStore(store.db);

  const envId = store.upsertEnvironment({
    serverId: 's1',
    envKey: 'linux',
    mcVersion: '1.20.1',
    loaderName: 'Fabric',
    loaderVersion: '0.19.3',
    javaMajor: '17',
    cpuModel: 'test',
    cpuThreads: 8,
    osName: 'Ubuntu',
    seenAt: 1000,
  });
  seasonId = store.createSeason({
    serverId: 's1',
    environmentId: envId,
    ordinal: 1,
    startedAt: 1000,
    reason: 'test',
    confirmed: true,
  });
  revisionId = store.createRevision({
    seasonId,
    ordinal: 1,
    modSetHash: 'h',
    heapMaxMb: 14336,
    startedAt: 1000,
    reason: 'test',
    added: 0,
    removed: 0,
    changed: 0,
  });
});

describe('what gets pinned', () => {
  test('the first capture of a season, because it is the only baseline', () => {
    const id = addCapture({ name: 'first', startedAt: 10_000, windows: [{}] });
    const decision = assessCapture(store.db, settings, {
      id,
      source_name: 'first',
      season_id: seasonId,
      started_at: 10_000,
      pinned: 0,
      tick_ms_per_tick: 10,
      blocked_ms_per_tick: 0,
      is_manual: 0,
    });
    assert.equal(decision.pin, true);
    assert.ok(decision.reasons.some((r) => r.kind === 'first-in-season'));
  });

  test('a median above the bad threshold', () => {
    addCapture({ name: 'baseline', startedAt: 1_000, windows: [{}] });
    addCapture({ name: 'spike', startedAt: 20_000, windows: [{ mspt_median: 10 }, { mspt_median: 55 }] });
    const summary = applyPins(store.db, settings);
    const spike = summary.decisions.find((d) => d.sourceName === 'spike');
    assert.ok(spike?.reasons.some((r) => r.kind === 'mspt-excursion'));
  });

  test('a catastrophic tick, even when the median is fine', () => {
    addCapture({ name: 'baseline', startedAt: 1_000, windows: [{ mspt_max: 120 }] });
    addCapture({
      name: 'onebadtick',
      startedAt: 20_000,
      windows: [{ mspt_median: 9, mspt_max: 4000 }],
    });
    const summary = applyPins(store.db, settings);
    const hit = summary.decisions.find((d) => d.sourceName === 'onebadtick');
    assert.ok(hit, 'a four-second tick hidden by a healthy median is exactly what must be kept');
    assert.ok(hit.reasons.some((r) => r.kind === 'mspt-excursion'));
  });

  test('a routine spike is NOT pinned', () => {
    // 200-300 ms ticks are ordinary in a 579-mod pack. Pinning on them
    // pinned 28 of 29 real captures, which is the same as pinning none.
    addCapture({ name: 'baseline', startedAt: 1_000, windows: [{ mspt_max: 250, players: 5 }] });
    addCapture({ name: 'other', startedAt: 10_000, windows: [{ mspt_max: 280, players: 5 }] });
    addCapture({ name: 'routine', startedAt: 20_000, windows: [{ mspt_median: 12, mspt_max: 300, players: 4 }] });
    const summary = applyPins(store.db, settings);
    assert.equal(summary.decisions.find((d) => d.sourceName === 'routine'), undefined);
  });

  test('a TPS drop below 19', () => {
    addCapture({ name: 'baseline', startedAt: 1_000, windows: [{}] });
    addCapture({ name: 'slow', startedAt: 20_000, windows: [{ tps: 17.2 }] });
    const summary = applyPins(store.db, settings);
    assert.ok(
      summary.decisions.find((d) => d.sourceName === 'slow')?.reasons.some((r) => r.kind === 'tps-drop'),
    );
  });

  test('blocked time, judged in ms/tick rather than as a stall duration', () => {
    addCapture({ name: 'baseline', startedAt: 1_000, blocked: 0.2, windows: [{}] });
    addCapture({ name: 'quiet', startedAt: 5_000, blocked: 0.3, windows: [{}] });
    addCapture({ name: 'stalled', startedAt: 20_000, blocked: 4.9, windows: [{}] });
    const summary = applyPins(store.db, settings);
    assert.ok(
      summary.decisions
        .find((d) => d.sourceName === 'stalled')
        ?.reasons.some((r) => r.kind === 'blocking-stall'),
    );
    assert.equal(summary.decisions.find((d) => d.sourceName === 'quiet'), undefined);
  });

  test('a small amount of blocked time is not a stall', () => {
    // The original rule compared ms_per_tick * 1000 against a 1000 ms
    // threshold, so 1.1 ms/tick read as a 1100 ms stall and flagged almost
    // everything.
    addCapture({ name: 'baseline', startedAt: 1_000, blocked: 0.9, windows: [{}] });
    addCapture({ name: 'b2', startedAt: 5_000, blocked: 1.0, windows: [{}] });
    addCapture({ name: 'slightly-blocked', startedAt: 20_000, blocked: 1.1, windows: [{}] });
    const summary = applyPins(store.db, settings);
    assert.equal(summary.decisions.find((d) => d.sourceName === 'slightly-blocked'), undefined);
  });

  test('a player-count record for the season', () => {
    addCapture({ name: 'baseline', startedAt: 1_000, windows: [{ players: 4 }] });
    addCapture({ name: 'busy', startedAt: 20_000, windows: [{ players: 11 }] });
    const summary = applyPins(store.db, settings);
    assert.ok(
      summary.decisions.find((d) => d.sourceName === 'busy')?.reasons.some((r) => r.kind === 'player-record'),
    );
  });

  test('anything captured by hand', () => {
    addCapture({ name: 'baseline', startedAt: 1_000, windows: [{}] });
    addCapture({ name: 'byhand', startedAt: 20_000, manual: true, windows: [{}] });
    const summary = applyPins(store.db, settings);
    assert.ok(
      summary.decisions.find((d) => d.sourceName === 'byhand')?.reasons.some((r) => r.kind === 'manual'),
    );
  });

  test('an unremarkable capture is not pinned', () => {
    addCapture({ name: 'baseline', startedAt: 1_000, windows: [{ players: 4 }] });
    addCapture({ name: 'ordinary', startedAt: 20_000, windows: [{ players: 3, mspt_median: 11, tps: 20 }] });
    const summary = applyPins(store.db, settings);
    assert.equal(summary.decisions.find((d) => d.sourceName === 'ordinary'), undefined);
  });
});

describe('pinning behaviour', () => {
  test('a dry run writes nothing', () => {
    addCapture({ name: 'first', startedAt: 1_000, windows: [{}] });
    applyPins(store.db, settings, { dryRun: true });
    const row = store.db.prepare('SELECT pinned FROM capture').get() as { pinned: number };
    assert.equal(row.pinned, 0);
  });

  test('the reason is stored as readable text, not a code', () => {
    addCapture({ name: 'first', startedAt: 1_000, windows: [{}] });
    applyPins(store.db, settings);
    const row = store.db.prepare('SELECT pinned, pinned_reason FROM capture').get() as {
      pinned: number;
      pinned_reason: string;
    };
    assert.equal(row.pinned, 1);
    assert.match(row.pinned_reason, /only baseline/);
  });

  test('a pin is never removed by a later run', () => {
    const id = addCapture({ name: 'first', startedAt: 1_000, windows: [{}] });
    applyPins(store.db, settings);
    // A threshold change that would no longer flag it must not unpin it.
    settings.apply({ 'analysis.thresholds.msptMedianBad': 50 }, { actor: 'test' });
    applyPins(store.db, settings);
    const row = store.db.prepare('SELECT pinned FROM capture WHERE id = ?').get(id) as { pinned: number };
    assert.equal(row.pinned, 1);
  });

  test('turning pinning off disables it entirely', () => {
    addCapture({ name: 'first', startedAt: 1_000, windows: [{}] });
    settings.apply({ 'retention.pinAnomalies': false }, { actor: 'test' });
    const summary = applyPins(store.db, settings);
    assert.equal(summary.examined, 0);
    assert.equal(summary.pinned, 0);
  });
});

describe('what retention may delete', () => {
  test('never a pinned capture, however old', () => {
    const now = Date.now();
    addCapture({ name: 'ancient', startedAt: now - 400 * DAY, windows: [{}] });
    applyPins(store.db, settings); // pins it: first in season
    assert.deepEqual(rawDeletionCandidates(store.db, settings, now), []);
  });

  test('never a capture inside the retention window', () => {
    const now = Date.now();
    addCapture({ name: 'baseline', startedAt: now - 400 * DAY, windows: [{}] });
    addCapture({ name: 'recent', startedAt: now - 2 * DAY, windows: [{ players: 1 }] });
    const candidates = rawDeletionCandidates(store.db, settings, now);
    assert.equal(candidates.find((c) => c.source_name === 'recent'), undefined);
  });

  test('an old unremarkable capture is eligible', () => {
    const now = Date.now();
    addCapture({ name: 'baseline', startedAt: now - 400 * DAY, windows: [{ players: 9 }] });
    addCapture({ name: 'old-ordinary', startedAt: now - 60 * DAY, windows: [{ players: 2 }] });
    applyPins(store.db, settings);
    const candidates = rawDeletionCandidates(store.db, settings, now);
    assert.ok(candidates.some((c) => c.source_name === 'old-ordinary'));
  });

  test('a capture with no archived copy is never a candidate', () => {
    const now = Date.now();
    store.db
      .prepare(
        `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256,
                              started_at, window_count, path_count, raw_bytes, ingested_at, is_manual, archive_path)
         VALUES ('s1',?,?,'unarchived','sha-x',?,0,0,1,1,0,NULL)`,
      )
      .run(seasonId, revisionId, now - 90 * DAY);
    const candidates = rawDeletionCandidates(store.db, settings, now);
    assert.equal(candidates.find((c) => c.source_name === 'unarchived'), undefined);
  });

  test('changing the retention setting changes the cutoff without code changes', () => {
    const now = Date.now();
    addCapture({ name: 'baseline', startedAt: now - 400 * DAY, windows: [{ players: 9 }] });
    addCapture({ name: 'twelve-days', startedAt: now - 12 * DAY, windows: [{ players: 2 }] });
    applyPins(store.db, settings);

    // Default is 15 days, so a 12-day-old capture is safe.
    assert.equal(
      rawDeletionCandidates(store.db, settings, now).find((c) => c.source_name === 'twelve-days'),
      undefined,
    );

    settings.apply({ 'retention.rawDays': 10 }, { actor: 'test' });
    assert.ok(
      rawDeletionCandidates(store.db, settings, now).some((c) => c.source_name === 'twelve-days'),
      'lowering retention to 10 days should make a 12-day-old capture eligible',
    );
  });
});

describe('thresholds are relative to the season', () => {
  test('the same spike is unusual on a quiet season and ordinary on a spiky one', () => {
    // A 1.5-second tick against a season whose normal worst is 100 ms.
    addCapture({ name: 'q1', startedAt: 1_000, windows: [{ mspt_max: 90 }] });
    addCapture({ name: 'q2', startedAt: 2_000, windows: [{ mspt_max: 110 }] });
    const spikeId = addCapture({ name: 'spike', startedAt: 20_000, windows: [{ mspt_max: 1500 }] });

    const decision = assessCapture(store.db, settings, {
      id: spikeId,
      source_name: 'spike',
      season_id: seasonId,
      started_at: 20_000,
      pinned: 0,
      tick_ms_per_tick: 10,
      blocked_ms_per_tick: 0,
      is_manual: 0,
    });
    assert.ok(decision.reasons.some((r) => r.kind === 'mspt-excursion'));
    assert.match(decision.reasons.find((r) => r.kind === 'mspt-excursion')!.detail, /season median worst tick/);
  });

  test('the baseline excludes the capture being judged', () => {
    addCapture({ name: 'a', startedAt: 1_000, windows: [{ mspt_max: 100, players: 3 }] });
    const bId = addCapture({ name: 'b', startedAt: 2_000, windows: [{ mspt_max: 5000, players: 9 }] });
    const base = seasonBaseline(store.db, seasonId, bId);
    assert.equal(base.captures, 1);
    assert.equal(base.medianWorstTick, 100, 'the capture under test must not raise its own bar');
    assert.equal(base.peakPlayers, 3);
  });

  test('an empty season falls back to the absolute floor', () => {
    const id = addCapture({ name: 'only', startedAt: 1_000, windows: [{ mspt_max: 1200 }] });
    const decision = assessCapture(store.db, settings, {
      id,
      source_name: 'only',
      season_id: seasonId,
      started_at: 1_000,
      pinned: 0,
      tick_ms_per_tick: 10,
      blocked_ms_per_tick: 0,
      is_manual: 0,
    });
    const excursion = decision.reasons.find((r) => r.kind === 'mspt-excursion');
    assert.ok(excursion, 'a 1.2 second tick is over the one-second floor');
    assert.match(excursion.detail, /no season baseline yet/);
  });
});

describe('over-pinning is reported rather than left to be discovered', () => {
  test('flags it when nearly everything qualifies', () => {
    // Every capture a player record and a stall: the thresholds would be
    // describing normal behaviour.
    for (let i = 0; i < 12; i += 1) {
      addCapture({
        name: `c${i}`,
        startedAt: 1_000 + i * 1_000,
        windows: [{ players: i + 1, tps: 17 }],
      });
    }
    const summary = applyPins(store.db, settings);
    assert.ok(summary.overPinning, 'pinning nearly everything is the same as pinning nothing');
    assert.match(summary.overPinning, /retention will effectively never delete/);
  });

  test('stays quiet at a sane rate', () => {
    for (let i = 0; i < 12; i += 1) {
      addCapture({ name: `c${i}`, startedAt: 1_000 + i * 1_000, windows: [{ players: 3, mspt_max: 120 }] });
    }
    const summary = applyPins(store.db, settings);
    assert.equal(summary.overPinning, undefined);
  });
});
