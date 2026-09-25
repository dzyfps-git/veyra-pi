/**
 * Read what monitoring setup actually exists on the server right now.
 *
 * Read-only throughout. This answers "what is there", never "what should be
 * there" — the comparison lives in `setup.ts`, deliberately separated so the
 * judgement can be tested without a filesystem and the observation can be
 * trusted without a policy baked into it.
 *
 * ## Why this exists
 *
 * A modpack rotation replaces `mods/` and usually `config/`. Everything the
 * archive depends on is in that blast radius:
 *
 *   - the spark jar itself, which may vanish, change version, or change
 *     loader (fabric -> neoforge)
 *   - `config/spark/config.json`, which carries `backgroundProfiler`
 *   - the JVM flags, which live in whatever launcher the new pack ships
 *   - the Yarn mappings, which are version-specific and become WRONG rather
 *     than merely missing when Minecraft changes
 *
 * None of that announces itself. Without a scan, the first sign of trouble is
 * a silent gap in history, which is the one failure this project exists to
 * prevent.
 *
 * ## Deliberately not clever
 *
 * Every field is either read or left undefined. Nothing is inferred from
 * something else, because a rotation is exactly when inference goes wrong:
 * the old loader is not evidence of the new one, and a jar that is present is
 * not evidence that it loaded.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import * as path from 'node:path';

export interface SparkJar {
  fileName: string;
  /** Parsed from the filename, e.g. "1.10.53". Undefined when unparseable. */
  version?: string;
  /** fabric | forge | neoforge | bukkit | ... as the filename states it. */
  loader?: string;
  bytes: number;
  modifiedAt: number;
}

export interface JvmArgsSource {
  /** Which launcher mechanism was found. */
  mechanism: 'variables.txt' | 'user_jvm_args.txt' | 'start.sh' | 'unknown';
  file: string;
  /** The flags as written, split on whitespace. */
  flags: string[];
  /** The exact line or region the flags came from, for a precise edit later. */
  excerpt?: string;
}

export interface ObservedSetup {
  root: string;
  rootReadable: boolean;

  /** Every spark-looking jar found. More than one is itself a problem. */
  sparkJars: SparkJar[];
  observableJars: SparkJar[];

  /** Parsed config/spark/config.json, or undefined when absent/unreadable. */
  sparkConfig?: Record<string, unknown>;
  sparkConfigPath: string;
  sparkConfigExists: boolean;

  /** Where JVM flags are configured, when a known mechanism was found. */
  jvmArgs?: JvmArgsSource;

  /** From server.properties, when readable. */
  levelName?: string;

  /** Directories the collector needs. */
  modsDirExists: boolean;
  sparkDirExists: boolean;
  logsDirExists: boolean;

  /** Anything that stopped the scan from seeing more. */
  problems: string[];
}

/** `spark-1.10.53-fabric.jar` -> { version: "1.10.53", loader: "fabric" } */
export function parseSparkFileName(fileName: string): { version?: string; loader?: string } {
  const match = /^spark[-_]?v?(\d+(?:\.\d+)*)[-_]?([a-z]+)?\.jar$/i.exec(fileName);
  if (match === null) return {};
  const out: { version?: string; loader?: string } = {};
  if (match[1] !== undefined) out.version = match[1];
  if (match[2] !== undefined) out.loader = match[2].toLowerCase();
  return out;
}

function scanJars(dir: string, pattern: RegExp): SparkJar[] {
  const out: SparkJar[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const name of entries) {
    if (!pattern.test(name)) continue;
    try {
      const stats = statSync(path.join(dir, name));
      if (!stats.isFile()) continue;
      const parsed = parseSparkFileName(name);
      out.push({
        fileName: name,
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
        ...(parsed.loader === undefined ? {} : { loader: parsed.loader }),
        bytes: stats.size,
        modifiedAt: stats.mtimeMs,
      });
    } catch {
      // A jar that cannot be stat'd is simply not reported.
    }
  }
  return out;
}

/**
 * Find where JVM flags are configured.
 *
 * Modpack launchers differ, and a rotation can change the mechanism as well
 * as the values. Each known shape is tried in turn; an unrecognised layout
 * reports `unknown` rather than guessing at a file to edit, because a wrong
 * guess here means editing something that launches the server.
 */
export function findJvmArgs(root: string): JvmArgsSource | undefined {
  // ServerStarterJar / modpack launcher style.
  const variables = path.join(root, 'variables.txt');
  if (existsSync(variables)) {
    try {
      const text = readFileSync(variables, 'utf8');
      const flags: string[] = [];
      const lines: string[] = [];
      for (const key of ['JAVA_ARGS', 'ADDITIONAL_ARGS']) {
        const match = new RegExp(`^${key}\\s*=\\s*"?([^"\\n]*)"?\\s*$`, 'm').exec(text);
        if (match?.[1] !== undefined) {
          flags.push(...match[1].split(/\s+/).filter((f) => f !== ''));
          lines.push(`${key}="${match[1]}"`);
        }
      }
      if (lines.length > 0) {
        return { mechanism: 'variables.txt', file: variables, flags, excerpt: lines.join('\n') };
      }
    } catch {
      // Fall through.
    }
  }

  // Forge / NeoForge style: one argument per line.
  const userArgs = path.join(root, 'user_jvm_args.txt');
  if (existsSync(userArgs)) {
    try {
      const text = readFileSync(userArgs, 'utf8');
      const flags = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'));
      return { mechanism: 'user_jvm_args.txt', file: userArgs, flags, excerpt: flags.join('\n') };
    } catch {
      // Fall through.
    }
  }

  // A plain shell launcher.
  const startSh = path.join(root, 'start.sh');
  if (existsSync(startSh)) {
    try {
      const text = readFileSync(startSh, 'utf8');
      const javaLine = text.split(/\r?\n/).find((l) => /\bjava\b/.test(l) && /-X|-jar/.test(l));
      if (javaLine !== undefined) {
        return {
          mechanism: 'start.sh',
          file: startSh,
          flags: javaLine.split(/\s+/).filter((f) => f.startsWith('-')),
          excerpt: javaLine.trim(),
        };
      }
    } catch {
      // Fall through.
    }
  }

  return undefined;
}

export function scanServer(root: string): ObservedSetup {
  const problems: string[] = [];
  const sparkConfigPath = path.join(root, 'config', 'spark', 'config.json');

  const setup: ObservedSetup = {
    root,
    rootReadable: false,
    sparkJars: [],
    observableJars: [],
    sparkConfigPath,
    sparkConfigExists: false,
    modsDirExists: false,
    sparkDirExists: false,
    logsDirExists: false,
    problems,
  };

  try {
    setup.rootReadable = statSync(root).isDirectory();
  } catch {
    problems.push(`the server directory ${root} could not be read; nothing else could be checked`);
    return setup;
  }

  const modsDir = path.join(root, 'mods');
  setup.modsDirExists = existsSync(modsDir);
  setup.sparkDirExists = existsSync(path.join(root, 'config', 'spark'));
  setup.logsDirExists = existsSync(path.join(root, 'logs'));

  if (setup.modsDirExists) {
    setup.sparkJars = scanJars(modsDir, /^spark.*\.jar$/i);
    setup.observableJars = scanJars(modsDir, /^observable.*\.jar$/i);
  } else {
    problems.push('no mods directory, so no mod could be checked for');
  }

  setup.sparkConfigExists = existsSync(sparkConfigPath);
  if (setup.sparkConfigExists) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(sparkConfigPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        setup.sparkConfig = parsed as Record<string, unknown>;
      } else {
        problems.push(`${sparkConfigPath} is not a JSON object`);
      }
    } catch (error) {
      problems.push(`${sparkConfigPath} could not be parsed: ${(error as Error).message}`);
    }
  }

  const jvm = findJvmArgs(root);
  if (jvm !== undefined) setup.jvmArgs = jvm;

  try {
    const propsPath = path.join(root, 'server.properties');
    if (existsSync(propsPath)) {
      const text = readFileSync(propsPath, 'utf8');
      const match = /^level-name\s*=\s*(.+)$/m.exec(text);
      if (match?.[1] !== undefined) setup.levelName = match[1].trim();
    }
  } catch {
    // level-name is a convenience, not a requirement.
  }

  return setup;
}
