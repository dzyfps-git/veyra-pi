/**
 * Seasons, environments, and the detail view for one capture.
 *
 * The season page exists because season boundaries are the thing most likely
 * to make a number lie. Everywhere else in the interface, a season is a
 * filter; here it is the subject, so the reason a boundary was drawn is
 * visible and arguable rather than implicit.
 *
 * The capture page deliberately stops short of drawing a flame graph. spark
 * already has a viewer, it is better than anything worth building here, and
 * the archived file opens in it directly — so this page's job is to say what
 * the capture contains and hand it over.
 */

import { rollupActivitySql } from '../../store/rollups.ts';
import { esc, num, bytes, when } from '../layout.ts';
import type { DatabaseSync } from 'node:sqlite';
import * as q from '../../query/queries.ts';
import type { SetupFinding } from '../../runtime/setup.ts';
import {
  gatherSetup,
  planJvmFlags,
  planSparkConfig,
  recentRemediations,
  tierOf,
  type FixTier,
  type SetupState,
} from '../../runtime/remediate.ts';
import type { SettingsStore } from '../../settings/store.ts';
import type { ServerConfig } from '../../store/servers.ts';

function card(k: string, v: string, note?: string): string {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${
    note === undefined ? '' : `<div class="n">${esc(note)}</div>`
  }</div>`;
}

interface SeasonDetail {
  id: number;
  ordinal: number;
  label: string | null;
  started_at: number;
  reason: string;
  confirmed: number;
  os_name: string;
  cpu_model: string;
  cpu_threads: number | null;
  mc_version: string;
  loader_name: string;
  loader_version: string;
  java_major: string;
  captures: number;
  first_capture: number | null;
  last_capture: number | null;
  revisions: number;
  paths: number;
}

interface WorldSummary {
  id: number;
  fingerprint: string;
  strength: string;
  seed: string | null;
  level_name: string | null;
  level_type: string | null;
  label: string | null;
  first_seen: number;
  last_seen: number;
  seasons: number;
  captures: number;
}

interface QuestionRow {
  id: number;
  kind: string;
  question: string;
  detail: string;
  options: string;
  created_at: number;
}

/**
 * Questions the system refused to answer for itself.
 *
 * Rendered above everything else on the page, because an unanswered question
 * means history is being recorded under an assumption nobody has checked —
 * and the longer that goes unnoticed, the more data is filed under it.
 */
function questionsBlock(db: DatabaseSync): string {
  const rows = db
    .prepare('SELECT id, kind, question, detail, options, created_at FROM boundary_question WHERE answered_at IS NULL ORDER BY created_at')
    .all() as unknown as QuestionRow[];

  if (rows.length === 0) {
    return `<div class="note faint">
  Nothing needs your input. Every boundary so far was decided from evidence strong enough to act on —
  a world seed, a Minecraft version, a loader. Anything weaker would appear here as a question rather
  than being guessed at.
</div>`;
  }

  return rows
    .map((row) => {
      let options: Array<{ id: string; label: string; description: string }> = [];
      try {
        options = JSON.parse(row.options) as typeof options;
      } catch {
        options = [];
      }

      const buttons = options
        .map(
          (o) =>
            `<button class="js-answer ghost" data-question="${row.id}" data-answer="${esc(o.id)}"
                     style="width:100%;margin-top:6px" title="${esc(o.description)}">${esc(o.label)}</button>`,
        )
        .join('');

      return `<div class="setting" style="grid-template-columns:1fr 240px;border-left:3px solid var(--warn)">
      <div>
        <div class="label">
          <strong>${esc(row.question)}</strong>
          <span class="tag warn">needs your input</span>
        </div>
        <div class="help">${esc(row.detail)}</div>
        <div class="help faint">
          Nothing has been split or merged while this is unanswered. Asked ${esc(when(row.created_at))}.
        </div>
        ${options.map((o) => `<div class="help faint"><strong>${esc(o.label)}:</strong> ${esc(o.description)}</div>`).join('')}
      </div>
      <div class="control">${buttons}</div>
    </div>`;
    })
    .join('');
}

function strengthTag(strength: string): string {
  switch (strength) {
    case 'seed':
      return '<span class="tag ok" title="Identified by world seed from level.dat. A reset is detected automatically.">by seed</span>';
    case 'name':
      return '<span class="tag warn" title="Identified by level name and datapacks only. A reset that kept the same name cannot be detected.">by name only</span>';
    default:
      return '<span class="tag">unidentified</span>';
  }
}

function worldsBlock(db: DatabaseSync): string {
  const worlds = db
    .prepare(
      `SELECT w.*,
              (SELECT count(*) FROM season s WHERE s.world_id = w.id) AS seasons,
              (SELECT count(*) FROM capture c JOIN season s ON s.id = c.season_id WHERE s.world_id = w.id) AS captures
         FROM world w ORDER BY w.last_seen DESC`,
    )
    .all() as unknown as WorldSummary[];

  const orphanSeasons = (
    db.prepare('SELECT count(*) AS n FROM season WHERE world_id IS NULL').get() as { n: number }
  ).n;

  const rows = worlds
    .map(
      (w) => `<div class="setting" style="grid-template-columns:1fr 250px" data-world="${w.id}">
    <div>
      <div class="label">
        <strong>${esc(w.label ?? w.level_name ?? 'unnamed world')}</strong>
        ${strengthTag(w.strength)}
        ${w.label === null ? '<span class="tag">no name yet</span>' : ''}
      </div>
      <div class="help mono" style="font-size:11.5px;color:var(--text-faint)">
        ${w.seed === null ? 'no seed recorded' : `seed ${esc(w.seed)}`} ·
        level "${esc(w.level_name ?? 'unknown')}" · type ${esc(w.level_type ?? 'unknown')}
      </div>
      <div class="help faint">First seen ${esc(when(w.first_seen))}, last ${esc(when(w.last_seen))}.</div>
    </div>
    <div class="control" style="gap:4px">
      <div class="faint" style="text-align:right;font-size:11.5px">${w.captures} capture${w.captures === 1 ? '' : 's'} · ${w.seasons} season${w.seasons === 1 ? '' : 's'}</div>
      <button class="ghost js-name-world" data-world="${w.id}" style="margin-top:6px">${w.label === null ? 'Name this world' : 'Rename'}</button>
    </div>
  </div>`,
    )
    .join('');

  return `
<h2 style="margin-top:26px">Worlds</h2>
<div class="note">
  A world reset starts a new season, because a fresh world has no loaded chunk backlog, no entities and
  no farms — measuring it against a world people have lived in for weeks compares an empty house to a
  full one. Detection is automatic <strong>only when the world seed is readable</strong> from
  <code>level.dat</code>; a seed change cannot mean anything else. Without it, only a rename is visible,
  and anything ambiguous is asked rather than assumed.
</div>
${
  orphanSeasons === 0
    ? ''
    : `<div class="note faint">${orphanSeasons} season${orphanSeasons === 1 ? '' : 's'} ${
        orphanSeasons === 1 ? 'predates' : 'predate'
      } world tracking and ${orphanSeasons === 1 ? 'is' : 'are'} not attributed to a world. That is left
       as-is deliberately: which world ${orphanSeasons === 1 ? 'it' : 'they'} measured is genuinely not
       known, and filling it in would be a guess. Their history is complete and still queryable.</div>`
}
${worlds.length === 0 ? '<div class="empty">No world has been identified yet.</div>' : rows}
`;
}

const SEVERITY_TAG: Record<string, string> = {
  blocking: '<span class="tag bad">not working</span>',
  degraded: '<span class="tag warn">degraded</span>',
  info: '<span class="tag">note</span>',
};

/** Registry and finding text write "--" for a dash. */
function dash(text: string): string {
  return esc(text.replaceAll(' -- ', ' — '));
}

const WHY_STYLE = `<style>
details.why summary { cursor: pointer; color: var(--accent); font-size: 12px; list-style: none; }
details.why summary::-webkit-details-marker { display: none; }
details.why[open] summary { margin-bottom: 4px; }
</style>`;

const TIER_LABEL: Record<string, string> = {
  automatic: '<span class="tag ok">fixed automatically</span>',
  'opt-in': '<span class="tag accent">one click, or automatic if enabled</span>',
  'one-click': '<span class="tag accent">one click, shown first</span>',
  guidance: '<span class="tag">you do this</span>',
};

const PRE =
  'class="mono" style="font-size:11.5px;background:var(--surface-2);border:1px solid var(--border);' +
  'border-radius:6px;padding:8px;margin-top:6px;white-space:pre-wrap;overflow-x:auto"';

/** A before/after, as lines a person can check before pressing anything. */
function diffBlock(removed: string[], added: string[]): string {
  const lines = [
    ...removed.map((l) => `<span style="color:var(--bad)">- ${esc(l)}</span>`),
    ...added.map((l) => `<span style="color:var(--ok)">+ ${esc(l)}</span>`),
  ];
  return `<pre ${PRE}>${lines.join('\n')}</pre>`;
}

/** What can be done about one finding, in this tier. */
function remedyBlock(f: SetupFinding, tier: FixTier, state: SetupState, settings: SettingsStore): string {
  const plain = `<div class="help"><strong>Fix:</strong> ${dash(f.remedy.action)}</div>${
    f.remedy.detail === undefined ? '' : `<pre ${PRE}>${esc(f.remedy.detail)}</pre>`
  }`;

  if (tier === 'automatic') {
    return `<div class="help"><strong>Fix:</strong> ${
      settings.getBoolean('setup.autoFix.analyzerSettings')
        ? 'corrected automatically at the next check. This changes a setting in this app only; nothing on the server.'
        : "automatic fixing of this app's own settings is off. " + esc(f.remedy.action)
    }</div>
    <div style="margin-top:8px"><button class="ghost js-setup-fix" data-what="analyzer">Fix now</button></div>`;
  }

  if (tier === 'opt-in') {
    let plan;
    try {
      plan = planSparkConfig(state);
    } catch (error) {
      return plain + `<div class="help faint">${esc((error as Error).message)}</div>`;
    }
    if (plan === undefined) {
      return (
        plain +
        `<div class="help faint">spark's config could not be read as JSON, so it is never rewritten here: it may be half-written or hand-edited.</div>`
      );
    }
    return `<div class="help"><strong>Fix:</strong> change only these keys in <span class="mono">${esc(plan.file)}</span>.
      Every other key the pack wrote is kept, the current file is backed up first, and nothing is restarted.
      It takes effect the next time the server starts.</div>
      ${diffBlock([], plan.changes)}
      <div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="js-setup-fix" data-what="spark-config" data-sha="${esc(plan.beforeSha ?? '')}">Apply to spark's config</button>
        <span class="faint" style="font-size:12px">${
          settings.getBoolean('setup.autoFix.sparkConfig')
            ? 'Automatic repair is on, so the next check will do this anyway.'
            : "Or let the next check do this: <a href=\"/settings\">Repair spark's config automatically</a>."
        }</span>
      </div>`;
  }

  if (tier === 'one-click') {
    let plan;
    try {
      plan = planJvmFlags(state.root);
    } catch (error) {
      return plain + `<div class="help faint">${esc((error as Error).message)}</div>`;
    }
    if ('refused' in plan) return plain + `<div class="help faint">${esc(plan.refused)}</div>`;
    return `<div class="help"><strong>Fix:</strong> this exact change to <span class="mono">${esc(plan.file)}</span>.
      Nothing is written until you press the button, the current file is backed up first, and the server is
      <strong>not</strong> restarted. It takes effect ${esc(plan.takesEffect)}</div>
      ${diffBlock(plan.before === '' ? [] : [plan.before], plan.after.split('\n'))}
      <div style="margin-top:8px">
        <button class="js-setup-fix" data-what="jvm-flags" data-sha="${esc(plan.beforeSha)}"
          data-confirm="Write this change to ${esc(plan.mechanism)}? The server is not restarted.">Add to ${esc(plan.mechanism)}</button>
      </div>`;
  }

  return plain;
}

function recentFixesBlock(db: DatabaseSync): string {
  const rows = recentRemediations({ db }, 8);
  if (rows.length === 0) return '';
  const items = rows
    .map(
      (r) => `<tr>
      <td class="faint" style="white-space:nowrap">${esc(when(r.at))}</td>
      <td>${esc(r.summary)}${r.actor === 'auto-fix' ? ' <span class="tag">automatic</span>' : ''}</td>
      <td style="text-align:right;white-space:nowrap">${
        r.status === 'undone'
          ? `<span class="faint">undone ${esc(when(r.undone_at ?? r.at))}</span>`
          : `<button class="ghost js-setup-undo" data-id="${r.id}" style="padding:5px 12px">Undo</button>`
      }</td>
    </tr>`,
    )
    .join('');
  return `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-faint);margin:18px 0 8px">Recent fixes</h3>
  <table>${items}</table>
  <div class="faint" style="font-size:11.5px;margin-top:6px">Undo works only while nobody has changed the file since; it never overwrites someone else’s edit.</div>`;
}

const PANEL_SCRIPT = (serverId: string): string => `${WHY_STYLE}<div id="setup-status" class="note" style="display:none" data-server="${esc(serverId)}"></div>
<script>
(() => {
  const status = document.getElementById('setup-status');
  const say = (text, bad) => { status.textContent = text; status.className = 'note' + (bad ? ' bad' : ''); status.style.display = 'block'; };
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  };
  for (const el of document.querySelectorAll('.js-setup-fix')) {
    el.addEventListener('click', async () => {
      if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
      el.disabled = true;
      const data = await post('/api/setup/fix', { serverId: status.dataset.server, what: el.dataset.what, expectedSha: el.dataset.sha ?? null });
      if (data.ok) { say(data.message || 'Done.'); setTimeout(() => location.reload(), 2500); }
      else { el.disabled = false; say(data.error || 'failed', true); }
    });
  }
  for (const el of document.querySelectorAll('.js-setup-undo')) {
    el.addEventListener('click', async () => {
      if (!confirm('Undo this fix?')) return;
      el.disabled = true;
      const data = await post('/api/setup/undo', { id: Number(el.dataset.id) });
      if (data.ok) { say(data.message || 'Undone.'); setTimeout(() => location.reload(), 1500); }
      else { el.disabled = false; say(data.error || 'failed', true); }
    });
  }
  document.getElementById('setup-recheck')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    const data = await post('/api/setup/recheck', { serverId: status.dataset.server });
    if (data.ok) location.reload(); else { event.target.disabled = false; say(data.error || 'failed', true); }
  });
})();
</script>`;

/**
 * Whether the monitoring setup on the server still matches what it needs to
 * be, and what can be done about it.
 *
 * Rendered on the Overview because the failure it catches is silent: a
 * modpack rotation replaces mods and config wholesale, spark disappears, and
 * the only symptom is a gap in history that cannot be filled in afterwards.
 *
 * Rendering never changes anything. Fixes happen on the collector's cadence
 * (only the tiers allowed to be automatic) or when a button here is pressed.
 */
export function setupPanel(db: DatabaseSync, settings: SettingsStore, server: ServerConfig): string {
  if (!settings.getBoolean('setup.checkOnRotation')) {
    return `<div class="note faint">
  Automatic setup checking is off. Nothing is watching for spark being removed by a modpack update.
  <a href="/settings">Turn it on</a>.
</div>`;
  }

  let state: SetupState | undefined;
  try {
    state = gatherSetup({ db }, settings, server.root, server.id);
  } catch (error) {
    return `<div class="note bad">The setup check could not run: ${esc((error as Error).message)}</div>`;
  }
  if (state === undefined) {
    return `<div class="note warn">
  No server folder is set for ${esc(server.displayName)}, so its monitoring setup cannot be checked.
  <a href="/server?id=${esc(server.id)}#monitoring">Choose one</a>.
</div>`;
  }

  const { observed, environment: env, findings, root } = state;
  const installed = [
    ...observed.sparkJars.map((j) => j.fileName),
    ...observed.observableJars.map((j) => j.fileName),
  ];

  const summary = `<div class="note faint" style="margin-top:0">
  Checked ${esc(root)}${env.loaderName === undefined ? '' : ` · ${esc(env.loaderName)} ${esc(env.minecraftVersion ?? '')} · Java ${esc(env.javaMajor ?? '?')}`}.
  ${installed.length === 0 ? 'No monitoring mods found.' : `Installed: ${esc(installed.join(', '))}.`}
  ${
    observed.jvmArgs === undefined
      ? 'JVM flags: launcher layout not recognised.'
      : `JVM flags read from ${esc(observed.jvmArgs.mechanism)}.`
  }
  <button class="ghost" id="setup-recheck" style="padding:4px 11px;margin-left:6px">Check again</button>
</div>`;

  const fixes = recentFixesBlock(db);

  if (findings.length === 0) {
    return `<div class="note" style="border-left-color:var(--ok)">
  <strong>Monitoring setup is intact.</strong> spark is installed for the right loader, background
  profiling is on, and the mappings match this Minecraft version.
</div>${summary}${fixes}${PANEL_SCRIPT(server.id)}`;
  }

  const rows = findings
    .map((f) => {
      const tier = tierOf(f, observed);
      return `<div class="setting" style="grid-template-columns:1fr;border-left:3px solid ${
        f.severity === 'blocking' ? 'var(--bad)' : f.severity === 'degraded' ? 'var(--warn)' : 'var(--border)'
      }">
    <div>
      <div class="label"><strong>${esc(f.title)}</strong> ${SEVERITY_TAG[f.severity] ?? ''} ${TIER_LABEL[tier] ?? ''}</div>
      <div class="help">${dash(f.observed)}</div>
      <details class="help faint why"><summary>Why this matters</summary>${dash(f.consequence)}</details>
      ${remedyBlock(f, tier, state, settings)}
    </div>
  </div>`;
    })
    .join('');

  const blocking = findings.filter((f) => f.severity === 'blocking').length;

  return `<div class="note ${blocking > 0 ? 'bad' : 'warn'}">
  <strong>${
    blocking > 0
      ? 'Monitoring is not working on the server.'
      : 'Monitoring works. An improvement is available.'
  }</strong>
  ${findings.length} item${findings.length === 1 ? '' : 's'} below. Nothing here ever restarts the server.
  <details class="why" style="margin-top:6px"><summary>How fixes work</summary>
    This app’s own settings are fixed automatically; spark’s config and the launcher are one click (spark’s can be
    automatic). Mods and restarts are always yours.
  </details>
</div>
${rows}
${summary}
${fixes}
${PANEL_SCRIPT(server.id)}`;
}

export function seasonsPage(db: DatabaseSync, settings: SettingsStore): string {
  const seasons = db
    .prepare(
      `SELECT s.id, s.ordinal, s.started_at, s.reason, s.confirmed, s.label,
              e.os_name, e.cpu_model, e.cpu_threads, e.mc_version,
              e.loader_name, e.loader_version, e.java_major,
              (SELECT count(*)        FROM capture c WHERE c.season_id = s.id) AS captures,
              (SELECT min(started_at) FROM capture c WHERE c.season_id = s.id) AS first_capture,
              (SELECT max(started_at) FROM capture c WHERE c.season_id = s.id) AS last_capture,
              (SELECT count(*)        FROM revision r WHERE r.season_id = s.id) AS revisions,
              (SELECT count(*)        FROM path_rollup pr WHERE pr.season_id = s.id${rollupActivitySql(db, 'all').replace('activity', 'pr.activity')}) AS paths
         FROM season s
         JOIN environment e ON e.id = s.environment_id
        ORDER BY last_capture DESC, s.started_at DESC`,
    )
    .all() as unknown as SeasonDetail[];

  if (seasons.length === 0) return '<div class="empty">No captures have been ingested yet.</div>';

  // Overlapping date ranges are normal here and are the reason seasons are
  // detected per environment rather than per timeline: a test box and
  // production interleave by date, and sequencing them invents rollovers
  // that never happened.
  const overlapping = seasons.filter((a) =>
    seasons.some(
      (b) =>
        b.id !== a.id &&
        a.first_capture !== null &&
        a.last_capture !== null &&
        b.first_capture !== null &&
        b.last_capture !== null &&
        a.first_capture <= b.last_capture &&
        b.first_capture <= a.last_capture,
    ),
  );

  const rows = seasons
    .map((s) => {
      const span =
        s.first_capture === null || s.last_capture === null
          ? '—'
          : `${when(s.first_capture)} → ${when(s.last_capture)}`;
      return `<div class="setting" style="grid-template-columns:1fr 230px">
      <div>
        <div class="label">
          <strong>${esc(s.label ?? s.os_name)}</strong>
          <span class="tag">season ${s.ordinal}</span>
          ${s.label === null ? '' : `<span class="tag">${esc(s.os_name)}</span>`}
          <span class="tag accent">${esc(s.loader_name)} ${esc(s.mc_version)}</span>
          <span class="tag">Java ${esc(s.java_major)}</span>
          ${s.confirmed === 1 ? '' : '<span class="tag warn">unconfirmed boundary</span>'}
        </div>
        <div class="help mono" style="font-size:11.5px;color:var(--text-faint)">
          ${esc(s.cpu_model)}${s.cpu_threads === null ? '' : ` · ${s.cpu_threads} threads`} ·
          ${esc(s.loader_name)} ${esc(s.loader_version)}
        </div>
        <div class="help">Boundary reason: ${esc(s.reason)}</div>
        <div class="help faint">${esc(span)}</div>
      </div>
      <div class="control" style="gap:3px">
        <div class="n" style="text-align:right;font-family:var(--mono);font-size:17px">${s.captures}<span class="faint" style="font-size:11px"> captures</span></div>
        <div class="faint" style="text-align:right;font-size:11.5px">${s.paths.toLocaleString('en-US')} call paths</div>
        <div class="faint" style="text-align:right;font-size:11.5px">${s.revisions} mod revision${s.revisions === 1 ? '' : 's'}</div>
        <a href="/findings?season=${s.id}"><button class="ghost" style="width:100%;margin-top:6px">Open in Findings</button></a>
        <button class="ghost js-name-season" data-season="${s.id}" data-current="${esc(s.label ?? '')}" style="width:100%;margin-top:4px">${s.label === null ? 'Name this season' : 'Rename'}</button>
      </div>
    </div>`;
    })
    .join('');

  return `
<div class="cards">
  ${card('Seasons', String(seasons.length), 'detected per machine, not per date')}
  ${card('Environments', String(new Set(seasons.map((s) => s.os_name)).size), 'distinct hosts observed')}
  ${card('Captures', String(seasons.reduce((sum, s) => sum + s.captures, 0)), 'across every season')}
</div>

<div class="note" style="margin-top:22px">
  A <strong>season</strong> is one environment: a machine, a Minecraft and loader version, a modpack.
  Boundaries are detected from capture metadata and grouped <strong>per machine before per date</strong>,
  because a test box and production interleave in time — sequencing them as one timeline invents
  rollovers that never happened. Adding or removing a mod is a <em>revision</em> within a season, kept
  as a covariate rather than treated as a new environment.
</div>

${
  overlapping.length > 1
    ? `<div class="note warn">
  ${overlapping.length} seasons have <strong>overlapping capture dates</strong>. That is expected when more
  than one machine is being profiled, and it is exactly why figures are never pooled across seasons:
  the sampler differs too. On Windows, spark falls back to the safepoint-biased ThreadMXBean sampler;
  on Linux it uses async-profiler. Averaging the two would describe neither.
</div>`
    : ''
}

${questionsBlock(db)}

${rows}

${worldsBlock(db)}

<script>
(() => {
  const post = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  for (const el of document.querySelectorAll('.js-answer')) {
    el.addEventListener('click', async () => {
      el.disabled = true;
      const data = await post('/api/boundary/answer', {
        id: Number(el.dataset.question),
        answer: el.dataset.answer,
      });
      if (data.ok) location.reload();
      else { el.disabled = false; alert(data.error || 'failed'); }
    });
  }

  for (const el of document.querySelectorAll('.js-name-world')) {
    el.addEventListener('click', async () => {
      const label = await perfint.ask('What do you call this world? For example: Spring World 2', '');
      if (label === null || label.trim() === '') return;
      const data = await post('/api/world/name', { id: Number(el.dataset.world), label: label.trim() });
      if (data.ok) location.reload();
      else alert(data.error || 'failed');
    });
  }

  for (const el of document.querySelectorAll('.js-name-season')) {
    el.addEventListener('click', async () => {
      const label = await perfint.ask('Name this season. For example: My Pack 2.0 — Spring', el.dataset.current || '');
      if (label === null) return;
      const data = await post('/api/season/name', { id: Number(el.dataset.season), label: label.trim() });
      if (data.ok) location.reload();
      else alert(data.error || 'failed');
    });
  }
})();
</script>
`;
}

interface CaptureDetailRow {
  id: number;
  source_name: string;
  archive_path: string | null;
  sidecar_path: string | null;
  content_sha256: string;
  raw_bytes: number;
  started_at: number | null;
  ended_at: number | null;
  interval_micros: number | null;
  number_of_ticks: number | null;
  divisor_ticks: number | null;
  window_count: number;
  path_count: number;
  sampler_mode: string | null;
  sampler_engine: string | null;
  engine_inferred: string | null;
  mappings_source: string | null;
  tick_ms_per_tick: number | null;
  idle_ms_per_tick: number | null;
  blocked_ms_per_tick: number | null;
  between_tick_ms_per_tick: number | null;
  wall_ms_per_tick: number | null;
  unclassified_ms_per_tick: number | null;
  is_manual: number;
  pinned: number;
  pinned_reason: string | null;
  season_id: number;
  ordinal: number;
  os_name: string;
  mc_version: string;
  loader_name: string;
}

function metric(label: string, value: number | null, note: string): string {
  return `<div class="card">
    <div class="k">${esc(label)}</div>
    <div class="v">${num(value, 2)}<span class="u">MSPT</span></div>
    <div class="n">${esc(note)}</div>
  </div>`;
}

export function capturePage(db: DatabaseSync, params: URLSearchParams): string {
  const id = Number(params.get('id'));
  if (!Number.isFinite(id)) return '<div class="empty">No capture selected.</div>';

  const c = db
    .prepare(
      `SELECT c.*, s.ordinal, e.os_name, e.mc_version, e.loader_name
         FROM capture c
         JOIN season s      ON s.id = c.season_id
         JOIN environment e ON e.id = s.environment_id
        WHERE c.id = ?`,
    )
    .get(id) as unknown as CaptureDetailRow | undefined;

  if (c === undefined) return '<div class="empty">No such capture.</div>';

  const windows = db
    .prepare(
      `SELECT window_id, start_time, ticks, players, entities, tile_entities, chunks,
              tps, mspt_median, mspt_max
         FROM capture_window WHERE capture_id = ? ORDER BY window_id`,
    )
    .all(id) as Array<Record<string, number | null>>;

  const mods = db
    .prepare(
      `SELECT m.mod_id, cm.version FROM capture_mod cm JOIN mod m ON m.id = cm.mod
        WHERE cm.capture_id = ? ORDER BY m.mod_id`,
    )
    .all(id) as Array<{ mod_id: string; version: string }>;

  const engine =
    c.sampler_engine ??
    (c.engine_inferred === 'async'
      ? 'async-profiler (inferred from native frames)'
      : 'not recorded by this spark version');

  const worstWindow = windows.reduce<Record<string, number | null> | undefined>(
    (worst, w) =>
      worst === undefined || (w['mspt_max'] ?? 0) > (worst['mspt_max'] ?? 0) ? w : worst,
    undefined,
  );

  return `
<div class="cards">
  ${metric('Tick', c.tick_ms_per_tick, 'inclusive MinecraftServer.tick — the headline')}
  ${metric('Idle', c.idle_ms_per_tick, 'parked under waitForTasks, deliberate')}
  ${metric('Blocked', c.blocked_ms_per_tick, 'stalled on something else — lost tick time')}
  ${metric('Between ticks', c.between_tick_ms_per_tick, 'work outside the tick loop')}
</div>

<div class="note">
  <strong>${esc(c.source_name)}</strong> · ${esc(c.os_name)} · ${esc(c.loader_name)} ${esc(c.mc_version)} ·
  season ${c.ordinal} · ${c.is_manual === 1 ? 'captured manually' : 'harvested automatically'}
</div>

${
  c.pinned === 1
    ? `<div class="note" style="border-left-color:var(--accent)">
  <strong>Pinned — the raw file is kept indefinitely.</strong> Retention will never delete it, whatever
  its age, because it holds evidence worth being able to re-examine: ${esc(c.pinned_reason ?? 'no reason recorded')}.
</div>`
    : `<div class="note faint">
  Not pinned. The decoded history below is kept forever, but the raw <code>.sparkprofile</code> becomes
  eligible for cleanup once it passes the retention window. Pinning is generous on purpose — keeping an
  unremarkable capture costs a few dozen megabytes, while deleting the one hour that went wrong destroys
  the only copy of the evidence.
</div>`
}

<table>
  <tr><th style="width:220px">Property</th><th>Value</th></tr>
  <tr><td>Started</td><td>${esc(when(c.started_at))}</td></tr>
  <tr><td>Ended</td><td>${esc(when(c.ended_at))}</td></tr>
  <tr><td>Windows</td><td>${c.window_count} × about one minute</td></tr>
  <tr><td>Ticks</td><td>${c.divisor_ticks === null ? '—' : c.divisor_ticks.toLocaleString('en-US')}${
    c.number_of_ticks === null || c.number_of_ticks === c.divisor_ticks
      ? ''
      : ` <span class="faint">(${c.number_of_ticks.toLocaleString('en-US')} reported)</span>`
  }</td></tr>
  <tr><td>Sampling interval</td><td>${c.interval_micros === null ? '—' : `${(c.interval_micros / 1000).toFixed(0)} ms`}</td></tr>
  <tr><td>Sampler engine</td><td>${esc(engine)}</td></tr>
  <tr><td>Sampler mode</td><td>${esc(c.sampler_mode ?? 'not recorded')}</td></tr>
  <tr><td>Mappings</td><td>${esc(c.mappings_source ?? 'none — frames are as captured')}</td></tr>
  <tr><td>Call paths</td><td>${c.path_count.toLocaleString('en-US')}</td></tr>
  <tr><td>Mods loaded</td><td>${mods.length.toLocaleString('en-US')}</td></tr>
  <tr><td>Raw size</td><td>${esc(bytes(c.raw_bytes))}</td></tr>
  <tr><td>Archived at</td><td class="mono" style="font-size:11.5px">${esc(c.archive_path ?? 'not archived')}</td></tr>
  <tr><td>Sidecar</td><td class="mono" style="font-size:11.5px">${esc(c.sidecar_path ?? 'none')}</td></tr>
  <tr><td>sha256</td><td class="mono" style="font-size:11px">${esc(c.content_sha256)}</td></tr>
</table>

<div class="note">
  <strong>Wall time is ${num(c.wall_ms_per_tick, 2)} MSPT</strong>, and it is the most misleading number here:
  it counts the server thread parked under <code>waitForTasks</code>, which is the tick loop waiting on
  purpose. The headline figure is the tick anchor above.
  ${
    c.unclassified_ms_per_tick === null || c.unclassified_ms_per_tick === 0
      ? ''
      : `<br>${num(c.unclassified_ms_per_tick, 2)} MSPT could not be classified as work, idle or blocked — usually
         a park with no recognisable caller. It is reported rather than folded into one of the others.`
  }
</div>

<h2 style="margin-top:26px">Open in spark's viewer</h2>
<div class="note">
  This system does not draw flame graphs, on purpose: spark already has a viewer and it is better than
  anything worth rebuilding here. The archived file is unchanged from what spark wrote, so it opens
  directly.
  <div style="margin-top:8px">
    <a href="https://spark.lucko.me/" target="_blank" rel="noopener"><button class="ghost">Open spark viewer</button></a>
    <span class="faint" style="margin-left:8px">then choose the archived file above.</span>
  </div>
  <div class="faint" style="margin-top:6px">
    The viewer runs in the browser and the file is not uploaded anywhere by this application.
  </div>
</div>

<h2 style="margin-top:26px">Windows</h2>
${
  windows.length === 0
    ? '<div class="empty">No per-window statistics in this capture.</div>'
    : `<table>
  <tr><th>#</th><th>Start</th><th class="n">Ticks</th><th class="n">Players</th><th class="n">TPS</th>
      <th class="n">MSPT median</th><th class="n">MSPT max</th><th class="n">Entities</th><th class="n">Chunks</th></tr>
  ${windows
    .map(
      (w) => `<tr${w === worstWindow ? ' style="background:var(--surface-2)"' : ''}>
      <td class="dim">${w['window_id']}</td>
      <td class="dim">${esc(when(w['start_time']))}</td>
      <td class="n dim">${w['ticks'] ?? '—'}</td>
      <td class="n">${w['players'] ?? '—'}</td>
      <td class="n">${num(w['tps'], 2)}</td>
      <td class="n">${num(w['mspt_median'], 2)}</td>
      <td class="n">${num(w['mspt_max'], 1)}</td>
      <td class="n dim">${w['entities'] ?? '—'}</td>
      <td class="n dim">${w['chunks'] ?? '—'}</td>
    </tr>`,
    )
    .join('')}
</table>
<div class="note faint">The highlighted row is the worst single minute. A median that looks healthy can hide it,
which is why it is shown rather than averaged away.</div>`
}
`;
}

export function seasonOptionsFor(db: DatabaseSync): q.SeasonOption[] {
  return q.seasonOptions(db);
}
