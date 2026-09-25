/**
 * Overview: the one page to open.
 *
 * It answers, in this order, for the server chosen in the sidebar and its
 * current season only:
 *
 *   1. Is monitoring working?      health, and how much of the last day
 *                                  was actually recorded
 *   2. How is the server doing?    right now against normal for that many
 *                                  players, the typical and worst minutes,
 *                                  the worst freeze -- each labelled with
 *                                  exactly what it covers
 *   3. Why does it look that way?  the chart (hover a minute, click to open
 *                                  it), freezes and their causes, and what
 *                                  normal MSPT is at each player count
 *   4. What needs me?              setup problems, questions, top findings
 *                                  and the latest changes
 *
 * Figures over "the last 24 h" are over the RECORDED minutes of it, and say
 * so: a day that was mostly not recorded must not read as a whole day.
 */

import { ACTIVITY_WORDS, DEFAULT_ACTIVITY } from '../../analysis/activity.ts';
import { effectiveActivity } from '../../store/rollups.ts';
import { ownerOf } from './findings.ts';
import { OUTLOOKS } from '../../analysis/priority.ts';
import { activityOf } from '../../analysis/activity.ts';
import { ownModPrefixes } from '../../analysis/priority.ts';
import type { DatabaseSync } from 'node:sqlite';

import { esc, num, when, ago, panel, stat, banner, icon, bytes, duration, clockTime, dayLabel } from '../layout.ts';
import type { SettingsStore } from '../../settings/store.ts';
import type { ServerConfig } from '../../store/servers.ts';
import type { ServerLink } from '../../runtime/link.ts';
import { coverage, coverageWords } from '../../store/health.ts';
import { coverageBlock, COVERAGE_STYLE } from './range.ts';
import { statusOf, serverFacts } from './servers.ts';
import { findings, groupFindings } from '../../analysis/findings.ts';
import { detectedChanges } from '../../analysis/changes.ts';
import { gatherSetup } from '../../runtime/remediate.ts';
import { FREEZE_MS, msptByPlayers, stalls } from '../../analysis/minute.ts';
import { listInvestigations, matches } from '../../analysis/investigations.ts';
import { readableMethod } from '../../analysis/owner.ts';
import { unreadHarvests } from '../../runtime/harvester.ts';
import { INVESTIGATE_STYLE, playerBandsPanel, stallList } from './investigate.ts';
import * as q from '../../query/queries.ts';

interface Point {
  t: number;
  /** Median ms per tick of the minute. */
  v: number;
  /** Worst single tick of the minute, ms. */
  max?: number | null;
  players?: number | null;
}

/**
 * Tick time per minute, with player count beneath it and freezes marked.
 * The line breaks where more than ten minutes are missing, so a gap looks
 * like a gap instead of a line drawn across hours nobody measured. Hovering
 * shows a minute's figures; clicking opens it (/minute).
 */
export function tickChart(
  points: Point[],
  opts: { fromMs: number; toMs: number; warn: number; bad: number; id?: string; zoomHref?: string },
): string {
  if (points.length < 2) return '<div class="empty">Not enough data in this span to draw a chart yet.</div>';
  const W = 1000;
  const H = 280;
  const padL = 46;
  const padR = 44;
  const padB = 28;
  const padT = 22;
  const GAP = 10 * 60_000;

  // A 10-minute average over each unbroken stretch: the per-minute median
  // jumps around, and the trend is what the eye is looking for.
  const smooth: number[] = points.map((p, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && p.t - points[j]!.t <= 5 * 60_000; j -= 1) {
      if (j < i && points[j + 1]!.t - points[j]!.t > GAP) break;
      sum += points[j]!.v;
      n += 1;
    }
    for (let j = i + 1; j < points.length && points[j]!.t - p.t <= 5 * 60_000; j += 1) {
      if (points[j]!.t - points[j - 1]!.t > GAP) break;
      sum += points[j]!.v;
      n += 1;
    }
    return sum / Math.max(1, n);
  });

  const top = Math.max(opts.bad * 1.12, ...points.map((p) => p.v)) * 1.04;
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((s) => top / s <= 6) ?? 500;
  const max = Math.ceil(top / step) * step;
  // The players scale tops out a little above the most seen in view, and only
  // real counts are labelled (0 and that most), so no number reads as a count it is not.
  const mostPlayers = Math.max(0, ...points.map((p) => p.players ?? 0));
  const playersTop = Math.max(4, mostPlayers * 1.15);
  const x = (t: number): number => padL + ((t - opts.fromMs) / Math.max(1, opts.toMs - opts.fromMs)) * (W - padL - padR);
  const y = (v: number): number => padT + (1 - v / max) * (H - padT - padB);
  const yp = (n: number): number => padT + (1 - n / playersTop) * (H - padT - padB);
  const base = H - padB;

  const segments = (value: (p: Point, i: number) => number | null | undefined, scale: (v: number) => number): Array<Array<[number, number]>> => {
    const out: Array<Array<[number, number]>> = [];
    let cur: Array<[number, number]> = [];
    let prev: Point | undefined;
    points.forEach((p, i) => {
      const v = value(p, i);
      if (v === null || v === undefined) return;
      if (prev !== undefined && p.t - prev.t > GAP && cur.length > 0) {
        out.push(cur);
        cur = [];
      }
      cur.push([x(p.t), scale(v)]);
      prev = p;
    });
    if (cur.length > 0) out.push(cur);
    return out;
  };
  const pathOf = (seg: Array<[number, number]>): string => seg.map(([a, b], i) => `${i === 0 ? 'M' : 'L'}${a.toFixed(1)},${b.toFixed(1)}`).join('');

  // Time with nothing recorded, shaded, so a quiet line is never mistaken for a quiet server.
  const gaps: Array<[number, number]> = [];
  if (points[0]!.t - opts.fromMs > GAP) gaps.push([opts.fromMs, points[0]!.t]);
  for (let i = 1; i < points.length; i += 1) if (points[i]!.t - points[i - 1]!.t > GAP) gaps.push([points[i - 1]!.t + 60_000, points[i]!.t]);
  if (opts.toMs - points[points.length - 1]!.t > GAP) gaps.push([points[points.length - 1]!.t + 60_000, opts.toMs]);

  const yTicks: number[] = [];
  for (let v = 0; v <= max; v += step) yTicks.push(v);
  const spanH = (opts.toMs - opts.fromMs) / 3_600_000;
  const stepH = spanH <= 1.5 ? 0.25 : spanH <= 3 ? 0.5 : spanH <= 8 ? 1 : spanH <= 26 ? 3 : spanH <= 50 ? 6 : 24;
  const firstTick = Math.ceil(opts.fromMs / (stepH * 3_600_000)) * stepH * 3_600_000;
  const xTicks: number[] = [];
  for (let t = firstTick; t <= opts.toMs; t += stepH * 3_600_000) xTicks.push(t);
  const label = (t: number): string => {
    const dt = new Date(t);
    if (stepH >= 24) return `${dt.getMonth() + 1}/${dt.getDate()}`;
    const h = dt.getHours();
    if (dt.getMinutes() !== 0) return `${h % 12 === 0 ? 12 : h % 12}:${String(dt.getMinutes()).padStart(2, '0')}`;
    return h === 0 ? `${dt.getMonth() + 1}/${dt.getDate()}` : `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
  };
  const threshold = (v: number, cls: string, text: string): string =>
    v > max
      ? ''
      : `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="thr ${cls}"/>
         <text x="${padL + 6}" y="${(y(v) - 5).toFixed(1)}" class="thr-label ${cls}">${text}</text>`;
  const freezes = points.filter((p) => (p.max ?? 0) >= FREEZE_MS);
  const id = opts.id ?? 'tick-chart';
  const data = JSON.stringify(
    points.map((p, i) => [
      p.t,
      Math.round(p.v * 10) / 10,
      p.max === null || p.max === undefined ? null : Math.round(p.max),
      p.players ?? null,
      Math.round(smooth[i]! * 10) / 10,
    ]),
  );
  // The highest minute in view, labelled and clickable, so a spike is found without hunting for it.
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a));
  const peakX = x(peak.t);
  const peakMark = `<a href="/minute?at=${peak.t + 1}" class="peak"><title>Open the highest minute</title>
    <circle cx="${peakX.toFixed(1)}" cy="${y(peak.v).toFixed(1)}" r="4.5"/>
    <text x="${peakX.toFixed(1)}" y="${Math.max(padT + 10, y(peak.v) - 9).toFixed(1)}" text-anchor="${peakX > W - padR - 60 ? 'end' : peakX < padL + 60 ? 'start' : 'middle'}">peak ${num(peak.v, 1)}</text></a>`;
  // Stretches with nobody online, shaded so an empty server's quick ticks are never read as good play.
  const idleRuns: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i += 1) {
    if (points[i]!.players !== 0) continue;
    const start = points[i]!.t;
    let end = start + 60_000;
    while (i + 1 < points.length && points[i + 1]!.players === 0 && points[i + 1]!.t - points[i]!.t <= GAP) {
      i += 1;
      end = points[i]!.t + 60_000;
    }
    idleRuns.push([start, end]);
  }
  const idleShade = idleRuns
    .map(([a, b]) => `<rect x="${x(a).toFixed(1)}" y="${padT}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${(base - padT).toFixed(1)}" class="idle"/>`)
    .join('');
  const playersArea = segments((p) => p.players, yp)
    .map((seg) => `<path d="${pathOf(seg)}L${seg[seg.length - 1]![0].toFixed(1)},${base}L${seg[0]![0].toFixed(1)},${base}Z" class="players-area"/><path d="${pathOf(seg)}" class="players-line"/>`)
    .join('');

  return `<div class="chart-wrap" id="${id}">
<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Typical tick time and players per minute">
  <defs><pattern id="idle-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="6" class="idle-line"/></pattern></defs>
  ${gaps.map(([a, b]) => `<rect x="${x(a).toFixed(1)}" y="${padT}" width="${Math.max(1, x(b) - x(a)).toFixed(1)}" height="${(base - padT).toFixed(1)}" class="gap"/>`).join('')}
  ${idleShade}
  ${yTicks
    .map(
      (v) => `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>
      <text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="axis">${v}</text>`,
    )
    .join('')}
  ${(mostPlayers > 0 ? [0, mostPlayers] : [0]).map((n) => `<text x="${W - 4}" y="${(yp(n) + 4).toFixed(1)}" text-anchor="end" class="axis players-axis">${n}</text>`).join('')}
  ${xTicks.map((t) => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${base}" y2="${base + 4}" class="grid"/><text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${label(t)}</text>`).join('')}
  ${playersArea}
  ${segments((p) => p.v, y).map((seg) => `<path d="${pathOf(seg)}" class="raw-line"/>`).join('')}
  ${segments((_, i) => smooth[i], y).map((seg) => `<path d="${pathOf(seg)}" class="avg-line"/>`).join('')}
  ${threshold(opts.warn, 'warn', `watch ${opts.warn}`)}
  ${threshold(opts.bad, 'bad', `too slow ${opts.bad}`)}
  ${freezes.map((p) => `<path d="M${x(p.t).toFixed(1)},${padT - 3} l-4.5,-9 h9 z" class="freeze"/>`).join('')}
  <text x="${padL - 8}" y="12" text-anchor="end" class="axis">MSPT</text>
  <text x="${W - 4}" y="12" text-anchor="end" class="axis players-axis">players</text>
  ${peakMark}
  <rect class="sel" x="0" y="${padT}" width="0" height="${(base - padT).toFixed(1)}" visibility="hidden"/>
  <line class="cursor" x1="0" x2="0" y1="${padT}" y2="${base}" visibility="hidden"/>
  <circle class="dot" r="4" cx="0" cy="0" visibility="hidden"/>
</svg>
<div class="chart-tip" hidden></div>
<script>
(() => {
  const root = document.getElementById(${JSON.stringify(id)});
  const svg = root.querySelector('svg'), tip = root.querySelector('.chart-tip'), cursor = root.querySelector('.cursor'), dot = root.querySelector('.dot');
  const pts = ${data};
  const from = ${opts.fromMs}, to = ${opts.toMs}, W = ${W}, H = ${H}, L = ${padL}, R = ${padR}, T = ${padT}, B = ${padB}, max = ${max};
  const xOf = (t) => L + ((t - from) / Math.max(1, to - from)) * (W - L - R);
  const yOf = (v) => T + (1 - v / max) * (H - T - B);
  let current = null;
  const zoomHref = ${JSON.stringify(opts.zoomHref ?? '')};
  const sel = root.querySelector('.sel');
  const vxOf = (evt) => { const box = svg.getBoundingClientRect(); return ((evt.clientX - box.left) / box.width) * W; };
  // The highest minute within a few pixels, so a spike is easy to land on.
  const near = (evt) => {
    const vx = vxOf(evt);
    let best = null;
    for (const p of pts) { if (Math.abs(xOf(p[0]) - vx) <= 7 && (best === null || p[1] > best[1])) best = p; }
    return best;
  };
  let drag = null;
  const hide = () => { tip.hidden = true; cursor.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); svg.style.cursor = ''; current = null; };
  svg.addEventListener('mousedown', (evt) => { if (zoomHref !== '' && evt.button === 0 && !evt.target.closest('a')) { drag = vxOf(evt); evt.preventDefault(); } });
  window.addEventListener('mouseup', (evt) => {
    if (drag === null) return;
    const a = Math.max(L, Math.min(drag, vxOf(evt))), b = Math.min(W - R, Math.max(drag, vxOf(evt)));
    drag = null; sel.setAttribute('visibility', 'hidden');
    const tOf = (vx) => from + ((vx - L) / (W - L - R)) * (to - from);
    if (b - a > 8) { location.href = zoomHref + '&zf=' + Math.round(tOf(a)) + '&zt=' + Math.round(tOf(b)); return; }
    if (current) location.href = '/minute?at=' + (current[0] + 1);
  });
  svg.addEventListener('mousemove', (evt) => {
    if (drag !== null) {
      const a = Math.min(drag, vxOf(evt)), b = Math.max(drag, vxOf(evt));
      sel.setAttribute('x', Math.max(L, a)); sel.setAttribute('width', Math.max(0, Math.min(W - R, b) - Math.max(L, a))); sel.setAttribute('visibility', 'visible');
    }
    const p = near(evt);
    current = p;
    if (!p) return hide();
    const d = new Date(p[0]);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ', ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    tip.innerHTML = '<b>' + time + '</b><br><b class="big">' + p[1].toFixed(1) + ' MSPT</b> typical tick' +
      '<br>' + p[4].toFixed(1) + ' MSPT around then (10-min average)' +
      (p[2] === null ? '' : '<br>worst tick ' + (p[2] >= 1000 ? (p[2] / 1000).toFixed(1) + ' s' : p[2] + ' ms')) +
      (p[3] === null ? '' : p[3] === 0 ? '<br><b>nobody online</b> (idle)' : '<br>' + p[3] + ' player' + (p[3] === 1 ? '' : 's')) + '<br><span>Click to see what happened' + (zoomHref === '' ? '' : ', or drag to zoom in') + '</span>';
    tip.hidden = false;
    const box = svg.getBoundingClientRect();
    const px = (xOf(p[0]) / W) * box.width;
    tip.style.left = (px + 230 > box.width ? px - 226 : px + 14) + 'px';
    cursor.setAttribute('x1', xOf(p[0])); cursor.setAttribute('x2', xOf(p[0])); cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', xOf(p[0])); dot.setAttribute('cy', yOf(p[1])); dot.setAttribute('visibility', 'visible');
    svg.style.cursor = 'pointer';
  });
  svg.addEventListener('mouseleave', hide);
  if (zoomHref === '') svg.addEventListener('click', () => { if (current) location.href = '/minute?at=' + (current[0] + 1); });
})();
</script>
</div>`;
}

const CHART_STYLE = `<style>
.chart-wrap { position: relative; }
.chart { display: block; }
.chart .grid { stroke: var(--border-soft); stroke-width: 1; }
.chart .axis { fill: var(--text-faint); font: 12.5px var(--sans); }
.chart .gap { fill: var(--surface-3); opacity: .45; }
.chart .idle { fill: url(#idle-hatch); }
.chart .idle-line { fill: var(--text); opacity: .07; }
.chart .players-area { fill: #8FA3BF; opacity: .08; }
.chart .players-line { fill: none; stroke: #8FA3BF; stroke-width: 1.2; opacity: .55; vector-effect: non-scaling-stroke; }
.chart .players-axis { fill: #8FA3BF; }
.chart .raw-line { fill: none; stroke: var(--accent); stroke-width: 1; opacity: .35; vector-effect: non-scaling-stroke; }
.chart .avg-line { fill: none; stroke: var(--accent); stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
.chart .thr { stroke-dasharray: 5 6; stroke-width: 1; opacity: .8; }
.chart .thr.warn { stroke: var(--warn); }
.chart .thr.bad { stroke: var(--bad); }
.chart .thr-label { font: 600 11.5px var(--sans); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.chart .thr-label.warn { fill: var(--warn); }
.chart .thr-label.bad { fill: var(--bad); }
.chart .freeze { fill: var(--bad); }
.chart .cursor { stroke: var(--text-dim); stroke-width: 1; }
.chart .dot { fill: var(--accent); stroke: var(--surface); stroke-width: 2; pointer-events: none; }
.chart .cursor { pointer-events: none; }
.chart .sel { fill: var(--accent); opacity: .12; pointer-events: none; }
.chart .peak circle { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.chart .peak text { fill: var(--text); font: 600 11.5px var(--sans); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; }
.chart .peak:hover circle { fill: var(--accent); }
.chart { user-select: none; }
.chart-tip { position: absolute; top: 8px; width: 212px; padding: 10px 13px; border-radius: 14px; background: var(--surface-2);
  border: 1px solid var(--border-soft); font-size: 12.5px; line-height: 1.55; pointer-events: none; box-shadow: 0 24px 60px -24px rgba(0,0,0,.9); }
.chart-tip .big { font-family: var(--mono); font-size: 14px; }
.chart-tip span { color: var(--text-faint); font-size: 11.5px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--text-faint); margin-top: 8px; }
.legend i { display: inline-block; width: 16px; height: 0; border-top: 2.4px solid var(--accent); vertical-align: middle; margin-right: 6px; }
.legend i.r { border-top: 1px solid var(--accent); opacity: .5; }
.legend i.p { height: 9px; border: none; background: #8FA3BF; opacity: .35; border-radius: 2px; }
.legend i.g { height: 9px; border: none; background: var(--surface-3); border-radius: 2px; }
.legend i.i { height: 9px; border: none; border-radius: 2px; background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--text) 16%, transparent) 0 2px, transparent 2px 5px); }
.legend i.f { width: 0; height: 0; border: 5px solid transparent; border-top: 8px solid var(--bad); border-bottom: 0; }
.attention a { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border-soft); color: var(--text); }
.attention a:last-child { border-bottom: none; }
.attention a:hover { text-decoration: none; color: var(--accent); }
.attention .att-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border-soft); }
.attention .att-row:last-child { border-bottom: none; }
.steps { counter-reset: step; list-style: none; padding: 0; margin: 0; }
.steps li { position: relative; padding: 0 0 18px 40px; }
.steps li::before { counter-increment: step; content: counter(step); position: absolute; left: 0; top: -2px; width: 26px; height: 26px; border-radius: 50%;
  display: grid; place-items: center; font-weight: 600; font-size: 12.5px; background: var(--surface-3); color: var(--text-dim); }
.steps li.done::before { content: '✓'; background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.steps li.now::before { background: var(--accent); color: #0B0E14; }
.steps .t { font-weight: 600; }
.steps .s { color: var(--text-dim); font-size: 13px; margin-top: 2px; }
</style>`;

/** A guided start for an empty app: what to do, in order, with where each step is done. */
function gettingStarted(db: DatabaseSync, server: ServerConfig | undefined): string {
  const hasServer = server !== undefined;
  const collecting = server !== undefined && server.collection !== 'off';
  const captures = server === undefined ? 0 : serverFacts(db, server.id).captures;
  const step = (done: boolean, now: boolean, title: string, text: string): string =>
    `<li class="${done ? 'done' : now ? 'now' : ''}"><div class="t">${title}</div><div class="s">${text}</div></li>`;
  return panel(
    'Getting started',
    `<ol class="steps">
      ${step(hasServer, !hasServer, 'Add your Minecraft server',
        `Tell the app where the server folder is (the one with <code>server.properties</code>). <a href="/servers">Add a server →</a>`)}
      ${step(collecting, hasServer && !collecting, 'Choose how to collect',
        `<b>Automatic</b> asks spark for its last hour every hour over SSH. <b>Watch folder</b> imports profiles you save yourself. ${
          hasServer ? `<a href="/server#monitoring">Open the server page →</a>` : ''
        }`)}
      ${step(captures > 0, collecting && captures === 0, 'Wait for the first capture',
        'spark has been sampling in the background all along; the first capture arrives within the hour. Everything on this page fills in from there.')}
    </ol>
    <div class="faint" style="font-size:12.5px">New to this? <a href="/guide">How it works</a> explains every number in plain words.</div>`,
  );
}

const seconds = duration;
const clock = clockTime;

const CHART_SPANS: Array<[string, string, number]> = [
  ['6h', '6 hours', 6],
  ['24h', '24 hours', 24],
  ['48h', '48 hours', 48],
  ['7d', '7 days', 168],
];

export function overviewPage(
  db: DatabaseSync,
  settings: SettingsStore,
  server: ServerConfig | undefined,
  links?: Map<string, ServerLink>,
  resolvePath: (stored: string | null) => string | undefined = () => undefined,
  params: URLSearchParams = new URLSearchParams(),
): string {
  const chartSpan = CHART_SPANS.find(([k]) => k === params.get('chart')) ?? CHART_SPANS[1]!;
  // A stretch dragged out on the chart: at least 10 minutes, within the last 7 days.
  const zf = Number(params.get('zf'));
  const zt = Number(params.get('zt'));
  const zoom =
    Number.isFinite(zf) && Number.isFinite(zt) && zt - zf >= 10 * 60_000 && zf >= Date.now() - 7 * 86_400_000 && zt <= Date.now() + 60_000
      ? { from: zf, to: zt }
      : undefined;
  const paused = settings.getBoolean('limits.paused');
  const facts = server === undefined ? undefined : serverFacts(db, server.id);
  if (server === undefined || facts === undefined || facts.captures === 0) {
    const health =
      server === undefined
        ? ''
        : (() => {
            const st = statusOf(db, server, paused, links?.get(server.id));
            return server.collection === 'off'
              ? banner('info', `Collection is off for ${esc(server.displayName)}.`,
                  'spark keeps only its last hour of samples, so each hour this stays off is history that will never exist.')
              : banner(st.tone, `${esc(st.words)}.`, 'Waiting for the first capture.');
          })();
    return CHART_STYLE + health + gettingStarted(db, server);
  }

  const now = Date.now();
  const st = statusOf(db, server, paused, links?.get(server.id));
  const seasonId = q.latestSeasonId(db, server.id);
  const season = q.seasonOptions(db, server.id).find((s) => s.id === seasonId);

  // --- 1. health -----------------------------------------------------------
  const lastIngest = db
    .prepare("SELECT max(started_at) AS t FROM capture WHERE server_id = ?")
    .get(server.id) as { t: number | null };
  const day = coverage(db, { serverId: server.id, fromMs: now - 86_400_000, toMs: now });
  const recordedHours = day.recordedMs / 3_600_000;
  const health =
    server.collection === 'off'
      ? banner('info', `Collection is off for ${esc(server.displayName)}.`,
          server.kind === 'production'
            ? 'spark keeps only its last hour of samples and discards everything older, so each hour this stays off is history that will never exist. <a href="/server#monitoring">Turn it on</a>.'
            : 'Its history stays viewable. <a href="/server#monitoring">Change this</a>.')
      : banner(
          paused ? 'warn' : st.tone,
          paused ? 'All monitoring is paused.' : `${esc(st.words)}.`,
          `${lastIngest.t === null ? '' : `Last capture ${esc(ago(lastIngest.t))}. `}${esc(coverageWords(day))} in the last 24 hours.`,
          `${st.tone === 'bad' && !paused ? '<button type="button" class="ghost js-retry-harvest">Try again now</button> ' : ''}<a class="button ghost" href="/server">Details</a>`,
        );

  // --- 4 (computed early). what needs attention -----------------------------
  const attention: string[] = [];
  if (st.tone === 'bad' || (st.tone === 'warn' && !paused)) {
    attention.push(`<a href="/server#monitoring">${icon('alert', 16)}<span>${esc(st.words)}${st.detail === undefined || st.detail === '' ? '' : ` — ${esc(st.detail)}`}</span></a>`);
  }
  // Saved on the server but never readable here, after an hour of tries.
  const unread = unreadHarvests(db, server.id);
  if (unread.length > 0) {
    attention.push(`<div class="att-row">${icon('alert', 16)}<span>${unread.length === 1 ? `${esc(unread[0]!)} was saved on the server but could not be read here` : `${unread.length} saved profiles could not be read here`} after an hour of tries. ${unread.length === 1 ? 'It is' : 'They are'} still on the server.</span><button type="button" class="ghost small js-retry-harvest" style="margin-left:auto">Try again</button></div>`);
  }
  const questions = (db.prepare('SELECT count(*) AS n FROM boundary_question WHERE answered_at IS NULL AND server_id = ?').get(server.id) as { n: number }).n;
  if (questions > 0) {
    attention.push(`<a href="/server">${icon('guide', 16)}<span>${questions} question${questions === 1 ? '' : 's'} about this server's history need${questions === 1 ? 's' : ''} your answer</span></a>`);
  }
  try {
    const setup = settings.getBoolean('setup.checkOnRotation') ? gatherSetup({ db }, settings, server.root, server.id) : undefined;
    const problems = setup?.findings.filter((f) => f.severity !== 'info') ?? [];
    for (const f of problems.slice(0, 3)) {
      attention.push(`<a href="/server#setup">${icon('alert', 16)}<span>${esc(f.title)}</span><span class="tag ${f.severity === 'blocking' ? 'bad' : 'warn'}" style="margin-left:auto">${f.severity === 'blocking' ? 'not working' : 'improvement'}</span></a>`);
    }
  } catch {
    // The setup check is advisory here; its own panel reports failures.
  }

  // --- 2. how it is doing ----------------------------------------------------
  const windows = db
    .prepare(
      `SELECT w.start_time AS t, w.mspt_median AS v, w.mspt_max AS m, w.players AS p
         FROM capture_window w JOIN capture c ON c.id = w.capture_id
        WHERE c.season_id = ? AND w.start_time >= ? AND w.mspt_median IS NOT NULL
        ORDER BY w.start_time`,
    )
    .all(seasonId ?? -1, Math.min(zoom?.from ?? now, now - Math.max(48, chartSpan[2]) * 3_600_000)) as Array<{ t: number; v: number; m: number | null; p: number | null }>;
  const last24 = windows.filter((w) => w.t >= now - 86_400_000);
  // Play and idle apart: hours with nobody online tick in well under a
  // millisecond and would make the typical minute look far healthier than
  // the server is while people play (analysis/activity.ts).
  const medianOf = (values: number[]): number | null => {
    const s = [...values].sort((a, b) => a - b);
    return s.length === 0 ? null : s[Math.floor(s.length / 2)]!;
  };
  const playing = last24.filter((w) => activityOf(w.p) === 'playing');
  const idle = last24.filter((w) => activityOf(w.p) === 'idle');
  const median = medianOf(playing.map((w) => w.v));
  const idleMedian = medianOf(idle.map((w) => w.v));
  const worstMinute = last24.reduce<(typeof last24)[number] | undefined>((a, w) => (a === undefined || w.v > a.v ? w : a), undefined);
  const latest = windows[windows.length - 1];
  const bands = seasonId === undefined ? [] : msptByPlayers(db, server.id, seasonId, now - 7 * 86_400_000, now);
  const band = latest?.p === null || latest === undefined ? undefined : bands.find((b) => b.players === latest.p);
  const worstFreeze = stalls(db, resolvePath, server.id, now - 86_400_000, now, { limit: 1, explain: 1 })[0];
  const warn = settings.getNumber('analysis.thresholds.msptMedianWatch');
  const bad = settings.getNumber('analysis.thresholds.msptMedianBad');
  const tone = (v: number | null | undefined): 'ok' | 'warn' | 'bad' | undefined =>
    v === null || v === undefined ? undefined : v >= bad ? 'bad' : v >= warn ? 'warn' : undefined;
  const of24 = `over the ${num(recordedHours, 1)} recorded h of the last 24`;

  const figures = `<div class="stats">
    ${stat(
      'Latest minute',
      latest === undefined ? '—' : num(latest.v, 1),
      'MSPT',
      latest === undefined
        ? 'nothing recorded yet'
        : `${latest.p === null ? '—' : latest.p === 0 ? 'nobody online' : `${latest.p} player${latest.p === 1 ? '' : 's'}`} · ${esc(clock(latest.t))}${
            band === undefined || band.minutes < 10 ? '' : ` · normal ${latest.p === 0 ? 'when empty' : `for ${latest.p}`}: ${num(band.median, 1)}`
          }`,
      tone(latest?.v),
    )}
    ${stat(
      'Typical while playing',
      median === null ? '—' : num(median, 1),
      'MSPT',
      median === null ? 'nobody played in the last 24 hours' : `the median of ${num(playing.length / 60, 1)} h with someone online in the last 24; 50 is the limit`,
      tone(median),
    )}
    ${
      idle.length < 10
        ? ''
        : stat('Idle baseline', num(idleMedian!, 2), 'MSPT', `${num(idle.length / 60, 1)} h with nobody online, kept apart from play`)
    }
    ${stat(
      'Slowest minute',
      worstMinute === undefined ? '—' : `<a href="/minute?at=${worstMinute.t + 1}">${num(worstMinute.v, 1)}</a>`,
      'MSPT',
      worstMinute === undefined ? of24 : `${esc(clock(worstMinute.t))} · ${worstMinute.p === 0 ? 'nobody online' : `${worstMinute.p ?? '—'} players`} · click to see why`,
      tone(worstMinute?.v),
    )}
    ${stat(
      'Worst freeze',
      worstFreeze === undefined ? 'none' : `<a href="/minute?at=${worstFreeze.window.startTime + 1}">${esc(seconds(worstFreeze.worstTick))}</a>`,
      undefined,
      worstFreeze === undefined
        ? 'no tick over half a second in the recorded minutes'
        : `${esc(clock(worstFreeze.window.startTime))}${worstFreeze.wait === undefined ? '' : ` · ${esc(worstFreeze.wait.what.replace(/^waited for /, 'waiting for '))}`}`,
      worstFreeze === undefined ? undefined : 'bad',
    )}
  </div>`;

  // The chart starts where recording does, so an empty stretch before the
  // first capture does not squeeze the line into a corner; gaps inside it
  // are shaded and named in the legend.
  const spanFrom = zoom?.from ?? now - chartSpan[2] * 3_600_000;
  const spanTo = zoom?.to ?? now;
  const inSpan = windows.filter((w) => w.t >= spanFrom && w.t <= spanTo);
  const chartFrom = zoom !== undefined || inSpan.length === 0 ? spanFrom : Math.max(spanFrom, inSpan[0]!.t - 20 * 60_000);
  const spans = `${zoom === undefined ? '' : `<a class="button ghost small" href="/?chart=${chartSpan[0]}">Reset zoom</a> `}<span class="seg small">${CHART_SPANS.map(([k, label]) => `<a href="/?chart=${k}" class="${zoom === undefined && k === chartSpan[0] ? 'on' : ''}">${label}</a>`).join('')}</span>`;
  const chart = panel(
    zoom === undefined
      ? `Tick time and players, last ${chartSpan[1]}`
      : `Tick time and players, ${clock(zoom.from)} to ${clock(zoom.to)}${new Date(zoom.from).toDateString() === new Date(now).toDateString() ? '' : `, ${dayLabel(zoom.from)}`}`,
    tickChart(
      inSpan.map((w) => ({ t: w.t, v: w.v, max: w.m, players: w.p })),
      { fromMs: chartFrom, toMs: spanTo, warn: Math.round(warn), bad, zoomHref: `/?chart=${chartSpan[0]}` },
    ) +
      `<div class="legend"><span><i></i>10-minute average</span><span><i class="r"></i>each minute’s typical tick</span><span><i class="p"></i>players online</span><span><i class="f"></i>a freeze (a tick of half a second or more)</span><span><i class="g"></i>not recorded</span><span><i class="i"></i>nobody online</span></div>
       <div class="faint" style="font-size:12px;margin-top:4px">Hover for a minute’s figures; click to see what happened in it; drag across the chart to zoom in.${chartFrom > spanFrom + 30 * 60_000 ? ` Nothing was recorded before ${esc(clock(chartFrom + 20 * 60_000))} in this span, so the chart starts there.` : ''}</div>`,
    { meta: spans },
  );

  const freezes = panel(
    'Freezes, last 24 hours',
    stallList(db, resolvePath, server, now - 86_400_000, now, 5) + '<div style="margin-top:10px"><a href="/stalls">All freezes and their causes →</a></div>',
    { meta: 'worst first' },
  );
  const byPlayers = playerBandsPanel(bands, latest === undefined || latest.p === null ? undefined : { players: latest.p, mspt: latest.v });

  // --- top findings and recent changes --------------------------------------
  let top = '';
  try {
    // Anything on hold or resolved stays off the Overview too.
    const setAside = listInvestigations(db, server.id).filter((i) => i.state !== 'active');
    const groups = groupFindings(findings(db, { limit: 120, ...(seasonId === undefined ? {} : { seasonId }) }))
      .filter((g) => {
        const owner = g.lead.source ?? (/^(net\.minecraft|com\.mojang)\./.test(g.label) ? 'Minecraft' : 'unknown');
        return !setAside.some((i) => matches(i, { label: g.label, owner }));
      })
      .slice(0, 4);
    top =
      groups.length === 0
        ? '<div class="faint">Nothing ranked yet.</div>'
        : groups
            .map(
              (g) => `<div class="list-row"><div class="main">
                <div class="t" title="${esc(g.label)}">${esc(readableMethod(g.label))}</div>
                <div class="s">${esc(ownerOf(g.lead))} · ${esc(OUTLOOKS[g.lead.priority.outlook].label)}${g.paths.length > 1 ? ` · ${g.paths.length} call paths` : ''}</div>
              </div><div class="fig"><b>${num(g.msPerTick, 2)}</b> <span class="faint">MSPT own</span></div></div>`,
            )
            .join('');
  } catch {
    top = '<div class="faint">Findings could not be computed.</div>';
  }

  const prefixes = ownModPrefixes(settings.getString('analysis.ownMods'));
  const changes = detectedChanges(db, { inHousePrefixes: prefixes, limit: 3, ...(seasonId === undefined ? {} : { seasonId }) });
  const changeList =
    changes.length === 0
      ? '<div class="faint">No mod or JVM flag changes detected this season.</div>'
      : changes
          .map((c) => {
            const lead = c.changes.slice(0, 2).map((m) => m.modId).join(', ');
            const more = c.changes.length - 2;
            return `<div class="list-row"><div class="main">
              <div class="t">${esc(lead || (c.runtimeChanges.length > 0 ? 'JVM flags changed' : 'change'))}${more > 0 ? ` <span class="faint">+${more} more</span>` : ''}</div>
              <div class="s">${esc(when(c.at))}</div>
            </div><a class="button ghost" href="/changes?view=compare&change=${c.revisionId}">Compare</a></div>`;
          })
          .join('');


  return `${CHART_STYLE}${COVERAGE_STYLE}${INVESTIGATE_STYLE}
${health}
${attention.length === 0 ? '' : panel('Needs attention', `<div class="attention">${attention.join('')}</div>`, { tone: 'warn' })}
${figures}
${chart}
<div class="grid-2">
  ${freezes}
  ${byPlayers}
</div>
<div class="grid-2">
  ${panel('Top findings', top + '<div style="margin-top:10px"><a href="/findings">All findings →</a></div>', { meta: `most worth looking at · ${seasonId === undefined ? 'all minutes' : ACTIVITY_WORDS[effectiveActivity(db, seasonId, DEFAULT_ACTIVITY)]}` })}
  ${panel('Recent changes', changeList + '<div style="margin-top:10px"><a href="/changes">All changes →</a></div>', { meta: 'mods and JVM flags' })}
</div>
<details class="note faint" style="margin-top:18px"><summary>Coverage of the last 24 hours</summary>${coverageBlock(day)}</details>`;
}
