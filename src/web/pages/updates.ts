/**
 * Updates: the running version and what is new in it, a newer version when
 * one is waiting, where new versions are looked for, and going back.
 *
 * Reached from the version at the foot of the rail (and the Install button
 * in the top bar when one is ready). This is the only place for any of it.
 *
 * Installing and going back need the desktop app (it runs the installer);
 * in a plain browser the page says so instead of offering buttons that
 * cannot work.
 */

import { esc, bytes, when, panel, icon } from '../layout.ts';
import type { SettingsStore } from '../../settings/store.ts';
import type { Store } from '../../store/db.ts';
import { APP_VERSION, CHANGELOG, compareVersions, notesFor, type Release } from '../../core/changelog.ts';
import { findInstallers, history, rollbackPlan, updateFolders } from '../../runtime/updates.ts';

/** Release notes; the version heading is left out where the panel title already says it. */
function notesList(releases: readonly Release[], options: { heads?: boolean } = {}): string {
  return releases
    .map(
      (r) => `<div class="release">${
        options.heads === false ? '' : `<div class="release-head"><b>${esc(r.version)}</b> <span class="faint">${esc(r.date)}</span></div>`
      }
      <ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`,
    )
    .join('');
}

export function updatesPage(store: Store, settings: SettingsStore, productName: string): string {
  const folders = updateFolders(store, settings);
  const chosen = settings.getString('updates.folder').trim();
  const newer = findInstallers(folders, productName).filter((i) => compareVersions(i.version, APP_VERSION) > 0);
  const next = newer[0];
  const plan = rollbackPlan(store, productName);
  const past = history(store).slice().reverse();
  const changedFrom = store.getMeta('app.changedFrom');
  const justUpdated = changedFrom !== undefined && changedFrom !== '' && store.getMeta('app.whatsNewSeen') !== '1';
  // Seeing this page is seeing what is new.
  if (justUpdated) store.setMeta('app.whatsNewSeen', '1');
  const current = notesFor(APP_VERSION);

  const repo = settings.getString('updates.githubRepo').trim();
  const available =
    next === undefined
      ? `<div class="upd-state"><div>
          <div class="upd-title">You have the newest version</div>
          <div class="help">${
            repo === ''
              ? `Looked in <span class="mono">${esc(folders[0]!)}</span>.`
              : 'New versions download from GitHub by themselves (checked every 6 hours) and appear here ready to install.'
          }</div>
        </div>
        <div class="upd-actions">
          <button type="button" class="ghost js-check">Check for updates</button>
        </div></div>`
      : `<div class="upd-state upd-ready"><div>
          <div class="upd-title">${esc(next.version)} is ready to install</div>
          ${
            next.manifest === undefined || next.manifest.notes.length === 0
              ? '<div class="help">What is new appears here once it is installed.</div>'
              : `<div class="upd-notes">${notesList(next.manifest.notes.filter((r) => compareVersions(r.version, APP_VERSION) > 0), { heads: next.manifest.notes.filter((r) => compareVersions(r.version, APP_VERSION) > 0).length > 1 })}</div>`
          }
          <div class="help" style="margin-top:10px">Takes about a minute: the database is backed up, monitoring pauses briefly, and the app reopens on the new version. Minecraft is not touched.</div>
          <details class="upd-file"><summary>Installer details</summary>
            <div class="mono">${esc(next.file)} · ${esc(bytes(next.size))}${next.manifest === undefined ? ' · no checksum file, so it cannot be verified' : ' · checksum verified before installing'}</div>
          </details>
        </div>
        <div class="upd-actions">
          <button type="button" class="js-install" data-version="${esc(next.version)}" hidden>Install ${esc(next.version)}</button>
          <span class="faint js-browser-only" style="font-size:12px">Open the desktop app to install.</span>
        </div></div>`;

  const source = `<div class="upd-row">
    <div class="upd-label">Look for new versions in</div>
    <div class="upd-value">
      <div class="mono">${esc(folders[0]!)}${chosen === '' ? ' <span class="faint">(your Downloads folder, the default)</span>' : ''}</div>
      <div class="help">Choosing an installer with <b>Install from file…</b> sets this to that installer's folder.</div>
    </div>
    <div class="upd-actions">
      <button type="button" class="ghost js-from-file" hidden>${icon('folder', 16)} Install from file…</button>
      ${chosen === '' ? '' : '<button type="button" class="ghost js-reset-folder">Use Downloads</button>'}
    </div>
  </div>`;

  const back = plan.possible
    ? `<div class="upd-row">
      <div class="upd-label">Go back to ${esc(plan.record!.from)}</div>
      <div class="upd-value help">If something is wrong with ${esc(APP_VERSION)}: the database is restored from the backup taken
      just before the update (${esc(when(plan.record!.at))}), your current settings and servers are kept, and
      ${
        plan.capturesSince === 0
          ? 'there are no captures since then to bring back'
          : `the ${plan.capturesSince} capture${plan.capturesSince === 1 ? '' : 's'} recorded since then ${plan.capturesSince === 1 ? 'is' : 'are'} imported again from the archive`
      }.</div>
      <div class="upd-actions"><button type="button" class="ghost js-rollback" data-version="${esc(plan.record!.from)}" hidden>Go back to ${esc(plan.record!.from)}</button></div>
    </div>`
    : `<div class="upd-row"><div class="upd-label">Going back</div><div class="upd-value help">${esc(plan.reason ?? '')}
       Every update installed from this page makes going back possible.</div><div class="upd-actions"></div></div>`;

  return `<style>
.upd-state { display: flex; gap: 20px; justify-content: space-between; align-items: flex-start; }
.upd-title { font: 800 18px var(--display); letter-spacing: -0.02em; color: var(--text-strong); margin-bottom: 4px; }
.upd-ready .upd-title { color: var(--accent); }
.upd-notes { margin-top: 8px; }
.upd-file { margin-top: 10px; }
.upd-file summary { font-size: 12px; color: var(--text-faint); }
.upd-file .mono { font-size: 11.5px; color: var(--text-faint); margin-top: 4px; overflow-wrap: anywhere; }
.upd-row { display: grid; grid-template-columns: 200px 1fr auto; gap: 16px; align-items: start; padding: 12px 0; border-bottom: 1px solid var(--border-soft); }
.upd-row:last-child { border-bottom: none; }
.upd-label { font-weight: 600; }
.upd-actions { flex: none; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.release { margin-top: 8px; }
.release ul { margin: 4px 0 0; padding-left: 18px; color: var(--text-dim); }
.release li { margin: 2px 0; }
.release-head { font-size: 12.5px; }
.history details { border-bottom: 1px solid var(--border-soft); padding: 8px 0; }
.history details:last-child { border-bottom: none; }
.history summary { cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
.history summary b { font-family: var(--mono); }
.history summary .first { color: var(--text-dim); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.history ul { margin: 6px 0 2px; padding-left: 18px; color: var(--text-dim); }
.history li { margin: 3px 0; }
@media (max-width: 800px) { .upd-row { grid-template-columns: 1fr; } .upd-state { flex-direction: column; } }
</style>
${panel(next === undefined ? 'Up to date' : 'Update available', available, { meta: `You are on ${esc(APP_VERSION)}` })}
${panel(
  `What is new in ${esc(APP_VERSION)}`,
  (justUpdated ? `<div class="tag ok" style="margin-bottom:6px">Updated from ${esc(changedFrom)}</div>` : '') +
    (current === undefined ? '<div class="help">No notes for this version.</div>' : notesList([current], { heads: false })),
)}
${panel(
  'Earlier versions',
  `<div class="history">${CHANGELOG.filter((r) => compareVersions(r.version, APP_VERSION) < 0)
    .map(
      (r) => `<details><summary><b>${esc(r.version)}</b><span class="faint">${esc(r.date)}</span><span class="first">${esc(r.notes[0] ?? '')}</span></summary>
        <ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>`,
    )
    .join('')}</div>`,
  { meta: 'what changed in each version; click one to read it' },
)}
${panel('Settings for updates', source + back)}
${
  past.length === 0
    ? ''
    : panel(
        'Update history',
        `<ul class="help" style="margin:0;padding-left:18px">${past.map((r) => `<li>${esc(when(r.at))}: ${esc(r.from)} → ${esc(r.to)}</li>`).join('')}</ul>`,
      )
}
<script>
(() => {
  const desktop = window.perfintDesktop;
  const canRun = desktop && typeof desktop.runInstaller === 'function';
  for (const el of document.querySelectorAll('.js-install, .js-rollback, .js-from-file')) el.hidden = !canRun;
  for (const el of document.querySelectorAll('.js-browser-only')) el.hidden = !!canRun;

  document.querySelector('.js-check')?.addEventListener('click', (event) => perfint.checkUpdates(event.currentTarget));
  document.querySelector('.js-reset-folder')?.addEventListener('click', async () => {
    await perfint.post('/api/settings', { 'updates.folder': '' });
    await perfint.post('/api/update/check', {});
    location.reload();
  });
  for (const btn of document.querySelectorAll('.js-from-file')) {
    btn.addEventListener('click', async () => {
      const file = await desktop.pickFile({ title: 'Choose the new installer', filters: [{ name: 'Installer', extensions: ['exe'] }] });
      if (!file) return;
      const data = await perfint.post('/api/update/choose-file', { path: file });
      if (!data.ok) return perfint.toast(data.error || 'That file cannot be used.', true);
      await perfint.post('/api/update/check', {});
      location.reload();
    });
  }
  if (!canRun) return;

  // Ask until the collector says it is a good moment (never mid-harvest).
  async function whenReady(url, body, btn) {
    for (;;) {
      const data = await perfint.post(url, body);
      if (data.ok) return data;
      if (!data.wait) { perfint.toast(data.error || 'Could not prepare.', true); return undefined; }
      btn.textContent = 'Waiting: ' + data.wait;
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  document.querySelector('.js-install')?.addEventListener('click', (event) => {
    const btn = event.currentTarget;
    perfint.installUpdate(btn.dataset.version, btn);
  });

  document.querySelector('.js-rollback')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const version = btn.dataset.version;
    const ok = await perfint.confirm('Go back to ' + version + '?',
      'The database is restored from the backup taken before the update. Your current settings and servers are kept, and captures recorded since then are imported again. Monitoring pauses for about a minute. Minecraft is not touched.',
      'Go back');
    if (!ok) return;
    btn.disabled = true; btn.textContent = 'Preparing…';
    const data = await whenReady('/api/update/stage-rollback', {}, btn);
    if (!data) { btn.disabled = false; btn.textContent = 'Go back to ' + version; return; }
    btn.textContent = 'Going back…';
    const result = await desktop.runInstaller({ installer: data.installer, restore: data.staged });
    if (!result || !result.ok) { perfint.toast((result && result.error) || 'The installer could not be started.', true); btn.disabled = false; btn.textContent = 'Go back to ' + version; }
  });
})();
</script>`;
}
