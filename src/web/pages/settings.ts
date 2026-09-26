/**
 * Settings page.
 *
 * Rendered from the registry, so adding a setting never means editing this
 * file. The page's job is to make four things obvious:
 *
 *   1. what a setting does, in plain language -- one line, with the rest a
 *      click away rather than a wall of text;
 *   2. when a change takes effect, but only when that is not "immediately";
 *   3. which changes can reach the live Minecraft server; and
 *   4. where things actually are. A path is shown resolved, checked, and
 *      pickable with a real folder dialog -- "data/archive" told nobody
 *      anything.
 *
 * Settings nothing acts on yet are not shown as controls. They are listed at
 * the bottom as planned, with what happens today instead.
 *
 * Safe settings save on change. Risky ones are parked and require explicit
 * approval, and the page shows them as pending rather than pretending they
 * were applied.
 */

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { esc, bytes, when } from '../layout.ts';
import { SETTINGS, type SettingDef, type RiskTier, type SettingGroup } from '../../settings/registry.ts';
import type { SettingsStore, SettingValue } from '../../settings/store.ts';
import type { Store } from '../../store/db.ts';
import { storageSummary } from '../../store/storage.ts';
import { lastCleanup } from '../../store/retention.ts';
import { lastServerCleanup } from '../../runtime/servercleanup.ts';
import { listServers } from '../../store/servers.ts';

const RISK_LABEL: Record<RiskTier, string> = {
  safe: '',
  'restart-collector': 'restarts monitoring',
  'needs-mc-restart': 'needs Minecraft restart',
  disruptive: 'touches the server',
};

const RISK_CLASS: Record<RiskTier, string> = {
  safe: '',
  'restart-collector': 'tag accent',
  'needs-mc-restart': 'tag warn',
  disruptive: 'tag bad',
};

/** Display order, with a sentence saying what each section is for. */
const SECTIONS: ReadonlyArray<{ group: SettingGroup; title: string; intro: string }> = [
  { group: 'Collection', title: 'Collection', intro: 'Whether and how often profiles are taken from the server.' },
  { group: 'Server', title: 'Server', intro: 'Where the server is, and how to reach its console.' },
  {
    group: 'Setup checks',
    title: 'Setup checks',
    intro: 'Watching for a modpack update breaking monitoring, and what may be fixed without asking.',
  },
  { group: 'Storage', title: 'Storage', intro: 'Where history is kept on this computer.' },
  { group: 'Retention', title: 'Retention', intro: 'How long things are kept.' },
  { group: 'Cleanup', title: 'Cleanup', intro: 'Removing harvested profiles from the server.' },
  { group: 'Notifications', title: 'Notifications', intro: 'What is posted to Discord.' },
  { group: 'Analysis', title: 'Analysis', intro: 'Thresholds used when judging tick time and changes.' },
  { group: 'Limits', title: 'Limits', intro: 'Limits on this app itself.' },
  { group: 'App', title: 'App', intro: 'The window, the tray and starting with Windows.' },
];

/** The registry writes "--" for a dash; show a real one. */
function prose(text: string): string {
  return esc(text.replaceAll(' -- ', ' — '));
}

/** First sentence visible, the rest behind "More". */
function helpText(text: string): string {
  const cut = text.search(/(?<=[.!?])\s+(?=[A-Z"(])/);
  if (cut === -1 || cut > 220) {
    return cut === -1 || text.length < 240
      ? `<div class="help">${prose(text)}</div>`
      : `<details class="help more"><summary>${prose(text.slice(0, 200).replace(/\s+\S*$/, ''))}… <span>More</span></summary>${prose(text)}</details>`;
  }
  const first = text.slice(0, cut);
  const rest = text.slice(cut).trim();
  return `<details class="help more"><summary>${prose(first)} <span>More</span></summary>${prose(rest)}</details>`;
}

function optionLabel(option: string): string {
  return option.charAt(0).toUpperCase() + option.slice(1);
}

/**
 * What a path setting currently points at, checked. Server side, because the
 * collector is what will read it.
 */
function pathStatus(def: SettingDef, value: string): string {
  if (value.trim() === '') {
    return def.key === 'server.mappingsFile'
      ? '<span class="faint">Not set. Filled in automatically when the setup check finds mappings for this Minecraft version.</span>'
      : '<span class="faint">Not set.</span>';
  }
  const full = path.resolve(value);
  if (!existsSync(full)) return `<span style="color:var(--bad)">Not found:</span> <span class="mono">${esc(full)}</span>`;
  try {
    const stats = statSync(full);
    return stats.isDirectory()
      ? `<span style="color:var(--ok)">Folder found</span> <span class="mono">${esc(full)}</span>`
      : `<span style="color:var(--ok)">Found</span>, ${esc(bytes(stats.size))} <span class="mono">${esc(full)}</span>`;
  } catch {
    return `<span class="mono">${esc(full)}</span>`;
  }
}

const PICK: Record<string, { kind: 'folder' | 'file'; title: string; filters?: string }> = {
  'server.mappingsFile': {
    kind: 'file',
    title: 'Choose a Yarn mappings file',
    filters: JSON.stringify([{ name: 'Tiny mappings', extensions: ['gz', 'tiny'] }, { name: 'All files', extensions: ['*'] }]),
  },
};

function control(def: SettingDef, value: SettingValue): string {
  const id = `s_${def.key.replaceAll('.', '_')}`;
  // `data-server-value` is the authoritative applied value. Browsers restore
  // form state across a reload, which would otherwise show a parked change as
  // if it had been applied -- directly contradicting the notice beside it.
  // A small script resets every control to this on load.
  const common =
    `id="${id}" name="${esc(def.key)}" data-key="${esc(def.key)}" data-risk="${def.risk}" ` +
    `data-label="${esc(def.label)}" data-warning="${esc(def.warning ?? '')}" ` +
    `data-server-value="${esc(String(value))}" autocomplete="off"`;

  switch (def.type) {
    case 'boolean':
      return (
        `<label class="toggle" style="justify-content:flex-end"><span class="toggle-text">${value === true ? 'On' : 'Off'}</span>` +
        `<input type="checkbox" ${common} ${value === true ? 'checked' : ''}></label>`
      );
    case 'enum':
      return (
        `<select ${common}>` +
        (def.options ?? [])
          .map(
            (option) =>
              `<option value="${esc(option)}" ${option === value ? 'selected' : ''}>${esc(def.optionLabels?.[option] ?? optionLabel(option))}</option>`,
          )
          .join('') +
        `</select>`
      );
    case 'integer':
    case 'number':
      return (
        `<div class="numrow"><input type="number" ${common} value="${esc(value)}"` +
        (def.min === undefined ? '' : ` min="${def.min}"`) +
        (def.max === undefined ? '' : ` max="${def.max}"`) +
        (def.step === undefined ? '' : ` step="${def.step}"`) +
        `>` +
        (def.unit === undefined ? '' : `<span class="unit">${esc(def.unit)}</span>`) +
        `</div>`
      );
    case 'secret':
      return `<input type="password" ${common} value="${value === '' ? '' : '••••••••••••'}" placeholder="not set" autocomplete="off">`;
    case 'path': {
      const pick = PICK[def.key];
      return (
        `<input type="text" ${common} value="${esc(value)}" placeholder="${pick?.kind === 'file' ? 'No file chosen' : 'No folder chosen'}">` +
        (pick === undefined
          ? ''
          : `<button type="button" class="ghost js-browse" hidden data-target="${id}" data-kind="${pick.kind}"
               data-title="${esc(pick.title)}"${pick.filters === undefined ? '' : ` data-filters="${esc(pick.filters)}"`}>Browse…</button>`)
      );
    }
    default:
      return `<input type="text" ${common} value="${esc(value)}">`;
  }
}

function renderSetting(def: SettingDef, value: SettingValue, pending: SettingValue | undefined): string {
  const risky = def.risk !== 'safe';
  const badge =
    def.risk === 'safe' ? '' : `<span class="${RISK_CLASS[def.risk]}">${esc(RISK_LABEL[def.risk])}</span>`;

  const pendingRow =
    pending === undefined
      ? ''
      : `<div class="note warn pending" style="margin:10px 0 0">
           <strong>Waiting for your approval:</strong> change to <code>${esc(String(pending))}</code>.
           This has <strong>not</strong> been applied.
           <div style="margin-top:9px;display:flex;gap:8px">
             <button type="button" class="approve" data-pending-key="${esc(def.key)}">Approve and apply</button>
             <button type="button" class="ghost discard" data-pending-key="${esc(def.key)}">Discard</button>
           </div>
         </div>`;

  const warning =
    def.warning === undefined
      ? ''
      : `<div class="note ${def.risk === 'disruptive' ? 'bad' : 'warn'}" style="margin:10px 0 0">${prose(def.warning)}</div>`;

  // Only worth a line when it needs a restart; "next cycle" and the like go without saying.
  const applies = /restart|app start|collector start|login/i.test(def.appliesAt) ? `<div class="applies">Takes effect: ${esc(def.appliesAt)}</div>` : '';
  const isPath = def.type === 'path';

  return `<div class="setting ${risky ? 'risky' : ''} ${isPath ? 'wide' : ''}">
  <div>
    <div class="label">${esc(def.label)} ${badge}</div>
    ${helpText(def.help)}
    ${applies}
    ${warning}
    ${pendingRow}
    ${isPath ? `<div class="control pathrow">${control(def, value)}</div><div class="pathstatus">${pathStatus(def, String(value))}</div>` : ''}
  </div>
  ${isPath ? '' : `<div class="control">${control(def, value)}</div>`}
</div>`;
}

/** Real locations, sizes and free space, with Open and Move. */
function storagePanel(store: Store, settings: SettingsStore): string {
  const s = storageSummary(store, settings);
  const free = (value: number | undefined): string => (value === undefined ? 'unknown' : bytes(value));
  const drive = (p: string): string => path.parse(p).root.replace(/\\$/, '');
  const low = s.freeBytesAtArchive !== undefined && s.freeBytesAtArchive < s.minFreeBytes;

  const row = (title: string, where: string, detail: string, actions: string): string => `
    <div class="storage-row">
      <div>
        <div class="label">${esc(title)}</div>
        <div class="mono where">${esc(where)}</div>
        <div class="help">${detail}</div>
      </div>
      <div class="storage-actions">${actions}</div>
    </div>`;

  const open = (p: string): string =>
    `<button type="button" class="ghost js-open" data-path="${esc(p)}">Open folder</button>` +
    `<button type="button" class="ghost js-copy" data-path="${esc(p)}">Copy path</button>`;

  return `<div class="storage-panel">
  ${row(
    'Data folder',
    s.dataDir,
    `The database (${esc(bytes(s.databaseBytes))}), logs, and safety backups (${esc(bytes(s.backups.bytes))}). ` +
      'Set by the desktop app, so it is shown here but cannot be moved here.',
    open(s.dataDir),
  )}
  ${row(
    'Archive folder',
    s.archive.path,
    `${s.rawProfiles.files} raw profile${s.rawProfiles.files === 1 ? '' : 's'} (${esc(bytes(s.rawProfiles.bytes))}) and ` +
      `${s.sidecars.files} per-capture detail file${s.sidecars.files === 1 ? '' : 's'} (${esc(bytes(s.sidecars.bytes))}). ` +
      (s.archiveIsDefault ? 'This is the default place, inside the data folder. ' : '') +
      'This is the part that grows; it can live on any drive.',
    open(s.archive.path) + `<button type="button" class="js-move-archive" data-current="${esc(s.archive.path)}">Move…</button>`,
  )}
  ${row(
    'Free space',
    `${free(s.freeBytesAtArchive)} free on ${drive(s.archive.path)}` +
      (drive(s.archive.path) === drive(s.dataDir) ? '' : ` · ${free(s.freeBytesAtData)} free on ${drive(s.dataDir)}`),
    low
      ? `<span style="color:var(--bad)">Below the ${esc(bytes(s.minFreeBytes))} floor: collection is paused until there is room.</span>`
      : `Collection pauses below ${esc(bytes(s.minFreeBytes))} free (set below), so it never fills the disk.`,
    '',
  )}
  ${(() => {
    const last = lastCleanup(store);
    return row(
      'Cleanup',
      last === undefined ? 'Not run yet' : `Last run ${esc(when(last.at))}`,
      last === undefined
        ? `Raw files older than ${settings.getNumber('retention.rawDays')} days` +
          (settings.getNumber('retention.sidecarDays') > 0 ? `, and per-minute detail older than ${settings.getNumber('retention.sidecarDays')} days,` : '') +
          ' are removed when the app starts and once a day (Retention, below).'
        : `Removed ${last.removed} raw file${last.removed === 1 ? '' : 's'} older than ${last.days} days (${esc(bytes(last.bytes))})` +
          ((last.detailRemoved ?? 0) > 0
            ? ` and per-minute detail for ${last.detailRemoved} older than ${last.detailDays} days (${esc(bytes(last.detailBytes ?? 0))})`
            : '') +
          `. Kept ${last.keptPinned} pinned, ${last.keptManual} of your own` +
          (last.keptForGoingBack > 0 ? `, and ${last.keptForGoingBack} needed for going back to the previous version` : '') +
          '. The daily history measured from removed files stays.',
      '',
    );
  })()}
</div>`;
}

/** Settings → Cleanup: what the last server cleanup did, per server. */
function serverCleanupPanel(store: Store, settings: SettingsStore): string {
  const servers = listServers(store.db).filter((s) => s.collection === 'automatic');
  if (servers.length === 0) return '';
  const enabled = settings.getBoolean('cleanup.server.enabled');
  return `<div class="storage-panel">${servers
    .map((server) => {
      const last = lastServerCleanup(store, server.id);
      const detail =
        last === undefined
          ? enabled
            ? 'Runs when the app starts and once a day.'
            : 'Off. Nothing on the server is deleted.'
          : `${last.dryRun ? 'Dry run: would have removed' : 'Removed'} ${last.removed.length} profile${last.removed.length === 1 ? '' : 's'} ` +
            `(${esc(bytes(last.bytes))}). Kept ${last.keptRecent} newer than the safety buffer, ${last.keptNotOurs} not harvested by this app` +
            (last.keptNotArchived > 0 ? `, ${last.keptNotArchived} not in the archive` : '') +
            (last.failed.length > 0 ? `, and ${last.failed.length} that failed a last check` : '') +
            '. Every decision is in the audit log.';
      return `<div class="storage-row"><div><div class="label">${esc(server.displayName)}</div>
        <div class="mono where">${esc(last === undefined ? 'Not run yet' : `Last run ${when(last.at)}`)}</div>
        <div class="help">${detail}</div></div><div class="storage-actions"></div></div>`;
    })
    .join('')}</div>`;
}

export function settingsPage(settings: SettingsStore, advanced: boolean, store?: Store, productName?: string): string {
  const all = settings.all();
  const active = all.filter((row) => row.def.planned === undefined && row.def.key !== 'storage.archiveDir');
  const rows = active.filter((row) => row.def.advanced === advanced);
  const planned = all.filter((row) => row.def.planned !== undefined);

  const sections = SECTIONS.map((section) => {
    const inGroup = rows.filter((r) => r.def.group === section.group);
    const panel =
      advanced || store === undefined
        ? ''
        : section.group === 'Storage'
          ? storagePanel(store, settings)
          : section.group === 'Cleanup'
            ? serverCleanupPanel(store, settings)
            : '';
    if (inGroup.length === 0 && panel === '') return '';
    return `<section class="group" id="${esc(section.group.toLowerCase().replace(/\s+/g, '-'))}">
  <h3>${esc(section.title)}</h3>
  <div class="group-intro">${esc(section.intro)}</div>
  ${panel}
  ${inGroup.map((r) => renderSetting(r.def, r.value, r.pending)).join('')}
</section>`;
  }).join('');

  const jump = SECTIONS.filter((section) =>
    rows.some((r) => r.def.group === section.group) || (section.group === 'Storage' && !advanced),
  )
    .map((section) => `<a href="#${esc(section.group.toLowerCase().replace(/\s+/g, '-'))}">${esc(section.title)}</a>`)
    .join('');

  const pending = settings.pendingCount();
  const pendingBanner =
    pending === 0
      ? ''
      : `<div class="note warn"><strong>${pending} change${pending === 1 ? '' : 's'} waiting for your approval.</strong>
         These reach the live server or need a Minecraft restart, so they are not applied until you say so.</div>`;

  const plannedList =
    planned.length === 0
      ? ''
      : `<details class="planned">
  <summary>Planned, not active yet (${planned.length})</summary>
  <div class="help" style="margin:8px 0 12px">These are designed but nothing acts on them yet, so they are listed rather than
  shown as switches that would do nothing. Each says what happens today.</div>
  ${planned
    .map(
      (r) => `<div class="planned-row"><div class="label">${esc(r.def.label)}</div>
      <div class="help">${prose(r.def.planned ?? '')}</div></div>`,
    )
    .join('')}
</details>`;

  return `
<style>
.settings-jump { display:flex; gap:6px; flex-wrap:wrap; margin: 0 0 18px; }
.settings-jump a { padding: 5px 13px; border-radius: 999px; background: var(--surface); font-size: 12.5px; font-weight: 600; color: var(--text-dim); transition: background .2s var(--ease), color .2s var(--ease); }
.settings-jump a:hover { color:var(--text); text-decoration:none; background:var(--surface-2); }
.group-intro { color: var(--text-faint); font-size: 12.5px; margin: -4px 0 12px; }
.group { scroll-margin-top: 16px; }
details.more summary { cursor: pointer; list-style: none; }
details.more summary::-webkit-details-marker { display: none; }
details.more summary span { color: var(--accent); font-size: 12px; margin-left: 4px; }
details.more[open] summary span { display: none; }
details.more[open] summary { margin-bottom: 4px; }
.setting.wide { grid-template-columns: 1fr; }
.pathrow { flex-direction: row !important; gap: 8px; margin-top: 10px; }
.pathrow input { flex: 1; font-family: var(--mono); font-size: 12.5px; }
.pathstatus { font-size: 12px; margin-top: 6px; color: var(--text-dim); word-break: break-all; }
.switch { display:flex; align-items:center; gap:8px; justify-content:flex-end; cursor:pointer; }
.switch-text { color: var(--text-dim); font-size: 12.5px; min-width: 22px; }
.numrow { display:flex; align-items:center; gap:8px; }
.numrow .unit { color: var(--text-faint); font-size: 12px; white-space: nowrap; }
.storage-panel { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; }
.storage-row { display:grid; grid-template-columns: 1fr auto; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--border-soft); align-items: start; }
.storage-row:last-child { border-bottom: none; }
.storage-row .where { font-size: 12.5px; color: var(--text); margin-top: 4px; word-break: break-all; }
.storage-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.storage-actions button { padding: 6px 12px; }
details.planned { margin-top: 26px; padding: 12px 16px; border: 1px dashed var(--border); border-radius: var(--radius); }
details.planned summary { cursor: pointer; color: var(--text-dim); font-size: 13px; }
.planned-row { padding: 8px 0; border-top: 1px solid var(--border-soft); }
.planned-row .label { font-size: 13px; color: var(--text-dim); }
@media (max-width: 900px) { .storage-row { grid-template-columns: 1fr; } .storage-actions { justify-content: flex-start; } }
</style>
<div class="tabs">
  <a href="/settings" class="${advanced ? '' : 'active'}">Everyday</a>
  <a href="/settings?advanced=1" class="${advanced ? 'active' : ''}">Advanced</a>
</div>
${pendingBanner}
<div class="settings-jump">${jump}</div>
<div class="note faint" style="margin-top:0">
  Server connections and collection are set per server, on <a href="/servers">All servers</a>.
</div>
<form id="settings-form" autocomplete="off">
${sections}
</form>
${advanced ? '' : plannedList}
<div id="storage-status" class="note" style="display:none"></div>

<script>
(() => {
  const form = document.getElementById('settings-form');
  const desktop = window.perfintDesktop;

  // Undo browser form restoration: the server-rendered value is the truth.
  for (const el of form.querySelectorAll('[data-server-value]')) {
    const truth = el.dataset.serverValue;
    if (el.type === 'checkbox') el.checked = truth === 'true';
    else if (el.type !== 'password') el.value = truth;
  }

  const read = (el) => {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return el.value === '' ? '' : Number(el.value);
    return el.value;
  };
  const revert = (el) => {
    const truth = el.dataset.serverValue;
    if (el.type === 'checkbox') el.checked = truth === 'true'; else if (el.type !== 'password') el.value = truth;
    syncToggleText(el);
  };
  const syncToggleText = (el) => {
    if (el.type !== 'checkbox') return;
    const text = el.parentElement.querySelector('.toggle-text');
    if (text) text.textContent = el.checked ? 'On' : 'Off';
  };
  const RISK_TEXT = {
    disruptive: 'This reaches the live Minecraft server.',
    'needs-mc-restart': 'This takes effect only after Minecraft restarts. Nothing is restarted for you.',
    'restart-collector': 'Monitoring restarts briefly to apply this.',
  };

  // One step: change it, and it is saved. Only what reaches the server asks.
  async function commit(el) {
    const key = el.dataset.key;
    const value = read(el);
    if (String(value) === el.dataset.serverValue) return;
    const risky = el.dataset.risk !== 'safe';
    let approve = false;
    if (risky) {
      const ok = await perfint.confirm(
        el.dataset.label,
        (el.dataset.warning || '') + ' ' + (RISK_TEXT[el.dataset.risk] || ''),
        'Apply',
      );
      if (!ok) { revert(el); return; }
      approve = true;
    }
    const result = await perfint.post('/api/settings', { [key]: value, ...(approve ? { _approve: true } : {}) });
    const bad = (result.rejected || []).find((r) => r.key === key);
    if (bad) { revert(el); perfint.toast(el.dataset.label + ': ' + bad.error, true); return; }
    el.dataset.serverValue = String(value);
    perfint.toast('Saved: ' + el.dataset.label);
    if (key === 'interface.theme') {
      document.documentElement.dataset.focus = value;
      window.perfintRedrawField?.();
      window.perfintDesktop?.setTheme?.(value);
    }
    if (el.closest('.pathrow')) setTimeout(() => location.reload(), 600);
  }

  form.addEventListener('change', (event) => {
    const el = event.target;
    if (!el.dataset || !el.dataset.key) return;
    syncToggleText(el);
    void commit(el);
  });
  // Text is saved when you leave the field or press Enter, not on every keystroke.
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.dataset && event.target.dataset.key) {
      event.preventDefault();
      event.target.blur();
    }
  });
  form.addEventListener('submit', (event) => event.preventDefault());

  document.querySelectorAll('button.approve').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!(await perfint.confirm('Apply this change?', 'It can reach the live server.', 'Apply'))) return;
      await perfint.post('/api/settings/approve', { key: btn.dataset.pendingKey });
      location.reload();
    });
  });
  document.querySelectorAll('button.discard').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await perfint.post('/api/settings/discard', { key: btn.dataset.pendingKey });
      location.reload();
    });
  });

  // --- paths: Browse, Open, Copy, Move --------------------------------------
  const storageStatus = document.getElementById('storage-status');
  const say = (text, bad) => {
    storageStatus.textContent = text;
    storageStatus.className = 'note' + (bad ? ' bad' : '');
    storageStatus.style.display = 'block';
    storageStatus.scrollIntoView({ block: 'nearest' });
  };

  for (const btn of document.querySelectorAll('.js-browse')) {
    if (!desktop) continue; // In a plain browser, paths are typed.
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      const input = document.getElementById(btn.dataset.target);
      const options = { title: btn.dataset.title, defaultPath: input.value };
      if (btn.dataset.filters) options.filters = JSON.parse(btn.dataset.filters);
      const chosen = btn.dataset.kind === 'folder' ? await desktop.pickFolder(options) : await desktop.pickFile(options);
      if (!chosen) return;
      input.value = chosen;
      void commit(input);
    });
  }

  for (const btn of document.querySelectorAll('.js-open')) {
    if (!desktop) { btn.hidden = true; continue; }
    btn.addEventListener('click', () => desktop.openFolder(btn.dataset.path));
  }
  for (const btn of document.querySelectorAll('.js-copy')) {
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(btn.dataset.path); btn.textContent = 'Copied'; }
      catch { await perfint.ask('Copy this path:', btn.dataset.path, 'Done'); }
      setTimeout(() => { btn.textContent = 'Copy path'; }, 1500);
    });
  }

  document.querySelector('.js-move-archive')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const target = desktop
      ? await desktop.pickFolder({ title: 'Choose an empty folder for the archive', defaultPath: btn.dataset.current })
      : await perfint.ask('Full path of an empty folder for the archive (created if it does not exist):', '');
    if (!target) return;
    if (!(await perfint.confirm('Move the archive?', 'To ' + target + '. Every file is copied and checked before anything is removed from the old place. This can take a while for a large archive.', 'Move'))) return;
    btn.disabled = true;
    say('Moving… every file is being copied and checked.');
    const data = await perfint.post('/api/storage/move-archive', { to: target });
    if (data.ok) {
      say('Moved ' + data.moved + ' files to ' + data.to + '.' + (data.leftBehind && data.leftBehind.length ? ' ' + data.leftBehind.length + ' old files could not be removed and are listed in the log.' : ''));
      setTimeout(() => location.reload(), 2200);
    } else {
      btn.disabled = false;
      say(data.error || 'The move failed; nothing was changed.', true);
    }
  });
})();
</script>`;
}
