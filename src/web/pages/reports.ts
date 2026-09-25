/**
 * Reports: the documents that leave the app.
 *
 * The handoff brief comes first, because it is what a finding turns into
 * when someone acts: pick one method, or a whole mod, from a searchable list
 * ordered by MSPT, and the brief carries the evidence with it so whoever
 * reads the code does not have to re-derive anything -- or guess. The shared
 * files (patch leaderboard, capture index) follow.
 */

import { ACTIVITY_WORDS, DEFAULT_ACTIVITY } from '../../analysis/activity.ts';
import { effectiveActivity } from '../../store/rollups.ts';
import { esc, num, panel } from '../layout.ts';
import type { DatabaseSync } from 'node:sqlite';
import { findings, groupFindings, type Finding } from '../../analysis/findings.ts';
import { readableMethod } from '../../analysis/owner.ts';
import { SYSTEMS, explainWait, type SystemKey } from '../../analysis/systems.ts';
import { classifyPath, subjectName } from '../../analysis/subjects.ts';
import { placesOf, splitFor } from '../../analysis/split.ts';
import { renderModBrief, type HandoffOptions } from '../../report/handoff.ts';
import { latestSeasonId } from '../../query/queries.ts';
import { priorityTag, TERMS_STYLE, outlookTag } from '../terms.ts';

type OwnMod = (mod: string | null | undefined) => boolean;

/** "Datapack functions › Entity selectors" for a finding's call path. */
function placeOf(f: Finding): string {
  const at = classifyPath(f.path.split(' > '), f.category, explainWait);
  const system = at.system ?? 'other';
  return at.subject === '' ? SYSTEMS[system].name : `${SYSTEMS[system].name} › ${subjectName(system, at.subject)}`;
}

/** Everything the archive knows one mod costs, as a brief. */
export function modBrief(db: DatabaseSync, mod: string, ownMod: OwnMod, options: HandoffOptions = {}): string | undefined {
  const seasonId = latestSeasonId(db);
  if (seasonId === undefined) return undefined;
  const activity = effectiveActivity(db, seasonId, DEFAULT_ACTIVITY);
  const split = splitFor(db, seasonId, { activity });
  const places = placesOf(split, mod);
  const list = findings(db, { seasonId, limit: 500, ownMod });
  if (places.length === 0 && !list.some((f) => f.source === mod)) return undefined;
  return renderModBrief(
    db,
    {
      mod,
      findings: groupFindings(list.filter((f) => f.source === mod))
        .map((g) => ({
          lead: [...g.paths].sort((a, b) => b.msPerTick - a.msPerTick)[0] ?? g.lead,
          msPerTick: g.msPerTick,
          totalMsPerTick: g.paths.reduce((s, p) => s + p.totalMsPerTick, 0),
          paths: g.paths.length,
        }))
        .sort((a, b) => b.msPerTick - a.msPerTick),
      places: places.map((p) => ({
        system: p.system,
        systemName: SYSTEMS[p.system].name,
        mspt: p.mspt,
        things: p.subjects.map((t) => ({ name: t.name, mspt: t.mspt })),
      })),
      totalMspt: places.reduce((s, p) => s + p.mspt, 0),
      tickMspt: split.totalMspt,
      measuredMspt: split.measuredMspt,
      minutes: split.minutes,
      activity: ACTIVITY_WORDS[activity],
      ownMod: ownMod(mod),
      placeOf,
    },
    options,
  );
}

const STYLE = `<style>
.brief-tools { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 10px; }
.brief-tools input[type=search] { flex: 1 1 280px; min-width: 220px; }
.picks { max-height: 420px; overflow: auto; border-radius: 14px; background: var(--well); box-shadow: var(--well-shadow); }
.pick { display: grid; grid-template-columns: minmax(0, 1fr) auto 92px; gap: 12px; align-items: center; width: 100%; text-align: left;
  padding: 8px 12px; border: none; border-bottom: 1px solid var(--border-soft); background: transparent; color: var(--text); font: inherit; font-size: 13px; cursor: pointer; border-radius: 0; }
.pick:hover { background: var(--surface-2); }
.pick.on { background: var(--surface-3); box-shadow: inset 3px 0 0 var(--accent); }
.pick .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick .s { font-size: 11.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick .fig { font-family: var(--mono); font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
.pick .fig span { font-weight: 400; font-size: 11px; color: var(--text-faint); }
.picks .none { padding: 14px; color: var(--text-faint); }
.brief-out { white-space: pre-wrap; background: var(--well); box-shadow: var(--well-shadow); border-radius: 14px; padding: 18px;
  font-size: 12px; max-height: 620px; overflow: auto; margin: 12px 0 0; }
.brief-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.files .row { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
.files .row:last-child { border-bottom: none; }
.files .row .help { margin-top: 2px; }
.files .row .btns { display: flex; gap: 6px; }
details.agent summary { cursor: pointer; font-size: 12.5px; color: var(--text-dim); }
details.agent .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; margin-top: 8px; }
</style>`;

export function reportsPage(db: DatabaseSync, params: URLSearchParams, ownMod: OwnMod = () => false): string {
  const seasonId = latestSeasonId(db);
  const list = seasonId === undefined ? [] : findings(db, { seasonId, limit: 500, ownMod });
  const groups = groupFindings(list).sort((a, b) => b.msPerTick - a.msPerTick);
  const split = seasonId === undefined ? undefined : splitFor(db, seasonId);
  const mods = (split?.mods ?? []).filter((m) => m.key !== '' && m.key !== 'Minecraft' && m.key !== 'Java' && m.mspt >= 0.0005);
  const counts = new Map<string, number>();
  for (const g of groups) if (g.lead.source !== null) counts.set(g.lead.source, (counts.get(g.lead.source) ?? 0) + 1);
  const mode = params.get('for') === 'mod' ? 'mod' : params.get('for') === 'thing' && params.get('subject') !== null ? 'thing' : 'method';
  const selected = params.get('pick') ?? '';

  const methodRows = groups
    .map((g) => {
      const f = g.lead;
      const text = `${readableMethod(f.label)} ${f.label} ${f.source ?? ''} ${placeOf(f)}`.toLowerCase();
      return `<button type="button" class="pick${selected === f.label ? ' on' : ''}" data-kind="method" data-key="${esc(f.label)}" data-text="${esc(text)}">
        <span><div class="t">${esc(readableMethod(f.label))}</div><div class="s">${esc(f.source ?? 'no mod')} · ${esc(placeOf(f))}</div></span>
        ${priorityTag(f.priority)}
        <span class="fig">${num(g.msPerTick, 3)} <span>MSPT</span></span>
      </button>`;
    })
    .join('');
  const modRows = mods
    .map((m) => {
      const own = ownMod(m.key);
      return `<button type="button" class="pick${selected === m.key ? ' on' : ''}" data-kind="mod" data-key="${esc(m.key)}" data-text="${esc(m.key.toLowerCase())}">
        <span><div class="t">${esc(m.key)}</div><div class="s">${counts.get(m.key) ?? 0} finding${counts.get(m.key) === 1 ? '' : 's'} · its own code, all parts of the game</div></span>
        ${own ? outlookTag('own-mod') : '<span></span>'}
        <span class="fig">${num(m.mspt, 3)} <span>MSPT</span></span>
      </button>`;
    })
    .join('');
  // A thing opened from Findings or a minute (Hand off): its brief covers the
  // span it was looked at over, so the link carries that span.
  const thingParams = new URLSearchParams([...params].filter(([k]) => ['season', 'range', 'from', 'to', 'players', 'system', 'subject'].includes(k)));
  const thingSystem = SYSTEMS[(params.get('system') ?? '') as keyof typeof SYSTEMS];
  const thingRow =
    mode !== 'thing'
      ? ''
      : `<button type="button" class="pick on" data-kind="thing" data-url="/reports/thing-brief.txt?${esc(thingParams.toString())}" data-text="">
        <span><div class="t">${esc(params.getAll('subject').map((s) => subjectName((params.get('system') ?? 'other') as SystemKey, s)).join(', '))}</div><div class="s">${esc(thingSystem?.name ?? '')}${params.getAll('subject').length > 1 ? ` · ${params.getAll('subject').length} things together` : ''} · over the span it was opened from</div></span>
        <span></span><span></span>
      </button>`;
  const suggestions = [...new Set([...mods.map((m) => m.key), ...groups.slice(0, 200).map((g) => readableMethod(g.lead.label))])]
    .map((v) => `<option value="${esc(v)}"></option>`)
    .join('');

  const brief = panel(
    'Handoff brief',
    `<div class="faint" style="font-size:12.5px;margin:-4px 0 12px">Everything known about a problem, for whoever will read the code. What the archive does not know is left blank, never guessed.</div>
    <div class="brief-tools">
      <span class="seg"><a class="${mode === 'method' ? 'on' : ''}" href="/reports">One method</a><a class="${mode === 'mod' ? 'on' : ''}" href="/reports?for=mod">A whole mod</a></span>
      <input type="search" id="pick-search" list="pick-suggest" autocomplete="off"
        placeholder="${mode === 'mod' ? 'Search mods…' : 'Search methods, mods or parts of the game…'}">
      <datalist id="pick-suggest">${suggestions}</datalist>
    </div>
    <div class="picks" id="picks">${
      mode === 'thing'
        ? thingRow
        : mode === 'mod'
        ? modRows === ''
          ? '<div class="none">No mod time recorded yet.</div>'
          : modRows
        : methodRows === ''
          ? '<div class="none">No findings yet.</div>'
          : methodRows
    }<div class="none" id="picks-empty" hidden>Nothing matches.</div></div>
    <div class="faint" style="font-size:12px;margin-top:6px">${
      mode === 'thing'
        ? 'A brief for this thing, over the span you opened it from: what it costs, the methods inside it, the mods involved, and its findings.'
        : mode === 'mod'
        ? `${mods.length} mods, most MSPT first. A mod’s brief covers its own code everywhere in the game, its methods, and the game’s code it drives.`
        : `${groups.length} methods, most MSPT first. Hover an outlook for its reason.`
    } Pick one to write its brief.</div>
    <details class="agent" style="margin-top:12px"><summary>Optional details for the agent</summary>
      <div class="grid">
        <input type="text" id="brief-project" placeholder="Build folder for the agent">
        <input type="text" id="brief-jar" placeholder="Installed JAR or source path">
        <input type="text" id="brief-mappings" placeholder="Mappings file">
      </div>
      <div class="help faint" style="margin-top:6px">Left blank, the brief says the value is unknown and where to find it.</div>
    </details>
    <pre id="brief-out" class="mono brief-out" hidden></pre>
    <div class="brief-actions" id="brief-actions" hidden>
      <button type="button" id="brief-copy">Copy</button>
      <a class="button ghost" id="brief-download" href="#" download>Download .md</a>
    </div>`,
    { meta: `most MSPT first · ${seasonId === undefined ? 'all minutes' : ACTIVITY_WORDS[effectiveActivity(db, seasonId, DEFAULT_ACTIVITY)]}` },
  );

  const files = panel(
    'Files to share',
    `<div class="files">
      <div class="row"><div><strong>Patch leaderboard</strong><div class="help">This season’s findings, one row per method, with MSPT, fix outlook
        and earlier work; ordered by the best chance to win MSPT back.</div></div>
        <div class="btns"><a class="button ghost" href="/reports/leaderboard.md?view=1" target="_blank" rel="noopener">View</a><a class="button" href="/reports/leaderboard.md" download>Download .md</a></div></div>
      <div class="row"><div><strong>Capture index</strong><div class="help">One row per capture: when, how long, tick time, idle and waiting.</div></div>
        <div class="btns"><a class="button ghost" href="/reports/index.md?view=1" target="_blank" rel="noopener">View</a><a class="button" href="/reports/index.md" download>Download .md</a></div></div>
    </div>`,
  );

  return `${STYLE}${TERMS_STYLE}
${brief}
${files}
<script>
(() => {
  const search = document.getElementById('pick-search');
  const picks = [...document.querySelectorAll('.pick')];
  const empty = document.getElementById('picks-empty');
  search?.addEventListener('input', () => {
    const t = search.value.trim().toLowerCase();
    let shown = 0;
    for (const p of picks) { const hit = t === '' || p.dataset.text.includes(t); p.hidden = !hit; if (hit) shown += 1; }
    empty.hidden = shown !== 0;
  });

  const out = document.getElementById('brief-out');
  const actions = document.getElementById('brief-actions');
  const download = document.getElementById('brief-download');
  const write = async (pick) => {
    for (const p of picks) p.classList.toggle('on', p === pick);
    const q = new URLSearchParams({
      projectDir: document.getElementById('brief-project').value,
      jarPath: document.getElementById('brief-jar').value,
      mappingsPath: document.getElementById('brief-mappings').value,
    });
    if (pick.dataset.kind !== 'thing') q.set(pick.dataset.kind === 'mod' ? 'mod' : 'label', pick.dataset.key);
    const url = pick.dataset.kind === 'thing'
      ? pick.dataset.url + '&' + q.toString()
      : (pick.dataset.kind === 'mod' ? '/reports/mod-brief.txt?' : '/reports/handoff.txt?') + q.toString();
    out.hidden = false;
    out.textContent = 'Writing the brief…';
    const res = await fetch(url);
    out.textContent = await res.text();
    actions.hidden = !res.ok;
    download.href = url + '&download=1';
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  for (const p of picks) p.addEventListener('click', () => write(p));
  document.getElementById('brief-copy')?.addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(out.textContent);
    e.currentTarget.textContent = 'Copied';
    setTimeout(() => { e.currentTarget.textContent = 'Copy'; }, 1500);
  });
  const preselected = document.querySelector('.pick.on');
  if (preselected) write(preselected);
})();
</script>`;
}
