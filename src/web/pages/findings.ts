/**
 * Findings: where the tick goes, and what is worth doing about it.
 *
 * Laid out for someone who does not read Java:
 *   1. Where the MSPT goes -- by part of the game and by mod, own time
 *      only, so the parts add up and nothing is counted twice.
 *   2. The list -- mod and plain method name first, own MSPT as the one bold
 *      number, sorted by cost or by how worth investigating it is; every
 *      technical detail (call paths, evidence, detectors, earlier work) one
 *      click away under Details.
 *   3. Investigations -- a problem can be put on hold or marked resolved as a
 *      whole (several methods, or a mod); it leaves the active list, keeps
 *      its history, and comes back by itself if it gets much worse.
 *
 * Unchanged rules: stars always show their inputs, detector hits are
 * hypotheses with a next step, thin evidence looks thin.
 */

import { ACTIVITY_WORDS, DEFAULT_ACTIVITY, activityFilterOf, type ActivityFilter } from '../../analysis/activity.ts';
import { effectiveActivity, hasActivityRollups } from '../../store/rollups.ts';
import { rangeControls, rangeParams, coverageBlock, spanOf, COVERAGE_STYLE } from './range.ts';
import { coverage as spanCoverage } from '../../store/health.ts';
import { prepareTimeRange, seasonLatestMoment, type HourlyCoverage } from '../../query/hourly.ts';
import { resolveRange, rollupSource, seasonDayBounds } from '../../query/range.ts';
import { esc, num, when, panel, banner } from '../layout.ts';
import type { DatabaseSync } from 'node:sqlite';
import { findings, groupFindings, type Finding, type FindingGroup } from '../../analysis/findings.ts';
import { priorityTag, evidenceTag, TERMS_STYLE } from '../terms.ts';
import { outcomeText } from '../../analysis/knowledge.ts';
import { recheckText } from '../../analysis/recheck.ts';
import { attributionFor } from '../../envx/lookup.ts';
import { envxBlock } from '../envx.ts';
import { SYSTEMS, explainWait, type SystemKey } from '../../analysis/systems.ts';
import { isLibraryFrame, meaningfulFrame, ownerOfPath, readableMethod } from '../../analysis/owner.ts';
import { placesOf, splitFor, subjectsOf, type SplitResult } from '../../analysis/split.ts';
import { classifyPath, subjectName } from '../../analysis/subjects.ts';
import { methodsInside, type Inside, type InsideSource } from '../../analysis/inside.ts';
import {
  cameBack,
  costOf,
  listInvestigations,
  matches,
  STATE_WORDS,
  type Investigation,
  type Matchable,
} from '../../analysis/investigations.ts';
import * as q from '../../query/queries.ts';
import { renderThingBrief, type HandoffOptions } from '../../report/handoff.ts';
import { callPathsTable } from './views.ts';
import { observableFor, type ObservableView } from '../../ingest/observable.ts';

const STYLE = `<style>
.where { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.slices a { display: grid; grid-template-columns: 170px 1fr 88px; gap: 12px; align-items: center; padding: 6px 8px; border-radius: 10px; color: var(--text); transition: background .2s var(--ease); }
.where-sub { font-size: 12.5px; color: var(--text-dim); margin: -4px 0 12px; }
.inside { margin-top: 16px; padding: 16px 18px; border-radius: 14px; background: var(--well); box-shadow: var(--well-shadow); }
.inside-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; margin-bottom: 10px; }
.inside-head b { font-size: 14px; }
.obs { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 3px 0; font-size: 12.5px; border-bottom: 1px dashed var(--border-soft); }
.obs .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obs .fig { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.things { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 2px 20px; }
.things a { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 5px 8px; border-radius: 9px; color: var(--text); font-size: 13px; }
.things a:hover { background: var(--surface-3); text-decoration: none; }
.things a.on { background: var(--surface-3); outline: 1px solid var(--accent); }
.things a.picked { background: var(--accent-soft); outline: 1px solid var(--accent); }
/* Several things picked with Ctrl-click, handed off together. */
.pick-bar { position: sticky; bottom: 14px; z-index: 4; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px;
  padding: 8px 10px 8px 16px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border-soft); box-shadow: var(--shadow); font-size: 13px; }
.pick-bar .fig { font-family: var(--mono); font-weight: 700; color: var(--text-strong); }
.pick-bar .grow { flex: 1; }
.things .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.things .nm .tag { margin-left: 4px; font-size: 10.5px; }
.things .fig { font-family: var(--mono); font-variant-numeric: tabular-nums; font-weight: 650; }
.things .bar { grid-column: 1 / -1; height: 4px; }
.methods { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 0 24px; margin-top: 4px; }
.methods a { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 4px 8px; border-radius: 9px; color: var(--text); font-size: 12.5px; }
.methods a:hover { background: var(--surface-3); text-decoration: none; }
.methods .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.methods .nm .tag { margin-left: 4px; font-size: 10.5px; }
.methods .fig { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.methods .bar { grid-column: 1 / -1; height: 3px; }
.inside-methods { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-soft); }
.places { display: grid; gap: 8px; }
.places .pl { display: grid; grid-template-columns: 170px 70px 1fr; gap: 12px; align-items: baseline; font-size: 13px; }
.places .pl .fig { font-family: var(--mono); font-weight: 650; text-align: right; }
.places .pl .what { color: var(--text-dim); font-size: 12.5px; }
.picker-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 4px; }
.picker-row > select { width: auto; max-width: 320px; }
.picker-row .range-form { margin-bottom: 0 !important; flex: 1 1 auto; }
.find-form { display: inline-flex; gap: 6px; align-items: center; }
.find-form input[type=search] { min-width: 240px; }
.slices a:hover { background: var(--surface-2); text-decoration: none; }
.slices a.on { background: var(--surface-2); outline: 1px solid var(--accent); }
.slices .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slices .fig { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; }
.slices .fig b { font-weight: 700; }
.bar { position: relative; height: 8px; border-radius: 999px; background: var(--well); box-shadow: var(--well-shadow); }
.bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--accent); }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 18px 0 10px; }
.chip { display: inline-flex; gap: 6px; align-items: center; padding: 5px 12px; border-radius: 999px; background: var(--surface-2); font-size: 12.5px; font-weight: 600; }
.chip a { color: var(--text-faint); }
.frow { border-bottom: 1px solid var(--border-soft); padding: 12px 2px; }
.frow:last-child { border-bottom: none; }
.frow .top { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: start; }
.frow .ttl { font-weight: 600; font-size: 14.5px; }
.frow .meta { font-size: 12.5px; color: var(--text-faint); margin-top: 3px; }
.frow .cost { text-align: right; white-space: nowrap; }
.frow .own { font-family: var(--mono); font-size: 17px; font-weight: 700; }
.frow .own span, .frow .sub span { font-weight: 400; font-size: 11.5px; color: var(--text-faint); }
.frow .focus { font-size: 11.5px; color: var(--text-faint); font-family: var(--mono); }
.frow .sub { font-size: 11.5px; color: var(--text-faint); font-family: var(--mono); }
.frow details.more { margin-top: 6px; }
.frow details.more > summary { cursor: pointer; color: var(--accent); font-size: 12.5px; }
.frow .inner { margin-top: 10px; padding: 14px 16px; border-radius: 14px; background: var(--well); box-shadow: var(--well-shadow); }
.frow .inner table { width: 100%; }
.frow .inner td { padding: 3px 4px; font-size: 12px; }
.frow .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.inv { border-bottom: 1px solid var(--border-soft); padding: 12px 2px; }
.inv:last-child { border-bottom: none; }
.inv .ttl { font-weight: 600; }
.inv .members { font-size: 12px; color: var(--text-faint); margin-top: 3px; }
dialog.hold { border: 1px solid var(--border-soft); border-radius: 20px; background: var(--surface); color: var(--text); padding: 22px 24px; width: min(560px, 92vw); }
dialog.hold::backdrop { background: rgba(8,10,14,0.55); }
dialog.hold h3 { margin: 0 0 12px; font: 800 18px var(--display); letter-spacing: -0.02em; }
dialog.hold label { display: block; margin: 8px 0; font-size: 13px; }
dialog.hold input[type=text], dialog.hold textarea { width: 100%; }
dialog.hold .opts { max-height: 220px; overflow: auto; border: 1px solid var(--border-soft); border-radius: 12px; background: var(--well); padding: 6px 10px; margin: 6px 0; }
dialog.hold .opts label { margin: 4px 0; }
dialog.hold .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
@media (max-width: 900px) { .where { grid-template-columns: 1fr; } .slices a { grid-template-columns: 120px 1fr 70px; } .places .pl { grid-template-columns: 1fr 60px; } .places .pl .what { grid-column: 1 / -1; } }
</style>`;

interface Row {
  group: FindingGroup;
  owner: string;
  system: SystemKey;
  title: string;
  /** Each call path's part of the game and thing, with its own MSPT. */
  places: Array<{ system: SystemKey; subject: string; mspt: number }>;
  /** Own MSPT of the paths matching the part/thing being looked at, when filtered. */
  focus?: number;
  investigation?: Investigation;
  back?: boolean;
}

/** Whose code a finding is: the mod, or Minecraft. The same answer everywhere it is shown. */
export function ownerOf(f: Finding): string {
  if (f.source !== null && f.source !== '' && f.attribution !== 'via-path') return f.source;
  const walked = ownerOfPath(f.path, null);
  return walked === 'Minecraft' && f.source !== null && f.source !== '' ? f.source : walked;
}

/** A plain name for a finding; library code is named after the code that called it. */
function titleOf(f: Finding): string {
  if (!isLibraryFrame(f.label)) return readableMethod(f.label);
  const caller = meaningfulFrame(f.path);
  return caller === f.label ? readableMethod(f.label) : `${readableMethod(caller)}, in ${readableMethod(f.label)}`;
}

function slices(items: Array<{ key: string; name: string; about?: string; mspt: number }>, total: number, href: (key: string) => string, selected: string | undefined, limit: number): string {
  const max = Math.max(...items.map((i) => i.mspt), 0.001);
  return `<div class="slices">${items
    .slice(0, limit)
    .map(
      (i) => `<a href="${href(i.key)}" class="${selected === i.key ? 'on' : ''}" title="${esc(i.about ?? '')}">
        <span class="nm">${esc(i.name)}</span>
        <span class="bar"><i style="width:${((i.mspt / max) * 100).toFixed(1)}%"></i></span>
        <span class="fig"><b>${num(i.mspt, 2)}</b> <span class="faint">${total > 0 ? `${Math.round((i.mspt / total) * 100)}%` : ''}</span></span>
      </a>`,
    )
    .join('')}</div>`;
}

/** A finding's Details, loaded when opened (they were two thirds of the page). */
function renderDetails(row: Row, envx = ''): string {
  const g = row.group;
  const f = g.lead;
  const paths =
    g.paths.length < 2
      ? `<div class="mono" style="font-size:11px;word-break:break-all;color:var(--text-dim)">${esc(f.path.split(' > ').slice(-10).join(' → '))}</div>`
      : `<div class="faint" style="font-size:12px;margin-bottom:4px">Reached through ${g.paths.length} call paths. Each is this method working for a different caller, so their own times add up to the ${num(g.msPerTick, 3)} MSPT above.</div>
         <table>${g.paths
           .map(
             (p) => `<tr><td class="mono" style="word-break:break-all">${esc(p.path.split(' > ').slice(-5).join(' → '))}</td>
               <td class="fig" style="text-align:right;white-space:nowrap">${num(p.msPerTick, 3)} MSPT</td><td class="faint" style="text-align:right">${Math.round(p.persistence * 100)}%</td></tr>`,
           )
           .join('')}</table>`;

  const knowledge = f.knowledge
    .map(
      (k) => `<div class="note" style="margin:8px 0 0;border-left-color:var(--accent)"><b>Seen before: ${esc(k.entry.title)}</b>
        <span class="tag">${esc(outcomeText(k.entry.outcome))}</span> <span class="faint">on ${esc(k.entry.mod)} ${esc(k.entry.modVersion)}, ${esc(k.entry.when)}</span>${
          k.confirmed === undefined
            ? ''
            : `<div style="margin-top:4px"><b>${esc(recheckText(k.confirmed, (v) => num(v, 2)))}</b>, measured across the update on ${esc(when(k.confirmed.at))}.</div>`
        }
        <div style="margin-top:4px">${esc(k.entry.finding)}</div><div class="faint" style="margin-top:4px">${esc(k.entry.resolution)}</div></div>`,
    )
    .join('');
  const detectors = f.detectors
    .map(
      (d) => `<div class="note" style="margin:8px 0 0"><b>${esc(d.title)}</b>, a pattern match, not confirmed.
        <div style="margin-top:4px">${esc(d.observation)}</div><div class="faint" style="margin-top:4px">${esc(d.hypothesis)}</div>
        <div style="margin-top:4px"><b>To confirm:</b> ${esc(d.confirmBy)}</div></div>`,
    )
    .join('');
  const tracked =
    g.tracked.length === 0
      ? ''
      : `<div class="note" style="margin:8px 0 0"><b>In the register:</b> ${g.tracked
          .map((t) => `<a href="/changes?view=tracked#entry-${t.id}">#${t.id} ${esc(t.title)}</a> <span class="tag">${esc(t.status)}</span>`)
          .join('; ')}</div>`;

  const exact = g.tracked.find((t) => t.exact === true);
  const trackButton =
    exact !== undefined
      ? `<a class="button ghost" href="/changes?view=tracked#entry-${exact.id}">Open register entry</a>`
      : `<button class="ghost js-track" data-label="${esc(f.label)}" data-path="${esc(f.path)}" data-feasibility="${esc(f.feasibility)}"
           data-hypothesis="${esc(f.detectors[0]?.hypothesis ?? '')}">Track a fix in the register</button>`;
  const setAside =
    row.investigation !== undefined && row.back !== true
      ? ''
      : `<button class="ghost js-hold" data-state="hold" data-label="${esc(f.label)}" data-owner="${esc(row.owner)}" data-title="${esc(row.title)}">Put on hold…</button>
         <button class="ghost js-hold" data-state="resolved" data-label="${esc(f.label)}" data-owner="${esc(row.owner)}" data-title="${esc(row.title)}">Mark resolved…</button>`;

  return `
      <div>${priorityTag(f.priority)} <span class="faint">${f.priority.rationale.map((r) => esc(r)).join(' ')}</span></div>
      <div class="faint" style="font-size:12px;margin:6px 0 10px">
        ${num(g.secondsPerDay, 1)} s of tick time per day · ${f.samples.toLocaleString('en-US')} samples over ${f.days} day${f.days === 1 ? '' : 's'} ·
        ${f.feasibility === 'likely' ? 'a known fixable pattern matched' : 'whether it can be avoided is not known until someone reads the code'} ·
        mod ${f.attribution === 'via-path' ? `inferred from the call path (${esc(row.owner)} may only be passing through)` : 'identified from the capture'}
      </div>
      ${paths}
      ${tracked}${knowledge}${envx}${detectors}
      <div class="actions">${trackButton}${setAside}</div>`;
}

function renderRow(row: Row, tickMspt: number): string {
  const g = row.group;
  const f = g.lead;
  const persistence = Math.round(f.persistence * 100);
  const evidence = f.priority.confidence === 'thin' ? ` · ${evidenceTag(f.priority.confidence)}` : '';
  const badge =
    row.investigation === undefined
      ? ''
      : row.back === true
        ? ` · <span class="tag bad">came back: ${esc(row.investigation.name)}</span>`
        : ` · <span class="tag">${esc(STATE_WORDS[row.investigation.state])}: ${esc(row.investigation.name)}</span>`;
  const share = tickMspt > 0 ? ` · ${num(((row.focus ?? g.msPerTick) / tickMspt) * 100, 1)}% of the tick` : '';
  return `<div class="frow" data-text="${esc(`${row.title} ${f.label} ${row.owner} ${SYSTEMS[row.system].name}`.toLowerCase())}">
  <div class="top">
    <div>
      <div class="ttl">${esc(row.title)}</div>
      <div class="meta">${priorityTag(f.priority)} ${esc(row.owner)} · ${esc(SYSTEMS[row.system].name)} · in ${persistence}% of minutes${evidence}${badge}</div>
    </div>
    <div class="cost">
      <div class="own" title="Time in this method itself, per tick. Own times add up.">${num(row.focus ?? g.msPerTick, 2)} <span>MSPT own${share}</span></div>
      ${row.focus === undefined ? '' : `<div class="focus">${num(g.msPerTick, 2)} MSPT across everything it does</div>`}
      <div class="sub" title="This method plus everything it calls. Context only: it overlaps with other rows, so never add these up.">${num(g.paths.reduce((s, p) => s + p.totalMsPerTick, 0), 2)} <span>MSPT including what it calls (don’t add)</span></div>
    </div>
  </div>
  <details class="more" data-key="${esc(g.key)}"><summary>Details</summary><div class="inner"><span class="faint">Loading…</span></div></details>
</div>`;
}

function renderInvestigation(inv: Investigation, nowMspt: number): string {
  const back = cameBack(inv, nowMspt);
  const members = inv.members.map((m) => (m.startsWith('mod:') ? `everything from ${m.slice(4)}` : readableMethod(m))).join(' · ');
  return `<div class="inv">
    <div style="display:flex;gap:12px;align-items:start;justify-content:space-between">
      <div>
        <div class="ttl">${esc(inv.name)} <span class="tag ${back.back ? 'bad' : ''}">${back.back ? 'came back' : esc(STATE_WORDS[inv.state])}</span></div>
        <div class="members">${esc(members)}</div>
        ${inv.note === '' ? '' : `<div style="margin-top:6px">${esc(inv.note)}</div>`}
        <div class="faint" style="font-size:12px;margin-top:6px">
          ${esc(STATE_WORDS[inv.state])} since ${esc(when(inv.updatedAt))} ·
          ${inv.baselineMspt === null ? '' : `${num(inv.baselineMspt, 2)} MSPT then, `}${num(nowMspt, 2)} MSPT now (this season)
        </div>
        ${
          inv.history.length < 2
            ? ''
            : `<details class="faint" style="font-size:12px;margin-top:4px"><summary>History</summary><ul style="margin:4px 0;padding-left:18px">${inv.history
                .map((h) => `<li>${esc(when(h.at))}: ${esc(STATE_WORDS[h.state])}${h.mspt === null ? '' : ` at ${num(h.mspt, 2)} MSPT`}${h.note === '' ? '' : `. ${esc(h.note)}`}</li>`)
                .join('')}</ul></details>`
        }
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        ${inv.state === 'active' ? '' : `<button class="ghost js-inv" data-id="${inv.id}" data-state="active" data-mspt="${nowMspt}">Make active</button>`}
        ${inv.state === 'hold' && !back.back ? '' : `<button class="ghost js-inv" data-id="${inv.id}" data-state="hold" data-mspt="${nowMspt}">${back.back ? 'Keep on hold' : 'Put on hold'}</button>`}
        ${inv.state === 'resolved' && !back.back ? '' : `<button class="ghost js-inv" data-id="${inv.id}" data-state="resolved" data-mspt="${nowMspt}">Mark resolved</button>`}
        <button class="ghost js-note" data-id="${inv.id}" data-note="${esc(inv.note)}">Note</button>
      </div>
    </div>
  </div>`;
}

/** Suggestions for the search box: mods, parts, things and methods on this page. */
function suggestions(rows: readonly Row[], where: SplitResult | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string, label?: string): void => {
    const key = value.toLowerCase();
    if (value === '' || seen.has(key) || out.length >= 400) return;
    seen.add(key);
    out.push(`<option value="${esc(value)}"${label === undefined ? '' : ` label="${esc(label)}"`}></option>`);
  };
  for (const m of where?.mods ?? []) add(m.name, 'mod');
  for (const s of where?.systems ?? []) {
    add(s.name, 'part of the game');
    for (const t of subjectsOf(where!, s.key as SystemKey).slice(0, 40)) {
      if (t.key !== '' && !t.key.startsWith('~')) add(t.name, s.name);
    }
  }
  for (const r of rows.slice(0, 150)) add(r.title, r.owner);
  return out.join('');
}

/** Several things asked for together: what they add up to, and one hand-off for all of them. */
function renderPickedSummary(picked: ReadonlyArray<{ name: string; mspt: number }>, handoff: string, clear: string): string {
  const total = picked.reduce((s, t) => s + t.mspt, 0);
  return `<div class="inside-methods"><div class="inside-head"><b>${picked.length} things together</b><span class="fig mono">${num(total, 2)} MSPT</span>
      <a class="button ghost small" href="${esc(handoff)}" title="One brief covering all of them">Hand off together</a>
      <a class="button ghost small" href="${esc(clear)}">Clear</a>
      <span class="faint" style="font-size:12px">${picked.map((t) => esc(t.name)).join(' · ')}. The findings below belong to any of them.</span></div></div>`;
}

/** What one thing spends its time on, method by method. */
function renderInsideMethods(
  system: SystemKey,
  key: string,
  thingMspt: number,
  inside: Inside | undefined,
  handoff: string,
  pathsOf: (search: string) => string,
): string {
  const name = subjectName(system, key);
  const handoffButton = `<a class="button ghost small" href="${esc(handoff)}" title="Write a brief about ${esc(name)} for whoever will read the code">Hand off</a>`;
  if (inside === undefined) {
    return `<div class="inside-methods"><div class="inside-head"><b>${esc(name)}</b><span class="fig mono">${num(thingMspt, 2)} MSPT</span>${handoffButton}</div>
      <div class="faint" style="font-size:12.5px">It is not one place in the code, so there is no list of methods inside it; the findings below are the ones that belong to it.</div></div>`;
  }
  const shown = inside.methods.filter((m) => m.mspt >= 0.0005);
  const max = Math.max(...shown.map((m) => m.mspt), 0.001);
  const item = (m: Inside['methods'][number]): string => `<a href="${esc(pathsOf(m.method.split('.').slice(-2).join('.')))}" title="${esc(m.method)} (${esc(m.owner)}). See every call path through it.">
      <span class="nm">${esc(readableMethod(m.method))}${m.owner === 'Minecraft' ? '' : `<span class="tag">${esc(m.owner)}</span>`}</span>
      <span class="fig">${num(m.mspt, 3)}</span>
      <span class="bar"><i style="width:${((m.mspt / max) * 100).toFixed(1)}%"></i></span>
    </a>`;
  const rest = thingMspt - inside.listedMspt;
  return `<div class="inside-methods">
    <div class="inside-head"><b>Inside ${esc(name)}</b><span class="fig mono">${num(thingMspt, 2)} MSPT</span>${handoffButton}
      <span class="faint" style="font-size:12px">What it spends its time on: own time per method, so these add up. Click one for every call path through it.</span></div>
    ${
      shown.length === 0
        ? '<div class="empty">No single method here is big enough to keep on its own.</div>'
        : `<div class="methods">${shown.slice(0, 30).map(item).join('')}</div>${
            shown.length > 30 ? `<details style="margin-top:6px"><summary class="faint" style="font-size:12.5px">${shown.length - 30} smaller</summary><div class="methods">${shown.slice(30, 200).map(item).join('')}</div></details>` : ''
          }`
    }
    ${rest > 0.005 ? `<div class="faint" style="font-size:12px;margin-top:8px">Plus ${num(rest, 2)} MSPT in call paths each too small to keep one by one.</div>` : ''}
  </div>`;
}

/**
 * One by one, with coordinates, from an in-game Observable profile (optional:
 * only when the pack has Observable and someone ran one). spark cannot tell
 * one villager from another; this can.
 */
function observablePanel(view: ObservableView | undefined, entities: boolean): string {
  if (view === undefined) return '';
  const where = (t: ObservableView['top'][number]): string =>
    t.x === null ? '' : `${t.x}, ${t.y}, ${t.z}${t.level === null ? '' : ` · ${t.level.replace(/^minecraft:/, '')}`}`;
  const name = (type: string): string => type.replace(/^(entity|block)\.minecraft\./, '').replace(/^minecraft:/, '');
  return panel(
    entities ? 'Entity by entity (Observable)' : 'Block by block (Observable)',
    `<div class="inside-methods">
      <div class="inside-head"><b>Costliest ${entities ? 'entities' : 'blocks'}</b><span class="faint" style="font-size:12px">each one on its own, with where it is</span></div>
      <div class="methods">${view.top
        .slice(0, 15)
        .map((t) => `<div class="obs"><span class="nm">${esc(name(t.type))} <span class="faint mono">${esc(where(t))}</span></span><span class="fig">${num(t.mspt, 3)}</span></div>`)
        .join('')}</div>
      <div class="inside-head" style="margin-top:14px"><b>By type</b></div>
      <div class="methods">${view.types
        .slice(0, 20)
        .map((t) => `<div class="obs"><span class="nm">${esc(name(t.type))} <span class="faint">× ${t.count}</span></span><span class="fig">${num(t.mspt, 3)}</span></div>`)
        .join('')}</div>
      <div class="faint" style="font-size:12px;margin-top:8px">MSPT from an in-game Observable profile, ${esc(when(view.takenAt))}, ${Math.round(view.ticks / 20)} s long.
        It is one moment and times each ${entities ? 'entity' : 'block'} on its own, so it will not match the figures above exactly.</div>
    </div>`,
  );
}

function renderWhere(
  where: SplitResult,
  ctx: {
    systemFilter: string | undefined;
    subjectFilter: string | undefined;
    /** Every thing asked for; more than one when several were picked together. */
    subjects: readonly string[];
    modFilter: string | undefined;
    link: (change: Record<string, string | undefined>) => string;
    description: string;
    inside?: Inside | undefined;
    handoff: string;
    /** The hand-off link without any thing, for the pick bar to add to. */
    handoffBase: string;
  },
): string {
  const pathsOf = (search: string): string => ctx.link({ view: 'paths', q: search, system: undefined, subject: undefined, mod: undefined });
  if (where.ticks === 0) {
    return where.pending > 0
      ? panel('Where your MSPT goes', `<div class="empty">Being prepared for ${where.pending} capture${where.pending === 1 ? '' : 's'}; this takes about a minute after an update. Refresh in a moment.</div>`, { meta: esc(ctx.description) })
      : '';
  }
  const { link } = ctx;
  const aligned = where.minutes > 0 ? where.alignedMinutes / where.minutes : 0;
  const measured =
    where.measuredMspt === undefined
      ? ''
      : ` spark’s own timing for the same minutes: a typical tick took <b>${num(where.measuredMspt, 1)} MSPT</b>${where.totalMspt > where.measuredMspt ? ' (a median, so spikes pull the average above it)' : ''}.`;
  const sub = `<div class="where-sub">Sampled tick work over ${where.minutes.toLocaleString('en-US')} minute${where.minutes === 1 ? '' : 's'} (${where.ticks.toLocaleString('en-US')} ticks).${measured}</div>`;
  // Lined-up minutes matter when the total disagrees with spark's own timing,
  // or the span is too short for them to even out.
  const ratio = where.measuredMspt === undefined || where.measuredMspt <= 0 ? 1 : where.totalMspt / where.measuredMspt;
  const disagrees = ratio < 0.75 || ratio > 1.35;
  const warn =
    aligned >= 0.2 && !disagrees && where.minutes >= 360
      ? `<div class="faint" style="font-size:12px;margin:-6px 0 12px">In ${where.alignedMinutes} of ${where.minutes} minutes spark’s samples lined up with the tick; over a span this long it evens out.</div>`
      : aligned >= 0.2
      ? `<div class="note warn" style="margin:0 0 12px">In <b>${where.alignedMinutes} of ${where.minutes} minutes</b> the samples lined up with the tick, so the total above can be off by up to half or double for this span; the split between parts stays roughly right. It happens at low load with 10 ms sampling; 9 ms avoids it.</div>`
      : '';
  const pending =
    where.pending > 0
      ? `<div class="faint" style="font-size:12px;margin-top:8px">${where.pending} more capture${where.pending === 1 ? ' is' : 's are'} still being prepared and not counted yet.</div>`
      : '';

  let inside = '';
  if (ctx.systemFilter !== undefined && ctx.systemFilter in SYSTEMS) {
    const system = ctx.systemFilter as SystemKey;
    const things = subjectsOf(where, system, ctx.modFilter);
    const total = things.reduce((s, t) => s + t.mspt, 0);
    const max = Math.max(...things.map((t) => t.mspt), 0.001);
    const item = (t: (typeof things)[number]): string => `<a href="${link({ subject: ctx.subjectFilter === t.key ? undefined : t.key })}" class="${ctx.subjects.includes(t.key) ? 'on' : ''}"
        data-key="${esc(t.key)}" data-name="${esc(t.name)}" data-mspt="${t.mspt}"
        title="${esc(t.name)}${t.owner !== undefined && t.owner !== 'Minecraft' ? ` (${t.owner})` : ''}. Click to list its findings; Ctrl-click to pick several.">
        <span class="nm">${esc(t.name)}${t.owner !== undefined && t.owner !== 'Minecraft' ? `<span class="tag">${esc(t.owner)}</span>` : ''}</span>
        <span class="fig">${num(t.mspt, 2)}</span>
        <span class="bar"><i style="width:${((t.mspt / max) * 100).toFixed(1)}%"></i></span>
      </a>`;
    const shown = things.filter((t) => t.mspt >= 0.005);
    inside = `<div class="inside">
      <div class="inside-head"><b>Inside ${esc(SYSTEMS[system].name)}${ctx.modFilter === undefined ? '' : `, ${esc(ctx.modFilter)}’s part`}</b>
        <span class="fig mono">${num(total, 2)} MSPT</span>
        <span class="faint" style="font-size:12px">${esc(SYSTEMS[system].about)} Click one to list its findings; Ctrl-click to pick several and hand them off together.</span></div>
      ${
        shown.length === 0
          ? '<div class="empty">Nothing here is big enough to show.</div>'
          : `<div class="things">${shown.slice(0, 45).map(item).join('')}</div>${
              shown.length > 45 ? `<details style="margin-top:8px"><summary class="faint" style="font-size:12.5px">${shown.length - 45} smaller</summary><div class="things" style="margin-top:6px">${shown.slice(45, 300).map(item).join('')}</div></details>` : ''
            }`
      }
      <div class="pick-bar" hidden data-handoff="${esc(ctx.handoffBase)}" data-list="${esc(link({ subject: undefined }))}">
        <span><b class="js-pick-count"></b> · <span class="fig js-pick-mspt"></span> MSPT</span><span class="grow"></span>
        <a class="button small js-pick-handoff" href="#">Hand off together</a>
        <a class="button ghost small js-pick-list" href="#">List their findings</a>
        <button type="button" class="ghost small js-pick-clear">Clear</button>
      </div>
      ${
        ctx.subjects.length > 1
          ? renderPickedSummary(things.filter((t) => ctx.subjects.includes(t.key)), ctx.handoff, link({ subject: undefined }))
          : ctx.subjectFilter === undefined
            ? ''
            : renderInsideMethods(system, ctx.subjectFilter, things.find((t) => t.key === ctx.subjectFilter)?.mspt ?? 0, ctx.inside, ctx.handoff, pathsOf)
      }
      ${system === 'datapacks' ? '<div class="faint" style="font-size:12px;margin-top:8px">A function’s own name is not in a profile; the commands it runs are.</div>' : ''}
      ${system === 'entities' ? '<div class="faint" style="font-size:12px;margin-top:8px">An entity type with no tick of its own is counted under the type it inherits it from. How many of each there were is not in a profile.</div>' : ''}
    </div>`;
  } else if (ctx.modFilter !== undefined) {
    const places = placesOf(where, ctx.modFilter);
    const total = places.reduce((s, p) => s + p.mspt, 0);
    inside = `<div class="inside">
      <div class="inside-head"><b>Where ${esc(ctx.modFilter)}’s time goes</b><span class="fig mono">${num(total, 2)} MSPT</span>
        <a class="button ghost small" href="/reports?for=mod&amp;pick=${encodeURIComponent(ctx.modFilter)}" title="Write a brief about everything ${esc(ctx.modFilter)} costs this season">Hand off</a>
        <span class="faint" style="font-size:12px">Time in its own code, by part of the game. Click a part to see the things in it.</span></div>
      <div class="places">${places
        .filter((p) => p.mspt >= 0.005)
        .map(
          (p) => `<div class="pl"><a href="${link({ system: p.system, subject: undefined })}">${esc(SYSTEMS[p.system].name)}</a>
            <span class="fig">${num(p.mspt, 2)}</span>
            <span class="what">${p.subjects
              .slice(0, 5)
              .map((t) => `${esc(t.name)} ${num(t.mspt, 2)}`)
              .join(' · ')}</span></div>`,
        )
        .join('')}</div>
    </div>`;
  }

  return panel(
    `Where your ${num(where.totalMspt, 1)} MSPT goes`,
    `${sub}${warn}<div class="where">
      <div><div class="faint" style="font-size:12px;margin-bottom:6px">By part of the game</div>
        ${slices(where.systems, where.totalMspt, (k) => link({ system: ctx.systemFilter === k ? undefined : k, subject: undefined }), ctx.systemFilter, 20)}</div>
      <div><div class="faint" style="font-size:12px;margin-bottom:6px">By mod</div>
        ${slices(where.mods.map((m) => ({ key: m.key, name: m.name, mspt: m.mspt })), where.totalMspt, (k) => link({ mod: ctx.modFilter === k ? undefined : k }), ctx.modFilter, 14)}</div>
    </div>
    ${inside}
    ${pending}
    <div class="faint" style="font-size:12px;margin-top:8px">Own time, so the parts add up to the total. Click a part or a mod to look inside it. “Minecraft” is the game’s own code, including work mods ask it to do.</div>`,
    { meta: esc(ctx.description) },
  );
}

export function findingsPage(
  db: DatabaseSync,
  params: URLSearchParams,
  resolvePath: (stored: string | null) => string | undefined = (p) => p ?? undefined,
  serverId?: string,
  options: {
    detail?: string;
    ownMod?: (mod: string | null | undefined) => boolean;
    /** Return the hand-off brief for the part and thing being looked at, not the page ('' when there is none). */
    brief?: HandoffOptions;
  } = {},
): string {
  const ownMod = options.ownMod === undefined ? {} : { ownMod: options.ownMod };
  const seasons = q.seasonOptions(db, serverId);
  const requested = Number(params.get('season'));
  const seasonId = seasons.some((s) => s.id === requested) ? requested : q.latestSeasonId(db, serverId);
  const season = seasons.find((s) => s.id === seasonId);
  const show = ['active', 'hold', 'resolved'].includes(params.get('show') ?? '') ? params.get('show')! : 'active';
  const sort = params.get('sort') === 'worth' ? 'worth' : 'cost';
  const only = params.get('only') ?? 'all';
  // By method (grouped, ranked) or every call path (one row per path, nothing left out; this was the Ledger).
  const view = params.get('view') === 'paths' ? 'paths' : 'methods';
  const systemFilter = params.get('system') ?? undefined;
  const modFilter = params.get('mod') ?? undefined;

  const bounds = seasonId === undefined ? undefined : seasonDayBounds(db, seasonId);
  const latest = seasonId === undefined ? undefined : seasonLatestMoment(db, seasonId);
  const resolved = resolveRange(params, bounds, latest);
  const coverageHtml = (() => {
    if (seasonId === undefined || serverId === undefined) return '';
    const seasonSpan = db
      .prepare(
        `SELECT min(w.start_time) AS f, max(COALESCE(w.end_time, w.start_time + 60000)) AS t
           FROM capture_window w JOIN capture c ON c.id = w.capture_id WHERE c.season_id = ?`,
      )
      .get(seasonId) as { f: number | null; t: number | null };
    const span = spanOf(resolved, seasonSpan.f === null || seasonSpan.t === null ? undefined : { fromMs: seasonSpan.f, toMs: seasonSpan.t });
    if (span === undefined) return '';
    return COVERAGE_STYLE + coverageBlock(spanCoverage(db, { serverId, seasonId, ...span }));
  })();
  // Playing, idle or both: exact for spans read minute by minute; whole days
  // and the season come from daily totals, which say how much was idle instead.
  // While playing by default; exact for every range once the day and season
  // roll-ups are split by activity (store/rollups.ts), and for hour ranges always.
  const wanted = activityFilterOf(params.get('players'));
  const preparing = resolved.time === undefined && !hasActivityRollups(db);
  const players: ActivityFilter =
    resolved.time !== undefined ? wanted : seasonId === undefined ? 'all' : effectiveActivity(db, seasonId, wanted);
  const activityWords = `, ${ACTIVITY_WORDS[players]}`;
  let coverage: HourlyCoverage | undefined;
  let table: string | undefined;
  if (resolved.time !== undefined && seasonId !== undefined) {
    const prepared = prepareTimeRange(db, seasonId, resolved.time, resolvePath, players);
    table = prepared.table;
    coverage = prepared.coverage;
  }
  const all = findings(db, {
    ...ownMod,
    limit: 500,
    ...(seasonId === undefined ? {} : { seasonId }),
    ...(resolved.range === undefined ? {} : { range: resolved.range }),
    ...(table === undefined ? {} : { table }),
    activity: players,
  });

  // Where the tick goes, over the same span as the list: every sample of
  // tick work, minute by minute (analysis/split.ts).
  let where: SplitResult | undefined;
  if (seasonId !== undefined) {
    where = splitFor(
      db,
      seasonId,
      resolved.time !== undefined
        ? { time: resolved.time, activity: players }
        : resolved.range !== undefined
          ? { days: resolved.range, activity: players }
          : { activity: players },
    );
  }
  const idleNote = (): string => {
    if (preparing) {
      return `<div class="note faint" style="margin:0 0 14px">Play and idle are being separated in the background (a few minutes, only while the PC is calm). Until then, whole days and the season show all minutes together; hour ranges can already switch.</div>`;
    }
    if (seasonId === undefined || players !== 'all') return '';
    const span =
      resolved.time !== undefined
        ? { from: resolved.time.fromMs, to: resolved.time.toMs }
        : resolved.range !== undefined
          ? { from: Date.parse(`${resolved.range.fromDay}T00:00:00`), to: Date.parse(`${resolved.range.toDay}T23:59:59`) }
          : { from: 0, to: Number.MAX_SAFE_INTEGER };
    const c = db
      .prepare(
        `SELECT count(*) AS n, COALESCE(sum(w.players = 0), 0) AS idle FROM capture_window w JOIN capture c ON c.id = w.capture_id
          WHERE c.season_id = ? AND w.start_time >= ? AND w.start_time <= ? AND w.mspt_median IS NOT NULL`,
      )
      .get(seasonId, span.from, span.to) as { n: number; idle: number };
    if (c.idle < 10 || c.n === 0) return '';
    const share = c.idle / c.n;
    return `<div class="note faint" style="margin:0 0 14px">Includes <b>${num(c.idle / 60, 1)} h with nobody online</b> (${Math.round(share * 100)}% of recorded minutes), which pulls every figure down. <a href="${link({ players: 'playing' })}">Show only while playing</a>.</div>`;
  };
  const tickMspt = where?.totalMspt ?? 0;
  // One thing, or several picked together (Ctrl-click): the list and the
  // brief then cover all of them.
  const subjects = systemFilter === undefined ? [] : [...new Set(params.getAll('subject').filter((s) => s !== ''))];
  const subjectFilter = subjects.length === 1 ? subjects[0] : undefined;
  const subjectSet = subjects.length === 0 ? undefined : new Set(subjects);
  const query = (params.get('q') ?? '').trim().toLowerCase();

  // Investigations, judged on the whole season so a short range cannot make
  // something look as if it came back or went away.
  const invs = serverId === undefined ? [] : listInvestigations(db, serverId);
  const seasonList: Matchable[] = (resolved.range === undefined && table === undefined && players === 'all' ? all : findings(db, { ...ownMod, limit: 500, activity: 'all', ...(seasonId === undefined ? {} : { seasonId }) })).map(
    (f) => ({ label: f.label, owner: ownerOf(f), msPerTick: f.msPerTick }),
  );
  const invNow = new Map(invs.map((i) => [i.id, costOf(i, seasonList)]));
  const setAside = invs.filter((i) => i.state !== 'active');

  const rows: Row[] = groupFindings(all).map((group) => {
    const owner = ownerOf(group.lead);
    const investigation = invs.find((i) => matches(i, { label: group.lead.label, owner }));
    const places = group.paths.map((p) => {
      const at = classifyPath(p.path.split(' > '), p.category, explainWait);
      return { system: at.system ?? 'other', subject: at.subject, mspt: p.msPerTick };
    });
    const row: Row = {
      group,
      owner,
      system: places[0]?.system ?? 'other',
      title: titleOf(group.lead),
      places,
    };
    if (investigation !== undefined) {
      row.investigation = investigation;
      if (cameBack(investigation, invNow.get(investigation.id) ?? 0).back) row.back = true;
    }
    return row;
  });

  if (options.detail !== undefined) {
    const row = rows.find((r) => r.group.key === options.detail);
    return row === undefined
      ? '<div class="empty">This finding is no longer in the list; refresh the page.</div>'
      : renderDetails(row, envxBlock(attributionFor(db, row.group.lead.pathId, seasonId)));
  }

  let list = rows.filter((r) => r.investigation === undefined || r.investigation.state === 'active' || r.back === true);
  if (systemFilter !== undefined) {
    // A method can work for several parts or things; the figure shown is the
    // part of it that belongs to what is being looked at.
    list = list.flatMap((r): Row[] => {
      const inside = r.places.filter((p) => p.system === systemFilter && (subjectSet === undefined || subjectSet.has(p.subject ?? '')));
      return inside.length === 0 ? [] : [{ ...r, focus: inside.reduce((s, p) => s + p.mspt, 0) }];
    });
  }
  if (modFilter !== undefined) list = list.filter((r) => r.owner === modFilter);
  if (query !== '') {
    list = list.filter((r) =>
      `${r.title} ${r.group.lead.label} ${r.owner} ${r.places.map((p) => `${SYSTEMS[p.system].name} ${subjectName(p.system, p.subject)}`).join(' ')}`
        .toLowerCase()
        .includes(query),
    );
  }
  if (only === 'top') list = list.filter((r) => r.group.lead.priority.top);
  if (only === 'own') list = list.filter((r) => r.group.lead.priority.outlook === 'own-mod');
  if (only === 'fixable') list = list.filter((r) => ['known-fix', 'pattern'].includes(r.group.lead.priority.outlook));
  if (only === 'unchecked') list = list.filter((r) => ['mod', 'mod-driven'].includes(r.group.lead.priority.outlook));
  if (only === 'small') list = list.filter((r) => r.group.msPerTick < 0.1 && r.group.lead.persistence > 0.8);
  if (only === 'stalls') list = list.filter((r) => r.group.category === 'blocked');
  if (only === 'matched') list = list.filter((r) => r.group.lead.detectors.length > 0);
  if (only === 'seen') list = list.filter((r) => r.group.lead.knowledge.length > 0);
  const cost = (r: Row): number => r.focus ?? r.group.msPerTick;
  // Cost x the outlook's chance (the lead path's ratio), so a method reached
  // many ways is weighed by all of its cost.
  const winBack = (r: Row): number => cost(r) * (r.group.lead.priority.winBack / Math.max(r.group.lead.msPerTick, 1e-9));
  list = [...list].sort((a, b) => (sort === 'cost' ? cost(b) - cost(a) : winBack(b) - winBack(a)));
  list = list.sort((a, b) => Number(b.back === true) - Number(a.back === true));
  const hiddenCount = rows.filter((r) => r.investigation !== undefined && r.investigation.state !== 'active' && r.back !== true).length;

  // Links keep every other choice.
  const base: Record<string, string> = {
    ...(seasonId === undefined ? {} : { season: String(seasonId) }),
    ...rangeParams(resolved, params),
    show,
    sort,
    only,
    ...(view === 'paths' ? { view } : {}),
    ...(players === DEFAULT_ACTIVITY ? {} : { players }),
    ...(systemFilter === undefined ? {} : { system: systemFilter }),
    ...(subjectFilter === undefined ? {} : { subject: subjectFilter }),
    ...(modFilter === undefined ? {} : { mod: modFilter }),
    ...(query === '' ? {} : { q: params.get('q')!.trim() }),
  };
  const link = (change: Record<string, string | undefined>): string => {
    const next = { ...base, ...change };
    const qs = Object.entries(next)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join('&');
    // Several picked things travel as repeated subjects, unless the link sets its own.
    const extra = 'subject' in change || subjects.length < 2 ? '' : subjects.map((s) => `&subject=${encodeURIComponent(s)}`).join('');
    return `/findings?${qs}${extra}`;
  };

  const insideSource: InsideSource =
    table !== undefined
      ? { kind: 'table', table }
      : resolved.range !== undefined
        ? { kind: 'days', ...resolved.range, activity: players }
        : { kind: 'season', activity: players };
  const insideOf = (key: string): Inside | undefined =>
    where === undefined || seasonId === undefined || systemFilter === undefined || !(systemFilter in SYSTEMS)
      ? undefined
      : methodsInside(
          db,
          seasonId,
          insideSource,
          systemFilter as SystemKey,
          key,
          where.ticks,
          `${seasonId}|${JSON.stringify(resolved.time ?? resolved.range ?? 'season')}|${players}|${where.captures}|${where.ticks}`,
        );
  const inside = subjectFilter === undefined ? undefined : insideOf(subjectFilter);
  // The brief covers the same season, span, part and thing(s), and nothing else.
  const handoffParams = new URLSearchParams({
    for: 'thing',
    ...(seasonId === undefined ? {} : { season: String(seasonId) }),
    ...rangeParams(resolved, params),
    ...(players === DEFAULT_ACTIVITY ? {} : { players }),
    ...(systemFilter === undefined ? {} : { system: systemFilter }),
  });
  const handoffBase = `/reports?${handoffParams.toString()}`;
  for (const s of subjects) handoffParams.append('subject', s);
  const handoff = `/reports?${handoffParams.toString()}`;
  if (options.brief !== undefined) {
    if (where === undefined || systemFilter === undefined || subjectSet === undefined || !(systemFilter in SYSTEMS)) return '';
    const system = systemFilter as SystemKey;
    const picked = subjectsOf(where, system).filter((t) => subjectSet.has(t.key));
    if (picked.length === 0) return '';
    // Things are separate slices of the tick, so their methods' own times add up.
    const methods = new Map<string, { method: string; owner: string; mspt: number }>();
    let listedMspt = 0;
    for (const t of picked) {
      const within = t.key === subjectFilter ? inside : insideOf(t.key);
      listedMspt += within?.listedMspt ?? 0;
      for (const m of within?.methods ?? []) {
        const at = methods.get(`${m.method}|${m.owner}`);
        if (at === undefined) methods.set(`${m.method}|${m.owner}`, { method: m.method, owner: m.owner, mspt: m.mspt });
        else at.mspt += m.mspt;
      }
    }
    const owners = new Set(picked.map((t) => t.owner ?? 'Minecraft'));
    const owner = owners.size === 1 ? [...owners][0] : undefined;
    return renderThingBrief(
      db,
      {
        systemName: SYSTEMS[system].name,
        thing: picked.map((t) => t.name).join(', '),
        ...(picked.length > 1 ? { parts: picked.map((t) => ({ name: t.name, mspt: t.mspt })) } : {}),
        owner: owner === undefined || owner === 'Minecraft' ? undefined : owner,
        span: resolved.description + activityWords,
        thingMspt: picked.reduce((s, t) => s + t.mspt, 0),
        tickMspt: where.totalMspt,
        measuredMspt: where.measuredMspt,
        minutes: where.minutes,
        methods: [...methods.values()].sort((a, b) => b.mspt - a.mspt),
        listedMspt,
        findings: list.map((r) => ({ lead: r.group.lead, mspt: r.focus ?? r.group.msPerTick })).sort((a, b) => b.mspt - a.mspt),
        ownMod: (m) => options.ownMod?.(m) === true,
      },
      options.brief,
    );
  }
  const wherePanel =
    idleNote() +
    (where === undefined ? '' : renderWhere(where, { systemFilter, subjectFilter, subjects, modFilter, link, description: resolved.description + activityWords, inside, handoff, handoffBase })) +
    ((systemFilter === 'entities' || systemFilter === 'block-entities') && serverId !== undefined && view === 'methods'
      ? observablePanel(observableFor(db, serverId, systemFilter === 'entities' ? 'entity' : 'block', resolved.time), systemFilter === 'entities')
      : '');

  const cameBackBanners = setAside
    .filter((i) => cameBack(i, invNow.get(i.id) ?? 0).back)
    .map((i) =>
      banner(
        'warn',
        `${esc(i.name)} came back.`,
        `It was ${esc(STATE_WORDS[i.state].toLowerCase())} at ${num(i.baselineMspt ?? 0, 2)} MSPT and is now ${num(invNow.get(i.id) ?? 0, 2)} MSPT. Its findings are back on the list, marked.`,
        `<a class="button ghost" href="${link({ show: i.state })}">Review</a>`,
      ),
    )
    .join('');

  const seg = (items: Array<[string, string]>, key: string, current: string): string =>
    `<span class="seg">${items.map(([k, label]) => `<a class="${current === k ? 'on' : ''}" href="${link({ [key]: k })}">${esc(label)}</a>`).join('')}</span>`;
  const counts = { hold: invs.filter((i) => i.state === 'hold').length, resolved: invs.filter((i) => i.state === 'resolved').length };
  const toolbar = `<div class="toolbar">
    ${seg([['methods', 'By method'], ['paths', 'Every call path']], 'view', view)}
    ${preparing ? '' : seg([['playing', 'While playing'], ['all', 'All minutes'], ['idle', 'Nobody online']], 'players', players)}
    ${view === 'methods' ? seg([['active', 'Active'], ['hold', `On hold (${counts.hold})`], ['resolved', `Resolved (${counts.resolved})`]], 'show', show) : ''}
    ${show === 'active' && view === 'methods' ? seg([['cost', 'Biggest MSPT'], ['worth', 'Best chance to win it back']], 'sort', sort) : ''}
    ${
      show === 'active'
        ? `<select onchange="location.href=this.value">${(view === 'paths'
            ? [
                ['all', 'Everything'],
                ['small', 'Small but constant'],
                ['stalls', 'Waiting (stalls)'],
              ]
            : [
                ['all', 'Everything'],
                ['top', 'Worth a look now'],
                ['own', 'Your own mods'],
                ['fixable', 'Known fix or fixable pattern'],
                ['unchecked', 'Mod code nobody has checked'],
                ['small', 'Small but constant'],
                ['stalls', 'Waiting (stalls)'],
                ['matched', 'Known patterns'],
                ['seen', 'Seen before'],
              ]
          )
            .map(([k, label]) => `<option value="${link({ only: k })}"${only === k ? ' selected' : ''}>${esc(label!)}</option>`)
            .join('')}</select>
           <form method="get" action="/findings" class="find-form">
             ${Object.entries({ ...base, q: undefined })
               .filter(([, v]) => v !== undefined)
               .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v!)}">`)
               .join('')}
             <input type="search" name="q" id="find-text" list="find-suggest" value="${esc(params.get('q') ?? '')}" placeholder="Search methods, mods, entities…" autocomplete="off">
             <datalist id="find-suggest">${suggestions(rows, where)}</datalist>
           </form>`
        : ''
    }
    ${systemFilter === undefined ? '' : `<span class="chip">${esc(SYSTEMS[systemFilter as SystemKey]?.name ?? systemFilter)} <a href="${link({ system: undefined, subject: undefined })}" title="Clear">×</a></span>`}
    ${subjectFilter === undefined || systemFilter === undefined ? '' : `<span class="chip">${esc(subjectName(systemFilter as SystemKey, subjectFilter))} <a href="${link({ subject: undefined })}" title="Clear">×</a></span>`}
    ${modFilter === undefined ? '' : `<span class="chip">${esc(modFilter)} <a href="${link({ mod: undefined })}" title="Clear">×</a></span>`}
    ${query === '' ? '' : `<span class="chip">“${esc(params.get('q')!.trim())}” <a href="${link({ q: undefined })}" title="Clear">×</a></span>`}
  </div>`;

  const picker =
    seasons.length <= 1
      ? ''
      : `<select onchange="location.href=this.value" title="Season">${seasons
          .map(
            (s) =>
              `<option value="/findings?season=${s.id}"${s.id === seasonId ? ' selected' : ''}>${esc(q.seasonName(s))} · ${s.captures} capture${s.captures === 1 ? '' : 's'}</option>`,
          )
          .join('')}</select>`;

  const pathsQuery: q.LedgerQuery = { search: params.get('q')?.trim() ?? '', limit: 150, orderBy: 'self', activity: players };
  if (seasonId !== undefined) pathsQuery.seasonId = seasonId;
  if (table !== undefined) pathsQuery.table = table;
  else if (resolved.range !== undefined) pathsQuery.range = resolved.range;
  if (only === 'small') Object.assign(pathsQuery, { maxMsPerTick: 0.05, minPersistence: 0.9, orderBy: 'seconds' });
  if (only === 'stalls') pathsQuery.category = 'blocked';
  const body =
    view === 'paths'
      ? panel(
          'Every call path',
          callPathsTable(db, pathsQuery, {
            showBetween: params.get('between') === '1',
            betweenHref: link({ between: '1' }),
            system: systemFilter,
            subject: subjectFilter,
            mod: modFilter,
          }),
          {
            meta:
              only === 'small'
                ? 'under 0.05 MSPT and in more than 90% of minutes'
                : only === 'stalls'
                  ? 'time spent waiting inside a tick'
                  : 'nothing grouped or left out; own MSPT, biggest first',
          },
        )
      : show === 'active'
      ? panel(
          sort === 'cost' ? 'Findings, biggest MSPT first' : 'Findings, best chance to win MSPT back first',
          (list.length === 0 ? '<div class="empty">No findings match.</div>' : list.slice(0, 80).map((r) => renderRow(r, tickMspt)).join('')) +
            (hiddenCount === 0 ? '' : `<div class="faint" style="font-size:12px;margin-top:10px">${hiddenCount} finding${hiddenCount === 1 ? ' is' : 's are'} on hold or resolved and not shown. <a href="${link({ show: 'hold' })}">See them</a>.</div>`),
          {
            meta:
              sort === 'cost'
                ? 'own MSPT: what each method costs by itself'
                : 'MSPT times how likely its fix outlook is to pay off; hover an outlook for its reason',
          },
        )
      : panel(
          show === 'hold' ? 'On hold' : 'Resolved',
          (() => {
            const shown = invs.filter((i) => i.state === show);
            return shown.length === 0
              ? `<div class="empty">${show === 'hold' ? 'Nothing is on hold. Use “Put on hold…” under a finding’s Details to set a problem aside without losing it.' : 'Nothing is marked resolved yet.'}</div>`
              : shown.map((i) => renderInvestigation(i, invNow.get(i.id) ?? 0)).join('');
          })(),
          { meta: 'kept with their history; each comes back by itself if it gets much worse' },
        );

  const sameOwner = JSON.stringify(
    rows.map((r) => ({ label: r.group.lead.label, owner: r.owner, title: r.title, mspt: Math.round(r.group.msPerTick * 1000) / 1000 })),
  );

  return `${STYLE}${TERMS_STYLE}
${rangeControls('/findings', { show, sort, only, ...(seasonId === undefined ? {} : { season: String(seasonId) }) }, resolved, bounds, params, latest, coverage, picker)}
${coverageHtml}
${cameBackBanners}
${wherePanel}
${toolbar}
${body}
<div class="faint" style="font-size:12px;margin-top:10px">
  <b>Own MSPT</b> adds up; <b>including what it calls</b> overlaps and is never added. <a href="/guide#numbers">More on these numbers</a>.
</div>

<dialog class="hold" id="hold-dialog">
  <h3></h3>
  <label>Name<input type="text" id="hold-name"></label>
  <div style="font-size:13px;margin-top:10px">What it covers</div>
  <label><input type="radio" name="hold-scope" value="some" checked> These methods</label>
  <div class="opts" id="hold-opts"></div>
  <label><input type="radio" name="hold-scope" value="mod"> Everything from <b id="hold-mod"></b>, now and later</label>
  <label>Note (why, what you tried)<textarea id="hold-note" rows="3"></textarea></label>
  <div class="faint" style="font-size:12px">It leaves the active list and keeps all its history. If its cost later rises well above today’s, it comes back.</div>
  <div class="actions"><button class="ghost" id="hold-cancel" type="button">Cancel</button><button id="hold-save" type="button">Save</button></div>
</dialog>

<script>
(() => {
  const rows = ${sameOwner};
  const serverSeason = ${seasonId === undefined ? 'null' : seasonId};

  // Typing narrows the rows on screen at once; Enter (or picking a
  // suggestion) searches every finding, not only the ones shown.
  // Clicking around Findings keeps your place on the page.
  try {
    const y = sessionStorage.getItem('findings-y');
    if (y !== null) { sessionStorage.removeItem('findings-y'); window.scrollTo(0, Number(y)); }
  } catch {}
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('a[href^="/findings"]')) try { sessionStorage.setItem('findings-y', String(window.scrollY)); } catch {}
  });

  const search = document.getElementById('find-text');
  search?.addEventListener('input', (e) => {
    const t = search.value.trim().toLowerCase();
    for (const el of document.querySelectorAll('.frow')) el.hidden = t !== '' && !el.dataset.text.includes(t);
    if (e.inputType === 'insertReplacementText' || e.inputType === undefined) search.form.requestSubmit();
  });

  // Ctrl-click (or Shift-click) things to pick several; one brief covers them all.
  const bar = document.querySelector('.pick-bar');
  if (bar) {
    const picked = new Map();
    const on = [...document.querySelectorAll('.things a.on[data-key]')];
    if (on.length > 1) for (const a of on) picked.set(a.dataset.key, Number(a.dataset.mspt));
    const withPicked = (base) => base + [...picked.keys()].map((k) => '&subject=' + encodeURIComponent(k)).join('');
    const draw = () => {
      bar.hidden = picked.size === 0;
      for (const a of document.querySelectorAll('.things a[data-key]')) a.classList.toggle('picked', picked.has(a.dataset.key));
      bar.querySelector('.js-pick-count').textContent = picked.size + (picked.size === 1 ? ' thing picked' : ' things picked');
      bar.querySelector('.js-pick-mspt').textContent = [...picked.values()].reduce((s, v) => s + v, 0).toFixed(2);
      bar.querySelector('.js-pick-handoff').href = withPicked(bar.dataset.handoff);
      bar.querySelector('.js-pick-list').href = withPicked(bar.dataset.list);
    };
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('.things a[data-key]');
      if (!a || !(e.ctrlKey || e.metaKey || e.shiftKey)) return;
      e.preventDefault();
      if (picked.has(a.dataset.key)) picked.delete(a.dataset.key); else picked.set(a.dataset.key, Number(a.dataset.mspt));
      draw();
    });
    bar.querySelector('.js-pick-clear').addEventListener('click', () => { picked.clear(); draw(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picked.size > 0) { picked.clear(); draw(); } });
    if (picked.size > 0) draw();
  }

  // Details load when first opened.
  for (const d of document.querySelectorAll('details.more')) {
    d.addEventListener('toggle', async () => {
      if (!d.open || d.dataset.loaded) return;
      d.dataset.loaded = '1';
      const q = new URLSearchParams(location.search);
      q.set('key', d.dataset.key);
      try {
        const res = await fetch('/findings/detail?' + q.toString());
        d.querySelector('.inner').innerHTML = await res.text();
      } catch { d.querySelector('.inner').textContent = 'Could not load the details.'; d.dataset.loaded = ''; }
    });
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest?.('.js-track');
    if (el === null || el === undefined) return;
    {
      el.disabled = true;
      const data = await perfint.post('/api/register/create', {
        title: el.dataset.label, targetLabel: el.dataset.label, targetPathText: el.dataset.path,
        feasibility: el.dataset.feasibility, hypothesis: el.dataset.hypothesis || undefined,
      });
      if (data.ok) { perfint.toast('Added to the register as proposed.'); el.textContent = 'Tracked'; }
      else { perfint.toast(data.error || 'Could not add it.', true); el.disabled = false; }
    }
  });

  const dlg = document.getElementById('hold-dialog');
  let state = 'hold', owner = '';
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.js-hold');
    if (btn === null || btn === undefined) return;
    {
      state = btn.dataset.state; owner = btn.dataset.owner;
      dlg.querySelector('h3').textContent = state === 'hold' ? 'Put on hold' : 'Mark resolved';
      document.getElementById('hold-name').value = owner + ': ' + btn.dataset.title;
      document.getElementById('hold-mod').textContent = owner;
      document.getElementById('hold-note').value = '';
      const opts = document.getElementById('hold-opts');
      opts.innerHTML = '';
      for (const r of rows.filter((r) => r.owner === owner)) {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox'; box.value = r.label; box.checked = r.label === btn.dataset.label; box.dataset.mspt = r.mspt;
        label.append(box, ' ' + r.title + ' (' + r.mspt.toFixed(2) + ' MSPT)');
        opts.append(label);
      }
      dlg.querySelector('input[value=some]').checked = true;
      dlg.showModal();
    }
  });
  document.getElementById('hold-cancel')?.addEventListener('click', () => dlg.close());
  document.getElementById('hold-save')?.addEventListener('click', async () => {
    const scope = dlg.querySelector('input[name=hold-scope]:checked').value;
    const boxes = [...dlg.querySelectorAll('#hold-opts input:checked')];
    const members = scope === 'mod' ? ['mod:' + owner] : boxes.map((b) => b.value);
    const mspt = scope === 'mod'
      ? rows.filter((r) => r.owner === owner).reduce((s, r) => s + r.mspt, 0)
      : boxes.reduce((s, b) => s + Number(b.dataset.mspt), 0);
    const data = await perfint.post('/api/investigations/create', {
      name: document.getElementById('hold-name').value, state, members, mspt,
      note: document.getElementById('hold-note').value, seasonId: serverSeason,
    });
    if (data.ok) { dlg.close(); perfint.toast(state === 'hold' ? 'Put on hold.' : 'Marked resolved.'); setTimeout(() => location.reload(), 500); }
    else perfint.toast(data.error || 'Could not save.', true);
  });

  for (const btn of document.querySelectorAll('.js-inv')) {
    btn.addEventListener('click', async () => {
      const data = await perfint.post('/api/investigations/update', { id: Number(btn.dataset.id), state: btn.dataset.state, mspt: Number(btn.dataset.mspt) });
      if (data.ok) location.reload(); else perfint.toast(data.error || 'Could not update.', true);
    });
  }
  for (const btn of document.querySelectorAll('.js-note')) {
    btn.addEventListener('click', async () => {
      const note = await perfint.ask('Note', btn.dataset.note, 'Save');
      if (note === null) return;
      const data = await perfint.post('/api/investigations/update', { id: Number(btn.dataset.id), note });
      if (data.ok) location.reload(); else perfint.toast(data.error || 'Could not update.', true);
    });
  }
})();
</script>
`;
}
