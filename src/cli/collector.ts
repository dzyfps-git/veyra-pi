/**
 * `collector` -- the background process.
 *
 * This is the thing that actually runs continuously. It owns the store, the
 * settings, the per-server links, the scheduler, and the web server. The
 * desktop window is a pure client of it, so closing the window never stops
 * monitoring.
 *
 * Design notes that matter for reliability:
 *
 *  - The scheduler is a single low-frequency tick that asks each server link
 *    whether it has anything due. Servers never share a fate: each one is
 *    wrapped so a throw is contained and logged against that server alone.
 *  - Settings are re-read at the top of every action, so a change made in the
 *    UI applies to the very next cycle without a restart.
 *  - Nothing contacts a live server unless collection is explicitly enabled
 *    AND the server is in a usable state. Probing is read-only throughout.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { Store } from '../store/db.ts';
import { SettingsStore } from '../settings/store.ts';
import { loadBranding } from '../core/brand.ts';
import { createWebServer } from '../web/server.ts';
import { ServerLink, DEFAULT_LINK_CONFIG } from '../runtime/link.ts';
import { Notifier } from '../notify/discord.ts';
import { findings } from '../analysis/findings.ts';
import { applyPins } from '../analysis/anomaly.ts';
import { harvestOptions } from '../runtime/harvest.ts';
import { runAllThreadsCycle, runHarvestCycle, type HarvestDeps, retryUnread } from '../runtime/harvester.ts';
import { decodeSparkProfile } from '../decode/sparkprofile.ts';
import { saveThreadProfile, summariseThreads } from '../analysis/threads.ts';
import { compressRaw, RAW_EXTENSION } from '../ingest/pipeline.ts';
import { SshTmuxConsole } from '../runtime/console.ts';
import { LogTail, judgeLogLines } from '../runtime/logwatch.ts';
import { loadTinyMappings, NO_MAPPINGS, type Mappings } from '../decode/mappings.ts';
import { readLevelDat } from '../model/leveldat.ts';
import { identifyWorld } from '../model/world.ts';
import { worstSeverity } from '../runtime/setup.ts';
import { runSetupPass, tierOf } from '../runtime/remediate.ts';
import { rebuildLedger } from '../ingest/ledger.ts';
import { importUploads } from '../runtime/uploads.ts';
import { scanWatchedFolder } from '../runtime/watch.ts';
import { listServers, getServer, defaultServerId, type ServerConfig } from '../store/servers.ts';
import { recordState, currentState, type MonitorState } from '../store/health.ts';
import { archiveDirOf, diskFloorProblem, findRestoreStubs, forgetCaptures } from '../store/storage.ts';
import { OUTLOOKS, ownModMatcher } from '../analysis/priority.ts';
import * as q from '../query/queries.ts';
import { Governor, lowerOwnPriority, REASON_WORDS, breathe } from '../runtime/throttle.ts';
import { SIDECAR_VERSION, decodeSidecar, upgradeSidecarFile } from '../store/sidecar.ts';
import { capturesWithoutSplit, computeSplit, saveSplit } from '../analysis/split.ts';
import { APP_VERSION, compareVersions } from '../core/changelog.ts';
import { findInstallers, githubDownloadsDir, history as updateHistory, keepInstaller, noteRunningVersion, readReimportList, saveReimportList, updateFolders, updatesDir } from '../runtime/updates.ts';
import { cleanupLocal, compressArchivedRaw } from '../store/retention.ts';
import { cleanupServer } from '../runtime/servercleanup.ts';
import { ingestFile } from '../ingest/pipeline.ts';
import { rebuildActivityRollups } from '../ingest/activityrebuild.ts';
import { backfillIdentity } from '../ingest/identity.ts';
import { hasActivityRollups } from '../store/rollups.ts';
import { findProfileFolders, importObservable, launcherRoots } from '../ingest/observable.ts';
import { downloadRelease, latestRelease } from '../runtime/github.ts';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const root = process.cwd();
const dbFile = flag('db', path.join(root, 'data', 'perfint.sqlite'));
const configDir = flag('config', path.join(root, 'config'));
const logDir = path.join(path.dirname(dbFile), 'logs');
mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'collector.log');

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`;
  try {
    appendFileSync(logFile, line);
  } catch {
    // Logging must never be able to take the collector down.
  }
  if (level !== 'info') process.stderr.write(line);
}

// The Minecraft server runs on this same PC; let the OS prefer it.
const lowered = lowerOwnPriority();

const store = new Store({ file: dbFile });
const settings = new SettingsStore(store.db);
const branding = loadBranding(configDir);
log('info', lowered ? 'running at below-normal priority' : 'could not lower process priority');
{
  const from = noteRunningVersion(store);
  log('info', from === undefined ? `version ${APP_VERSION}` : `updated from ${from} to ${APP_VERSION}`);
}

const governor = new Governor(() => ({
  maxOwnCpuPercent: settings.getNumber('limits.maxCpuPercent'),
  busyHostPercent: settings.getNumber('limits.busyHostPercent'),
  maxRssMb: settings.getNumber('limits.maxRssMb'),
  maxWaitMs: settings.getNumber('limits.maxWaitMinutes') * 60_000,
}));

/**
 * For heavy work started from the tick: may it run now? It may when the PC
 * is calm, or once it has been held back for the longest allowed wait. Each
 * hold is logged once, when it starts and when it ends.
 */
const heldSince = new Map<string, number>();
function heavyAllowed(key: string, label: string): boolean {
  const reason = governor.reason();
  const since = heldSince.get(key);
  if (reason === undefined || (since !== undefined && Date.now() - since >= settings.getNumber('limits.maxWaitMinutes') * 60_000)) {
    if (since !== undefined) {
      heldSince.delete(key);
      log('info', `${label}: resumed after ${Math.round((Date.now() - since) / 1000)} s`);
    }
    return true;
  }
  if (since === undefined) {
    heldSince.set(key, Date.now());
    log('info', `${label}: waiting, because ${REASON_WORDS[reason]}`);
  }
  return false;
}

forgetRestoreStubsIfPending();
repairLedgerIfPending();

/**
 * Take out the seconds-long restore files that used to be archived as
 * captures. Backs the database up first; the files themselves are moved to
 * backups/removed-captures. A ledger rebuild follows, so their time leaves
 * the daily figures too.
 */
function forgetRestoreStubsIfPending(): void {
  const pending = store.getMeta('captures.forgetStubsPending');
  if (pending === undefined || pending === '') return;
  try {
    const stubs = findRestoreStubs(store);
    if (stubs.length > 0) {
      const backupDir = path.join(store.dataDir, 'backups');
      mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, `before-removing-restore-stubs-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
      store.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      const result = forgetCaptures(store, stubs.map((s) => s.id));
      log('info', `removed ${result.removed} restore stub capture(s): ${stubs.map((s) => s.source_name).join(', ')} (backup ${backup})`);
      store.setMeta('ledger.rebuildPending', `${store.getMeta('ledger.rebuildPending') || ''} v11: restore stubs removed`.trim());
    }
    store.setMeta('captures.forgetStubsPending', '');
  } catch (error) {
    log('error', `removing restore stubs failed; nothing lost, retried next start: ${(error as Error).message}`);
  }
}

/**
 * Perform a ledger rebuild that a migration recorded as owed.
 *
 * Runs before the scheduler and the web server, so nothing reads or writes
 * the ledger while it is replaced. The database is copied first; the rebuild
 * itself is one transaction that rolls back unless the new ledger holds
 * exactly the time the captures hold. If it cannot run (a sidecar is
 * missing), the existing ledger is left exactly as it was.
 */
function repairLedgerIfPending(): void {
  const pending = store.getMeta('ledger.rebuildPending');
  if (pending === undefined || pending === '') return;

  const captures = (store.db.prepare('SELECT count(*) AS n FROM capture').get() as { n: number }).n;
  if (captures === 0) {
    store.setMeta('ledger.rebuildPending', '');
    return;
  }

  try {
    const backupDir = path.join(store.dataDir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `before-ledger-rebuild-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    store.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    log('info', `ledger rebuild (${pending}): database backed up to ${backup}`);

    const started = Date.now();
    const result = rebuildLedger(store, {
      minWindows: settings.getNumber('analysis.evidence.minWindows'),
      minSamples: settings.getNumber('analysis.evidence.minSamples'),
    });
    if (!result.ok) {
      log('warn', `ledger rebuild not performed, existing ledger kept: ${result.refused ?? 'unknown reason'}`);
      store.setMeta('ledger.rebuildPending', '');
      store.setMeta('ledger.rebuildRefused', result.refused ?? 'unknown');
      return;
    }
    store.setMeta('ledger.rebuildPending', '');
    store.setMeta('ledger.rebuiltAt', String(Date.now()));
    log('info', `ledger rebuilt from ${result.captures} captures in ${Date.now() - started} ms`);
    for (const day of result.changedDays ?? []) log('info', `  ledger rebuild corrected ${day}`);
  } catch (error) {
    // Rolled back; the old ledger is intact. Retried at the next start.
    log('error', `ledger rebuild failed and was rolled back: ${(error as Error).message}`);
  }
}

// --- servers -----------------------------------------------------------------
//
// One runtime per configured server, rebuilt from its database row on every
// tick, so an edit on the Servers page applies to the very next cycle. Each
// server keeps its own timers and state: a slow or broken server can never
// hold up, reschedule or mislabel another.

interface Runtime {
  config: ServerConfig;
  link: ServerLink;
  linkKey: string;
  harvestInFlight: boolean;
  nextHarvestAt: number;
  logTail: LogTail | undefined;
  logTailFile: string;
  lastSetupSignature: string;
  nextUploadCheckAt: number;
  uploadsInFlight: boolean;
  watchPending: Map<string, { size: number; mtime: number; seenAt: number }>;
}

const runtimes = new Map<string, Runtime>();

/** Record a server's monitoring state when it changes (see store/health.ts). */
function mark(rt: Runtime, state: MonitorState, detail = ''): void {
  try {
    if (recordState(store.db, rt.config.id, state, detail)) {
      log('info', `${rt.config.displayName}: monitoring is now "${state}"${detail === '' ? '' : ` (${detail})`}`);
    }
  } catch (error) {
    log('warn', `${rt.config.displayName}: could not record state: ${(error as Error).message}`);
  }
}
/** The liveness links, by server id -- handed to the web server for status. */
const links = new Map<string, ServerLink>();

function linkFor(config: ServerConfig): { link: ServerLink; key: string } {
  const key = [config.displayName, config.root, config.sparkDir, config.mcHost, config.mcPort].join('|');
  const link = new ServerLink({
    ...DEFAULT_LINK_CONFIG,
    serverId: config.id,
    displayName: config.displayName,
    root: config.root,
    sparkDir: config.sparkDir,
    logFile: 'logs/latest.log',
    pingHost: config.mcHost,
    pingPort: config.mcPort,
    probeIntervalSeconds: settings.getNumber('server.offline.probeIntervalSeconds'),
    backoffMaxSeconds: settings.getNumber('server.offline.maxBackoffMinutes') * 60,
    startupGraceSeconds: settings.getNumber('server.offline.startupGraceMinutes') * 60,
  });
  return { link, key };
}

function syncServers(): Runtime[] {
  const configs = listServers(store.db);
  for (const config of configs) {
    let rt = runtimes.get(config.id);
    if (rt === undefined) {
      const { link, key } = linkFor(config);
      rt = {
        config, link, linkKey: key, harvestInFlight: false, nextHarvestAt: 0, logTail: undefined,
        logTailFile: '', lastSetupSignature: '', nextUploadCheckAt: 0, uploadsInFlight: false,
        watchPending: new Map(),
      };
      runtimes.set(config.id, rt);
      log('info', `tracking server ${config.displayName} (${config.id}): collection ${config.collection}`);
    } else {
      if (rt.config.collection !== config.collection) {
        log('info', `${config.displayName}: collection ${rt.config.collection} -> ${config.collection}`);
        // Switching automatic collection on starts from a fresh schedule.
        if (config.collection === 'automatic') rt.nextHarvestAt = 0;
      }
      rt.config = config;
      const { key } = { key: [config.displayName, config.root, config.sparkDir, config.mcHost, config.mcPort].join('|') };
      if (key !== rt.linkKey) {
        const fresh = linkFor(config);
        rt.link = fresh.link;
        rt.linkKey = fresh.key;
      }
    }
    links.set(config.id, rt.link);
  }
  for (const id of [...runtimes.keys()]) {
    if (!configs.some((c) => c.id === id)) {
      runtimes.delete(id);
      links.delete(id);
    }
  }
  return [...runtimes.values()];
}

/**
 * Pin captures holding unusual evidence, so retention cannot delete them.
 *
 * This runs before anything else in the analysis pass on purpose: if the
 * process is going to fall over, it should fall over having kept the
 * evidence rather than having notified about it.
 */
function pinAnomalies(): void {
  try {
    const summary = applyPins(store.db, settings);
    if (summary.pinned > 0) {
      log('info', `pinned ${summary.pinned} capture(s) holding unusual evidence`);
      for (const decision of summary.decisions) {
        log('info', `  ${decision.sourceName}: ${decision.reasons.map((r) => r.detail).join('; ')}`);
      }
    }
  } catch (error) {
    log('warn', `anomaly pinning: ${(error as Error).message}`);
  }
}

// --- notifications ---------------------------------------------------------
//
// The notifier is deliberately the LAST thing wired and the least privileged
// thing running. Every call site swallows its own failures: a webhook that
// times out, rate-limits or 404s must never affect collection, ingest or
// cleanup.

const notifier = new Notifier(store.db, settings, log);

/**
 * Announce findings that newly became worth a look (a real chance at a real
 * cost, on solid evidence), for servers being collected from. Dedupe is by
 * call path inside the notifier.
 */
async function checkTopFindings(): Promise<void> {
  try {
    for (const rt of runtimes.values()) {
      if (rt.config.collection === 'off') continue;
      const seasonId = q.latestSeasonId(store.db, rt.config.id);
      if (seasonId === undefined) continue;
      const top = findings(store.db, { limit: 40, topOnly: true, seasonId, ownMod: ownModMatcher(settings.getString('analysis.ownMods')) });
      for (const finding of top.slice(0, 5)) {
        const prior =
          finding.knowledge.length === 0
            ? ''
            : `\n\nSeen before: ${finding.knowledge.map((k) => k.entry.title).join('; ')}.`;
        await notifier.notify({
          kind: 'newTopFinding',
          signature: finding.path,
          title: `${OUTLOOKS[finding.priority.outlook].label}: ${finding.label} (${rt.config.displayName})`,
          severity: 'info',
          body:
            `${finding.msPerTick.toFixed(4)} MSPT of its own time, about ${finding.secondsPerDay.toFixed(0)} seconds of ` +
            `tick budget per day. Present in ${Math.round(finding.persistence * 100)}% of windows over ` +
            `${finding.days} day${finding.days === 1 ? '' : 's'}.\n\n` +
            `${finding.priority.outlookWhy}${prior}`,
          fields: [
            { name: 'Attributed', value: finding.source ?? 'unattributed', inline: true },
            { name: 'Evidence', value: finding.priority.confidence, inline: true },
            { name: 'Samples', value: finding.samples.toLocaleString('en-US'), inline: true },
          ],
        });
      }
    }
  } catch (error) {
    log('warn', `finding notifications: ${(error as Error).message}`);
  }
}

/** Announce a new season, which means comparisons across it are now refused. */
async function checkSeasonRollover(): Promise<void> {
  try {
    for (const season of q.seasonOptions(store.db)) {
      await notifier.notify({
        kind: 'seasonRollover',
        signature: `season-${season.id}`,
        title: `New season on ${season.server_name}: ${season.os_name}`,
        severity: 'info',
        body:
          `${season.loader_name} ${season.mc_version} on ${season.os_name}. History before this point ` +
          'belongs to a different environment, so figures are no longer compared across the boundary.',
      });
    }
  } catch (error) {
    log('warn', `season notifications: ${(error as Error).message}`);
  }
}

/**
 * Announce a server that has been down long enough to matter. Not every
 * restart: the signature carries the hour, so a server that stays down
 * re-announces at most hourly.
 */
async function checkOffline(link: ServerLink): Promise<void> {
  const snapshot = link.snapshot();
  if (snapshot.state !== 'offline') return;
  const downForMinutes = (Date.now() - snapshot.since) / 60_000;
  if (downForMinutes < 30) return;

  try {
    await notifier.notify({
      kind: 'collectorOffline',
      signature: `offline-${snapshot.serverId}-${Math.floor(Date.now() / 3_600_000)}`,
      title: `${link.config.displayName} has been unreachable for ${Math.round(downForMinutes)} minutes`,
      severity: 'warn',
      body:
        `${link.describe()}\n\nNothing is being collected from this server. Other servers are unaffected. ` +
        'Probing continues with backoff and collection resumes on its own when the server answers.',
    });
  } catch (error) {
    log('warn', `offline notification: ${(error as Error).message}`);
  }
}

// --- setup drift -----------------------------------------------------------

/**
 * Notice when a modpack rotation has moved the ground underneath a server,
 * and fix what is allowed to be fixed without asking (see remediate.ts).
 * Sends no console command. Announces only when a server's set of problems
 * CHANGES, and always announces a fix it made.
 */
function checkServerSetup(rt: Runtime): void {
  if (!settings.getBoolean('setup.checkOnRotation')) return;
  const name = rt.config.displayName;

  try {
    const pass = runSetupPass(store, settings, rt.config.root, rt.config.id);
    for (const line of pass.fixed) log('info', `${name}: setup fixed: ${line}`);
    for (const line of pass.failed) log('warn', `${name}: setup fix failed: ${line}`);
    if (pass.state === undefined) return;
    const problems = pass.state.findings;

    if (pass.fixed.length > 0 || pass.failed.length > 0) {
      void notifier
        .notify({
          kind: 'harvestFailure',
          signature: `setup-fixed-${rt.config.id}-${Date.now()}`,
          severity: pass.failed.length > 0 ? 'warn' : 'info',
          title: pass.failed.length > 0 ? `A setup fix could not be applied on ${name}` : `${name}: monitoring setup fixed automatically`,
          body: [...pass.fixed, ...pass.failed.map((f) => `Not applied: ${f}`)]
            .join('\n\n')
            .concat('\n\nEach fix is listed on the server page and can be undone there.')
            .slice(0, 3500),
        })
        .catch(() => {});
    }

    const signature = problems.map((f) => f.id).join('|');
    if (signature === rt.lastSetupSignature) return;
    const hadProblems = rt.lastSetupSignature !== '';
    rt.lastSetupSignature = signature;

    if (problems.length === 0) {
      log('info', `${name}: monitoring setup: nothing wrong`);
      if (hadProblems) {
        void notifier
          .notify({
            kind: 'harvestFailure',
            signature: `setup-clear-${rt.config.id}-${Date.now()}`,
            severity: 'info',
            title: `${name}: monitoring setup is intact again`,
            body: 'Everything the setup check looks for is in place.',
          })
          .catch(() => {});
      }
      return;
    }

    const worst = worstSeverity(problems);
    for (const f of problems) {
      log(f.severity === 'blocking' ? 'warn' : 'info', `${name}: setup [${f.severity}] ${f.title}: ${f.observed}`);
    }
    // Only servers being collected from are worth a notification; a server
    // switched off is looked at when someone opens its page.
    if (rt.config.collection === 'off') return;
    void notifier
      .notify({
        kind: 'harvestFailure',
        signature: `setup-${rt.config.id}-${signature}`,
        severity: worst === 'blocking' ? 'bad' : 'warn',
        title:
          worst === 'blocking'
            ? `Monitoring is not working on ${name}`
            : `${name}: monitoring works -- an improvement is available`,
        body: problems
          .map((f) => {
            const tier = tierOf(f, pass.state?.observed);
            const how =
              tier === 'one-click' || tier === 'opt-in' ? ' (one click on the server page)' : tier === 'guidance' ? ' (needs you)' : '';
            return `**${f.title}**\n${f.observed}\n${f.consequence}\n→ ${f.remedy.action}${how}`;
          })
          .join('\n\n')
          .slice(0, 3500),
      })
      .catch(() => {});
  } catch (error) {
    log('warn', `${name}: setup check: ${(error as Error).message}`);
  }
}

// --- world timeline --------------------------------------------------------

/**
 * Record which world a server has loaded, so captures are attributed to the
 * world they actually measured. Reads level.dat and nothing else, on the
 * slow cadence, whatever the collection mode -- except "off", which means
 * nothing is read at all.
 */
function sampleWorld(rt: Runtime): void {
  const { root, id: serverId, displayName } = rt.config;
  if (root === '') return;

  try {
    const result = readLevelDat(root);
    // A server that is down has no readable level.dat; that is normal.
    if (!result.ok || result.facts?.seed === undefined) return;

    const identity = identifyWorld({ seed: result.facts.seed, levelName: result.facts.levelName });
    if (identity.fingerprint === undefined) return;

    const before = store.worlds(serverId).find((w) => w.fingerprint === identity.fingerprint);
    const worldId = store.upsertWorld({
      serverId,
      fingerprint: identity.fingerprint,
      strength: identity.strength,
      seed: identity.seed,
      levelName: identity.levelName,
      seenAt: Date.now(),
    });
    store.recordWorldSighting(serverId, worldId, Date.now(), 'probe');

    if (before === undefined) {
      log('info', `${displayName}: world observed: seed ${identity.seed} (${identity.levelName ?? 'unnamed'})`);
      void notifier
        .notify({
          kind: 'seasonRollover',
          signature: `world-${serverId}-${identity.fingerprint}`,
          title: `A new world is live on ${displayName}`,
          severity: 'info',
          body:
            `Seed ${identity.seed}. Measurements from this point are recorded against it, and are not ` +
            'pooled with the previous world -- a fresh world has no chunk backlog, no entities and no ' +
            'farms, so comparing the two would compare an empty house to a full one.\n\n' +
            'Earlier history is kept in full and stays viewable.',
        })
        .catch(() => {});
    }
  } catch (error) {
    log('warn', `${displayName}: world sampling: ${(error as Error).message}`);
  }
}

// --- mappings ----------------------------------------------------------------

let mappingsCache: { file: string; mappings: Mappings } | undefined;

function currentMappings(): Mappings {
  const file = settings.getString('server.mappingsFile');
  if (file === '') return NO_MAPPINGS;
  if (mappingsCache?.file === file) return mappingsCache.mappings;
  try {
    const mappings = loadTinyMappings(file);
    mappingsCache = { file, mappings };
    return mappings;
  } catch (error) {
    log('warn', `mappings ${file} could not be loaded: ${(error as Error).message}`);
    return NO_MAPPINGS;
  }
}

// --- manual uploads ----------------------------------------------------------

/**
 * Import profiles people uploaded to spark's viewer (see runtime/uploads.ts)
 * for one server. Off unless switched on: it is the one thing that downloads
 * from the internet. Reads activity.json on the server; sends nothing to it.
 */
async function importManualUploads(rt: Runtime): Promise<void> {
  rt.nextUploadCheckAt = Date.now() + 15 * 60_000;
  if (rt.uploadsInFlight || !settings.getBoolean('collection.importUploads') || rt.config.root === '') return;
  if (diskFloorProblem(store, settings) !== undefined) return;

  rt.uploadsInFlight = true;
  try {
    const result = await importUploads({
      store,
      serverId: rt.config.id,
      serverRoot: rt.config.root,
      mappings: currentMappings(),
      archiveDir: archiveDirOf(store, settings),
      archiveRaw: settings.getBoolean('storage.archiveRaw'),
      lookbackMs: 30 * 86_400_000,
      log: (level, message) => log(level, `${rt.config.displayName}: ${message}`),
    });
    if (result.imported + result.failed > 0) {
      log('info', `${rt.config.displayName}: uploads: ${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed`);
    }
  } catch (error) {
    log('warn', `${rt.config.displayName}: uploads: ${(error as Error).message}`);
  } finally {
    rt.uploadsInFlight = false;
  }
}

// --- watch folder ------------------------------------------------------------

function scanWatched(rt: Runtime): void {
  if (rt.config.root === '' || diskFloorProblem(store, settings) !== undefined) return;
  try {
    scanWatchedFolder({
      store,
      serverId: rt.config.id,
      serverRoot: rt.config.root,
      sparkDir: rt.config.sparkDir,
      mappings: currentMappings(),
      archiveDir: archiveDirOf(store, settings),
      archiveRaw: settings.getBoolean('storage.archiveRaw'),
      pending: rt.watchPending,
      log: (level, message) => log(level, `${rt.config.displayName}: ${message}`),
    });
  } catch (error) {
    log('warn', `${rt.config.displayName}: watching: ${(error as Error).message}`);
  }
}

// --- harvest ---------------------------------------------------------------

/**
 * Bring a server's next harvest forward when its log shows background
 * profiling has just been lost. Reads the log only; it never sends anything.
 */
function watchForLostProfiler(rt: Runtime): void {
  if (!settings.getBoolean('collection.harvest.restoreBackgroundProfiler')) return;

  const file = path.join(rt.config.root, 'logs', 'latest.log');
  if (rt.logTail === undefined || rt.logTailFile !== file) {
    rt.logTail = new LogTail(file);
    rt.logTailFile = file;
  }

  const verdict = judgeLogLines(rt.logTail.read());
  if (!verdict.backgroundLikelyLost) return;

  log('info', `${rt.config.displayName}: background profiling appears to have stopped (${verdict.evidence ?? 'profiler ended'}); restoring shortly`);
  mark(rt, 'restoring', verdict.evidence ?? 'profiler ended');
  // A timed profile that ended by uploading has a link in activity.json
  // within seconds; look for it soon rather than at the next slow pass.
  if (/upload/i.test(verdict.evidence ?? '')) rt.nextUploadCheckAt = Math.min(rt.nextUploadCheckAt, Date.now() + 30_000);
  // A short pause, so a person profiling by hand is not interrupted between
  // one timed capture and the next.
  rt.nextHarvestAt = Math.min(rt.nextHarvestAt, Date.now() + 90_000);
}

/**
 * Run one harvest cycle against a server in automatic mode. Only one cycle
 * per server at a time; a failed or skipped cycle retries after a short
 * backoff rather than waiting a whole interval.
 */
function planHarvest(rt: Runtime): void {
  if (rt.harvestInFlight || Date.now() < rt.nextHarvestAt || Date.now() < installHoldUntil) return;
  const { config } = rt;

  let transport: SshTmuxConsole;
  try {
    transport = new SshTmuxConsole({ sshHost: config.sshHost, tmuxTarget: config.tmuxTarget });
  } catch (error) {
    log('error', `${config.displayName}: harvest: ${(error as Error).message}`);
    rt.nextHarvestAt = Date.now() + 15 * 60_000;
    return;
  }

  rt.harvestInFlight = true;
  const deps = {
    console: transport,
    store,
    serverId: config.id,
    decide: harvestOptions(settings),
    localSparkDir: path.join(config.root, config.sparkDir),
    mappings: currentMappings(),
    archiveRaw: settings.getBoolean('storage.archiveRaw'),
    serverRoot: config.root,
    archiveDir: archiveDirOf(store, settings),
    diskProblem: () => diskFloorProblem(store, settings),
    beforeIngest: async () => {
      await governor.whenCalm(`${config.displayName}: importing capture`, (message) => log('info', message));
    },
    keepThreadProfile: (file: string, sha256: string) => keepThreadProfile(config.id, file, sha256),
    log: (level: 'info' | 'warn' | 'error', message: string) => log(level, `${config.displayName}: ${message}`),
  };
  void runHarvestCycle(deps)
    .then(async (outcome) => {
      const interval = settings.getNumber('collection.harvest.intervalMinutes') * 60_000;
      switch (outcome.kind) {
        case 'harvested':
          log(
            'info',
            `${config.displayName}: harvested ${outcome.file} (${outcome.duplicate ? 'already archived' : `capture ${outcome.captureId}`})` +
              (outcome.restarted ? '' : ' -- background profiler restart was NOT confirmed'),
          );
          rt.nextHarvestAt = Date.now() + interval;
          mark(rt, 'collecting', outcome.restarted ? '' : 'background profiler restart not confirmed');
          if (outcome.restarted && allThreadsDue(config.id)) await runAllThreads(rt, deps);
          break;
        case 'all-threads':
          log('info', `${config.displayName}: finished an interrupted all-thread profile (${outcome.file})`);
          rt.nextHarvestAt = Date.now() + 60_000;
          break;
        case 'deferred':
          // Saved and verified on the server; the share just does not show it
          // yet. Not a failure: the next collections read it (harvester.ts).
          log('info', `${config.displayName}: ${outcome.reason}; read at the next collection`);
          rt.nextHarvestAt = Date.now() + interval;
          mark(rt, 'collecting', '');
          break;
        case 'restored':
          log('info', `${config.displayName}: background profiling restored (confirmed: ${outcome.restarted})`);
          rt.nextHarvestAt = Date.now() + interval;
          mark(rt, 'collecting', 'background profiling restored');
          break;
        case 'skipped':
          log('info', `${config.displayName}: harvest skipped -- ${outcome.reason}`);
          // The console being in use clears quickly (a backup's save window is
          // ~20 s); anything else is worth a longer pause.
          rt.nextHarvestAt = Date.now() + (outcome.reason.startsWith('waiting:') ? 60_000 : 5 * 60_000);
          mark(rt, outcome.reason.includes('the floor is') ? 'disk-full' : 'waiting', outcome.reason);
          if (outcome.reason.includes('the floor is')) {
            void notifier
              .notify({
                kind: 'harvestFailure',
                signature: `disk-floor-${Math.floor(Date.now() / 3_600_000)}`,
                severity: 'bad',
                title: 'Collection paused: the archive drive is nearly full',
                body:
                  `Harvesting stopped because ${outcome.reason}. Free some space, lower the floor, or move the ` +
                  'archive to a larger drive (Settings, Storage). spark keeps only its last hour, so history is ' +
                  'being lost while this lasts.',
              })
              .catch(() => {});
          }
          break;
        case 'failed':
          log('warn', `${config.displayName}: harvest failed -- ${outcome.reason}`);
          rt.nextHarvestAt = Date.now() + 5 * 60_000;
          mark(rt, 'failing', outcome.reason);
          void notifier
            .notify({
              kind: 'harvestFailure',
              signature: `harvest-failed-${config.id}-${Math.floor(Date.now() / 3_600_000)}`,
              severity: 'warn',
              title: `Harvest failed on ${config.displayName}`,
              body: `${outcome.reason}\n\nNothing on the server was changed by the failed attempt. It will retry.`,
            })
            .catch(() => {});
          break;
      }
    })
    .catch((error: unknown) => {
      log('error', `${config.displayName}: harvest crashed: ${(error as Error).message}`);
      rt.nextHarvestAt = Date.now() + 5 * 60_000;
    })
    .finally(() => {
      rt.harvestInFlight = false;
    });
}

// --- all-thread profiles ---------------------------------------------------------

function allThreadsDue(serverId: string): boolean {
  if (!settings.getBoolean('collection.allThreads.enabled')) return false;
  const last = Number(store.getMeta(`allThreads.last.${serverId}`) ?? 0);
  return Date.now() - last >= 86_400_000 / Math.max(1, settings.getNumber('collection.allThreads.perDay'));
}

/** Straight after a harvest, while the harvest slot is still held. */
async function runAllThreads(rt: Runtime, deps: HarvestDeps): Promise<void> {
  const seconds = settings.getNumber('collection.allThreads.seconds');
  store.setMeta(`allThreads.last.${rt.config.id}`, String(Date.now()));
  mark(rt, 'collecting', `profiling every thread for ${seconds} s`);
  try {
    const outcome = await runAllThreadsCycle({ ...deps, seconds });
    if (outcome.kind === 'all-threads') {
      log('info', `${rt.config.displayName}: all-thread profile kept (${outcome.file}; background profiling restart confirmed: ${outcome.restarted})`);
      mark(rt, 'collecting', outcome.restarted ? '' : 'background profiler restart not confirmed');
    } else {
      log('warn', `${rt.config.displayName}: all-thread profile: ${outcome.kind === 'skipped' || outcome.kind === 'failed' ? outcome.reason : outcome.kind}`);
      mark(rt, 'collecting', '');
    }
  } catch (error) {
    log('warn', `${rt.config.displayName}: all-thread profile: ${(error as Error).message}`);
  }
  // The next harvest restores background profiling if the stop did not.
  rt.nextHarvestAt = Math.min(rt.nextHarvestAt, Date.now() + 60_000);
}

/** Summarise, archive (compressed) and store an all-thread profile. */
function keepThreadProfile(serverId: string, file: string, sha256: string): number | undefined {
  const bytes = readFileSync(file);
  const profile = decodeSparkProfile(bytes);
  const summary = summariseThreads(profile, currentMappings());
  const capturedAt = profile.metadata.startTime ?? Date.now();
  const dir = path.join(archiveDirOf(store, settings), 'threads');
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${new Date(capturedAt).toISOString().replace(/[:.]/g, '-')}_${sha256.slice(0, 12)}${RAW_EXTENSION}`);
  writeFileSync(target, compressRaw(bytes));
  return saveThreadProfile(store.db, { serverId, capturedAt, sha256, archivePath: store.toStoredPath(target), summary });
}

// --- stalls ------------------------------------------------------------------

/**
 * The failure nobody sees: a server on automatic, answering, not paused, and
 * yet nothing recorded for well over two collection intervals. Every
 * individual step can look fine while this happens, so it is checked from
 * the outcome -- the last capture -- rather than from any step.
 */
function checkStalled(rt: Runtime, paused: boolean): void {
  if (paused || rt.config.collection !== 'automatic' || !rt.link.usable) return;
  const interval = settings.getNumber('collection.harvest.intervalMinutes') * 60_000;
  const limit = 2 * interval + 15 * 60_000;
  const state = currentState(store.db, rt.config.id);
  if (state === undefined || Date.now() - state.since < limit) return; // not long enough in this mode yet
  const last = store.db
    .prepare('SELECT max(started_at) AS t FROM capture WHERE server_id = ?')
    .get(rt.config.id) as { t: number | null };
  if (last.t !== null && Date.now() - last.t < limit) return;
  if (state.state === 'stalled') return;
  const hours = last.t === null ? undefined : (Date.now() - last.t) / 3_600_000;
  mark(rt, 'stalled', hours === undefined ? 'no capture yet' : `last capture ${hours.toFixed(1)} h ago`);
  void notifier
    .notify({
      kind: 'harvestFailure',
      signature: `stalled-${rt.config.id}-${Math.floor(Date.now() / 3_600_000)}`,
      severity: 'bad',
      title: `Nothing recorded on ${rt.config.displayName}${hours === undefined ? '' : ` for ${hours.toFixed(1)} hours`}`,
      body:
        'The server is answering and collection is set to automatic, but no capture has arrived for more than ' +
        'two collection intervals. spark keeps only its last hour, so history is being lost. The collector log ' +
        'and the server page say what the last attempt did.',
    })
    .catch(() => {});
}

// --- scheduler -------------------------------------------------------------

const TICK_MS = 15_000;

/**
 * How often findings are recomputed for notification purposes, and the
 * slow read-only checks run. Recomputing the backlog walks the whole rollup
 * and is the most expensive thing this process does; captures arrive hourly.
 */
const ANALYSIS_INTERVAL_MS = 15 * 60_000;

let ticking = false;
let lastAnalysisAt = 0;

/**
 * New versions from GitHub (optional): one small request every 6 hours; a
 * newer release is downloaded in the background and checked, then offered on
 * the Updates page. Never installed without a click.
 */
const COLLECTOR_STARTED_AT = Date.now();
let lastGithubAt = 0;
let githubDownload: Promise<unknown> | undefined;
let githubDownloading: string | undefined;
async function checkGithub(): Promise<{ version?: string; downloading?: boolean; error?: string }> {
  const repo = settings.getString('updates.githubRepo').trim();
  if (repo === '') return {};
  lastGithubAt = Date.now();
  try {
    const release = await latestRelease(repo, branding.name);
    if (release === undefined || compareVersions(release.version, APP_VERSION) <= 0) return {};
    if (githubDownload === undefined) {
      log('info', `updates: downloading ${release.version} from GitHub`);
      githubDownloading = release.version;
      githubDownload = downloadRelease(release, githubDownloadsDir(store), branding.name, APP_VERSION)
        .then((file) => {
          if (file !== undefined) log('info', `updates: ${release.version} downloaded and verified; ready on the Updates page`);
          // Older downloads are no longer needed.
          for (const old of findInstallers([githubDownloadsDir(store)], branding.name).filter((i) => compareVersions(i.version, release.version) < 0)) {
            rmSync(old.file, { force: true });
            rmSync(old.file.replace(/\.exe$/, '.json'), { force: true });
          }
        })
        .catch((error: unknown) => log('warn', `updates: ${(error as Error).message}`))
        .finally(() => {
          githubDownload = undefined;
          githubDownloading = undefined;
        });
    }
    return { version: release.version, downloading: true };
  } catch (error) {
    log('warn', `updates: GitHub: ${(error as Error).message}`);
    return { error: (error as Error).message };
  }
}

/**
 * Observable profiles saved by the game client on this PC (optional; only
 * packs with Observable make them). A few directory listings every ten
 * minutes; files are only read when new.
 */
let lastObservableAt = 0;
function importObservableProfiles(): void {
  const configured = settings.getString('analysis.observableFolder').trim();
  const folders = configured !== '' ? [configured] : findProfileFolders(launcherRoots());
  if (folders.length === 0) return;
  const serverId = defaultServerId(store.db);
  if (serverId === undefined) return;
  try {
    const r = importObservable(store.db, serverId, folders);
    if (r.imported > 0) log('info', `observable: imported ${r.imported} in-game profile(s)`);
    for (const f of r.failed) log('warn', `observable: ${f}`);
  } catch (error) {
    log('warn', `observable: ${(error as Error).message}`);
  }
}

async function tick(): Promise<void> {
  if (ticking) return; // Never overlap; a slow cycle must not stack up.
  ticking = true;
  try {
    governor.sample();
    const all = syncServers();
    const paused = settings.getBoolean('limits.paused');

    // Each server is serviced independently and concurrently: one
    // unreachable server never delays the others.
    await Promise.all(
      all.map(async (rt) => {
        try {
          rt.link.setPaused(paused);
          // "off" means nothing at all: no probe, no file read.
          if (rt.config.collection === 'off') {
            mark(rt, 'off');
            return;
          }
          if (paused) {
            mark(rt, 'paused');
            return;
          }

          if (Date.now() >= rt.nextUploadCheckAt && heavyAllowed(`uploads-${rt.config.id}`, `${rt.config.displayName}: uploads`)) {
            void importManualUploads(rt);
          }
          if (rt.config.collection === 'watch') {
            mark(rt, 'watching');
            if (heavyAllowed(`watch-${rt.config.id}`, `${rt.config.displayName}: importing saved profiles`)) scanWatched(rt);
            return;
          }

          // automatic
          watchForLostProfiler(rt);
          if (!rt.link.dueForProbe()) return;
          const before = rt.link.state;
          await rt.link.probe();
          if (rt.link.state !== before) {
            log('info', `${rt.config.displayName}: ${before} -> ${rt.link.state} (${rt.link.describe()})`);
          }
          await checkOffline(rt.link);
          if (rt.link.state === 'offline') mark(rt, 'offline', rt.link.describe());
          if (!rt.link.usable) return;
          const now = currentState(store.db, rt.config.id);
          if (now === undefined || ['off', 'paused', 'offline', 'watching'].includes(now.state)) {
            mark(rt, 'waiting', 'waiting for the next harvest');
          }
          planHarvest(rt);
        } catch (error) {
          log('error', `${rt.config.displayName}: ${(error as Error).message}`);
        }
      }),
    );

    if (Date.now() - lastAnalysisAt > ANALYSIS_INTERVAL_MS && heavyAllowed('analysis', 'background checks')) {
      lastAnalysisAt = Date.now();
      for (const rt of all) {
        if (rt.config.collection === 'off') continue;
        sampleWorld(rt);
        checkServerSetup(rt);
        checkStalled(rt, paused);
      }
      pinAnomalies();
      if (Date.now() - lastHousekeepingAt > 86_400_000) {
        lastHousekeepingAt = Date.now();
        housekeeping(all, paused);
      }
      await checkSeasonRollover();
      await checkTopFindings();
      await notifier.flush();
    }
    if (Date.now() - lastGithubAt > 6 * 3_600_000 && Date.now() - COLLECTOR_STARTED_AT > 2 * 60_000) void checkGithub();
    if (Date.now() - lastObservableAt > 10 * 60_000) {
      lastObservableAt = Date.now();
      importObservableProfiles();
    }
  } catch (error) {
    log('error', `scheduler: ${(error as Error).message}`);
  } finally {
    ticking = false;
  }
}

// --- older sidecars ----------------------------------------------------------

/**
 * Rewrite sidecars from before format 2 (which stored every full call path
 * and cost ~10x more to read). One file at a time, only while the PC is calm,
 * each verified before it replaces the old one. Runs once; a failure leaves
 * that file as it was (it stays readable) and is retried next start.
 */
// --- housekeeping ------------------------------------------------------------

/** When the app starts (the first background check) and once a day after. */
let lastHousekeepingAt = 0;

function housekeeping(all: Runtime[], paused: boolean): void {
  // Raw files recorded since the last update are what going back re-imports,
  // so they are kept while going back is on offer (30 days at most).
  const update = [...updateHistory(store)].reverse().find((r) => r.to === APP_VERSION);
  const protectSince = update !== undefined && Date.now() - update.at < 30 * 86_400_000 ? update.at : undefined;
  try {
    const local = cleanupLocal(store, settings, protectSince === undefined ? {} : { protectSince });
    if (local.removed > 0 || local.keptForGoingBack > 0) {
      log(
        'info',
        `local cleanup: removed ${local.removed} raw file(s) older than ${local.days} days (${(local.bytes / 1e6).toFixed(0)} MB); ` +
          `kept ${local.keptPinned} pinned, ${local.keptManual} of your own, ${local.keptForGoingBack} for going back`,
      );
    }
  } catch (error) {
    log('warn', `local cleanup: ${(error as Error).message}`);
  }

  // The kill switch stops server cleanup too.
  if (paused || !settings.getBoolean('cleanup.server.enabled')) return;
  for (const rt of all) {
    if (rt.config.collection !== 'automatic' || rt.config.root === '') continue;
    const dir = path.join(rt.config.root, rt.config.sparkDir);
    if (!existsSync(dir)) {
      log('warn', `${rt.config.displayName}: server cleanup skipped, ${dir} is not reachable`);
      continue;
    }
    try {
      const r = cleanupServer(store, settings, { id: rt.config.id, sparkDirLocal: dir });
      log(
        r.failed.length > 0 ? 'warn' : 'info',
        `${rt.config.displayName}: server cleanup${r.dryRun ? ' (dry run, nothing deleted)' : ''}: ` +
          `${r.dryRun ? 'would remove' : 'removed'} ${r.removed.length} file(s), ${(r.bytes / 1e6).toFixed(0)} MB; ` +
          `kept ${r.keptRecent} recent, ${r.keptNotOurs} not harvested by this app, ${r.keptNotArchived} not archived` +
          (r.failed.length > 0 ? `; ${r.failed.length} kept after a last check failed` : ''),
      );
    } catch (error) {
      log('warn', `${rt.config.displayName}: server cleanup: ${(error as Error).message}`);
    }
  }
}

/**
 * Compress raw captures archived before compression existed. One at a time
 * while the PC is calm; each verified against its recorded hash first.
 */
async function compressOldRaw(): Promise<void> {
  if (store.getMeta('raw.compressed') === '1') return;
  const ids = (store.db
    .prepare("SELECT id FROM capture WHERE archive_path IS NOT NULL AND archive_path NOT LIKE '%.zst' ORDER BY id")
    .all() as Array<{ id: number }>).map((r) => r.id);
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    if (shuttingDown) return;
    while (!heavyAllowed('raw-compress', 'compressing older raw captures')) {
      await breathe(15_000);
      if (shuttingDown) return;
    }
    try {
      if (compressArchivedRaw(store, id) === 'compressed') done += 1;
    } catch (error) {
      failed += 1;
      log('warn', (error as Error).message);
    }
    await breathe(500);
  }
  if (failed === 0) store.setMeta('raw.compressed', '1');
  if (done + failed > 0) log('info', `older raw captures: ${done} compressed, ${failed} left as they were`);
}

async function upgradeOldSidecars(): Promise<void> {
  if (store.getMeta('sidecars.format') === String(SIDECAR_VERSION)) return;
  const rows = store.db
    .prepare('SELECT id, sidecar_path FROM capture WHERE sidecar_path IS NOT NULL ORDER BY id')
    .all() as Array<{ id: number; sidecar_path: string }>;
  let upgraded = 0;
  let missing = 0;
  let failed = 0;
  for (const row of rows) {
    if (shuttingDown) return;
    while (!heavyAllowed('sidecar-upgrade', 'updating older capture files')) {
      await breathe(15_000);
      if (shuttingDown) return;
    }
    const file = store.resolveDataPath(row.sidecar_path);
    try {
      if (file === undefined) missing += 1;
      else if (upgradeSidecarFile(file) === 'upgraded') upgraded += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing += 1;
      else {
        failed += 1;
        log('warn', `capture ${row.id}: ${(error as Error).message}`);
      }
    }
    await breathe(1_000);
  }
  if (failed === 0) store.setMeta('sidecars.format', String(SIDECAR_VERSION));
  if (upgraded + failed > 0 || missing > 0) {
    log('info', `older capture files: ${upgraded} updated, ${failed} failed, ${missing} missing`);
  }
}
/**
 * Where-the-tick-went splits for captures imported before they existed (and
 * any whose split failed). One at a time, only while the PC is calm; the
 * figures that need them say how many are still being prepared.
 */
/**
 * Split the day and season roll-ups by who was online, once, for a database
 * from before the split (ingest/activityrebuild.ts). A capture at a time,
 * only while the PC is calm; every page keeps working on the current figures
 * until it swaps the new ones in. A backup is taken first.
 */
async function splitRollupsByActivity(): Promise<void> {
  if (hasActivityRollups(store.db)) return;
  while (!heavyAllowed('activity-split', 'separating play from idle')) {
    await breathe(15_000);
    if (shuttingDown) return;
  }
  const backup = path.join(store.dataDir, 'backups', `before-activity-split-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  mkdirSync(path.dirname(backup), { recursive: true });
  store.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  log('info', `playing and idle: database backed up to ${backup}; separating the history in the background`);
  const started = Date.now();
  const ok = await rebuildActivityRollups(
    store,
    { minWindows: settings.getNumber('analysis.evidence.minWindows'), minSamples: settings.getNumber('analysis.evidence.minSamples') },
    { allowed: () => heavyAllowed('activity-split', 'separating play from idle'), breathe, stopped: () => shuttingDown },
    (text) => log('info', text),
  );
  if (ok) log('info', `playing and idle: history separated in ${Math.round((Date.now() - started) / 1000)} s`);
}

/**
 * Boots and exact method keys for captures from before v15 (ingest/identity.ts),
 * once, a capture at a time and only while the PC is calm. Rows are re-derived
 * from the raw file and must match the sidecar exactly, so any mappings will do:
 * a mismatch just leaves that capture without keys.
 */
async function fillIdentity(): Promise<void> {
  const pace = { allowed: () => heavyAllowed('identity', 'recording boots and method keys'), breathe, stopped: () => shuttingDown };
  await backfillIdentity(store, (source) => (source === null ? NO_MAPPINGS : currentMappings()), pace, (text) => log('info', text));
}

async function fillSplits(): Promise<void> {
  const todo = capturesWithoutSplit(store.db);
  let done = 0;
  let missing = 0;
  let failed = 0;
  for (const row of todo) {
    if (shuttingDown) return;
    while (!heavyAllowed('split-fill', 'preparing where the tick went')) {
      await breathe(15_000);
      if (shuttingDown) return;
    }
    const file = store.resolveDataPath(row.sidecar_path);
    try {
      if (file === undefined || !existsSync(file)) missing += 1;
      else {
        const sidecar = decodeSidecar(readFileSync(file));
        const split = computeSplit(sidecar.rows, sidecar.windows);
        store.transaction(() => saveSplit(store.db, row.id, split));
        done += 1;
      }
    } catch (error) {
      failed += 1;
      log('warn', `capture ${row.id}: where the tick went: ${(error as Error).message}`);
    }
    await breathe(500);
  }
  if (done + failed + missing > 0) log('info', `where the tick went: ${done} captures prepared, ${failed} failed, ${missing} without detail`);
}

// --- updates -------------------------------------------------------------------

/**
 * Keep a copy of the installer for the version that is running, when one is
 * found, so this version can be gone back to after a later update.
 */
function keepCurrentInstaller(): void {
  try {
    const current = findInstallers(updateFolders(store, settings), branding.name).find((i) => i.version === APP_VERSION);
    if (current !== undefined) keepInstaller(store, current, branding.name);
    // A going-back that was prepared but never carried out leaves its staged
    // database behind; it is a copy, so after a day it is only clutter.
    const dir = updatesDir(store);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (/^rollback-to-.*\.sqlite$/.test(name) && Date.now() - statSync(file).mtimeMs > 86_400_000) rmSync(file, { force: true });
      }
    }
  } catch (error) {
    log('warn', `updates: ${(error as Error).message}`);
  }
}

/**
 * After going back to an earlier version, import again the captures that
 * were recorded after the update (see runtime/updates.ts). One at a time,
 * only while the PC is calm.
 */
async function reimportAfterRollback(): Promise<void> {
  let pending = readReimportList(store);
  if (pending.length === 0) return;
  log('info', `re-importing ${pending.length} capture(s) recorded before going back to ${APP_VERSION}`);
  let imported = 0;
  while (pending.length > 0) {
    if (shuttingDown) return;
    while (!heavyAllowed('reimport', 're-importing captures')) {
      await breathe(15_000);
      if (shuttingDown) return;
    }
    const entry = pending[0]!;
    const serverId = getServer(store.db, entry.serverId) !== undefined ? entry.serverId : defaultServerId(store.db);
    try {
      if (serverId === undefined) throw new Error('no server to import into');
      const result = ingestFile(entry.file, {
        store,
        serverId,
        mappings: currentMappings(),
        archiveDir: archiveDirOf(store, settings),
        archiveRaw: settings.getBoolean('storage.archiveRaw'),
        serverRoot: getServer(store.db, serverId)?.root ?? entry.serverRoot,
      });
      if (result.status === 'ingested') imported += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log('warn', `re-import ${entry.file}: ${(error as Error).message}`);
      else log('warn', `re-import: ${entry.file} is no longer in the archive`);
    }
    pending = pending.slice(1);
    saveReimportList(store, pending);
    await breathe(1_000);
  }
  log('info', `re-import finished: ${imported} capture(s) imported`);
}

/**
 * "Try again now": saved profiles the app gave up reading get their tries
 * back, and the next collection starts straight away (it reads them first).
 */
function retryHarvest(serverId: string): { reset: number; scheduled: boolean } {
  const reset = retryUnread(store.db, serverId);
  const rt = runtimes.get(serverId);
  const scheduled = rt !== undefined && rt.config.collection === 'automatic' && !rt.harvestInFlight;
  if (scheduled) rt!.nextHarvestAt = Date.now();
  log('info', `harvest: tried again by hand (${reset} saved profile(s) given their tries back)`);
  return { reset, scheduled };
}

/** While an install waits, no new collection starts (spark keeps the hour, so nothing is lost). */
let installHoldUntil = 0;

/**
 * Whether now is a good moment to stop monitoring for an update. Asking holds
 * back new collections for a few minutes, so only one already running is
 * waited for; if the install is abandoned, collection carries on by itself.
 */
function updateGate(): string | undefined {
  installHoldUntil = Date.now() + 3 * 60_000;
  for (const rt of runtimes.values()) {
    if (rt.harvestInFlight) return `collecting from ${rt.config.displayName}`;
  }
  return undefined;
}

setTimeout(() => {
  keepCurrentInstaller();
  void reimportAfterRollback().catch((error: unknown) => log('warn', `re-import: ${(error as Error).message}`));
}, 45_000).unref?.();

setTimeout(
  () =>
    void upgradeOldSidecars()
      .then(() => fillSplits())
      .then(() => splitRollupsByActivity())
      .then(() => fillIdentity())
      .then(() => compressOldRaw())
      .catch((error: unknown) => log('warn', `older capture files: ${(error as Error).message}`)),
  60_000,
).unref?.();

const timer = setInterval(() => void tick(), TICK_MS);
timer.unref?.();
void tick();

// --- web server ------------------------------------------------------------

const host = settings.getString('interface.host');
const port = settings.getNumber('interface.port');
const server = createWebServer({
  store, settings, branding, host, port, links, onShutdown: shutdown, updateGate, checkGithub, retryHarvest,
  updateStatus: () => ({ downloading: githubDownloading }),
});

server.listen(port, host, () => {
  log('info', `${branding.name} collector listening on http://${host}:${port}`);
  process.stdout.write(`${branding.name} -> http://${host}:${port}\n`);
});

server.on('error', (error) => {
  log('error', `web server: ${error.message}`);
  process.exit(1);
});

// --- lifecycle -------------------------------------------------------------

let shuttingDown = false;

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `shutting down (${reason})`);
  clearInterval(timer);
  server.close(() => {
    try {
      store.close();
    } catch {
      // Closing a database mid-shutdown is not worth failing over.
    }
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(0), 4000).unref?.();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => shutdown(signal));
}

process.on('uncaughtException', (error) => {
  // The collector staying up matters more than any single failed operation.
  log('error', `uncaught: ${error.stack ?? error.message}`);
});
process.on('unhandledRejection', (reason) => {
  log('error', `unhandled rejection: ${String(reason)}`);
});
