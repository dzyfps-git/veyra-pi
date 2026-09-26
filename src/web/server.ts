/**
 * Web interface.
 *
 * Plain `node:http`, no framework. Binds to loopback by default because the
 * interface has no authentication; the `interface.host` setting warns about
 * this explicitly if you change it.
 *
 * Read-only with respect to the Minecraft server. The only writes this process
 * performs from here are to perfint's own settings.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { layout, contextLine, esc, banner, type NavItem, type ShellServer } from './layout.ts';
import { settingsPage } from './pages/settings.ts';
import { updatesPage } from './pages/updates.ts';
import { minutePage, stallsPage, threadsPage } from './pages/investigate.ts';
import { createInvestigation, updateInvestigation, type InvestigationState } from '../analysis/investigations.ts';
import { capturesPage } from './pages/views.ts';
import { overviewPage } from './pages/overview.ts';
import { guidePage } from './pages/guide.ts';
import { findingsPage } from './pages/findings.ts';
import { ownModMatcher, ownModPrefixes } from '../analysis/priority.ts';
import { registerPage } from './pages/register.ts';
import { changesPage } from './pages/changes.ts';
import { moveArchive } from '../store/storage.ts';
import { checkInstaller, findInstallers, installerPattern, keepInstaller, prepareUpdate, stageRollback, updateFolders, type Installer } from '../runtime/updates.ts';
import { APP_VERSION, compareVersions } from '../core/changelog.ts';
import {
  createServer as createServerRecord,
  defaultServerId,
  getServer,
  listServers,
  updateServer,
  COLLECTION_MODES,
  SERVER_KINDS,
  type CollectionMode,
  type ServerConfig,
  type ServerKind,
  type ServerPatch,
} from '../store/servers.ts';
import {
  applyAutomaticFixes,
  applyJvmFlags,
  applySparkConfig,
  gatherSetup,
  planSparkConfig,
  runSetupPass,
  undoRemediation,
} from '../runtime/remediate.ts';
import { detectedChanges } from '../analysis/changes.ts';
import { capturePage } from './pages/seasons.ts';
import { serversPage, serverHomePage, contextFor, statusOf } from './pages/servers.ts';
import { modBrief, reportsPage } from './pages/reports.ts';
import { renderLeaderboard, renderIndex } from '../report/markdown.ts';
import { renderHandoff } from '../report/handoff.ts';
import { findings } from '../analysis/findings.ts';
import * as q from '../query/queries.ts';
import { Register, type OptimizationStatus, type OptimizationInput } from '../analysis/register.ts';
import { validate, collectObservations, comparisonScope } from '../analysis/validate.ts';
import type { Feasibility } from '../analysis/detectors.ts';
import type { Risk } from '../analysis/priority.ts';
import type { SettingsStore } from '../settings/store.ts';
import { settingDef } from '../settings/registry.ts';
import type { Branding } from '../core/brand.ts';
import type { Store } from '../store/db.ts';
import type { ServerLink } from '../runtime/link.ts';

const FONTS_DIR = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'fonts');

export interface WebOptions {
  store: Store;
  settings: SettingsStore;
  branding: Branding;
  host: string;
  port: number;
  /** Live per-server state, when running inside the collector. */
  links?: Map<string, ServerLink>;
  /** Called by the tray's Quit action. */
  onShutdown?: (reason: string) => void;
  /** Why now is a bad moment to stop monitoring for an update, if it is. */
  updateGate?: () => string | undefined;
  /** Look for a newer GitHub release now; starts its download and returns at once. */
  checkGithub?: () => Promise<{ version?: string; downloading?: boolean; error?: string }>;
  /** "Try again now" on a harvest problem: tries given back, next collection now. */
  retryHarvest?: (serverId: string) => { reset: number; scheduled: boolean };
  /** A newer version being downloaded right now, if one is. */
  updateStatus?: () => { downloading?: string | undefined };
}

const MAX_BODY_BYTES = 256 * 1024;

/** Accepted values, so a request body cannot introduce a new one. */
const FEASIBILITY: readonly Feasibility[] = ['unknown', 'likely', 'unlikely', 'proven'];
const RISK: readonly Risk[] = ['unknown', 'low', 'medium', 'high'];

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function text(res: ServerResponse, status: number, body: string, contentType: string, filename?: string): void {
  res.writeHead(status, {
    'content-type': contentType + '; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...(filename === undefined ? {} : { 'content-disposition': 'attachment; filename="' + filename + '"' }),
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

/** Only the fields a person can set, with their types checked. */
function serverPatchFrom(body: Record<string, unknown>): ServerPatch {
  const patch: ServerPatch = {};
  const text = (key: string): string | undefined => (typeof body[key] === 'string' ? (body[key] as string) : undefined);
  const name = text('displayName');
  if (name !== undefined) patch.displayName = name;
  const kind = text('kind');
  if (kind !== undefined) patch.kind = kind as ServerKind;
  for (const key of ['machine', 'root', 'sparkDir', 'sshHost', 'tmuxTarget', 'mcHost'] as const) {
    const value = text(key);
    if (value !== undefined) patch[key] = value;
  }
  const collection = text('collection');
  if (collection !== undefined) patch.collection = collection as CollectionMode;
  if (body['mcPort'] !== undefined) patch.mcPort = Number(body['mcPort']);
  if (typeof body['visible'] === 'boolean') patch.visible = body['visible'];
  void COLLECTION_MODES;
  void SERVER_KINDS;
  return patch;
}

export function createWebServer(options: WebOptions) {
  const { store, settings, branding } = options;

  // Once after an update, until the Updates page has been seen.
  const justUpdatedBanner = (): string => {
    const from = store.getMeta('app.changedFrom');
    if (from === undefined || from === '' || store.getMeta('app.whatsNewSeen') === '1') return '';
    const upgraded = compareVersions(APP_VERSION, from) > 0;
    return banner(
      'ok',
      upgraded ? `Updated to ${esc(APP_VERSION)}.` : `Back on ${esc(APP_VERSION)}.`,
      upgraded ? 'Your settings, captures and history are all here.' : 'The database was restored from before the update; captures recorded since are being imported again.',
      `<a class="button ghost" href="/updates">What is new</a>`,
    );
  };

  const openQuestions = (): number => {
    try {
      return store.openQuestions().length;
    } catch {
      // A database from before world tracking has no such table.
      return 0;
    }
  };

  const nav = (): NavItem[] => {
    const pending = settings.pendingCount();
    const questions = openQuestions();
    // Grouped by what each page is about: the pages for the chosen server,
    // then the app itself. History lives on the server's own page now.
    return [
      { href: '/', label: 'Overview', icon: 'overview', section: 'This server' },
      { href: '/findings', label: 'Findings', icon: 'findings' },
      { href: '/changes', label: 'Changes', icon: 'changes' },
      questions > 0
        ? { href: '/server', label: 'Server & history', short: 'Server', icon: 'server', badge: String(questions) }
        : { href: '/server', label: 'Server & history', short: 'Server', icon: 'server' },
      { href: '/reports', label: 'Reports', icon: 'reports' },
      { href: '/servers', label: 'All servers', short: 'Servers', icon: 'servers', section: 'App' },
      pending > 0
        ? { href: '/settings', label: 'Settings', icon: 'settings', badge: String(pending) }
        : { href: '/settings', label: 'Settings', icon: 'settings' },
      { href: '/guide', label: 'How it works', short: 'Guide', icon: 'guide' },
    ];
  };

  /**
   * Which server the everyday views show: `?server=` if given (and then
   * remembered in a cookie), else the cookie, else the default.
   */
  const currentServer = (req: IncomingMessage, url: URL): ServerConfig | undefined => {
    const asked = url.searchParams.get('server');
    if (asked !== null) {
      const chosen = getServer(store.db, asked);
      if (chosen !== undefined) return chosen;
    }
    const cookie = /(?:^|;\s*)perfint_server=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (cookie !== undefined) {
      const remembered = getServer(store.db, decodeURIComponent(cookie));
      if (remembered !== undefined) return remembered;
    }
    const fallback = defaultServerId(store.db);
    return fallback === undefined ? undefined : getServer(store.db, fallback);
  };

  const shellServers = (): ShellServer[] =>
    listServers(store.db).map((sv) => {
      const st = statusOf(store.db, sv, settings.getBoolean('limits.paused'), options.links?.get(sv.id));
      return {
        id: sv.id,
        name: sv.displayName,
        kind: sv.kind,
        collection: sv.collection,
        visible: sv.visible,
        state: st.words,
        tone: st.tone,
      };
    });

  const page = (
    active: string,
    title: string,
    subtitle: string,
    body: string,
    extra: { current?: ServerConfig | undefined; here?: string; context?: string; actions?: string; bare?: boolean } = {},
  ): string =>
    layout({
      branding,
      title,
      subtitle,
      active,
      nav: nav(),
      body,
      theme: settings.getString('interface.theme'),
      servers: shellServers(),
      ...(extra.current === undefined ? {} : { currentServerId: extra.current.id }),
      ...(extra.here === undefined ? {} : { here: extra.here }),
      ...(extra.context === undefined ? {} : { context: extra.context }),
      ...(extra.actions === undefined ? {} : { actions: extra.actions }),
      ...(extra.bare === true ? { bare: true } : {}),
      paused: settings.getBoolean('limits.paused'),
      version: APP_VERSION,
      ...(availableUpdate() === undefined ? {} : { update: availableUpdate()!.version }),
      ...(options.updateStatus?.().downloading === undefined ? {} : { downloading: options.updateStatus().downloading! }),
    });

  // Looking for installers is a directory listing or two; still, not on
  // every page view. "Check for updates" clears it.
  let updateCache: { at: number; value: Installer | undefined } | undefined;
  function availableUpdate(): Installer | undefined {
    if (updateCache === undefined || Date.now() - updateCache.at > 60_000) {
      let value: Installer | undefined;
      try {
        value = findInstallers(updateFolders(store, settings), branding.name).find((i) => compareVersions(i.version, APP_VERSION) > 0);
      } catch {
        value = undefined;
      }
      updateCache = { at: Date.now(), value };
    }
    return updateCache.value;
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const path = url.pathname;
        const current = currentServer(req, url);
        const here = url.pathname + url.search;
        const view = (
          active: string,
          title: string,
          subtitle: string,
          body: string,
          extra: { context?: string; actions?: string; bare?: boolean } = {},
        ): string => page(active, title, subtitle, body, { current, here, ...extra });
        // Choosing a server in the top bar is remembered for every page.
        if (url.searchParams.has('server') && current !== undefined) {
          res.setHeader('set-cookie', `perfint_server=${encodeURIComponent(current.id)}; Path=/; SameSite=Lax; Max-Age=31536000`);
        }

        if (req.method === 'POST') {
          const body = await readJsonBody(req);

          if (path === '/api/settings') {
            // The page asks for confirmation before sending a change that
            // reaches the server; that confirmation is the approval.
            const approved = body['_approve'] === true;
            const { _approve: _ignored, ...updates } = body;
            void _ignored;
            return json(res, 200, settings.apply(updates, { actor: 'ui', approveRisky: approved }));
          }
          if (path === '/api/settings/approve') {
            const key = String(body['key'] ?? '');
            return json(res, 200, settings.approvePending(key));
          }
          if (path === '/api/shutdown') {
            if (options.onShutdown === undefined) return json(res, 501, { error: 'not running under the collector' });
            json(res, 200, { ok: true });
            setTimeout(() => options.onShutdown?.('tray quit'), 50);
            return;
          }
          if (path === '/api/settings/discard') {
            settings.discardPending(String(body['key'] ?? ''));
            return json(res, 200, { ok: true });
          }

          // Copies and verifies every file before switching; see storage.ts.
          if (path === '/api/storage/move-archive') {
            const result = moveArchive(store, settings, String(body['to'] ?? ''));
            return json(res, result.ok ? 200 : 400, result);
          }

          // --- servers ---------------------------------------------------
          if (path === '/api/servers/create') {
            const result = createServerRecord(store.db, serverPatchFrom(body) as ServerPatch & { displayName: string });
            return result.errors.length > 0
              ? json(res, 400, { error: result.errors.join(' ') })
              : json(res, 200, { ok: true, id: result.id });
          }
          // --- updates ---------------------------------------------------
          // Preparing only: the desktop app runs the installer, and only
          // from the app's own kept-installers folder.
          if (path === '/api/update/prepare') {
            const gate = options.updateGate?.();
            if (gate !== undefined) return json(res, 200, { ok: false, wait: gate });
            const version = String(body['version'] ?? '');
            const installer = findInstallers(updateFolders(store, settings), branding.name).find(
              (i) => i.version === version && compareVersions(i.version, APP_VERSION) > 0,
            );
            if (installer === undefined) return json(res, 404, { error: `No installer for ${version} was found.` });
            const check = checkInstaller(installer);
            if (!check.ok) return json(res, 400, { error: check.detail });
            const kept = keepInstaller(store, installer, branding.name);
            const record = prepareUpdate(store, version);
            return json(res, 200, { ok: true, installer: kept, backup: record.backup, verified: check.verified });
          }
          // "Install from file…": the folder it came from is where updates are
          // looked for from now on, so choosing once is enough.
          if (path === '/api/update/choose-file') {
            const file = String(body['path'] ?? '');
            if (!installerPattern(branding.name).test(nodePath.basename(file)) || !existsSync(file)) {
              return json(res, 400, { error: `That is not an installer for ${branding.name}.` });
            }
            settings.apply({ 'updates.folder': nodePath.dirname(file) }, { actor: 'ui' });
            updateCache = undefined;
            return json(res, 200, { ok: true });
          }
          if (path === '/api/harvest/retry') {
            if (current === undefined || options.retryHarvest === undefined) return json(res, 400, { error: 'No server to collect from.' });
            return json(res, 200, { ok: true, ...options.retryHarvest(current.id) });
          }
          if (path === '/api/update/check') {
            updateCache = undefined;
            const found = availableUpdate();
            // Always ask GitHub too: an installer already waiting may not be the newest.
            if (options.checkGithub !== undefined) {
              const gh = await options.checkGithub();
              const newer = gh.version !== undefined && (found === undefined || compareVersions(gh.version, found.version) > 0);
              if (gh.downloading === true && newer) return json(res, 200, { ok: true, version: null, downloading: gh.version });
              if (gh.error !== undefined && found === undefined) return json(res, 200, { ok: true, version: null, error: gh.error });
            }
            return json(res, 200, { ok: true, version: found?.version ?? null });
          }
          if (path === '/api/update/stage-rollback') {
            const gate = options.updateGate?.();
            if (gate !== undefined) return json(res, 200, { ok: false, wait: gate });
            try {
              const staged = stageRollback(store, branding.name);
              return json(res, 200, { ok: true, installer: staged.installer.file, staged: staged.staged, reimport: staged.reimport });
            } catch (error) {
              return json(res, 400, { error: (error as Error).message });
            }
          }

          // --- investigations ------------------------------------------------
          if (path === '/api/investigations/create') {
            if (current === undefined) return json(res, 400, { error: 'No server selected.' });
            const members = Array.isArray(body['members']) ? (body['members'] as unknown[]).filter((m): m is string => typeof m === 'string') : [];
            const mspt = typeof body['mspt'] === 'number' && Number.isFinite(body['mspt']) ? (body['mspt'] as number) : null;
            const seasonId = typeof body['seasonId'] === 'number' ? (body['seasonId'] as number) : undefined;
            const result = createInvestigation(store.db, {
              serverId: current.id,
              name: String(body['name'] ?? ''),
              state: String(body['state'] ?? 'hold') as InvestigationState,
              note: String(body['note'] ?? ''),
              members,
              mspt,
              ...(seasonId === undefined ? {} : { seasonId }),
            });
            return result.error === undefined ? json(res, 200, { ok: true, id: result.id }) : json(res, 400, { error: result.error });
          }
          if (path === '/api/investigations/update') {
            const patch: Parameters<typeof updateInvestigation>[2] = {};
            if (typeof body['state'] === 'string') patch.state = body['state'] as InvestigationState;
            if (typeof body['note'] === 'string') patch.note = body['note'];
            if (typeof body['name'] === 'string') patch.name = body['name'];
            if (typeof body['mspt'] === 'number' && Number.isFinite(body['mspt'])) patch.mspt = body['mspt'] as number;
            const result = updateInvestigation(store.db, Number(body['id']), patch);
            return result.error === undefined ? json(res, 200, { ok: true }) : json(res, 400, { error: result.error });
          }

          if (path === '/api/servers/update') {
            const result = updateServer(store.db, String(body['id'] ?? ''), serverPatchFrom(body));
            return result.errors.length > 0 ? json(res, 400, { error: result.errors.join(' ') }) : json(res, 200, { ok: true });
          }

          // --- setup fixes ---------------------------------------------
          // Every one of these is a button press: the operator saw what would
          // change before sending it. The launcher edit additionally carries
          // the hash of the file the preview was made from, so a file edited
          // in the meantime is refused rather than overwritten.
          const serverFromBody = (): ServerConfig | undefined =>
            getServer(store.db, String(body['serverId'] ?? '')) ?? getServer(store.db, defaultServerId(store.db) ?? '');

          if (path === '/api/setup/recheck') {
            const target = serverFromBody();
            if (target === undefined) return json(res, 400, { error: 'no such server' });
            const pass = runSetupPass(store, settings, target.root, target.id);
            return json(res, 200, {
              ok: true,
              findings: pass.state?.findings.length ?? 0,
              fixed: pass.fixed,
              failed: pass.failed,
            });
          }

          if (path === '/api/setup/fix') {
            const what = String(body['what'] ?? '');
            const expected = body['expectedSha'] === null || body['expectedSha'] === undefined
              ? ''
              : String(body['expectedSha']);
            try {
              const target = serverFromBody();
              if (target === undefined) return json(res, 400, { error: 'no such server' });
              const state = gatherSetup(store, settings, target.root, target.id);
              if (state === undefined) return json(res, 400, { error: 'no server folder is set for this server' });
              if (!state.observed.rootReadable) return json(res, 400, { error: `${state.root} cannot be read` });

              if (what === 'analyzer') {
                const fixes = applyAutomaticFixes(store, settings, state);
                return json(res, 200, {
                  ok: true,
                  message:
                    fixes.length === 0
                      ? 'Nothing could be fixed automatically. See the item for what it needs.'
                      : fixes.map((f) => f.summary).join(' '),
                });
              }
              if (what === 'spark-config') {
                const plan = planSparkConfig(state);
                if (plan === undefined) return json(res, 400, { error: "spark's config needs no change, or cannot be read safely" });
                if ((plan.beforeSha ?? '') !== expected) {
                  return json(res, 409, { error: "spark's config changed since this page was loaded. Reload and review it again." });
                }
                return json(res, 200, { ok: true, message: applySparkConfig(store, plan, 'ui').summary });
              }
              if (what === 'jvm-flags') {
                if (expected === '') return json(res, 400, { error: 'the preview this was approved from is missing' });
                return json(res, 200, { ok: true, message: applyJvmFlags(store, state.root, expected).summary });
              }
              return json(res, 400, { error: 'unknown fix' });
            } catch (error) {
              return json(res, 409, { error: (error as Error).message });
            }
          }

          if (path === '/api/setup/undo') {
            try {
              const roots = listServers(store.db).map((sv) => sv.root).filter((r) => r !== '');
              return json(res, 200, { ok: true, message: undoRemediation(store, settings, Number(body['id']), roots) });
            } catch (error) {
              return json(res, 409, { error: (error as Error).message });
            }
          }

          // --- changes -------------------------------------------------
          if (path === '/api/register/target') {
            const id = Number(body['id']);
            const pathText = String(body['targetPathText'] ?? '').trim();
            const label = String(body['targetLabel'] ?? '').trim();
            const reg = new Register(store.db);
            if (reg.get(id) === undefined) return json(res, 404, { error: 'no such change' });
            if (pathText === '' || label === '') return json(res, 400, { error: 'a target path and label are required' });
            reg.setTarget(id, pathText, label);
            return json(res, 200, { ok: true });
          }

          if (path === '/api/changes/track') {
            const revisionId = Number(body['revisionId']);
            const prefixes = ownModPrefixes(settings.getString('analysis.ownMods'));
            const change = detectedChanges(store.db, { inHousePrefixes: prefixes, limit: 500 }).find(
              (c) => c.revisionId === revisionId,
            );
            if (change === undefined) return json(res, 404, { error: 'no such detected change' });
            if (change.trackedId !== undefined) return json(res, 200, { ok: true, id: change.trackedId });

            const serverId = store.firstServerId();
            if (serverId === undefined) return json(res, 400, { error: 'no server is configured yet' });

            const mine = change.changes.filter((m) => m.inHouse);
            const lead = (mine.length > 0 ? mine : change.changes).slice(0, 3);
            const describe = (m: (typeof change.changes)[number]): string =>
              m.kind === 'updated' ? `${m.modId} ${m.from} -> ${m.to}` : `${m.kind} ${m.modId} ${m.to ?? m.from ?? ''}`;

            const id = new Register(store.db).create({
              serverId,
              title:
                lead.map((m) => m.modId).join(', ') +
                (change.changes.length > lead.length ? ` (+${change.changes.length - lead.length} more)` : ''),
              revisionId: change.revisionId,
              deployedAt: change.at,
              notes:
                'detected from the mod list:\n' +
                change.changes.map(describe).join('\n') +
                (change.runtimeChanges.length === 0 ? '' : `\nJVM flags: ${change.runtimeChanges.join(', ')}`),
            });
            return json(res, 200, { ok: true, id });
          }

          if (path === '/api/changes/record') {
            const title = String(body['title'] ?? '').trim();
            const at = Number(body['at']);
            if (title === '') return json(res, 400, { error: 'describe what changed' });
            if (!Number.isFinite(at) || at <= 0) return json(res, 400, { error: 'say when it went live' });
            if (at > Date.now() + 60_000) return json(res, 400, { error: 'that time is in the future' });
            const serverId = store.firstServerId();
            if (serverId === undefined) return json(res, 400, { error: 'no server is configured yet' });
            const notes = String(body['notes'] ?? '').trim();
            const id = new Register(store.db).create({
              serverId,
              title,
              deployedAt: at,
              ...(notes === '' ? {} : { notes }),
            });
            return json(res, 200, { ok: true, id });
          }

          // --- optimization register -----------------------------------
          //
          // Nothing here touches the Minecraft server. The register records
          // what someone decided and what the archive later showed; applying
          // a change to production is a manual act, by design.
          if (path.startsWith('/api/register/')) {
            const reg = new Register(store.db);
            const id = Number(body['id']);

            if (path === '/api/register/create') {
              const title = String(body['title'] ?? '').trim();
              if (title === '') return json(res, 400, { error: 'a title is required' });
              const serverId = store.firstServerId();
              if (serverId === undefined) return json(res, 400, { error: 'no server is configured yet' });
              // Built field by field so an omitted value stays omitted, and
              // so feasibility/risk fall back to `unknown` rather than
              // accepting whatever arrived in the body.
              const input: OptimizationInput = { serverId, title };
              for (const field of ['targetLabel', 'targetPathText', 'hypothesis', 'approach', 'notes'] as const) {
                const value = body[field];
                if (typeof value === 'string' && value.trim() !== '') input[field] = value.trim();
              }
              if (FEASIBILITY.includes(body['feasibility'] as Feasibility)) {
                input.feasibility = body['feasibility'] as Feasibility;
              }
              if (RISK.includes(body['risk'] as Risk)) input.risk = body['risk'] as Risk;

              const newId = reg.create(input);
              return json(res, 200, { ok: true, id: newId });
            }

            if (path === '/api/register/status') {
              // setStatus refuses a measured status on its own; this is the
              // same refusal stated at the edge, so a hand-rolled request
              // gets the explanation too.
              const next = String(body['status'] ?? '') as OptimizationStatus;
              const result = reg.setStatus(id, next);
              return json(res, result.ok ? 200 : 400, result);
            }

            if (path === '/api/register/deploy') {
              const at = Number(body['deployedAt']);
              if (!Number.isFinite(at)) return json(res, 400, { error: 'deployedAt must be a timestamp' });
              if (reg.get(id) === undefined) return json(res, 404, { error: 'no such optimization' });
              reg.markDeployed(id, at);
              return json(res, 200, { ok: true });
            }

            if (path === '/api/register/synthetic') {
              const note = String(body['note'] ?? '').trim();
              if (note === '') return json(res, 400, { error: 'a note is required' });
              if (reg.get(id) === undefined) return json(res, 404, { error: 'no such optimization' });
              reg.attachSynthetic(id, note);
              return json(res, 200, { ok: true });
            }

            if (path === '/api/register/validate') {
              const opt = reg.get(id);
              if (opt === undefined) return json(res, 404, { error: 'no such optimization' });
              if (opt.deployed_at === null) {
                return json(res, 400, {
                  error: 'Record when the change actually went live first. Without a deploy time there is nothing to compare across.',
                });
              }
              if (opt.target_path_text === null || opt.target_path_text === '') {
                return json(res, 400, {
                  error:
                    'This entry has no target call path, so there is nothing specific to measure. ' +
                    'Whole-server tick time moves with player count and would not answer the question.',
                });
              }

              // The Changes page passes the window that was on screen, so the
              // recorded result is the one that was looked at. Without one,
              // the configured default applies.
              const defaultMs = settings.getNumber('analysis.validation.comparisonWindowDays') * 86_400_000;
              const beforeMs = Number(body['beforeMs']) > 0 ? Number(body['beforeMs']) : defaultMs;
              const afterMs = Number(body['afterMs']) > 0 ? Number(body['afterMs']) : defaultMs;
              const deployedAt = opt.deployed_at;

              // Before and after must be one season: one world, one modpack,
              // one machine. Otherwise the comparison measures the reset or
              // rotation, not the patch.
              const serverIdForOpt =
                (store.db.prepare('SELECT server_id FROM optimization WHERE id = ?').get(id) as
                  | { server_id: string }
                  | undefined)?.server_id ?? store.firstServerId() ?? '';
              const scope = comparisonScope(store.db, serverIdForOpt, deployedAt);
              if (!scope.ok) {
                return json(res, 400, { error: `Cannot validate this change: ${scope.reason}` });
              }

              const resolve = (stored: string): string | undefined => store.resolveDataPath(stored);
              const before = collectObservations(
                store.db,
                opt.target_path_text,
                { fromMs: deployedAt - beforeMs, toMs: deployedAt, seasonId: scope.seasonId },
                resolve,
              );
              const after = collectObservations(
                store.db,
                opt.target_path_text,
                { fromMs: deployedAt, toMs: deployedAt + afterMs, seasonId: scope.seasonId },
                resolve,
              );

              const result = validate(before, after, {
                deployedAt,
                minEffect: settings.getNumber('analysis.validation.minEffectMsPerTick'),
                minWindowsPerSide: settings.getNumber('analysis.validation.minWindowsPerSide'),
                playerBucketSize: settings.getNumber('analysis.validation.playerBucketSize'),
              });
              const assigned = reg.recordValidation(id, result);
              return json(res, 200, { ok: true, verdict: result.verdict, status: assigned, result });
            }

            return json(res, 404, { error: 'not found' });
          }

          // --- world identity and boundary questions -------------------
          //
          // Answering a question is the one place a person overrides the
          // system's own judgement, so the answer is recorded permanently
          // rather than applied and forgotten.
          if (path === '/api/boundary/answer') {
            const id = Number(body['id']);
            const answer = String(body['answer'] ?? '').trim();
            if (!Number.isFinite(id) || answer === '') {
              return json(res, 400, { error: 'an id and an answer are required' });
            }

            const open = store.openQuestions().find((q) => q.id === id);
            if (open === undefined) {
              return json(res, 404, { error: 'no open question with that id' });
            }

            let allowed: string[] = [];
            try {
              allowed = (JSON.parse(open.options) as Array<{ id: string }>).map((o) => o.id);
            } catch {
              allowed = [];
            }
            if (allowed.length > 0 && !allowed.includes(answer)) {
              return json(res, 400, { error: `"${answer}" is not one of the offered answers` });
            }

            store.answerQuestion(id, answer);

            // "new-world" is the only answer that changes stored structure,
            // and it only ever applies going FORWARD. Retroactively re-filing
            // captures already recorded would rewrite history on the strength
            // of a judgement call, which is the opposite of what the record
            // is for.
            if (answer === 'new-world' && open.season_id !== null) {
              store.db
                .prepare('UPDATE season SET confirmed = 1, notes = ? WHERE id = ?')
                .run(
                  'Confirmed as a new world by the operator. Captures recorded before this answer keep ' +
                    'their original season; the split applies from here on.',
                  open.season_id,
                );
            }
            store.markQuestionApplied(id);
            return json(res, 200, { ok: true, answer });
          }

          if (path === '/api/world/name') {
            const id = Number(body['id']);
            const label = String(body['label'] ?? '').trim();
            if (!Number.isFinite(id) || label === '') {
              return json(res, 400, { error: 'an id and a name are required' });
            }
            if (store.getWorld(id) === undefined) return json(res, 404, { error: 'no such world' });
            store.nameWorld(id, label);
            return json(res, 200, { ok: true });
          }

          if (path === '/api/season/name') {
            const id = Number(body['id']);
            const label = String(body['label'] ?? '').trim();
            if (!Number.isFinite(id)) return json(res, 400, { error: 'an id is required' });
            store.nameSeason(id, label === '' ? '' : label);
            return json(res, 200, { ok: true });
          }

          return json(res, 404, { error: 'not found' });
        }

        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

        // The interface's own fonts, shipped with the app (web/fonts, OFL).
        const font = /^\/fonts\/((?:figtree|jetbrains-mono-[457]00)\.woff2)$/.exec(path);
        if (font !== null) {
          const file = nodePath.join(FONTS_DIR, font[1]!);
          if (!existsSync(file)) return json(res, 404, { error: 'not found' });
          res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
          res.end(readFileSync(file));
          return;
        }

        switch (path) {
          case '/':
            return html(
              res,
              200,
              view(
                '/',
                'Overview',
                'How this server is performing, and what needs attention.',
                justUpdatedBanner() + overviewPage(store.db, settings, current, options.links, (p) => store.resolveDataPath(p), url.searchParams),
                // Home draws its own head: the server in focus, its state and the latest minute.
                { bare: true },
              ),
            );
          case '/ledger': {
            // The Ledger is now Findings' "every call path" view; old links still land.
            const next = new URLSearchParams({ view: 'paths' });
            for (const key of ['q', 'season', 'range', 'from', 'to', 'between']) {
              const value = url.searchParams.get(key);
              if (value !== null && value !== '') next.set(key, value);
            }
            const preset = url.searchParams.get('preset');
            if (preset === 'small') next.set('only', 'small');
            if (preset === 'blocked') next.set('only', 'stalls');
            return redirect(res, `/findings?${next.toString()}`);
          }
          case '/findings/detail':
            return html(
              res,
              200,
              findingsPage(store.db, url.searchParams, (p) => store.resolveDataPath(p), current?.id, {
                detail: url.searchParams.get('key') ?? '',
                ownMod: ownModMatcher(settings.getString('analysis.ownMods')),
              }),
            );
          case '/findings':
            return html(
              res,
              200,
              view(
                '/findings',
                'Findings',
                'Where the tick time goes, and what is worth doing about it.',
                findingsPage(store.db, url.searchParams, (p) => store.resolveDataPath(p), current?.id, {
                  ownMod: ownModMatcher(settings.getString('analysis.ownMods')),
                }),
                { context: contextLine(contextFor(store.db, current)) },
              ),
            );
          case '/server': {
            if (current === undefined) {
              res.writeHead(302, { location: '/servers' });
              res.end();
              return;
            }
            return html(
              res,
              200,
              view(
                '/server',
                current.displayName,
                `${current.kind.charAt(0).toUpperCase()}${current.kind.slice(1)} server${current.machine === '' ? '' : ` · ${current.machine}`}`,
                serverHomePage(store.db, settings, current, options.links),
                {
                  context: contextLine([{ label: 'Server', value: current.displayName }]),
                  actions: `<button type="button" class="ghost js-rename-server" data-id="${esc(current.id)}" data-current="${esc(current.displayName)}">Rename</button>`,
                },
              ),
            );
          }
          case '/guide':
            return html(
              res,
              200,
              view('/guide', 'How it works', 'Everything this app shows, in plain words.', guidePage()),
            );
          case '/servers':
            return html(
              res,
              200,
              view(
                '/servers',
                'All servers',
                'Each server is monitored on its own. Hiding one only takes it out of everyday views.',
                serversPage(store.db, settings, options.links),
              ),
            );
          case '/history':
          case '/seasons':
          case '/captures': {
            // History lives on the server's own page now; the full list of
            // captures stays reachable here.
            if (path !== '/captures' && url.searchParams.get('tab') !== 'captures') {
              res.writeHead(302, { location: '/server#history' });
              res.end();
              return;
            }
            return html(
              res,
              200,
              view(
                '/server',
                'Captures',
                'Every archived profile for this server, newest first.',
                capturesPage(store.db, current?.id),
                { context: contextLine(contextFor(store.db, current)) },
              ),
            );
          }
          case '/changes':
          case '/register': {
            const params = new URLSearchParams(url.searchParams);
            if (path === '/register' && !params.has('view')) params.set('view', 'tracked');
            return html(
              res,
              200,
              view(
                '/changes',
                'Changes',
                'What was deployed, and whether it helped.',
                changesPage(store, settings, params, current?.id),
                { context: contextLine(contextFor(store.db, current)) },
              ),
            );
          }
          case '/capture':
            return html(
              res,
              200,
              view(
                '/history',
                'Capture',
                'Everything one archived profile contains.',
                capturePage(store.db, url.searchParams),
              ),
            );
          case '/reports':
            return html(
              res,
              200,
              view(
                '/reports',
                'Reports',
                'Briefs for whoever will read the code, and the files to share.',
                reportsPage(store.db, url.searchParams, ownModMatcher(settings.getString('analysis.ownMods'))),
              ),
            );

          // Generated markdown. `?view=1` renders in the browser; without it
          // the file downloads, because downloading is what it is for.
          case '/reports/leaderboard.md': {
            const seasonRaw = url.searchParams.get('season');
            const body = renderLeaderboard(store.db, {
              ...(seasonRaw === null ? {} : { seasonId: Number(seasonRaw) }),
              ownMod: ownModMatcher(settings.getString('analysis.ownMods')),
            });
            const viewing = url.searchParams.get('view') === '1';
            return viewing
              ? text(res, 200, body, 'text/plain')
              : text(res, 200, body, 'text/markdown', 'PATCH_LEADERBOARD.md');
          }
          case '/reports/index.md': {
            const body = renderIndex(store.db);
            const viewing = url.searchParams.get('view') === '1';
            return viewing
              ? text(res, 200, body, 'text/plain')
              : text(res, 200, body, 'text/markdown', 'INDEX.md');
          }
          case '/reports/thing-brief.txt': {
            const opts: Parameters<typeof renderHandoff>[2] = {};
            for (const key of ['projectDir', 'jarPath', 'mappingsPath'] as const) {
              const value = url.searchParams.get(key);
              if (value !== null && value.trim() !== '') opts[key] = value.trim();
            }
            const body = findingsPage(store.db, url.searchParams, (p) => store.resolveDataPath(p), current?.id, {
              ownMod: ownModMatcher(settings.getString('analysis.ownMods')),
              brief: opts,
            });
            if (body === '') return text(res, 404, 'Nothing is recorded for that thing over that span.\n', 'text/plain');
            const subjects = url.searchParams.getAll('subject');
            const name =
              subjects.length > 1
                ? `${url.searchParams.get('system') ?? 'things'}_${subjects.length}_things`
                : ((subjects[0] ?? 'thing').split(/[.$/]/).filter(Boolean).pop() ?? 'thing');
            return url.searchParams.get('download') === '1'
              ? text(res, 200, body, 'text/markdown', `BRIEF_${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.md`)
              : text(res, 200, body, 'text/plain');
          }
          case '/reports/mod-brief.txt': {
            const mod = url.searchParams.get('mod') ?? '';
            const opts: Parameters<typeof renderHandoff>[2] = {};
            for (const key of ['projectDir', 'jarPath', 'mappingsPath'] as const) {
              const value = url.searchParams.get(key);
              if (value !== null && value.trim() !== '') opts[key] = value.trim();
            }
            const body = modBrief(store.db, mod, ownModMatcher(settings.getString('analysis.ownMods')), opts);
            if (body === undefined) return text(res, 404, 'Nothing is recorded for the mod "' + mod + '".\n', 'text/plain');
            return url.searchParams.get('download') === '1'
              ? text(res, 200, body, 'text/markdown', `BRIEF_${mod.replace(/[^A-Za-z0-9_.-]/g, '_')}.md`)
              : text(res, 200, body, 'text/plain');
          }
          case '/reports/handoff.txt': {
            const label = url.searchParams.get('label') ?? '';
            const match = findings(store.db, { limit: 500, ownMod: ownModMatcher(settings.getString('analysis.ownMods')) }).find(
              (f) => f.label === label,
            );
            if (match === undefined) {
              return text(res, 404, 'No finding matches "' + label + '".\n', 'text/plain');
            }
            // Blank fields are omitted rather than passed as empty strings,
            // so the brief prints its own "unknown" text for them.
            const opts: Parameters<typeof renderHandoff>[2] = {};
            for (const key of ['projectDir', 'jarPath', 'mappingsPath', 'evidencePath'] as const) {
              const value = url.searchParams.get(key);
              if (value !== null && value.trim() !== '') opts[key] = value.trim();
            }
            const brief = renderHandoff(store.db, match, opts);
            return url.searchParams.get('download') === '1'
              ? text(res, 200, brief, 'text/markdown', `BRIEF_${label.split('.').slice(-2).join('_').replace(/[^A-Za-z0-9_.-]/g, '_')}.md`)
              : text(res, 200, brief, 'text/plain');
          }

          // Prometheus exposition. Deliberately cheap: counts and the latest
          // headline figures, with no per-path series -- a million call paths
          // would make a scrape useless and expensive at the same time.
          case '/metrics': {
            const o = q.overview(store.db);
            const latest = q.captures(store.db, 1)[0];
            const lines = [
              '# HELP perfint_captures_total Archived captures.',
              '# TYPE perfint_captures_total counter',
              'perfint_captures_total ' + o.captures,
              '# HELP perfint_call_paths Distinct call paths in the ledger.',
              '# TYPE perfint_call_paths gauge',
              'perfint_call_paths ' + o.paths,
              '# HELP perfint_ledger_rows Rows in the permanent daily ledger.',
              '# TYPE perfint_ledger_rows gauge',
              'perfint_ledger_rows ' + o.ledgerRows,
              '# HELP perfint_settings_version Monotonic settings version, for change detection.',
              '# TYPE perfint_settings_version counter',
              'perfint_settings_version ' + settings.version,
              '# HELP perfint_paused Whether collection is paused.',
              '# TYPE perfint_paused gauge',
              'perfint_paused ' + (settings.getBoolean('limits.paused') ? 1 : 0),
            ];
            if (latest !== undefined) {
              lines.push(
                '# HELP perfint_last_capture_tick_ms Tick time of the most recent capture. Inclusive MinecraftServer.tick, never thread wall time.',
                '# TYPE perfint_last_capture_tick_ms gauge',
                'perfint_last_capture_tick_ms ' + (latest.tick_ms_per_tick ?? 'NaN'),
                '# HELP perfint_last_capture_blocked_ms Blocked time of the most recent capture. Lost tick time, not idle.',
                '# TYPE perfint_last_capture_blocked_ms gauge',
                'perfint_last_capture_blocked_ms ' + (latest.blocked_ms_per_tick ?? 'NaN'),
                '# HELP perfint_last_capture_timestamp_seconds When the most recent capture started.',
                '# TYPE perfint_last_capture_timestamp_seconds gauge',
                'perfint_last_capture_timestamp_seconds ' +
                  (latest.started_at === null ? 'NaN' : Math.floor(latest.started_at / 1000)),
              );
            }
            for (const link of options.links?.values() ?? []) {
              const snapshot = link.snapshot();
              lines.push(
                'perfint_server_online{server="' + snapshot.serverId + '"} ' +
                  (snapshot.state === 'online' ? 1 : 0),
              );
            }
            return text(res, 200, lines.join('\n') + '\n', 'text/plain');
          }
          case '/minute': {
            if (current === undefined) return redirect(res, '/servers');
            const at = Number(url.searchParams.get('at'));
            const m = minutePage(store.db, (p) => store.resolveDataPath(p), current, Number.isFinite(at) && at > 0 ? at : Date.now());
            return html(res, 200, view('/', m.title, m.subtitle, m.body, { context: contextLine(contextFor(store.db, current)) }));
          }
          case '/stalls': {
            if (current === undefined) return redirect(res, '/servers');
            const hours = [24, 72, 168].includes(Number(url.searchParams.get('hours'))) ? Number(url.searchParams.get('hours')) : 24;
            return html(
              res,
              200,
              view('/', 'Freezes', 'Every tick of half a second or more, and what the server was waiting for.', stallsPage(store.db, (p) => store.resolveDataPath(p), current, hours), {
                context: contextLine(contextFor(store.db, current)),
              }),
            );
          }
          case '/threads': {
            if (current === undefined) return redirect(res, '/servers');
            const id = Number(url.searchParams.get('id'));
            return html(
              res,
              200,
              view(
                '/',
                'Other threads',
                'What world generation, chunk loading, disk and network were doing, from the all-thread profiles.',
                threadsPage(store.db, current, settings.getBoolean('collection.allThreads.enabled'), Number.isFinite(id) && id > 0 ? id : undefined),
                { context: contextLine(contextFor(store.db, current)) },
              ),
            );
          }
          case '/updates':
            return html(
              res,
              200,
              view('/updates', 'Updates', 'Your version, what is new, and going back.', updatesPage(store, settings, branding.name)),
            );
          case '/settings':
            return html(
              res,
              200,
              view(
                '/settings',
                'Settings',
                'Changes save as you make them; anything that reaches the live server asks first.',
                settingsPage(settings, url.searchParams.get('advanced') === '1', store, branding.name),
              ),
            );
          case '/api/settings/value': {
            // Single-value read for the desktop shell, which needs a couple
            // of settings before the interface has loaded.
            const key = url.searchParams.get('key') ?? '';
            try {
              // A secret is never handed back, not even to the desktop shell:
              // it reads settings like port and closeToTray, and has no
              // business receiving a credential.
              const def = settingDef(key);
              if (def?.type === 'secret') {
                return json(res, 200, { key, value: settings.getString(key) === '' ? '' : '(set)' });
              }
              return json(res, 200, { key, value: settings.get(key) });
            } catch {
              return json(res, 404, { error: 'unknown setting' });
            }
          }
          case '/api/update/status': {
            // The top bar asks while a download runs; a directory listing, once.
            updateCache = undefined;
            return json(res, 200, { ready: availableUpdate()?.version ?? null, downloading: options.updateStatus?.().downloading ?? null });
          }
          case '/api/health':
            return json(res, 200, {
              ok: true,
              pid: process.pid,
              version: APP_VERSION,
              settingsVersion: settings.version,
              paused: settings.getBoolean('limits.paused'),
              servers: [...(options.links?.values() ?? [])].map((l) => ({
                ...l.snapshot(),
                description: l.describe(),
              })),
            });
          default:
            return html(res, 404, view('/', 'Not found', '', '<div class="empty">No such page.</div>'));
        }
      } catch (error) {
        // A rendering failure must not take the interface down.
        json(res, 500, { error: (error as Error).message });
      }
    })();
  });
}
