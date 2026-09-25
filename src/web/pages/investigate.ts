/**
 * "What happened, and why": one minute explained, the list of freezes, and
 * what normal MSPT looks like at each player count.
 *
 * Plain words first, numbers in MSPT, and the limits of the evidence stated
 * on the page rather than left to be assumed. Call paths are one click away,
 * never the first thing on screen.
 */

import type { DatabaseSync } from 'node:sqlite';

import { esc, num, when, panel, stat, banner, duration, clockTime, dayLabel } from '../layout.ts';
import { localInputValue } from '../../query/range.ts';
import type { ServerConfig } from '../../store/servers.ts';
import { FREEZE_MS, minuteDetail, msptByPlayers, stalls, type Difference, type PlayerBand, type Stall } from '../../analysis/minute.ts';
import { threadProfiles } from '../../analysis/threads.ts';

export const INVESTIGATE_STYLE = `<style>
.cmp { width: 100%; border-collapse: collapse; }
.cmp td { padding: 8px 6px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
.cmp tr:last-child td { border-bottom: none; }
.cmp .name { font-weight: 560; }
.cmp .about { font-size: 12px; color: var(--text-faint); }
.cmp .fig { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
.cmp .delta.up { color: var(--bad); }
.cmp .delta.down { color: var(--ok); }
.bar { position: relative; height: 8px; border-radius: 999px; background: var(--well); box-shadow: var(--well-shadow); min-width: 120px; }
.sys { border-bottom: 1px solid var(--border-soft); }
.sys:last-of-type { border-bottom: none; }
.sys > summary { list-style: none; display: grid; grid-template-columns: minmax(0, 1fr) 30% 92px 96px 64px 16px; gap: 10px; align-items: center; padding: 8px 10px; cursor: pointer; border-radius: 12px; }
.sys > summary::-webkit-details-marker { display: none; }
.sys > summary:hover { background: var(--surface-2); }
.sys > summary .chev { color: var(--text-faint); transition: transform .15s; }
.sys[open] > summary .chev { transform: rotate(90deg); }
.sys .name { font-weight: 560; }
.sys .about { font-size: 12px; color: var(--text-faint); }
.sys .fig { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
.sys .delta.up { color: var(--bad); }
.sys .delta.down { color: var(--ok); }
.sys .inner { padding: 6px 8px 12px 18px; }
.mini { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 0 22px; }
.mini > div { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; padding: 4px 0; font-size: 12.5px; border-bottom: 1px dashed var(--border-soft); }
.mini .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mini .nm .tag { font-size: 10.5px; margin-left: 4px; }
.mini .nm a { color: var(--text); }
.mini .nm a:hover { color: var(--accent); }
.mini .fig { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; }
.mini .up { color: var(--bad); }
.mini .down { color: var(--ok); }
@media (max-width: 800px) { .sys > summary { grid-template-columns: 1fr 70px 60px 16px; } .sys > summary .bar, .sys > summary .normal { display: none; } }
.bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--accent); }
.bar > b { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text-dim); }
.mspt { font-weight: 700; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.unit { font-size: 11.5px; color: var(--text-faint); margin-left: 3px; }
.stall { display: grid; grid-template-columns: 96px 64px minmax(0, 1fr) 74px; gap: 14px; align-items: center; padding: 11px 0; border-bottom: 1px solid var(--border-soft); }
.stall:last-child { border-bottom: none; }
.stall .when { line-height: 1.3; }
.stall .when .faint { display: block; font-size: 12px; }
.stall .dur { font-family: var(--mono); font-weight: 700; color: var(--text-strong); }
.stall .why { min-width: 0; line-height: 1.4; }
.stall .why .w { color: var(--text); font-weight: 600; }
.stall .why .c { color: var(--text-faint); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stall .button { justify-self: end; }
.limits li { margin: 4px 0; color: var(--text-dim); }
.pager { display: flex; gap: 8px; }
@media (max-width: 800px) { .stall { grid-template-columns: 1fr; gap: 2px; } }
</style>`;

const mspt = (v: number, digits = 2): string => `<span class="mspt">${num(v, digits)}</span><span class="unit">MSPT</span>`;
const seconds = duration;
const timeOf = clockTime;
const dayOf = dayLabel;

function compareTable(rows: Difference[], options: { withAbout?: boolean } = {}): string {
  if (rows.length === 0) return '<div class="faint">Nothing stood out.</div>';
  const max = Math.max(...rows.map((r) => Math.max(r.here, r.normal)), 0.001);
  return `<table class="cmp">${rows
    .map((r) => {
      const delta = r.here - r.normal;
      const cls = Math.abs(delta) < 0.05 ? '' : delta > 0 ? 'up' : 'down';
      return `<tr>
        <td><div class="name">${esc(r.label)}</div>${options.withAbout === true && r.detail !== undefined ? `<div class="about">${esc(r.detail)}</div>` : ''}</td>
        <td style="width:34%"><div class="bar"><i style="width:${((r.here / max) * 100).toFixed(1)}%"></i><b style="left:${((r.normal / max) * 100).toFixed(1)}%" title="normal"></b></div></td>
        <td class="fig">${mspt(r.here)}</td>
        <td class="fig faint">normal ${num(r.normal, 2)}</td>
        <td class="fig delta ${cls}">${delta >= 0 ? '+' : '−'}${num(Math.abs(delta), 2)}</td>
      </tr>`;
    })
    .join('')}</table>`;
}

/**
 * Parts of the game, each opening onto the things inside it. Each part and
 * thing links to Findings over this minute, which lists the methods inside
 * it and can hand it off.
 */
function systemsTable(rows: Difference[], minuteStart: number): string {
  const from = Math.floor(minuteStart / 60_000) * 60_000;
  const span = { range: 'custom', from: localInputValue(from), to: localInputValue(from + 120_000) };
  const open = (system: string | undefined, subject?: string): string =>
    system === undefined ? '' : `/findings?${new URLSearchParams({ ...span, system, ...(subject === undefined ? {} : { subject }) }).toString()}`;
  if (rows.length === 0) return '<div class="faint">Nothing stood out.</div>';
  const max = Math.max(...rows.map((r) => Math.max(r.here, r.normal)), 0.001);
  const sign = (d: number): string => `${d >= 0 ? '+' : '−'}${num(Math.abs(d), 2)}`;
  return rows
    .map((r) => {
      const delta = r.here - r.normal;
      const cls = Math.abs(delta) < 0.05 ? '' : delta > 0 ? 'up' : 'down';
      const things = r.things ?? [];
      const inner =
        things.length === 0
          ? '<div class="faint" style="font-size:12.5px">Nothing inside it is big enough to show on its own.</div>'
          : `<div class="mini">${things
              .map((t) => {
                const d = t.here - t.normal;
                const tone = Math.abs(d) < 0.03 ? 'faint' : d > 0 ? 'up' : 'down';
                const href = open(t.system, t.subject);
                const name = `${esc(t.label)}${t.owner === undefined ? '' : `<span class="tag">${esc(t.owner)}</span>`}`;
                return `<div><span class="nm" title="${esc(t.label)}">${href === '' || t.subject === '' ? name : `<a href="${esc(href)}" title="What is inside ${esc(t.label)} this minute, and hand it off">${name}</a>`}</span>
                  <span class="fig">${num(t.here, 2)}</span>
                  <span class="fig ${tone}" title="against ${num(t.normal, 2)} normally">${sign(d)}</span></div>`;
              })
              .join('')}</div>
            <div class="faint" style="font-size:11.5px;margin-top:6px">MSPT this minute, and the change from normal. Click a thing to open it.
              ${r.system === undefined ? '' : `<a href="${esc(open(r.system))}">Open ${esc(r.label)} in Findings</a>`}</div>`;
      return `<details class="sys">
        <summary>
          <div><div class="name">${esc(r.label)}</div>${r.detail === undefined ? '' : `<div class="about">${esc(r.detail)}</div>`}</div>
          <div class="bar"><i style="width:${((r.here / max) * 100).toFixed(1)}%"></i><b style="left:${((r.normal / max) * 100).toFixed(1)}%" title="normal"></b></div>
          <div class="fig">${mspt(r.here)}</div>
          <div class="fig faint normal">normal ${num(r.normal, 2)}</div>
          <div class="fig delta ${cls}">${sign(delta)}</div>
          <div class="chev">&rsaquo;</div>
        </summary>
        <div class="inner">${inner}</div>
      </details>`;
    })
    .join('');
}

/** "code in com.bawnorton.neruina.handler.TickHandler" reads as "code in TickHandler"; the full name is on hover. */
function shortCause(cause: string): string {
  return cause.replace(/\b(?:[a-z][a-z0-9_]*\.)+([A-Z][A-Za-z0-9_$]*)/g, '$1');
}

function stallRow(s: Stall): string {
  const players = s.window.players === null ? '' : s.window.players === 0 ? 'nobody online' : plural(s.window.players, 'player');
  return `<div class="stall">
    <div class="when">${esc(timeOf(s.window.startTime))}<span class="faint">${esc(dayOf(s.window.startTime))}</span></div>
    <div class="dur">${esc(seconds(s.worstTick))}</div>
    <div class="why">${
      s.wait === undefined
        ? `<div class="w">No single wait explains it</div><div class="c">${players === '' ? 'open the minute to see what took longer' : esc(players)}</div>`
        : `<div class="w">${esc(capitalise(s.wait.what.replace(/^waited for /, 'waiting for ')))}</div>
           <div class="c" title="${esc(s.wait.cause)}">${esc(capitalise(shortCause(s.wait.cause)))}${players === '' ? '' : ` · ${esc(players)}`}</div>`
    }</div>
    <a class="button ghost small" href="/minute?at=${s.window.startTime + 1}">Open</a>
  </div>`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function stallList(db: DatabaseSync, resolvePath: (p: string | null) => string | undefined, server: ServerConfig, fromMs: number, toMs: number, limit: number): string {
  const list = stalls(db, resolvePath, server.id, fromMs, toMs, { limit, explain: limit });
  return list.length === 0 ? '<div class="faint">No tick took longer than half a second.</div>' : list.map(stallRow).join('');
}

/** Normal MSPT at each player count, with the current minute placed on it. */
export function playerBandsPanel(bands: PlayerBand[], current?: { players: number; mspt: number }): string {
  if (bands.length === 0) return panel('MSPT by player count', '<div class="faint">Not enough recorded minutes yet.</div>');
  const max = Math.max(...bands.map((b) => b.p90), 1);
  const rows = bands
    .map((b) => {
      const isNow = current !== undefined && current.players === b.players;
      return `<tr${isNow ? ' style="background:var(--surface-2)"' : ''}>
        <td class="name">${b.players === 0 ? 'Nobody online' : `${b.players} player${b.players === 1 ? '' : 's'}`}${isNow ? ' <span class="tag">now</span>' : ''}</td>
        <td style="width:40%"><div class="bar"><i style="width:${((b.median / max) * 100).toFixed(1)}%"></i><b style="left:${((b.p90 / max) * 100).toFixed(1)}%" title="1 minute in 10 is slower than this"></b></div></td>
        <td class="fig">${mspt(b.median, 1)}</td>
        <td class="fig faint">slow minutes ${num(b.p90, 1)}</td>
        <td class="fig faint">${b.minutes} min</td>
      </tr>`;
    })
    .join('');
  const band = current === undefined ? undefined : bands.find((b) => b.players === current.players);
  const verdict =
    current === undefined || band === undefined || band.minutes < 10
      ? ''
      : (() => {
          const ratio = current.mspt / Math.max(band.median, 0.01);
          const words = ratio > 1.25 ? 'noticeably higher than' : ratio > 1.08 ? 'a little higher than' : ratio < 0.92 ? 'lower than' : 'about';
          return `<div style="margin:0 0 10px">The latest minute ran at <b>${num(current.mspt, 1)} MSPT ${current.players === 0 ? 'with nobody online' : `with ${plural(current.players, 'player')}`}</b>,
            ${words} normal ${current.players === 0 ? 'for an empty server' : 'for that many players'} (${num(band.median, 1)}).${ratio > 1.25 ? ' Something beyond player load is costing time: open that minute to see what.' : ''}</div>`;
        })();
  return panel(
    'MSPT by player count',
    verdict +
      `<table class="cmp">${rows}</table>
      <div class="faint" style="font-size:12px;margin-top:8px">Bar: the typical minute at that load. Mark: the slowest one in ten.</div>`,
    { meta: 'last 7 days, this season, recorded minutes only' },
  );
}

export function minutePage(
  db: DatabaseSync,
  resolvePath: (p: string | null) => string | undefined,
  server: ServerConfig,
  at: number,
): { title: string; subtitle: string; body: string } {
  const detail = minuteDetail(db, resolvePath, server.id, at);
  if (detail === undefined) {
    return {
      title: 'No recording for that minute',
      subtitle: when(at),
      body:
        INVESTIGATE_STYLE +
        banner('info', 'Nothing was recorded at that time.', 'Monitoring was off, paused, or the server was not answering then. The Overview’s coverage section lists the gaps and why.') +
        `<a class="button ghost" href="/">Back to the Overview</a>`,
    };
  }
  const w = detail.window;
  const title = `${timeOf(w.startTime)}, ${dayOf(w.startTime)}`;

  // What happened, in sentences.
  const sentences: string[] = [];
  const mainWait = detail.waits[0];
  if (mainWait !== undefined && mainWait.ms >= 200) {
    sentences.push(`The server thread stopped for about <b>${esc(seconds(mainWait.ms))}</b> in total and ${esc(mainWait.what)}, most likely because of <b>${esc(mainWait.cause)}</b>.`);
  }
  const worse = detail.systems.filter((s) => s.here - s.normal >= 0.5).sort((a, b) => b.here - b.normal - (a.here - a.normal));
  for (const s of worse.slice(0, 2)) {
    if (s.label === 'Waiting') continue;
    sentences.push(`<b>${esc(s.label)}</b> took ${num(s.here, 1)} MSPT, against ${num(s.normal, 1)} in a normal minute.`);
  }
  if (sentences.length === 0 && detail.evidence) sentences.push('Nothing stands out against a normal minute: the time was spread the usual way.');
  const lost =
    detail.lostSeconds >= 0.5
      ? ` It completed ${w.ticks} of 1,200 ticks, so the server fell about ${detail.lostSeconds.toFixed(1)} s behind.`
      : '';

  const summary = `<div class="stats">
    ${stat('Typical tick this minute', num(w.msptMedian, 1), 'MSPT', 'the median of its ticks')}
    ${stat('Worst single tick', w.msptMax === null ? '—' : esc(seconds(w.msptMax)), undefined, 'a freeze players notice', (w.msptMax ?? 0) >= FREEZE_MS ? 'bad' : undefined)}
    ${stat('Players', w.players === null ? '—' : String(w.players), undefined, `${w.players === 0 ? 'nobody online · ' : ''}${w.entities ?? '—'} entities · ${w.chunks ?? '—'} chunks loaded`)}
    ${stat('Ticks completed', w.ticks === null ? '—' : `${w.ticks}`, 'of 1,200', detail.lostSeconds >= 0.5 ? `about ${detail.lostSeconds.toFixed(1)} s behind` : 'kept up')}
  </div>`;

  const body = !detail.evidence
    ? banner('warn', 'Only the summary is available for this minute.', esc(detail.why ?? ''))
    : `${banner(mainWait !== undefined && mainWait.ms >= 200 ? 'warn' : 'info', 'What happened.', sentences.join(' ') + lost)}
${panel(
  'Compared with a normal minute',
  systemsTable(detail.systems, w.startTime) +
    `<div class="faint" style="font-size:12px;margin-top:8px">Own time per part; these add up to the whole tick. “Normal” is the median of ${detail.baselineMinutes} nearby minutes${detail.baselineMatchedPlayers ? (w.players === 0 ? ' with nobody online too' : ' with a similar number of players') : ''}.</div>`,
  { meta: `working ${num(detail.working.here, 1)} MSPT (normal ${num(detail.working.normal, 1)}) · waiting ${num(detail.waiting.here, 2)} (normal ${num(detail.waiting.normal, 2)})` },
)}
${
  detail.waits.length === 0
    ? ''
    : panel(
        'Waiting',
        detail.waits
          .map(
            (x) => `<div class="list-row"><div class="main"><div class="t">${esc(capitalise(x.what))}</div>
              <div class="s">Triggered by ${esc(x.cause)}.</div>
              <details><summary class="faint" style="font-size:12px">Call path</summary><div class="mono" style="font-size:11.5px;white-space:normal;word-break:break-all">${esc(x.path.split(' > ').slice(-12).join(' → '))}</div></details>
            </div><div class="fig">${esc(seconds(x.ms))}</div></div>`,
          )
          .join(''),
        { meta: 'time the server thread spent stopped, waiting on something else' },
      )
}
<div class="grid-2">
  ${panel('Mods that took longer', compareTable(detail.mods), { meta: 'own time, MSPT' })}
  ${panel(
    'Methods that took longer',
    detail.methods.length === 0
      ? '<div class="faint">No single method stood out.</div>'
      : `<table class="cmp">${detail.methods
          .map(
            (m) => `<tr><td><div class="name" style="font-size:13px">${esc(m.label)}</div>
              <div class="about mono" style="word-break:break-all">${esc(m.detail ?? '')}</div></td>
              <td class="fig">${mspt(m.here)}</td><td class="fig delta up">+${num(m.here - m.normal, 2)}</td></tr>`,
          )
          .join('')}</table>`,
    { meta: 'own time, MSPT, including library code they called' },
  )}
</div>`;

  const limits = panel(
    'What this cannot tell you',
    `<ul class="limits" style="margin:0;padding-left:18px">
      <li>The exact second: spark keeps one-minute slices, so everything here is for the whole minute.</li>
      <li>Which player, or where in the world.</li>
      <li>What other threads were doing: chunk loading and generation happen off the server thread. <a href="/threads">Other threads</a> shows them when all-thread profiles are on.</li>
      <li>Which datapack function ran: time in datapacks shows as Minecraft running commands.</li>
    </ul>`,
  );

  const nav = `<div class="pager" style="margin-bottom:16px">
    <a class="button ghost" href="/minute?at=${w.startTime - 30_000}">← Previous minute</a>
    <a class="button ghost" href="/minute?at=${w.endTime + 1}">Next minute →</a>
    <a class="button ghost" href="/stalls">All freezes</a>
  </div>`;

  return {
    title,
    subtitle: `One minute on ${server.displayName}, compared with normal`,
    body: INVESTIGATE_STYLE + nav + summary + body + limits,
  };
}

export function stallsPage(
  db: DatabaseSync,
  resolvePath: (p: string | null) => string | undefined,
  server: ServerConfig,
  rangeHours: number,
): string {
  const now = Date.now();
  const list = stalls(db, resolvePath, server.id, now - rangeHours * 3_600_000, now, { limit: 60, explain: 60 });
  const groups = new Map<string, { count: number; worst: number; total: number }>();
  for (const s of list) {
    const key = s.wait === undefined ? 'Not explained by a single wait' : `${capitalise(s.wait.what)}: ${s.wait.cause}`;
    const g = groups.get(key) ?? { count: 0, worst: 0, total: 0 };
    g.count += 1;
    g.worst = Math.max(g.worst, s.worstTick);
    g.total += s.worstTick;
    groups.set(key, g);
  }
  const ranges = [24, 72, 168]
    .map((h) => `<a class="button ${h === rangeHours ? '' : 'ghost'}" href="/stalls?hours=${h}">${h === 24 ? 'Last 24 h' : h === 72 ? '3 days' : '7 days'}</a>`)
    .join('');
  return `${INVESTIGATE_STYLE}
<div class="pager" style="margin-bottom:16px">${ranges}</div>
${
  list.length === 0
    ? banner('ok', 'No freezes.', 'No tick took longer than half a second in this span (recorded minutes only).')
    : panel(
        'By cause',
        `<table class="cmp">${[...groups.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .map(([k, g]) => `<tr><td class="name">${esc(k)}</td><td class="fig">${g.count}×</td><td class="fig faint">worst ${esc(seconds(g.worst))}</td></tr>`)
          .join('')}</table>`,
        { meta: 'ticks of half a second or more' },
      )
}
${list.length === 0 ? '' : panel('Every freeze, worst first', list.map(stallRow).join(''), { meta: `${list.length} minute${list.length === 1 ? '' : 's'}` })}
<div class="faint" style="font-size:12px;margin-top:8px">Most freezes are the server waiting for a chunk; <a href="/threads">Other threads</a> shows what the chunk-loading threads were doing.</div>`;
}

export { msptByPlayers };

/** What every thread was doing, from the all-thread profiles. */
export function threadsPage(db: DatabaseSync, server: ServerConfig, enabled: boolean, selected?: number): string {
  const list = threadProfiles(db, server.id, 20);
  if (list.length === 0) {
    return `${INVESTIGATE_STYLE}${banner(
      'info',
      enabled ? 'No all-thread profile yet.' : 'All-thread profiles are off.',
      enabled
        ? 'The first one is taken straight after the next normal collection.'
        : 'Background profiling watches only the server thread, so why a chunk loads slowly (world generation, disk) is out of sight. Switch on “Profile every thread a few times a day” in Settings, Collection, to see it here. It sends two spark commands to the server a few times a day and leaves a two-minute gap in the server-thread history each time.',
      enabled ? undefined : '<a class="button ghost" href="/settings#collection">Settings</a>',
    )}`;
  }
  const current = list.find((p) => p.id === selected) ?? list[0]!;
  const s = current.summary;
  const groups = s.groups
    .filter((g) => g.busyMs > 0)
    .map((g) => {
      const share = Math.min(1, g.busyShare);
      const top = g.top
        .slice(0, 8)
        .map(
          (m) => `<tr><td class="name" style="font-weight:400">${esc(m.method)}</td><td class="faint">${esc(m.owner)}</td>
            <td class="fig">${num((m.ms / Math.max(g.busyMs, 1)) * 100, 0)}%</td></tr>`,
        )
        .join('');
      return panel(
        esc(g.group),
        `<div class="about" style="color:var(--text-dim);margin-bottom:8px">${esc(g.about)}</div>
         <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px">
           <div class="bar" style="flex:1"><i style="width:${(share * 100).toFixed(1)}%"></i></div>
           <b>${num(share * 100, 0)}% busy</b>
         </div>
         <details><summary class="faint" style="font-size:12px">What it spent that time on</summary><table class="cmp">${top}</table></details>`,
        { meta: `${g.threads} thread${g.threads === 1 ? '' : 's'}` },
      );
    })
    .join('');
  const others = list
    .map((p) => `<option value="/threads?id=${p.id}"${p.id === current.id ? ' selected' : ''}>${esc(when(p.capturedAt))} · ${Math.round(p.durationMs / 1000)} s</option>`)
    .join('');
  return `${INVESTIGATE_STYLE}
<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">
  <select onchange="location.href=this.value">${others}</select>
  <span class="faint" style="font-size:12.5px">${Math.round(current.durationMs / 1000)} seconds of every thread, busiest first.</span>
</div>
${groups}
<div class="faint" style="font-size:12px;margin-top:8px">“Busy” is the share of time each group’s threads spent working, not waiting. Near 100% for world generation or disk means chunks queue up, and players exploring new terrain make the server wait.</div>`;
}
