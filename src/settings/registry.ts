/**
 * Settings registry.
 *
 * Every configurable value in the application is declared here once, with its
 * type, default, validation, grouping and -- most importantly -- its RISK
 * TIER. The UI renders from this registry, so adding a setting never means
 * touching the Settings page, and no setting can exist that the UI does not
 * know how to explain or guard.
 *
 * The risk tier is the safety mechanism. Most settings are inert bookkeeping
 * that can change at any time. A few reach into a live Minecraft server, and
 * those must never be applied silently just because someone dragged a slider.
 */

export type SettingType = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'path' | 'secret';

/**
 * How dangerous a change is, and therefore how it is applied.
 *
 *  safe              Applies at the next relevant moment. No confirmation.
 *  restart-collector perfint restarts its own scheduler. The game server is
 *                    untouched; worst case is a missed harvest cycle.
 *  needs-mc-restart  Cannot take effect until Minecraft restarts. Never
 *                    applied automatically, never triggers a restart. Stored
 *                    as pending and shown as such.
 *  disruptive        Reaches into the live server (sends commands, deletes
 *                    files). Requires explicit approval, runs through the
 *                    dry-run and audit path, and is off by default.
 */
export type RiskTier = 'safe' | 'restart-collector' | 'needs-mc-restart' | 'disruptive';

export type SettingGroup =
  | 'Collection'
  | 'Server'
  | 'Setup checks'
  | 'Storage'
  | 'Retention'
  | 'Cleanup'
  | 'Analysis'
  | 'Notifications'
  | 'Limits'
  | 'Updates'
  | 'App';

export interface SettingDef {
  key: string;
  label: string;
  help: string;
  type: SettingType;
  default: string | number | boolean;
  group: SettingGroup;
  /** Advanced settings are real, supported, and kept out of the way. */
  advanced: boolean;
  risk: RiskTier;
  /** Plain-language statement of when a change takes effect. Shown in the UI. */
  appliesAt: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  /** Keys that must be truthy for this setting to do anything. */
  dependsOn?: readonly string[];
  /** Extra warning shown before a change is accepted. */
  warning?: string;
  /**
   * Set when the setting is declared but nothing acts on it yet. The page
   * lists these separately as "planned" rather than showing a control that
   * silently does nothing -- which is what it did until an audit found 25 of
   * them. The text says what happens today instead.
   */
  planned?: string;
}

export const SETTINGS: readonly SettingDef[] = [
  {
    key: 'collection.harvest.intervalMinutes',
    label: 'Collection interval',
    help: 'How often to collect. spark keeps only about an hour, so above 60 leaves gaps. Shorter does not use more storage.',
    type: 'integer',
    default: 60,
    group: 'Collection',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next scheduled harvest',
    unit: 'minutes',
    min: 5,
    max: 60,
  },
  {
    key: 'collection.importUploads',
    label: 'Import profiles you upload to spark',
    help: 'Also archive profiles you run with “/spark profiler … --timeout”, which spark uploads instead of saving. They are downloaded from spark’s site; nothing is uploaded.',
    type: 'boolean',
    default: false,
    group: 'Collection',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Within 15 minutes',
  },
  {
    key: 'collection.allThreads.enabled',
    label: 'Profile every thread a few times a day',
    help: 'A few times a day, profile every thread for two minutes to see what world generation, chunk loading and disk were doing (Other threads page).',
    type: 'boolean',
    default: false,
    group: 'Collection',
    advanced: false,
    risk: 'disruptive',
    appliesAt: 'At the next collection',
    warning: 'Sends two spark commands a few times a day. The server-thread history has a two-minute gap each time.',
  },
  {
    key: 'collection.allThreads.perDay',
    label: 'All-thread profiles per day',
    help: 'Spread evenly: three a day means one every eight hours.',
    type: 'integer',
    default: 3,
    group: 'Collection',
    advanced: true,
    risk: 'safe',
    appliesAt: 'At the next collection',
    min: 1,
    max: 12,
    dependsOn: ['collection.allThreads.enabled'],
  },
  {
    key: 'collection.allThreads.seconds',
    label: 'Length of each all-thread profile',
    help: 'Longer shows more, and leaves a longer gap in the server-thread history.',
    type: 'integer',
    default: 120,
    group: 'Collection',
    advanced: true,
    risk: 'safe',
    appliesAt: 'At the next collection',
    unit: 'seconds',
    min: 30,
    max: 600,
    dependsOn: ['collection.allThreads.enabled'],
  },
  {
    key: 'collection.harvest.restoreBackgroundProfiler',
    label: 'Restore background profiling when it stops',
    help: 'spark stops background profiling when a timed manual profile ends, until the next restart. This starts it again.',
    type: 'boolean',
    default: true,
    group: 'Collection',
    advanced: false,
    risk: 'disruptive',
    appliesAt: 'Next harvest cycle',
    warning: 'Sends “spark profiler start”, and only when no profiler is running.',
  },
  {
    key: 'collection.harvest.minProfilerAgeSeconds',
    label: 'Minimum data before harvesting',
    help: 'Do not harvest a profiler younger than this, since stopping resets it. Capped to fit the collection interval.',
    type: 'integer',
    default: 600,
    group: 'Collection',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next harvest cycle',
    unit: 'seconds',
    min: 30,
    max: 3600,
  },
  {
    key: 'collection.harvest.skipIfIdle',
    label: 'Skip harvest when the server was idle',
    help: 'Skip collection when nobody is on and ticks are fast. Saves storage, but loses the idle baseline.',
    type: 'boolean',
    default: false,
    group: 'Collection',
    advanced: true,
    risk: 'safe',
    planned: 'Every hour is harvested for now, busy or idle.',
    appliesAt: 'Next scheduled harvest',
  },
  {
    key: 'collection.sparkSamplingIntervalMs',
    label: "spark background sampling interval",
    help: 'spark’s background sampling interval. Lower catches small costs better; higher costs the server less.',
    type: 'integer',
    default: 10,
    group: 'Collection',
    advanced: true,
    risk: 'needs-mc-restart',
    appliesAt: 'Next Minecraft restart — perfint will not restart the server',
    unit: 'ms',
    min: 1,
    max: 100,
    warning: 'Written to spark’s config on the server; takes effect when Minecraft restarts.',
  },
  {
    key: 'storage.archiveDir',
    label: 'Archive folder',
    help: 'Where raw profiles and their detail are kept: almost all the space this app uses. Change it with Move, which copies and verifies every file first.',
    type: 'path',
    default: '',
    group: 'Storage',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
  },
  {
    key: 'storage.minFreeGb',
    label: 'Stop ingesting below',
    help: 'Stop taking in new captures below this much free space, so the disk never fills.',
    type: 'integer',
    default: 50,
    group: 'Storage',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    unit: 'GB',
    min: 1,
    max: 1000,
  },
  {
    key: 'storage.archiveRaw',
    label: 'Keep the original .sparkprofile files',
    help: 'Keep spark’s original file for each capture (about 2.3 MB an hour), so it can be opened in spark’s viewer or re-read after an update.',
    type: 'boolean',
    default: true,
    group: 'Storage',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next ingest',
  },

  // ----------------------------------------------------------------- Retention
  {
    key: 'retention.rawDays',
    label: 'Keep raw captures for',
    help: 'How long to keep spark’s original files. What was measured from them stays forever; pinned captures and your own profiles are always kept.',
    type: 'integer',
    default: 15,
    group: 'Retention',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next cleanup run',
    unit: 'days',
    min: 1,
    max: 3650,
  },
  {
    key: 'retention.sidecarDays',
    label: 'Keep per-capture detail for',
    help: 'How long to keep per-minute detail, used by minute views and comparisons (about 2.5 MB an hour).',
    type: 'integer',
    default: 90,
    group: 'Retention',
    advanced: false,
    risk: 'safe',
    planned:
      'Per-minute detail is kept for now: nothing removes it yet (about 57 MB a day, 21 GB a year, with method keys). Removing it would make hour ranges, spike views ' +
      'and patch comparisons impossible for those days, so it waits until space actually calls for it.',
    appliesAt: 'Next cleanup run',
    unit: 'days',
    min: 1,
    max: 3650,
  },
  {
    key: 'retention.ledgerDays',
    label: 'Keep the daily history for',
    help: 'The long-term record behind Findings. 0 keeps it forever; it is small.',
    type: 'integer',
    default: 0,
    group: 'Retention',
    advanced: true,
    risk: 'safe',
    planned: 'The daily ledger is kept forever by design.',
    appliesAt: 'Next cleanup run',
    unit: 'days (0 = forever)',
    min: 0,
    max: 36500,
  },
  {
    key: 'retention.pinAnomalies',
    label: 'Never expire captures containing anomalies',
    help: 'Keep the original file for good when a capture holds a spike, crash or deploy.',
    type: 'boolean',
    default: true,
    group: 'Retention',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next cleanup run',
  },

  // ------------------------------------------------------------------- Cleanup
  {
    key: 'cleanup.server.enabled',
    label: 'Remove harvested profiles from the server',
    help: 'Delete harvested profiles from the server once they are archived and verified (otherwise about 1.4 GB a day piles up). Profiles you save are never touched.',
    type: 'boolean',
    default: false,
    group: 'Cleanup',
    advanced: false,
    risk: 'disruptive',
    appliesAt: 'Next cleanup run',
    warning: 'Deletes files on the live server: only profiles this app harvested, and only while they still match the archived copy.',
  },
  {
    key: 'cleanup.server.dryRun',
    label: 'Dry run (report only, delete nothing)',
    help: 'Log exactly what would be deleted without deleting anything.',
    type: 'boolean',
    default: false,
    group: 'Cleanup',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next cleanup run',
    dependsOn: ['cleanup.server.enabled'],
  },
  {
    key: 'cleanup.server.retentionHours',
    label: 'Keep profiles on the server for',
    help: 'A safety buffer in case this app is offline for a while; the archive itself is on this PC.',
    type: 'integer',
    default: 48,
    group: 'Cleanup',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next cleanup run',
    unit: 'hours',
    min: 1,
    max: 8760,
    dependsOn: ['cleanup.server.enabled'],
  },
  {
    key: 'cleanup.server.minFileAgeMinutes',
    label: 'Never touch files newer than',
    help: 'Guards against reading or deleting a profile spark is still writing.',
    type: 'integer',
    default: 10,
    group: 'Cleanup',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next cleanup run',
    unit: 'minutes',
    min: 1,
    max: 1440,
    dependsOn: ['cleanup.server.enabled'],
  },
  {
    key: 'server.offline.probeIntervalSeconds',
    label: 'Liveness check interval',
    help: 'How often to check that a server is up while it is responding normally.',
    type: 'integer',
    default: 60,
    group: 'Server',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next liveness check',
    unit: 'seconds',
    min: 10,
    max: 3600,
  },
  {
    key: 'server.offline.maxBackoffMinutes',
    label: 'Maximum retry interval when offline',
    help: 'An unreachable server is retried less and less often, up to this.',
    type: 'integer',
    default: 15,
    group: 'Server',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next liveness check',
    unit: 'minutes',
    min: 1,
    max: 240,
  },
  {
    key: 'server.offline.startupGraceMinutes',
    label: 'Startup grace period',
    help: 'After starting, how long before an unreachable server counts as offline rather than still booting.',
    type: 'integer',
    default: 5,
    group: 'Server',
    advanced: true,
    risk: 'safe',
    appliesAt: 'On next collector start',
    unit: 'minutes',
    min: 0,
    max: 120,
  },
  {
    key: 'desktop.startCollectorAtLogin',
    label: 'Start monitoring when Windows starts',
    help: 'Start in the notification area when you sign in, so monitoring carries on after a reboot.',
    type: 'boolean',
    default: true,
    group: 'App',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
  },
  {
    key: 'desktop.showTrayIcon',
    label: 'Show a tray icon',
    help: 'Keeps the app in the notification area so you can open it, pause monitoring, or quit.',
    type: 'boolean',
    default: true,
    group: 'App',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next app start',
  },
  {
    key: 'desktop.closeToTray',
    label: 'Closing the window keeps it running',
    help: 'Closing the window hides it to the tray. Monitoring continues either way.',
    type: 'boolean',
    default: true,
    group: 'App',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
  },
  {
    key: 'desktop.openWindowAtLogin',
    label: 'Open the window at login',
    help: 'Otherwise the app starts in the background and you open the window when you want it.',
    type: 'boolean',
    default: false,
    group: 'App',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next login',
  },
  {
    key: 'setup.checkOnRotation',
    label: 'Check the monitoring setup automatically',
    help: 'Regularly check the spark jar, its config, JVM flags and mappings on the server, and report anything a modpack update broke. Reads only.',
    type: 'boolean',
    default: true,
    group: 'Setup checks',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next cycle',
  },
  {
    key: 'setup.autoFix.analyzerSettings',
    label: "Fix this application's own settings automatically",
    help: 'Fix this app’s own settings, such as mappings for the wrong Minecraft version, without asking. Nothing on the server changes; every fix can be undone.',
    type: 'boolean',
    default: true,
    group: 'Setup checks',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next setup check',
  },
  {
    key: 'setup.autoFix.sparkConfig',
    label: "Repair spark's config automatically",
    help: 'If a modpack update switches background profiling off or changes the interval in spark’s config, put those two keys back. Backed up first and undoable. When off, it is one click on the Overview.',
    type: 'boolean',
    default: false,
    group: 'Setup checks',
    advanced: false,
    risk: 'disruptive',
    warning: 'Writes spark’s config on the server without asking each time. Never restarts anything.',
    appliesAt: 'Next setup check',
  },
  {
    key: 'setup.wantDiagnosticFlags',
    label: 'Prefer accurate inlined-frame attribution',
    help: 'Report when the two JVM flags that attribute small methods accurately are missing. The launcher is only edited when you press the button.',
    type: 'boolean',
    default: true,
    group: 'Setup checks',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next setup check',
  },
  {
    key: 'server.mappingsFile',
    label: 'Mappings file',
    help: 'Yarn mappings for this Minecraft version. Without them the tick figure cannot be computed.',
    type: 'path',
    default: '',
    group: 'Setup checks',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next ingest',
  },

  {
    key: 'analysis.observableFolder',
    label: 'Observable profiles folder',
    help: 'Optional. If your pack has Observable, profiles you run in-game are saved in the game’s observable_profiles folder and show which entities and blocks cost most, with coordinates. Empty looks in the usual launcher folders.',
    type: 'path',
    default: '',
    group: 'Collection',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Within 10 minutes',
  },

  // ------------------------------------------------------------------ Analysis
  {
    key: 'analysis.ownMods',
    label: 'Your own mods',
    help:
      'Mod ids that start with any of these (separate several with commas) are yours. Findings in them, or driven by ' +
      'them, are marked “Your own mod”, because you can change that code directly.',
    type: 'string',
    default: '',
    group: 'Analysis',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
  },
  {
    key: 'analysis.evidence.minWindows',
    label: 'History evidence floor (minutes)',
    help: 'A call path gets its own long-term row once it appears in this many minutes. Smaller ones still count toward their method.',
    type: 'integer',
    default: 2,
    group: 'Analysis',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next ingest',
    min: 1,
    max: 60,
  },
  {
    key: 'analysis.evidence.minSamples',
    label: 'History evidence floor (samples)',
    help: 'As above, by sample count. Passing either is enough.',
    type: 'integer',
    default: 2,
    group: 'Analysis',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next ingest',
    min: 1,
    max: 1000,
  },
  {
    key: 'analysis.thresholds.msptMedianWatch',
    label: 'Tick time — watch',
    help: 'Median tick time above this marks a window as worth attention.',
    type: 'number',
    default: 30,
    group: 'Analysis',
    advanced: false,
    risk: 'safe',
    planned: 'Only the "bad" threshold is used today, for pinning unusual captures.',
    appliesAt: 'Immediately',
    unit: 'ms',
    min: 1,
    max: 50,
    step: 0.5,
  },
  {
    key: 'analysis.thresholds.msptMedianBad',
    label: 'Tick time — bad',
    help: 'Median tick time above this is a problem. At 50 ms the server is losing ticks outright.',
    type: 'number',
    default: 40,
    group: 'Analysis',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    unit: 'ms',
    min: 1,
    max: 50,
    step: 0.5,
  },
  {
    key: 'analysis.thresholds.blockingChunkWaitMs',
    label: 'Blocking chunk load — bad',
    help: 'A server-thread stall longer than this is flagged. These are lost tick time, not idle waiting.',
    type: 'integer',
    default: 1000,
    group: 'Analysis',
    advanced: true,
    risk: 'safe',
    planned: 'Stalls are listed without a threshold today.',
    appliesAt: 'Immediately',
    unit: 'ms',
    min: 50,
    max: 60000,
  },

  // The acceptance gate for an A/B validation. These were the hardcoded
  // numbers inherited from the existing manual workflow; they belong here so
  // the bar can be argued with rather than buried in the engine.
  {
    key: 'analysis.validation.minEffectMsPerTick',
    label: 'Smallest change worth reporting',
    help: 'A difference below this is reported as “no measurable change”, not as a small win.',
    type: 'number',
    default: 0.03,
    group: 'Analysis',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next validation run',
    unit: 'MSPT',
    min: 0.001,
    max: 5,
    step: 0.001,
  },
  {
    key: 'analysis.validation.minWindowsPerSide',
    label: 'Matched windows required per side',
    help: 'Minutes needed before and after a change, at matching player counts, before any verdict.',
    type: 'integer',
    default: 10,
    group: 'Analysis',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Next validation run',
    min: 3,
    max: 500,
  },
  {
    key: 'analysis.validation.playerBucketSize',
    label: 'Player-count bucket width',
    help: 'Minutes are only compared with minutes at a similar player count. Wider finds more data but matches less closely.',
    type: 'integer',
    default: 2,
    group: 'Analysis',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next validation run',
    unit: 'players',
    min: 1,
    max: 20,
  },
  {
    key: 'analysis.validation.comparisonWindowDays',
    label: 'Comparison window',
    help: 'How far either side of a change to look. Longer finds more data but may catch unrelated changes.',
    type: 'integer',
    default: 14,
    group: 'Analysis',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Next validation run',
    unit: 'days',
    min: 1,
    max: 365,
  },

  // ------------------------------------------------------------- Notifications
  {
    key: 'notifications.discord.enabled',
    label: 'Discord notifications',
    help: 'Post important events to a Discord webhook. Outgoing only.',
    type: 'boolean',
    default: false,
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
  },
  {
    key: 'notifications.discord.webhookUrl',
    label: 'Webhook URL',
    help: 'Kept as a credential and never shown in full once saved.',
    type: 'secret',
    default: '',
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.discord.mode',
    label: 'Delivery',
    help: 'Digest batches everything into at most one message per interval. Immediate posts as events happen.',
    type: 'enum',
    default: 'digest',
    options: ['digest', 'immediate'],
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.discord.digestIntervalMinutes',
    label: 'Digest interval',
    help: 'Maximum one message per this many minutes.',
    type: 'integer',
    default: 60,
    group: 'Notifications',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Immediately',
    unit: 'minutes',
    min: 5,
    max: 1440,
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.discord.perEventCooldownMinutes',
    label: 'Minimum gap between notifications of the same type',
    help: 'Stops one noisy kind of event from flooding the channel. 0 turns it off.',
    type: 'integer',
    default: 180,
    group: 'Notifications',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Immediately',
    unit: 'minutes',
    min: 0,
    max: 10080,
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.events.anomalyCaptured',
    label: 'Anomaly captured',
    help: 'Notify when a tick-time excursion is detected and its evidence pinned.',
    type: 'boolean',
    default: true,
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.events.crashEvidence',
    label: 'Crash or watchdog evidence',
    help: 'Notify when a crash report or watchdog kill is detected and evidence preserved.',
    type: 'boolean',
    default: true,
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.events.collectorOffline',
    label: 'Server unreachable',
    help: 'Notify when a monitored server has been unreachable past the backoff threshold.',
    type: 'boolean',
    default: true,
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.events.seasonRollover',
    label: 'New season detected',
    help: 'Notify when a modpack change is detected and a new season begins.',
    type: 'boolean',
    default: true,
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.events.newTopFinding',
    label: 'New finding worth a look',
    help: 'Notify when a finding becomes worth a look now.',
    type: 'boolean',
    default: true,
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.events.regression',
    label: 'Performance regression detected',
    help: 'Notify when a tracked call path gets measurably worse after a deploy.',
    type: 'boolean',
    default: true,
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },
  {
    key: 'notifications.events.harvestFailure',
    label: 'Collection failure',
    help: 'Notify when a harvest fails or perfint has been unable to reach the server.',
    type: 'boolean',
    default: true,
    group: 'Notifications',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    dependsOn: ['notifications.discord.enabled'],
  },

  // -------------------------------------------------------------------- Limits
  {
    key: 'limits.busyHostPercent',
    label: 'Wait while this PC is busier than',
    help: 'Heavy work (reading captures, cleanup) waits while the whole PC is busier than this. Collection itself never waits.',
    type: 'integer',
    default: 75,
    group: 'Limits',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
    unit: '%',
    min: 20,
    max: 100,
  },
  {
    key: 'limits.maxWaitMinutes',
    label: 'Longest wait',
    help: 'After waiting this long, heavy work runs anyway at low priority, so the archive never falls far behind.',
    type: 'integer',
    default: 20,
    group: 'Limits',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Immediately',
    unit: 'min',
    min: 1,
    max: 240,
  },
  {
    key: 'limits.maxCpuPercent',
    label: 'CPU budget',
    help: 'Heavy work also waits while this app has averaged more than this share of one core over the last minute.',
    type: 'integer',
    default: 25,
    group: 'Limits',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Immediately',
    unit: '%',
    min: 5,
    max: 100,
  },
  {
    key: 'limits.maxRssMb',
    label: 'Memory budget',
    help: 'Heavy work waits while this app holds more memory than this.',
    type: 'integer',
    default: 1024,
    group: 'Limits',
    advanced: true,
    risk: 'safe',
    appliesAt: 'Immediately',
    unit: 'MB',
    min: 128,
    max: 16384,
  },
  {
    key: 'limits.paused',
    label: 'Pause all server interaction',
    help: 'Stops all harvesting, cleanup and commands at once. Captures already collected are still read.',
    type: 'boolean',
    default: false,
    group: 'Collection',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
  },

  // ------------------------------------------------------------------- Updates
  {
    key: 'updates.githubRepo',
    label: 'Download new versions from GitHub',
    help: 'The GitHub repository releases are published to (owner/name). New versions are downloaded in the background and checked; installing is still your click. Empty turns this off.',
    type: 'string',
    default: 'dzyfps-git/veyra-pi',
    group: 'Updates',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Within 6 hours, or Check again on Updates',
  },
  {
    key: 'updates.folder',
    label: 'Look for new versions in',
    help: 'The folder where new installers arrive. Empty means your Downloads folder. Only this app’s own installers ("… Setup 1.2.3.exe") are considered, and nothing is installed until you press Install.',
    type: 'path',
    default: '',
    group: 'Updates',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
  },

  // ----------------------------------------------------------------- Interface
  {
    key: 'interface.host',
    label: 'Listen address',
    help: 'Loopback by default. The interface has no password, so do not expose it to a network.',
    type: 'string',
    default: '127.0.0.1',
    group: 'App',
    advanced: true,
    risk: 'restart-collector',
    appliesAt: 'After perfint restarts',
    warning: 'Anything other than 127.0.0.1 exposes an unauthenticated interface to your network.',
  },
  {
    key: 'interface.port',
    label: 'Port',
    help: 'The desktop window connects here; reopen it after changing.',
    type: 'integer',
    default: 9101,
    group: 'App',
    advanced: true,
    risk: 'restart-collector',
    appliesAt: 'After perfint restarts',
    min: 1024,
    max: 65535,
  },
  {
    key: 'interface.theme',
    label: 'Theme',
    help: 'Dark, light, or follow Windows.',
    type: 'enum',
    default: 'dark',
    options: ['dark', 'light', 'system'],
    group: 'App',
    advanced: false,
    risk: 'safe',
    appliesAt: 'Immediately',
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export function settingGroups(): SettingGroup[] {
  const seen: SettingGroup[] = [];
  for (const setting of SETTINGS) if (!seen.includes(setting.group)) seen.push(setting.group);
  return seen;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  value?: string | number | boolean;
}

/** Coerce and validate a raw value against its definition. */
export function validateSetting(key: string, raw: unknown): ValidationResult {
  const def = BY_KEY.get(key);
  if (def === undefined) return { ok: false, error: `unknown setting "${key}"` };

  switch (def.type) {
    case 'boolean': {
      const value = raw === true || raw === 'true' || raw === 1 || raw === '1';
      const falsy = raw === false || raw === 'false' || raw === 0 || raw === '0';
      if (!value && !falsy) return { ok: false, error: 'expected a boolean' };
      return { ok: true, value };
    }
    case 'integer':
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) return { ok: false, error: 'expected a number' };
      if (def.type === 'integer' && !Number.isInteger(value)) return { ok: false, error: 'expected a whole number' };
      if (def.min !== undefined && value < def.min) return { ok: false, error: `must be at least ${def.min}` };
      if (def.max !== undefined && value > def.max) return { ok: false, error: `must be at most ${def.max}` };
      return { ok: true, value };
    }
    case 'enum': {
      const value = String(raw);
      if (def.options !== undefined && !def.options.includes(value)) {
        return { ok: false, error: `must be one of: ${def.options.join(', ')}` };
      }
      return { ok: true, value };
    }
    case 'secret':
    case 'string':
    case 'path':
      return { ok: true, value: String(raw) };
    default:
      return { ok: false, error: 'unsupported setting type' };
  }
}

/** True when changing this setting must be confirmed before it is applied. */
export function requiresApproval(def: SettingDef): boolean {
  return def.risk === 'disruptive' || def.risk === 'needs-mc-restart';
}
