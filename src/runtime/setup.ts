/**
 * Does the monitoring setup on the server still match what it needs to be?
 *
 * A modpack rotation replaces `mods/` and usually `config/`, and everything
 * this archive depends on is inside that blast radius. The failure mode is
 * silence: spark disappears, background profiling stops, and the first sign
 * is a gap in history that cannot be filled in afterwards.
 *
 * ## The rule this file is built around
 *
 * **Carry the intent forward, re-derive the mechanism.**
 *
 * What is preserved across a rotation is what the operator wanted: background
 * profiling on, a 10 ms interval, accurate inlined-frame attribution. What is
 * NOT preserved is how that was achieved, because the new pack may use a
 * different loader, a different Java version, a different launcher and a
 * different spark build. Copying the old jar into a NeoForge pack, or writing
 * the old `config.json` over a new one, would be the "blindly overwrite" move
 * that turns a working server into a broken one.
 *
 * So every finding names the intent, states what it observed, and proposes a
 * remedy whose blast radius is stated explicitly. Nothing here applies
 * anything: `remedy.kind` tells the caller what class of action it would be,
 * and the disruptive ones stay behind the same approval gate as everything
 * else that touches the server.
 *
 * ## Minor update versus full rotation
 *
 * They are genuinely different and are reported differently:
 *
 *   minor (4.0.4 -> 4.0.5)  Same Minecraft, loader and Java. spark is usually
 *                           untouched; what breaks is `config/spark/config.json`
 *                           being reset by the pack. Cheap to fix, no restart
 *                           of anything except the server it already needed.
 *
 *   rotation (-> NeoForge)  Minecraft, loader and Java all change. The old
 *                           spark jar is not merely missing, it is WRONG for
 *                           the new loader. The Yarn mappings are wrong too --
 *                           and wrong mappings are worse than none, because
 *                           they decode to plausible nonsense rather than
 *                           failing.
 */

export type SetupSeverity =
  /** Collection is not happening, or would produce wrong data. */
  | 'blocking'
  /** Collection works but is degraded, or will break soon. */
  | 'degraded'
  /** Worth knowing. Nothing is wrong. */
  | 'info';

export type RemedyKind =
  /** Change a setting inside this application. Touches nothing on the server. */
  | 'perfint-setting'
  /** Edit a file inside the writable scope on the server. Approval-gated. */
  | 'server-file'
  /** Needs Minecraft to restart before it takes effect. Never done for you. */
  | 'needs-mc-restart'
  /** A person has to do it: install a mod, download mappings. */
  | 'manual';

export interface SetupRemedy {
  kind: RemedyKind;
  /** What to do, in terms someone can act on. */
  action: string;
  /** The exact change, when there is one. */
  detail?: string;
}

export interface SetupFinding {
  id: string;
  severity: SetupSeverity;
  title: string;
  /** What was observed, as fact. */
  observed: string;
  /** Why it matters, in terms of the archive. */
  consequence: string;
  remedy: SetupRemedy;
}

/** What the operator wants, independent of how any pack achieves it. */
export interface DesiredSetup {
  /** spark must be installed and its background profiler running. */
  backgroundProfiler: boolean;
  /** Sampling interval in ms. spark's own `backgroundProfilerInterval`. */
  samplingIntervalMs: number;
  /** The two flags that make inlined-frame attribution accurate. */
  wantDiagnosticFlags: boolean;
  /** Path to Yarn mappings, which are Minecraft-version specific. */
  mappingsFile: string;
}

/** What the environment currently is, from the archive's own metadata. */
export interface EnvironmentFactsLite {
  minecraftVersion?: string | undefined;
  loaderName?: string | undefined;
  javaMajor?: string | undefined;
  /** What the running server actually uses, from the newest capture: its -X flags and sampling interval. */
  runningFlags?: readonly string[] | undefined;
  runningIntervalMs?: number | undefined;
}

export const DIAGNOSTIC_FLAGS = ['-XX:+UnlockDiagnosticVMOptions', '-XX:+DebugNonSafepoints'] as const;

/** spark's own default for backgroundProfilerInterval, in ms. */
export const SPARK_DEFAULT_INTERVAL_MS = 10;

/** Loader names spark ships a distinct build for. */
const LOADER_ALIASES: Record<string, string> = {
  fabric: 'fabric',
  quilt: 'fabric',
  forge: 'forge',
  neoforge: 'neoforge',
  paper: 'bukkit',
  spigot: 'bukkit',
  bukkit: 'bukkit',
};

export function normaliseLoader(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return LOADER_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
}

/**
 * Does a mappings filename look like it belongs to this Minecraft version?
 *
 * Only ever answers "no" when it can read a version out of the name and that
 * version disagrees. A name it cannot parse yields `undefined` -- unknown,
 * not wrong -- because refusing to work with an unusually-named file would be
 * worse than the risk it guards against.
 */
export function mappingsMatchVersion(
  mappingsFile: string,
  minecraftVersion: string | undefined,
): boolean | undefined {
  if (mappingsFile === '' || minecraftVersion === undefined) return undefined;
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(mappingsFile.replace(/\\/g, '/').split('/').pop() ?? '');
  if (match?.[1] === undefined) return undefined;
  return match[1] === minecraftVersion;
}

/**
 * Which names a loader runs with, and therefore what mappings it needs.
 *
 * This is where a rotation to a different loader most easily goes wrong, and
 * it went wrong in this file's first version: it told a NeoForge 1.21.1 pack
 * to download Yarn mappings, which would have been actively wrong advice.
 *
 *   fabric / quilt       Intermediary names at runtime (method_12345). Needs
 *                        Yarn for that exact Minecraft version to be readable.
 *   neoforge >= 1.20.5   Runs with Mojang's official names. Already readable;
 *                        needs no mappings at all.
 *   forge, and neoforge  SRG names at runtime (m_12345_). Yarn is wrong for
 *     before 1.20.5      these, and SRG decoding is not implemented here, so
 *                        the honest answer is "not supported yet".
 */
export type NamingScheme = 'intermediary' | 'official' | 'srg' | 'unknown';

function versionAtLeast(version: string | undefined, minimum: [number, number, number]): boolean | undefined {
  if (version === undefined) return undefined;
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return undefined;
  for (let i = 0; i < 3; i += 1) {
    const have = parts[i] ?? 0;
    if (have !== minimum[i]) return have > minimum[i]!;
  }
  return true;
}

export function namingScheme(loaderName: string | undefined, minecraftVersion: string | undefined): NamingScheme {
  const loader = normaliseLoader(loaderName);
  if (loader === 'fabric') return 'intermediary';
  if (loader === 'neoforge') {
    const modern = versionAtLeast(minecraftVersion, [1, 20, 5]);
    if (modern === undefined) return 'unknown';
    return modern ? 'official' : 'srg';
  }
  if (loader === 'forge') return 'srg';
  return 'unknown';
}

export interface ObservedForCheck {
  rootReadable: boolean;
  root: string;
  sparkJars: ReadonlyArray<{ fileName: string; version?: string | undefined; loader?: string | undefined }>;
  sparkConfigExists: boolean;
  sparkConfig?: Record<string, unknown> | undefined;
  sparkConfigPath: string;
  jvmArgs?: { mechanism: string; file: string; flags: string[] } | undefined;
  modsDirExists: boolean;
  problems: readonly string[];
}

/**
 * Compare what is there against what is wanted.
 *
 * Pure. Every rotation scenario is exercised in tests without a server,
 * which matters because the situations this guards against happen rarely and
 * at the worst possible moment.
 */
export function checkSetup(
  observed: ObservedForCheck,
  desired: DesiredSetup,
  environment: EnvironmentFactsLite = {},
): SetupFinding[] {
  const findings: SetupFinding[] = [];

  if (!observed.rootReadable) {
    return [
      {
        id: 'root-unreachable',
        severity: 'blocking',
        title: 'The server directory cannot be read',
        observed: `${observed.root} did not respond as a directory.`,
        consequence:
          'Nothing can be collected, no world can be identified, and no setup problem can be detected ' +
          'until this is reachable again. Existing history is untouched.',
        remedy: {
          kind: 'perfint-setting',
          action: 'Check that the share is mounted and that the path in Settings is still correct.',
          detail: `Current value: ${observed.root}`,
        },
      },
    ];
  }

  // --- spark itself --------------------------------------------------------
  const wantLoader = normaliseLoader(environment.loaderName);

  if (observed.sparkJars.length === 0) {
    findings.push({
      id: 'spark-missing',
      severity: 'blocking',
      title: 'spark is not installed',
      observed: observed.modsDirExists
        ? 'No spark jar was found in the mods directory.'
        : 'There is no mods directory to look in.',
      consequence:
        'Nothing is being sampled, so there is no data to archive. This is the normal state immediately ' +
        'after a modpack rotation, because the new pack ships its own mods folder.',
      remedy: {
        kind: 'manual',
        action:
          'Install spark for this pack. It is a mod, so it is never installed automatically — ' +
          'and the previous jar is not reusable if the loader changed.',
        detail:
          wantLoader === undefined
            ? 'Download the spark build matching this pack from https://spark.lucko.me/download'
            : `This pack needs the ${wantLoader} build of spark` +
              (environment.minecraftVersion === undefined ? '' : ` for Minecraft ${environment.minecraftVersion}`) +
              '. https://spark.lucko.me/download',
      },
    });
  } else if (observed.sparkJars.length > 1) {
    findings.push({
      id: 'spark-duplicate',
      severity: 'degraded',
      title: 'More than one spark jar is installed',
      observed: `Found ${observed.sparkJars.map((j) => j.fileName).join(', ')}.`,
      consequence:
        'Two copies of the same mod usually stop the server from starting, and if it does start it is ' +
        'unclear which one is active — so version-specific behaviour cannot be relied on.',
      remedy: {
        kind: 'manual',
        action: 'Remove all but one spark jar, keeping the one built for this loader.',
      },
    });
  } else {
    const jar = observed.sparkJars[0]!;
    const jarLoader = normaliseLoader(jar.loader);
    if (wantLoader !== undefined && jarLoader !== undefined && jarLoader !== wantLoader) {
      findings.push({
        id: 'spark-wrong-loader',
        severity: 'blocking',
        title: 'The installed spark is built for a different loader',
        observed: `${jar.fileName} is the ${jarLoader} build, but this pack runs ${wantLoader}.`,
        consequence:
          'The mod will not load, so nothing is sampled. This is what a modpack rotation looks like when ' +
          'the old jar was carried across by hand.',
        remedy: {
          kind: 'manual',
          action: `Replace it with the ${wantLoader} build of spark.`,
          detail: 'https://spark.lucko.me/download',
        },
      });
    }
  }

  // --- background profiling ------------------------------------------------
  if (desired.backgroundProfiler) {
    if (!observed.sparkConfigExists) {
      findings.push({
        id: 'spark-config-missing',
        severity: 'blocking',
        title: "spark's configuration is missing",
        observed: `${observed.sparkConfigPath} does not exist.`,
        consequence:
          'spark defaults background profiling ON for servers, so this may be harmless — but the setting ' +
          'is no longer pinned, and a future spark version changing its default would switch collection ' +
          'off silently.',
        remedy: {
          kind: 'server-file',
          action: 'Write a minimal spark config that pins background profiling on.',
          detail: JSON.stringify({ backgroundProfiler: true }, null, 2),
        },
      });
    } else {
      const enabled = observed.sparkConfig?.['backgroundProfiler'];
      if (enabled === false) {
        findings.push({
          id: 'background-profiler-off',
          severity: 'blocking',
          title: 'Background profiling is switched off',
          observed: `${observed.sparkConfigPath} sets backgroundProfiler to false.`,
          consequence:
            'Nothing is being sampled between manual profiles, so there is no continuous history to ' +
            'archive. This is the single setting the whole archive depends on.',
          remedy: {
            kind: 'needs-mc-restart',
            action: 'Set backgroundProfiler to true, then restart the server.',
            detail: 'Only this key changes; every other key in the file is left as the pack shipped it.',
          },
        });
      }

      // A pack that says nothing about the interval gets spark's own default,
      // 10 ms, so absence is compared as 10 rather than skipped.
      const configured = observed.sparkConfig?.['backgroundProfilerInterval'];
      const interval = typeof configured === 'number' ? configured : SPARK_DEFAULT_INTERVAL_MS;
      if (observed.sparkConfig !== undefined && interval !== desired.samplingIntervalMs) {
        findings.push({
          id: 'sampling-interval-differs',
          severity: 'degraded',
          title: 'The sampling interval is not what you asked for',
          observed:
            `spark ${typeof configured === 'number' ? 'is configured for' : 'uses its default of'} ${interval} ms; ` +
            `the preference is ${desired.samplingIntervalMs} ms.`,
          consequence:
            interval > desired.samplingIntervalMs
              ? 'Coarser sampling means fewer samples behind every figure, which hits small recurring costs ' +
                'hardest — exactly the findings this archive exists to surface.'
              : 'Finer sampling costs more overhead than you asked for.',
          remedy: {
            kind: 'needs-mc-restart',
            action: `Set backgroundProfilerInterval to ${desired.samplingIntervalMs}, then restart.`,
          },
        });
      } else if (observed.sparkConfig !== undefined && environment.runningIntervalMs !== undefined && environment.runningIntervalMs !== interval) {
        findings.push({
          id: 'sampling-interval-not-running',
          severity: 'info',
          title: 'The new sampling interval is written but not running yet',
          observed: `spark's config says ${interval} ms; the newest capture was still sampled every ${environment.runningIntervalMs} ms.`,
          consequence: 'Nothing is wrong: spark reads its config when the server starts.',
          remedy: { kind: 'needs-mc-restart', action: 'Restart the server when convenient.' },
        });
      }
    }
  }

  // --- JVM flags -----------------------------------------------------------
  if (desired.wantDiagnosticFlags) {
    if (observed.jvmArgs === undefined) {
      findings.push({
        id: 'jvm-args-unknown',
        severity: 'degraded',
        title: 'Where JVM flags are configured could not be determined',
        observed:
          'None of the launcher layouts this recognises were found (variables.txt, user_jvm_args.txt, start.sh).',
        consequence:
          'The inlined-frame attribution flags cannot be checked or proposed. Collection still works; ' +
          'attribution of small hot methods is less accurate.',
        remedy: {
          kind: 'manual',
          action:
            'Add the flags to whatever launches the server, wherever that pack keeps them. ' +
            'Nothing is edited automatically here, because editing the wrong launcher file breaks startup.',
          detail: DIAGNOSTIC_FLAGS.join(' '),
        },
      });
    } else {
      const missing = DIAGNOSTIC_FLAGS.filter((flag) => !observed.jvmArgs!.flags.includes(flag));
      const notRunning =
        environment.runningFlags === undefined ? [] : DIAGNOSTIC_FLAGS.filter((flag) => !environment.runningFlags!.includes(flag));
      if (missing.length === 0 && notRunning.length > 0) {
        findings.push({
          id: 'jvm-flags-not-running',
          severity: 'info',
          title: 'The attribution flags are written but not running yet',
          observed: `${observed.jvmArgs.file} has ${notRunning.join(' ')}, but the newest capture's server was started without ${notRunning.length === 1 ? 'it' : 'them'}.`,
          consequence: 'Nothing is wrong: JVM flags take effect when the server starts.',
          remedy: { kind: 'needs-mc-restart', action: 'Restart the server when convenient.' },
        });
      }
      if (missing.length > 0) {
        findings.push({
          id: 'jvm-flags-missing',
          severity: 'degraded',
          title: 'Inlined-frame attribution flags are not set',
          observed: `${observed.jvmArgs.mechanism} does not include ${missing.join(' ')}.`,
          consequence:
            'Collection works without these -- this is an improvement, not a fault, and there is no ' +
            'reason to hold collection back for it. With them, small hot methods are attributed more ' +
            'precisely: the JIT can fold a 0.15 MSPT method into its caller, and the profiler then ' +
            'names the caller. Existing captures stay valid; the restart that adds them is recorded as ' +
            'its own change, so no before/after comparison will mistake the flag for a patch.',
          remedy: {
            kind: 'needs-mc-restart',
            action: `Add ${missing.join(' ')} to ${observed.jvmArgs.file}, then restart.`,
            detail: `Mechanism detected: ${observed.jvmArgs.mechanism}. Current flags: ${observed.jvmArgs.flags.join(' ') || '(none)'}`,
          },
        });
      }
    }
  }

  // --- mappings ------------------------------------------------------------
  // What the loader runs with decides what is needed at all, BEFORE any
  // question of versions. Checking Yarn versions on a NeoForge pack would
  // produce confident, wrong advice.
  const scheme = namingScheme(environment.loaderName, environment.minecraftVersion);

  if (scheme === 'official') {
    if (desired.mappingsFile !== '') {
      findings.push({
        id: 'mappings-not-needed',
        severity: 'info',
        title: 'Mappings are not needed for this loader',
        observed:
          `This pack runs NeoForge on Minecraft ${environment.minecraftVersion}, which uses Mojang's ` +
          'official names directly, so frames are already readable.',
        consequence:
          'The configured Yarn file matches nothing in these captures and has no effect. It is harmless, ' +
          'but clearing it avoids confusion if the pack changes again.',
        remedy: { kind: 'perfint-setting', action: 'Clear the mappings setting for this pack.' },
      });
    }
  } else if (scheme === 'srg') {
    findings.push({
      id: 'mappings-srg-unsupported',
      severity: 'degraded',
      title: "This loader's method names cannot be decoded yet",
      observed:
        `${environment.loaderName ?? 'This loader'} on Minecraft ${environment.minecraftVersion ?? '?'} runs with ` +
        'SRG names (m_12345_), which this application does not translate.',
      consequence:
        'Captures still archive and mod attribution still works, but vanilla method names stay obfuscated ' +
        'and the headline tick figure cannot be computed. Yarn mappings would be WRONG here, not merely absent.',
      remedy: {
        kind: 'manual',
        action: 'Nothing to install. This is a limitation of the analyzer, reported so it is not mistaken for a fault.',
      },
    });
  }

  const mappingsOk =
    scheme === 'intermediary' || scheme === 'unknown'
      ? mappingsMatchVersion(desired.mappingsFile, environment.minecraftVersion)
      : undefined;
  if (scheme !== 'intermediary' && scheme !== 'unknown') {
    // Handled above; nothing more to say about Yarn for these loaders.
  } else if (desired.mappingsFile === '') {
    findings.push({
      id: 'mappings-missing',
      severity: 'degraded',
      title: 'No mappings are configured',
      observed: 'The mappings setting is empty.',
      consequence:
        'Headline tick figures cannot be computed, because the anchor method cannot be identified. ' +
        'Captures still archive; they just report no tick time rather than a guessed one.',
      remedy: {
        kind: 'perfint-setting',
        action: 'Point the mappings setting at a Yarn tiny mappings file for this Minecraft version.',
      },
    });
  } else if (mappingsOk === false) {
    findings.push({
      id: 'mappings-wrong-version',
      severity: 'blocking',
      title: 'The mappings are for a different Minecraft version',
      observed:
        `The configured mappings file names a different version than the ${environment.minecraftVersion} ` +
        'this environment reports.',
      consequence:
        'Wrong mappings are worse than none. They decode to plausible-looking but incorrect method names, ' +
        'so findings would name the wrong code and every comparison against older seasons would be ' +
        'meaningless. This is the usual state immediately after a Minecraft version change.',
      remedy: {
        kind: 'perfint-setting',
        action: `Download Yarn mappings for Minecraft ${environment.minecraftVersion} and update the setting.`,
        detail: 'Until then it is safer to clear the setting than to leave the wrong file in place.',
      },
    });
  }

  for (const problem of observed.problems) {
    findings.push({
      id: `scan-problem-${findings.length}`,
      severity: 'info',
      title: 'Part of the server could not be inspected',
      observed: problem,
      consequence: 'That part of the setup could not be checked, so it is reported as unknown rather than fine.',
      remedy: { kind: 'manual', action: 'Check permissions and that the path still exists.' },
    });
  }

  return findings;
}

/** The worst severity present, for a badge. */
export function worstSeverity(findings: readonly SetupFinding[]): SetupSeverity | undefined {
  if (findings.some((f) => f.severity === 'blocking')) return 'blocking';
  if (findings.some((f) => f.severity === 'degraded')) return 'degraded';
  if (findings.length > 0) return 'info';
  return undefined;
}
