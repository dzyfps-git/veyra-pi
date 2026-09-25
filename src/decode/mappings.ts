/**
 * Yarn "tiny" mapping support.
 *
 * A Fabric server runs on *intermediary* names, so a raw capture is full of
 * `method_29739` and `class_1234`. Mapping them matters for two reasons:
 *
 *  - the ledger is only useful if a call path means the same thing across
 *    captures and is readable by a human or a coding agent; and
 *  - idle-vs-blocked classification anchors on a real Minecraft method name
 *    (`MinecraftServer.waitForTasks`), which is unreachable without mappings.
 *
 * Mappings are per Minecraft version. When none is available for a capture,
 * callers must degrade honestly rather than guess -- see `NO_MAPPINGS`.
 *
 * Supports tiny v1 and tiny v2, gzipped or plain.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export interface Mappings {
  /** intermediary internal name (`net/minecraft/class_1234`) -> named. */
  classes: Map<string, string>;
  /** intermediary method name (`method_1234`) -> named. */
  methods: Map<string, string>;
  /** Where these came from, for provenance in the archive. */
  source: string | null;
  /** False for `NO_MAPPINGS`; lets callers report reduced confidence. */
  available: boolean;
}

export const NO_MAPPINGS: Mappings = {
  classes: new Map(),
  methods: new Map(),
  source: null,
  available: false,
};

export function loadTinyMappings(file: string): Mappings {
  const raw = readFileSync(file);
  const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
  const lines = text.split(/\r?\n/);

  const classes = new Map<string, string>();
  const methods = new Map<string, string>();
  const header = (lines[0] ?? '').split('\t');

  if (header[0] === 'v1') {
    // v1: `v1<TAB>ns0<TAB>ns1...`; CLASS/METHOD rows carry one column per ns.
    const intermediary = header.indexOf('intermediary') - 1;
    const named = header.indexOf('named') - 1;
    if (intermediary < 0 || named < 0) return { ...NO_MAPPINGS, source: file };
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts[0] === 'CLASS') {
        const from = parts[1 + intermediary];
        const to = parts[1 + named];
        if (from !== undefined && to !== undefined) classes.set(from, to);
      } else if (parts[0] === 'METHOD') {
        // METHOD <owner> <desc> <ns0name> <ns1name>...
        const from = parts[3 + intermediary];
        const to = parts[3 + named];
        if (from !== undefined && to !== undefined) methods.set(from, to);
      }
    }
  } else if (header[0] === 'tiny' && header[1] === '2') {
    const intermediary = header.indexOf('intermediary') - 3;
    const named = header.indexOf('named') - 3;
    if (intermediary < 0 || named < 0) return { ...NO_MAPPINGS, source: file };
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts[0] === 'c') {
        const from = parts[1 + intermediary];
        const to = parts[1 + named];
        if (from !== undefined && to !== undefined) classes.set(from, to);
      } else if (parts[0] === '' && parts[1] === 'm') {
        const from = parts[3 + intermediary];
        const to = parts[3 + named];
        if (from !== undefined && to !== undefined) methods.set(from, to);
      }
    }
  } else {
    return { ...NO_MAPPINGS, source: file };
  }

  return { classes, methods, source: file, available: classes.size > 0 || methods.size > 0 };
}

/** Maps a dotted class name. Non-Minecraft classes pass through unchanged. */
export function mapClassName(className: string, mappings: Mappings): string {
  if (className === '') return '<unknown>';
  if (!className.startsWith('net.minecraft.')) return className;

  const internal = className.replaceAll('.', '/');
  const exact = mappings.classes.get(internal);
  if (exact !== undefined) return exact.replaceAll('/', '.');

  // Inner classes and lambda holders are not in the mapping table directly;
  // map the outer class and keep the `$Inner` / `$$Lambda$123` suffix.
  const dollar = internal.indexOf('$');
  if (dollar !== -1) {
    const outer = mappings.classes.get(internal.slice(0, dollar));
    if (outer !== undefined) return `${outer}${internal.slice(dollar)}`.replaceAll('/', '.');
  }
  return className;
}

/**
 * Maps a frame to `Class.method`.
 *
 * Intermediary method names are globally unique, so a name-only lookup is
 * sufficient and avoids needing the owner and descriptor to line up.
 */
export function mapFrame(className: string, methodName: string, mappings: Mappings): string {
  const cls = mapClassName(className, mappings);
  const method = mappings.methods.get(methodName) ?? methodName;
  return `${cls}.${method}`;
}
