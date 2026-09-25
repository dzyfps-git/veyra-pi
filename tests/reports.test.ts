/**
 * Generated reports and the remaining HTTP surface.
 *
 * The handoff brief gets the most attention here, because it is the document
 * someone actually acts on. The property that matters is not that it is well
 * formatted — it is that a field the archive does not know is printed as a
 * gap rather than filled with something plausible.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { Store } from '../src/store/db.ts';
import { SettingsStore } from '../src/settings/store.ts';
import { loadBranding } from '../src/core/brand.ts';
import { createWebServer } from '../src/web/server.ts';
import { renderLeaderboard, renderIndex } from '../src/report/markdown.ts';
import { renderHandoff, renderModBrief, renderThingBrief } from '../src/report/handoff.ts';
import { findings } from '../src/analysis/findings.ts';
import type { Finding } from '../src/analysis/findings.ts';

let store: Store;
let server: Server;
let base: string;
let seasonId: number;

/** A minimal archive: one server, one environment, one season, one capture. */
function seed(store: Store): number {
  store.upsertServer('s1', 'main', 'Main');
  const envId = store.upsertEnvironment({
    serverId: 's1',
    envKey: 'linux',
    mcVersion: '1.20.1',
    loaderName: 'Fabric',
    loaderVersion: '0.19.3',
    javaMajor: '17',
    cpuModel: 'test cpu',
    cpuThreads: 8,
    osName: 'Ubuntu 26.04.1 LTS',
    seenAt: 1000,
  });
  const season = store.createSeason({
    serverId: 's1',
    environmentId: envId,
    ordinal: 1,
    startedAt: 1000,
    reason: 'first capture for this server',
    confirmed: true,
  });
  const revision = store.createRevision({
    seasonId: season,
    ordinal: 1,
    modSetHash: 'hash',
    heapMaxMb: 14336,
    startedAt: 1000,
    reason: 'first',
    added: 0,
    removed: 0,
    changed: 0,
  });

  store.db
    .prepare(
      `INSERT INTO capture (server_id, season_id, revision_id, source_name, content_sha256,
                            started_at, ended_at, interval_micros, divisor_ticks,
                            window_count, path_count, raw_bytes, ingested_at, is_manual,
                            tick_ms_per_tick, idle_ms_per_tick, blocked_ms_per_tick,
                            wall_ms_per_tick, archive_path)
       VALUES ('s1',?,?,'testprofile','sha-1',1000,61000,10000,1200,1,1,4096,1,0,
               11.4,28.9,0.31,44.8,'D:/archive/testprofile.sparkprofile')`,
    )
    .run(season, revision);

  // One costly path: a mod-owned frame under the tick.
  const tickFrame = store.internFrame(
    'net.minecraft.server.MinecraftServer.tick',
    'net.minecraft.server.MinecraftServer',
    'tick',
  );
  const leafFrame = store.internFrame(
    'noobanidus.mods.lootr.ticker.TileTicker.onServerTick',
    'noobanidus.mods.lootr.ticker.TileTicker',
    'onServerTick',
  );
  const root = store.internPathEdge({ parentId: 0, frameId: tickFrame, depth: 0, source: null, seenAt: 1000 });
  const leaf = store.internPathEdge({ parentId: root, frameId: leafFrame, depth: 1, source: 'lootr', seenAt: 1000 });

  store.db
    .prepare(
      `INSERT INTO path_daily (day, server_id, season_id, path_id, activity, self_ms, total_ms, ticks,
                               windows_present, windows_total, captures_present, category)
       VALUES ('2026-09-01','s1',?,?,'playing',2400,2400,1200,10,10,1,'work')`,
    )
    .run(season, leaf);
  store.rebuildRollup();
  return season;
}

before(async () => {
  store = new Store({ file: ':memory:' });
  seasonId = seed(store);
  const settings = new SettingsStore(store.db);
  server = createWebServer({ store, settings, branding: loadBranding('config'), host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

after(() => {
  server.close();
  store.close();
});

describe('the leaderboard', () => {
  test('states its ordering, because it is not the usual one', () => {
    const md = renderLeaderboard(store.db, { seasonId });
    assert.match(md, /best chance to win MSPT back/i);
    assert.match(md, /Nothing is called hard on a\s+guess/);
  });

  test('says figures are never added together', () => {
    const md = renderLeaderboard(store.db, { seasonId });
    assert.match(md, /never added together/i);
  });

  test('surfaces prior work on a target', () => {
    const md = renderLeaderboard(store.db, { seasonId });
    assert.match(md, /Seen before/);
    assert.match(md, /Lootr rebuilds its tile set/);
  });

  test('keeps corrections visible rather than applying them silently', () => {
    const md = renderLeaderboard(store.db, {
      seasonId,
      corrections: [
        { subject: 'entrySet()', wrong: '3.47 ms/tick', right: '2.09 ms/tick', why: 'added a nested lambda to its parent' },
      ],
    });
    assert.match(md, /## Corrections/);
    assert.match(md, /3\.47/);
    assert.match(md, /nested lambda/);
  });

  test('an empty archive says so instead of rendering an empty table', () => {
    const empty = new Store({ file: ':memory:' });
    assert.match(renderLeaderboard(empty.db), /No captures have been ingested/);
    empty.close();
  });
});

describe('the capture index', () => {
  test('explains that tick is not wall time', () => {
    const md = renderIndex(store.db);
    assert.match(md, /not thread wall time/i);
    assert.match(md, /testprofile/);
  });

  test('does not read a missing engine as the Java sampler', () => {
    const md = renderIndex(store.db);
    assert.match(md, /absence is never read as "Java sampler"/);
    assert.match(md, /unknown/);
  });
});

describe('the handoff brief', () => {
  function brief(options = {}): string {
    const list = findings(store.db, { seasonId, limit: 50 });
    const target = list.find((f) => f.label.includes('TileTicker')) as Finding;
    assert.ok(target, 'the seeded finding should be present');
    return renderHandoff(store.db, target, options);
  }

  test('prints unknown fields as gaps rather than inventing them', () => {
    const text = brief();
    assert.match(text, /Installed JAR: <UNKNOWN/);
    assert.match(text, /JAR SHA-256: <UNKNOWN/);
    assert.match(text, /Build only in a new isolated project at: <UNKNOWN/);
    // Nothing that looks like a real path may appear where one is unknown.
    assert.doesNotMatch(text, /Installed JAR: [A-Z]:\\/);
  });

  test('uses supplied values when they are known', () => {
    const text = brief({ projectDir: 'D:/build/here', jarPath: 'D:/mods/x.jar' });
    assert.match(text, /D:\/build\/here/);
    assert.match(text, /D:\/mods\/x\.jar/);
  });

  test('carries the environment the archive actually recorded', () => {
    const text = brief();
    assert.match(text, /Minecraft 1\.20\.1/);
    assert.match(text, /Java 17/);
    assert.match(text, /Fabric 0\.19\.3/);
  });

  test('warns against the double-count that happened here before', () => {
    assert.match(brief(), /Do not add it to any parent or child/);
  });

  test('states the acceptance gate and refuses synthetic benchmarks as proof', () => {
    const text = brief();
    assert.match(text, /0\.03 MSPT/);
    assert.match(text, /NOT acceptance evidence/);
    assert.match(text, /"No measurable change" is a complete and acceptable result/);
  });

  test('a whole-mod brief lists its methods and keeps the same safety process and acceptance gate', () => {
    const list = findings(store.db, { seasonId, limit: 50 });
    const mod = list.find((f) => f.source !== null)?.source ?? 'somemod';
    const text = renderModBrief(store.db, {
      mod,
      findings: list.filter((f) => f.source === mod).map((f) => ({ lead: f, msPerTick: f.msPerTick, totalMsPerTick: f.totalMsPerTick, paths: 1 })),
      places: [{ system: 'entities', systemName: 'Entities', mspt: 0.5, things: [{ name: 'Villager', mspt: 0.3 }] }],
      totalMspt: 0.5,
      tickMspt: 10,
      measuredMspt: 9.5,
      minutes: 60,
      ownMod: true,
      placeOf: () => 'Entities',
    });
    assert.match(text, new RegExp(`the mod \`${mod}\``));
    assert.match(text, /one of the server owner's own mods/);
    assert.match(text, /Entities: 0\.500 MSPT — Villager 0\.300/);
    assert.match(text, /ITS METHODS, BIGGEST FIRST/);
    assert.match(text, /MANDATORY SAFETY PROCESS/);
    assert.match(text, /0\.03 MSPT/);
    assert.match(text, /<UNKNOWN/);
  });

  test('a brief for one thing names its span, the methods inside it and the mods involved', () => {
    const list = findings(store.db, { seasonId, limit: 50 });
    const text = renderThingBrief(store.db, {
      systemName: 'Entities',
      thing: 'Mod hook on every entity (tick)',
      owner: 'cardinal-components-entity',
      span: '2026-09-23 11:19 to 2026-09-23 11:21',
      thingMspt: 0.775,
      tickMspt: 14,
      measuredMspt: 11.6,
      minutes: 2,
      methods: [
        { method: 'a.b.Apoli.writeToNbt', owner: 'apoli', mspt: 0.02 },
        { method: 'net.minecraft.Foo.bar', owner: 'Minecraft', mspt: 0.01 },
      ],
      listedMspt: 0.03,
      findings: list.slice(0, 1).map((f) => ({ lead: f, mspt: 0.2 })),
      ownMod: (m) => m === 'apoli',
    });
    assert.match(text, /"Mod hook on every entity \(tick\)" \(Entities\)/);
    assert.match(text, /0\.775 MSPT of every tick \(5\.5% of the tick\), over 2026-09-23 11:19 to 2026-09-23 11:21/);
    assert.match(text, /It belongs to cardinal-components-entity/);
    assert.match(text, /Mods whose code runs inside it \(own time\): apoli 0\.020\./);
    assert.match(text, /1\. `a\.b\.Apoli\.writeToNbt` \(apoli\) — 0\.0200 MSPT/);
    assert.match(text, /Plus 0\.745 MSPT in call paths each too small to list/);
    assert.match(text, /`apoli` is one of the server owner's own mods/);
    assert.match(text, /A short span can be one unusual moment/);
    assert.match(text, /MANDATORY SAFETY PROCESS/);
  });

  test('includes prior work on the same target', () => {
    const text = brief();
    assert.match(text, /PRIOR WORK ON THIS/);
    assert.match(text, /Lootr rebuilds its tile set/);
  });

  test('says plainly what is not known', () => {
    const text = brief();
    assert.match(text, /WHAT IS NOT KNOWN/);
    assert.match(text, /measures TIME, not call counts/);
  });
});

describe('report routes', () => {
  test('the leaderboard downloads with a filename', async () => {
    const res = await fetch(`${base}/reports/leaderboard.md`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /PATCH_LEADERBOARD\.md/);
  });

  test('view mode renders instead of downloading', async () => {
    const res = await fetch(`${base}/reports/leaderboard.md?view=1`);
    assert.equal(res.headers.get('content-disposition'), null);
  });

  test('a handoff for an unknown label is a 404, not an empty brief', async () => {
    const res = await fetch(`${base}/reports/handoff.txt?label=nope`);
    assert.equal(res.status, 404);
  });

  test('a handoff with blank parameters still prints gaps', async () => {
    const list = findings(store.db, { seasonId, limit: 50 });
    const label = list.find((f) => f.label.includes('TileTicker'))!.label;
    const res = await fetch(`${base}/reports/handoff.txt?label=${encodeURIComponent(label)}&projectDir=`);
    const text = await res.text();
    assert.match(text, /<UNKNOWN/);
  });
});

describe('metrics', () => {
  test('exposes counts in Prometheus format', async () => {
    const body = await (await fetch(`${base}/metrics`)).text();
    assert.match(body, /# TYPE perfint_captures_total counter/);
    assert.match(body, /perfint_captures_total 1/);
    assert.match(body, /perfint_call_paths \d+/);
  });

  test('labels the tick metric as the tick anchor, not wall time', async () => {
    const body = await (await fetch(`${base}/metrics`)).text();
    assert.match(body, /never thread wall time/);
    assert.match(body, /perfint_last_capture_tick_ms 11\.4/);
  });

  test('emits no per-path series', async () => {
    // A million call paths would make a scrape useless and expensive.
    const body = await (await fetch(`${base}/metrics`)).text();
    assert.doesNotMatch(body, /perfint_path_/);
  });
});

describe('seasons and capture pages', () => {
  test('the server timeline groups seasons by machine and says why', async () => {
    const body = await (await fetch(`${base}/server`)).text();
    assert.match(body, /never compared across machines/);
  });

  test('a capture page shows the tick anchor and warns about wall time', async () => {
    const id = (store.db.prepare('SELECT id FROM capture LIMIT 1').get() as { id: number }).id;
    const body = await (await fetch(`${base}/capture?id=${id}`)).text();
    assert.match(body, /most misleading number/);
    assert.match(body, /spark/);
  });

  test('a missing capture says so rather than erroring', async () => {
    const res = await fetch(`${base}/capture?id=999999`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /No such capture/);
  });
});
