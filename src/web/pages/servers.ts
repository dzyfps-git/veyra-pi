/**
 * Servers: the list of every server, and one server's home.
 *
 * A server's home is the one place to understand it: is it being monitored
 * and how, is its setup healthy, and its whole history -- machine, world,
 * season -- as a single timeline, with its captures underneath. The rest of
 * the app shows one server at a time (chosen in the top bar); this page is
 * where that server is described and controlled.
 */

import { rollupActivitySql } from '../../store/rollups.ts';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { esc, when, ago, num, panel, stat, banner, icon, dotClass } from '../layout.ts';
import { seasonName } from '../../query/queries.ts';
import type { SettingsStore } from '../../settings/store.ts';
import { listServers, type ServerConfig } from '../../store/servers.ts';
import type { ServerLink } from '../../runtime/link.ts';
import { currentState, recentStates, coverage, coverageWords, STATE_WORDS, type MonitorState } from '../../store/health.ts';
import { setupPanel } from './seasons.ts';
import { capturesPage } from './views.ts';

// ---------------------------------------------------------------------------
// Shared facts about a server.
// ---------------------------------------------------------------------------

interface ServerFacts {
  captures: number;
  seasons: number;
  lastCapture: number | null;
  firstCapture: number | null;
  machine: string | null;
  world: string | null;
}

export function serverFacts(db: DatabaseSync, serverId: string): ServerFacts {
  const counts = db
    .prepare(
      `SELECT count(*) AS captures, min(started_at) AS first, max(started_at) AS last,
              (SELECT count(*) FROM season WHERE server_id = ?) AS seasons
         FROM capture WHERE server_id = ?`,
    )
    .get(serverId, serverId) as { captures: number; first: number | null; last: number | null; seasons: number };
  const env = db
    .prepare(
      `SELECT e.os_name, e.cpu_model FROM capture c JOIN season s ON s.id = c.season_id
         JOIN environment e ON e.id = s.environment_id WHERE c.server_id = ? ORDER BY c.started_at DESC LIMIT 1`,
    )
    .get(serverId) as { os_name: string; cpu_model: string | null } | undefined;
  const world = db
    .prepare(`SELECT label, seed, level_name FROM world WHERE server_id = ? ORDER BY last_seen DESC LIMIT 1`)
    .get(serverId) as { label: string | null; seed: string | null; level_name: string | null } | undefined;
  return {
    captures: counts.captures,
    seasons: counts.seasons,
    lastCapture: counts.last,
    firstCapture: counts.first,
    machine: env === undefined ? null : machineName(env.os_name, env.cpu_model),
    world: world === undefined ? null : worldName(world),
  };
}

export function machineName(os: string, cpu: string | null): string {
  const shortCpu = (cpu ?? '')
    .replace(/\(R\)|\(TM\)|CPU|Processor|\d+-Core/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return shortCpu === '' || /unknown/i.test(shortCpu) ? os : `${os} · ${shortCpu}`;
}

export function worldName(w: { label: string | null; seed: string | null; level_name: string | null }): string {
  if (w.label !== null && w.label !== '') return w.label;
  if (w.seed !== null) return `seed ${w.seed.length > 10 ? `${w.seed.slice(0, 6)}…${w.seed.slice(-3)}` : w.seed}`;
  return w.level_name ?? 'unidentified world';
}

const MODE_WORDS: Record<string, { title: string; text: string }> = {
  off: {
    title: 'Off',
    text: 'Nothing is read from or sent to this server. Its history stays and can still be viewed.',
  },
  watch: {
    title: 'Watch folder',
    text: 'Profiles you save in its spark folder are imported once they finish writing. No command is ever sent to the console. Good for staging servers you profile by hand.',
  },
  automatic: {
    title: 'Automatic',
    text: 'spark is asked over SSH and tmux to save what it has collected, at the collection interval; each profile is archived and verified.',
  },
};

export function statusOf(
  db: DatabaseSync,
  server: ServerConfig,
  paused: boolean,
  link: ServerLink | undefined,
): { tone: 'ok' | 'warn' | 'info' | 'bad'; words: string; since?: number; detail?: string } {
  const as = (state: MonitorState): { tone: 'ok' | 'warn' | 'info' | 'bad'; words: string } => ({ ...STATE_WORDS[state] });
  if (server.collection === 'off') return as('off');
  if (paused) return as('paused');
  const recorded = currentState(db, server.id);
  if (recorded !== undefined && !(server.collection === 'automatic' && recorded.state === 'off')) {
    const w = STATE_WORDS[recorded.state];
    return { tone: w.tone, words: w.words, since: recorded.since, detail: recorded.detail };
  }
  if (server.collection === 'watch') return as('watching');
  if (link?.snapshot().state === 'offline') return as('offline');
  // No recorded state yet (a fresh install, or history from before states
  // were kept): judge by the outcome instead of assuming nothing happened.
  const last = db.prepare('SELECT max(started_at) AS t FROM capture WHERE server_id = ?').get(server.id) as { t: number | null };
  if (last.t !== null && Date.now() - last.t < 3 * 3_600_000) return as('collecting');
  return { tone: 'info', words: last.t === null ? 'Waiting for the first harvest' : 'Waiting for the next harvest' };
}

function activity(db: DatabaseSync, serverId: string): string {
  const rows = recentStates(db, serverId, 8);
  if (rows.length === 0) return '';
  return `<details style="margin-top:14px"><summary class="faint" style="font-size:12.5px">Recent activity</summary>
    <table style="margin-top:6px">${rows
      .map(
        (r) => `<tr><td class="faint" style="white-space:nowrap">${esc(when(r.at))}</td>
          <td><span class="dot ${dotClass(STATE_WORDS[r.state]?.tone ?? 'info')}" style="display:inline-block;margin-right:8px"></span>${esc(STATE_WORDS[r.state]?.words ?? r.state)}</td>
          <td class="faint">${esc(r.detail)}</td></tr>`,
      )
      .join('')}</table></details>`;
}

// ---------------------------------------------------------------------------
// All servers.
// ---------------------------------------------------------------------------

export function serversPage(db: DatabaseSync, settings: SettingsStore, links?: Map<string, ServerLink>): string {
  const servers = listServers(db);
  const paused = settings.getBoolean('limits.paused');

  const card = (s: ServerConfig): string => {
    const f = serverFacts(db, s.id);
    const st = statusOf(db, s, paused, links?.get(s.id));
    return `<div class="server-card${s.visible ? '' : ' hidden-server'}">
      <div class="server-card-head">
        <span class="dot ${dotClass(st.tone)}"></span>
        <a class="server-card-name" href="/server?server=${esc(s.id)}">${esc(s.displayName)}</a>
        <span class="tag">${esc(s.kind)}</span>
        ${s.visible ? '' : '<span class="tag">hidden</span>'}
        <label class="toggle" style="margin-left:auto" title="Show this server in the everyday views">
          <span class="toggle-text">Shown</span>
          <input type="checkbox" class="js-visible" data-id="${esc(s.id)}" ${s.visible ? 'checked' : ''}>
        </label>
      </div>
      <div class="server-card-meta">${esc(st.words)}${f.machine === null ? '' : ` · ${esc(f.machine)}`}${
        s.machine === '' ? '' : ` · ${esc(s.machine)}`
      }</div>
      <div class="server-card-stats">
        <div><b>${f.captures}</b> captures</div>
        <div><b>${f.seasons}</b> season${f.seasons === 1 ? '' : 's'}</div>
        <div>${f.lastCapture === null ? 'no captures yet' : `last ${esc(ago(f.lastCapture))}`}</div>
      </div>
      <div class="server-card-foot">
        <span class="mono faint" title="Server folder">${esc(s.root === '' ? 'no folder set' : s.root)}</span>
        <a class="button ghost" href="/server?server=${esc(s.id)}">Open</a>
      </div>
    </div>`;
  };

  return `
<style>
.server-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; margin-bottom: 26px; }
.server-card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 18px; padding: 16px 18px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 10px; }
.server-card.hidden-server { opacity: .72; }
.server-card-head { display: flex; align-items: center; gap: 9px; }
.server-card-name { font: 800 17px var(--display); letter-spacing: -0.02em; color: var(--text-strong); }
.server-card-meta { font-size: 12.5px; color: var(--text-dim); }
.server-card-stats { display: flex; gap: 18px; font-size: 12.5px; color: var(--text-faint); }
.server-card-stats b { color: var(--text); font-variant-numeric: tabular-nums; }
.server-card-foot { display: flex; align-items: center; gap: 10px; justify-content: space-between; border-top: 1px solid var(--border-soft); padding-top: 10px; }
.server-card-foot .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
.form-grid label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--text-dim); }
.form-grid .wide { grid-column: 1 / -1; }
.inline { display: flex; gap: 8px; }
</style>

${
  servers.length === 0
    ? banner('info', 'No servers yet.', 'Add your Minecraft server below to start keeping its history.')
    : `<div class="server-grid">${servers.map(card).join('')}</div>`
}

${panel(
  `${icon('plus', 16)} Add a server`,
  `<div class="form-grid">
    <label class="f">Name<input type="text" id="new-name" placeholder="e.g. Staging"></label>
    <label class="f">Kind<select id="new-kind"><option value="staging">Staging</option><option value="production">Production</option><option value="other">Other</option></select></label>
    <label class="f wide">Server folder
      <span class="inline"><input type="text" id="new-root" placeholder="The folder with server.properties, e.g. D:\\\\Servers\\\\MyPack">
      <button type="button" class="ghost js-browse-new" hidden>${icon('folder', 16)} Browse…</button></span></label>
    <label class="f wide">Where it runs (optional)<input type="text" id="new-machine" placeholder="e.g. This PC, or Ubuntu VM 192.168.1.20"></label>
  </div>
  <div class="faint" style="font-size:12px;margin:10px 0 12px">New servers start with collection <b>off</b>. Choose how to collect on its page: watch its folder for profiles you save, or automatic over SSH.</div>
  <button type="button" id="new-save">Add server</button>`,
  { meta: 'Production, staging, anything with a spark folder' },
)}

<script>
(() => {
  const desktop = window.perfintDesktop;
  for (const el of document.querySelectorAll('.js-visible')) {
    el.addEventListener('change', async () => {
      const data = await perfint.post('/api/servers/update', { id: el.dataset.id, visible: el.checked });
      if (data.ok) location.reload(); else { el.checked = !el.checked; perfint.toast(data.error || 'failed', true); }
    });
  }
  const browse = document.querySelector('.js-browse-new');
  if (desktop && browse) {
    browse.hidden = false;
    browse.addEventListener('click', async () => {
      const chosen = await desktop.pickFolder({ title: 'Choose the Minecraft server folder' });
      if (chosen) document.getElementById('new-root').value = chosen;
    });
  }
  document.getElementById('new-save').addEventListener('click', async () => {
    const body = {
      displayName: document.getElementById('new-name').value.trim(),
      kind: document.getElementById('new-kind').value,
      root: document.getElementById('new-root').value.trim(),
      machine: document.getElementById('new-machine').value.trim(),
    };
    if (!body.displayName) return perfint.toast('Give the server a name.', true);
    const data = await perfint.post('/api/servers/create', body);
    if (data.ok) location.href = '/server?server=' + encodeURIComponent(data.id);
    else perfint.toast(data.error || 'failed', true);
  });
})();
</script>`;
}

// ---------------------------------------------------------------------------
// One server's home.
// ---------------------------------------------------------------------------

interface SeasonRow {
  id: number;
  ordinal: number;
  label: string | null;
  started_at: number;
  reason: string;
  confirmed: number;
  environment_id: number;
  os_name: string;
  cpu_model: string | null;
  cpu_threads: number | null;
  mc_version: string;
  loader_name: string;
  loader_version: string;
  java_major: string;
  world_label: string | null;
  world_seed: string | null;
  world_level: string | null;
  world_id: number | null;
  captures: number;
  first_capture: number | null;
  last_capture: number | null;
  revisions: number;
  paths: number;
}

function timeline(db: DatabaseSync, server: ServerConfig): string {
  const seasons = db
    .prepare(
      `SELECT s.id, s.ordinal, s.label, s.started_at, s.reason, s.confirmed, s.environment_id,
              e.os_name, e.cpu_model, e.cpu_threads, e.mc_version, e.loader_name, e.loader_version, e.java_major,
              w.label AS world_label, w.seed AS world_seed, w.level_name AS world_level, w.id AS world_id,
              (SELECT count(*)        FROM capture c WHERE c.season_id = s.id) AS captures,
              (SELECT min(started_at) FROM capture c WHERE c.season_id = s.id) AS first_capture,
              (SELECT max(started_at) FROM capture c WHERE c.season_id = s.id) AS last_capture,
              (SELECT count(*)        FROM revision r WHERE r.season_id = s.id) AS revisions,
              (SELECT count(*)        FROM path_rollup pr WHERE pr.season_id = s.id${rollupActivitySql(db, 'all').replace('activity', 'pr.activity')}) AS paths
         FROM season s
         JOIN environment e ON e.id = s.environment_id
         LEFT JOIN world w  ON w.id = s.world_id
        WHERE s.server_id = ?
        ORDER BY COALESCE((SELECT max(started_at) FROM capture c WHERE c.season_id = s.id), s.started_at) DESC`,
    )
    .all(server.id) as unknown as SeasonRow[];

  if (seasons.length === 0) {
    return '<div class="empty">No history yet. It starts with the first capture.</div>';
  }

  // Group by machine, newest machine first, keeping season order inside.
  const machines = new Map<number, SeasonRow[]>();
  for (const s of seasons) {
    const list = machines.get(s.environment_id) ?? [];
    list.push(s);
    machines.set(s.environment_id, list);
  }
  const currentSeason = seasons[0]!.id;

  const seasonNode = (s: SeasonRow): string => {
    const world = s.world_id === null ? 'world not recorded (before world tracking)' : worldName({ label: s.world_label, seed: s.world_seed, level_name: s.world_level });
    const span =
      s.first_capture === null
        ? 'no captures yet'
        : `${when(s.first_capture).slice(0, 10)} → ${s.id === currentSeason ? 'now' : when(s.last_capture).slice(0, 10)}`;
    return `<div class="tl-node${s.id === currentSeason ? ' current' : ''}">
      <div class="tl-title">
        ${esc(seasonName(s))}
        ${s.id === currentSeason ? '<span class="tag accent">current</span>' : ''}
        ${s.confirmed === 1 ? '' : '<span class="tag warn">boundary unconfirmed</span>'}
      </div>
      <div class="tl-meta">${esc(span)} · ${esc(world)}</div>
      <div class="tl-card">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span class="tag accent">${esc(s.loader_name)} ${esc(s.loader_version)} · Minecraft ${esc(s.mc_version)}</span>
          <span class="tag">Java ${esc(s.java_major)}</span>
        </div>
        <div class="row"><span><b>${s.captures}</b> captures</span><span><b>${s.revisions}</b> mod change${s.revisions === 1 ? '' : 's'}</span><span><b>${s.paths.toLocaleString('en-US')}</b> call paths</span></div>
        <div class="faint" style="font-size:12px;margin-top:6px">Why a new season started: ${esc(s.reason)}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <a class="button ghost" href="/findings?season=${s.id}">Findings</a>
          <a class="button ghost" href="/findings?season=${s.id}">Findings</a>
          <button class="ghost js-name-season" data-season="${s.id}" data-current="${esc(s.label ?? '')}">${s.label === null ? 'Name season' : 'Rename'}</button>
          ${s.world_id === null ? '' : `<button class="ghost js-name-world" data-world="${s.world_id}" data-current="${esc(s.world_label ?? '')}">${s.world_label === null ? 'Name world' : 'Rename world'}</button>`}
        </div>
      </div>
    </div>`;
  };

  const body = [...machines.values()]
    .map((list) => {
      const first = list[list.length - 1]!;
      const last = list[0]!;
      return `<div class="tl-node machine">
        <div class="tl-title">${icon('server', 16)} ${esc(machineName(first.os_name, first.cpu_model))}${
          first.cpu_threads === null ? '' : ` <span class="faint" style="font-weight:400">· ${first.cpu_threads} threads</span>`
        }</div>
        <div class="tl-meta">Machine · ${esc(when(first.first_capture ?? first.started_at).slice(0, 10))} → ${
          last.id === currentSeason ? 'now' : esc(when(last.last_capture).slice(0, 10))
        } · figures are never compared across machines</div>
        <div class="timeline" style="margin-top:12px">${list.map(seasonNode).join('')}</div>
      </div>`;
    })
    .join('');

  return `<div class="timeline">${body}</div>`;
}

function questions(db: DatabaseSync, serverId: string): string {
  const rows = db
    .prepare(
      `SELECT id, question, detail, options, created_at FROM boundary_question
        WHERE answered_at IS NULL AND server_id = ? ORDER BY created_at`,
    )
    .all(serverId) as Array<{ id: number; question: string; detail: string; options: string; created_at: number }>;
  if (rows.length === 0) return '';
  return rows
    .map((row) => {
      let options: Array<{ id: string; label: string; description: string }> = [];
      try {
        options = JSON.parse(row.options) as typeof options;
      } catch {
        options = [];
      }
      return panel(
        `${esc(row.question)} <span class="tag warn">needs your answer</span>`,
        `<div class="dim">${esc(row.detail)}</div>
         <div class="faint" style="font-size:12px;margin:6px 0 10px">Nothing is split or merged until you answer. Asked ${esc(ago(row.created_at))}.</div>
         <div style="display:flex;gap:8px;flex-wrap:wrap">${options
           .map((o) => `<button class="ghost js-answer" data-question="${row.id}" data-answer="${esc(o.id)}" title="${esc(o.description)}">${esc(o.label)}</button>`)
           .join('')}</div>`,
        { tone: 'warn' },
      );
    })
    .join('');
}

function monitoringPanel(server: ServerConfig): string {
  const modes = (['off', 'watch', 'automatic'] as const)
    .map(
      (m) => `<label><input type="radio" name="mode" value="${m}" ${server.collection === m ? 'checked' : ''}><span>${esc(MODE_WORDS[m]!.title)}</span></label>`,
    )
    .join('');
  const folderOk = server.root !== '' && existsSync(path.join(server.root, 'server.properties'));
  const folderLine =
    server.root === ''
      ? '<span class="faint">No folder set.</span>'
      : folderOk
        ? `<span style="color:var(--ok)">Found</span> a Minecraft server folder.`
        : existsSync(server.root)
          ? '<span style="color:var(--warn)">This folder has no server.properties</span>, so it may not be the server folder.'
          : '<span style="color:var(--bad)">Not found</span> from this computer.';

  return `<div class="segmented" id="mode">${modes}</div>
  <div class="dim" id="mode-help" style="margin:10px 0 16px;max-width:760px">${esc(MODE_WORDS[server.collection]!.text)}</div>

  <div class="form-grid">
    <label class="f">Kind<select data-field="kind">${['production', 'staging', 'other']
      .map((k) => `<option value="${k}" ${server.kind === k ? 'selected' : ''}>${k.charAt(0).toUpperCase() + k.slice(1)}</option>`)
      .join('')}</select></label>
    <label class="f">Where it runs<input type="text" data-field="machine" value="${esc(server.machine)}" placeholder="e.g. Ubuntu VM 192.168.1.20"></label>
    <label class="f wide">Server folder, as seen from this computer
      <span class="inline"><input type="text" data-field="root" value="${esc(server.root)}" placeholder="e.g. S:\\ or D:\\Servers\\MyPack">
      <button type="button" class="ghost js-browse-root" hidden>${icon('folder', 16)} Browse…</button></span>
      <span style="font-size:12px">${folderLine}</span></label>
    <label class="f">spark folder inside it<input type="text" data-field="sparkDir" value="${esc(server.sparkDir)}"></label>
    <div class="wide js-automatic" ${server.collection === 'automatic' ? '' : 'hidden'}>
      <div class="faint" style="font-size:12px;margin:4px 0 8px">Collection reaches the console through this SSH host and tmux session. Only spark profiler commands are sent.</div>
      <div class="form-grid">
        <label class="f">SSH host<input type="text" data-field="sshHost" value="${esc(server.sshHost)}" placeholder="an entry in your SSH config"></label>
        <label class="f">tmux session<input type="text" data-field="tmuxTarget" value="${esc(server.tmuxTarget)}"></label>
        <label class="f">Game address (for "is it up?")<input type="text" data-field="mcHost" value="${esc(server.mcHost)}"></label>
        <label class="f">Game port<input type="number" data-field="mcPort" value="${server.mcPort}"></label>
      </div>
    </div>
  </div>
  <div style="display:flex;gap:10px;align-items:center;margin-top:16px">
    <button type="button" id="server-save">Save</button>
  </div>`;
}

export function serverHomePage(
  db: DatabaseSync,
  settings: SettingsStore,
  server: ServerConfig,
  links?: Map<string, ServerLink>,
): string {
  const f = serverFacts(db, server.id);
  const paused = settings.getBoolean('limits.paused');
  const st = statusOf(db, server, paused, links?.get(server.id));
  const lastIngest = db
    .prepare("SELECT at FROM server_action WHERE server_id = ? AND action = 'ingest' ORDER BY at DESC LIMIT 1")
    .get(server.id) as { at: number } | undefined;
  const capturesToday = (
    db.prepare('SELECT count(*) AS n FROM capture WHERE server_id = ? AND started_at > ?').get(server.id, Date.now() - 86_400_000) as { n: number }
  ).n;

  const statusBanner =
    server.collection === 'off'
      ? banner(
          'info',
          'Collection is off.',
          server.kind === 'production'
            ? 'spark keeps only its last hour of samples, so every hour this stays off is history that will never exist.'
            : 'Its history stays viewable; nothing new is added until you choose a mode below.',
        )
      : paused
        ? banner('warn', 'Monitoring is paused for every server.', 'Resume it from the tray or Settings.')
        : banner(
            st.tone,
            `${esc(st.words)}.`,
            [
              st.since === undefined ? '' : `Since ${esc(ago(st.since))}.`,
              st.detail === undefined || st.detail === '' ? '' : esc(st.detail) + '.',
              lastIngest === undefined ? 'No capture yet.' : `Last capture ${esc(ago(lastIngest.at))}; ${capturesToday} in the last 24 hours.`,
              `<span class="faint">${esc(coverageWords(coverage(db, { serverId: server.id, fromMs: Date.now() - 86_400_000, toMs: Date.now() })))} in the last 24 hours.</span>`,
            ].filter((x) => x !== '').join(' '),
          );

  return `
<style>
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
.form-grid label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--text-dim); }
.form-grid .wide { grid-column: 1 / -1; }
.inline { display: flex; gap: 8px; }
.jump { display: flex; gap: 6px; flex-wrap: wrap; margin: -8px 0 18px; }
.jump a { padding: 5px 13px; border-radius: 999px; background: var(--surface); font-size: 12.5px; font-weight: 600; color: var(--text-dim); transition: background .2s var(--ease), color .2s var(--ease); }
.jump a:hover { color: var(--text); background: var(--surface-2); text-decoration: none; }
section.panel { scroll-margin-top: 20px; }
</style>
<div class="jump"><a href="#monitoring">Monitoring</a><a href="#setup">Setup health</a><a href="#history">History</a><a href="#captures">Captures</a></div>
${statusBanner}
<div class="stats">
  ${stat('Captures', String(f.captures), undefined, f.firstCapture === null ? 'none yet' : `since ${esc(when(f.firstCapture).slice(0, 10))}`)}
  ${stat('Seasons', String(f.seasons), undefined, 'world, machine or modpack changes')}
  ${stat('Current world', `<span class="stat-text">${esc(f.world ?? '—')}</span>`, undefined, 'read from level.dat')}
  ${stat('Machine', `<span class="stat-text">${esc(f.machine ?? '—')}</span>`, undefined, 'from the latest capture')}
</div>
${questions(db, server.id)}
${panel('Monitoring', monitoringPanel(server) + activity(db, server.id), { id: 'monitoring', meta: esc(st.words) })}
${panel('Setup health', setupPanel(db, settings, server), { id: 'setup', meta: 'spark, its config, JVM flags, mappings' })}
${panel('History', timeline(db, server), { id: 'history', meta: 'machine → world → season' })}
${panel('Recent captures', capturesPage(db, server.id, 15), { id: 'captures', meta: '<a href="/history?tab=captures">All captures →</a>' })}

<script>
(() => {
  const desktop = window.perfintDesktop;
  const id = ${JSON.stringify(server.id)};
  const help = ${JSON.stringify(Object.fromEntries(Object.entries(MODE_WORDS).map(([k, v]) => [k, v.text])))};
  const was = ${JSON.stringify(server.collection)};
  const mode = () => document.querySelector('#mode input:checked').value;
  for (const r of document.querySelectorAll('#mode input')) {
    r.addEventListener('change', () => {
      document.getElementById('mode-help').textContent = help[mode()];
      document.querySelector('.js-automatic').hidden = mode() !== 'automatic';
    });
  }
  const browse = document.querySelector('.js-browse-root');
  if (desktop && browse) {
    browse.hidden = false;
    browse.addEventListener('click', async () => {
      const input = document.querySelector('[data-field="root"]');
      const chosen = await desktop.pickFolder({ title: 'Choose the Minecraft server folder', defaultPath: input.value });
      if (chosen) input.value = chosen;
    });
  }
  document.getElementById('server-save').addEventListener('click', async () => {
    const body = { id, collection: mode() };
    for (const el of document.querySelectorAll('[data-field]')) {
      body[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    if (body.collection === 'automatic' && was !== 'automatic') {
      const ok = await perfint.confirm('Turn on automatic collection?',
        'Every hour, spark profiler commands will be sent to this server through SSH and tmux. Only spark commands are ever sent, and never while someone else is profiling.',
        'Turn on');
      if (!ok) return;
    }
    const data = await perfint.post('/api/servers/update', body);
    if (data.ok) { perfint.toast('Saved.'); setTimeout(() => location.reload(), 700); }
    else perfint.toast(data.error || 'Could not save.', true);
  });
  for (const el of document.querySelectorAll('.js-answer')) {
    el.addEventListener('click', async () => {
      const data = await perfint.post('/api/boundary/answer', { id: Number(el.dataset.question), answer: el.dataset.answer });
      if (data.ok) location.reload(); else perfint.toast(data.error || 'failed', true);
    });
  }
  for (const el of document.querySelectorAll('.js-name-world')) {
    el.addEventListener('click', async () => {
      const label = await perfint.ask('What do you call this world?', el.dataset.current || '');
      if (label === null || label.trim() === '') return;
      const data = await perfint.post('/api/world/name', { id: Number(el.dataset.world), label: label.trim() });
      if (data.ok) location.reload(); else perfint.toast(data.error || 'failed', true);
    });
  }
  for (const el of document.querySelectorAll('.js-name-season')) {
    el.addEventListener('click', async () => {
      const label = await perfint.ask('Name this season, e.g. My Pack 2.0 — Spring', el.dataset.current || '');
      if (label === null) return;
      const data = await perfint.post('/api/season/name', { id: Number(el.dataset.season), label: label.trim() });
      if (data.ok) location.reload(); else perfint.toast(data.error || 'failed', true);
    });
  }
})();
</script>`;
}

/** Numbers for the page header's context line. */
export function contextFor(db: DatabaseSync, server: ServerConfig | undefined): Array<{ label: string; value: string; href?: string }> {
  if (server === undefined) return [];
  const f = serverFacts(db, server.id);
  const out: Array<{ label: string; value: string; href?: string }> = [
    { label: 'Server', value: server.displayName, href: '/server' },
  ];
  if (f.machine !== null) out.push({ label: 'Machine', value: f.machine });
  if (f.world !== null) out.push({ label: 'World', value: f.world });
  void num;
  return out;
}
