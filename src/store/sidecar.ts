/**
 * Per-capture sidecar: the full per-path, per-window detail.
 *
 * SQLite holds what you query across time; this holds what you need when you
 * drill into one capture -- every call path, its self and total time, and its
 * value in each ~1-minute window. Measured at ~3 MB/hour of capture once
 * zstd-compressed (~27 GB/year of continuous collection), against ~47 MB/hour
 * for the raw `.sparkprofile`.
 *
 * Deliberately simple: JSON plus zstd. It is inspectable with standard tools,
 * has no schema-compiler dependency, and decodes in tens of milliseconds. A
 * binary format would be smaller but the compression already does most of that
 * work, and being able to read an archive by hand in five years matters more.
 *
 * Three encodings do the heavy lifting:
 *   - a row's path is stored as its parent row plus the one frame it adds
 *     (version 2). Version 1 stored every full path: ~2,800 characters on
 *     average and 229 MB of JSON for one 19 MB capture, which cost ~0.8 s of
 *     CPU and ~1 GB of memory per ingest on the machine that also runs the
 *     Minecraft server. Version 1 files are still read.
 *   - strings are interned into a dictionary (frames and sources repeat), and
 *   - per-window values are stored sparsely as (window, value) pairs, because
 *     most cells are zero (measured: 9-24% non-zero on hour-scale captures).
 *
 * Method keys (optional, added without a version bump so older builds still
 * read the file and ignore them): `keys` lists each distinct
 * "class<TAB>method<TAB>descriptor" exactly as spark recorded it, and `k` gives
 * each row's index into it. Self-contained on purpose: a sidecar never refers
 * to database ids, so a restored or rebuilt database cannot misread it.
 * Measured at +43-64% per file (+47% on a day of 5-minute captures).
 *
 * Compressed at zstd level 9: 17% smaller than the default level for ~10 ms
 * more CPU per capture, measured on a day of live sidecars. Higher levels save
 * up to 30% but cost 100-200 ms each on the PC that also runs the server.
 * Reading is equally fast at any level.
 */

import { readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib';

import type { FrameCategory } from '../decode/aggregate.ts';

export const SIDECAR_VERSION = 2;
export const READABLE_SIDECAR_VERSIONS: readonly number[] = [1, 2];
const PATH_SEPARATOR = ' > ';
const SIDECAR_ZSTD_LEVEL = 9;

const CATEGORY_CODES: Record<FrameCategory, number> = {
  work: 0,
  idle: 1,
  blocked: 2,
  waiting: 3,
};
const CATEGORY_BY_CODE: FrameCategory[] = ['work', 'idle', 'blocked', 'waiting'];

/**
 * A row as stored: [path, source, parent, depth, self, total, category, selfPairs, totalPairs].
 * In version 2, `path` >= 0 is a dictionary id of the frame added to the
 * parent's path; a negative value -(id + 1) is a whole path, used for roots
 * and for any row whose path does not extend its parent's.
 */
type EncodedRow = [number, number, number, number, number, number, number, number[], number[]];

interface SidecarPayload {
  v: number;
  captureSha: string;
  windows: number[];
  dict: string[];
  rows: EncodedRow[];
  /** Distinct raw method keys, "class\tmethod\tdescriptor". Optional. */
  keys?: string[];
  /** Per row, an index into `keys`. Present exactly when `keys` is. */
  k?: number[];
}

/** A method exactly as the capture recorded it, before any mapping. */
export interface RawKey {
  rawClass: string;
  rawMethod: string;
  rawDesc: string;
}

export function keyString(key: RawKey): string {
  return `${key.rawClass}\t${key.rawMethod}\t${key.rawDesc}`;
}

export function parseKey(text: string): RawKey {
  const [rawClass = '', rawMethod = '', rawDesc = ''] = text.split('\t');
  return { rawClass, rawMethod, rawDesc };
}

/** The keys of a payload, or undefined when absent or not one per row. */
function keysOf(payload: SidecarPayload): { keys: string[]; k: number[] } | undefined {
  const { keys, k } = payload;
  if (!Array.isArray(keys) || !Array.isArray(k) || k.length !== payload.rows.length) return undefined;
  return { keys, k };
}

export interface SidecarRow {
  path: string;
  /**
   * The row's own frame. Use it instead of taking `path` apart: paths are
   * built parent-first and shared until something reads them as text, and
   * splitting every row's path costs ~115 MB per capture.
   */
  label: string;
  source: string | null;
  parentIndex: number;
  depth: number;
  selfMs: number;
  totalMs: number;
  category: FrameCategory;
  selfMsByWindow: number[];
  totalMsByWindow: number[];
}

export interface Sidecar {
  version: number;
  captureSha: string;
  windows: number[];
  rows: SidecarRow[];
  /** Each row's raw method key, parallel to `rows`; undefined for files written without them. */
  keys?: RawKey[];
}

/** Round to microsecond precision; beyond that is sampling noise, not signal. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** What a row needs to be stored. `label` is the frame it adds to its parent's path, when known. */
export interface EncodableRow {
  path: string;
  label?: string;
  source: string | null;
  parentIndex: number;
  depth: number;
  selfMs: number;
  totalMs: number;
  category: FrameCategory;
  selfMsByWindow: readonly number[];
  totalMsByWindow: readonly number[];
  /** The raw method, as decode/aggregate.ts PathRow has it. Keys are stored only when every row has them. */
  className?: string;
  methodName?: string;
  methodDesc?: string;
}

export function encodeSidecar(captureSha: string, windows: readonly number[], rows: readonly EncodableRow[]): Buffer {
  const dict: string[] = [];
  const dictIndex = new Map<string, number>();
  const intern = (value: string): number => {
    let id = dictIndex.get(value);
    if (id === undefined) {
      id = dict.length;
      dict.push(value);
      dictIndex.set(value, id);
    }
    return id;
  };

  const encoded: EncodedRow[] = [];
  rows.forEach((row, index) => {
    // aggregateProfile builds every path as `${parent.path} > ${label}`, so a
    // matching length is enough and the long path string is never touched:
    // reading it would flatten ~80k concatenated strings, which alone cost
    // ~0.4 s of CPU per capture.
    // Without a label (a converted file), the frame is found by comparing
    // strings instead -- slower, and done once per file.
    const parent = row.parentIndex >= 0 && row.parentIndex < index ? rows[row.parentIndex] : undefined;
    let frame: string | undefined;
    if (parent !== undefined) {
      if (row.label !== undefined) {
        if (row.label !== '' && row.path.length === parent.path.length + PATH_SEPARATOR.length + row.label.length) frame = row.label;
      } else if (row.path.startsWith(parent.path + PATH_SEPARATOR) && row.path.length > parent.path.length + PATH_SEPARATOR.length) {
        frame = row.path.slice(parent.path.length + PATH_SEPARATOR.length);
      }
    }
    const pathRef = frame === undefined ? -(intern(row.path) + 1) : intern(frame);
    const selfPairs: number[] = [];
    const totalPairs: number[] = [];
    for (let w = 0; w < windows.length; w += 1) {
      const self = row.selfMsByWindow[w] ?? 0;
      const total = row.totalMsByWindow[w] ?? 0;
      if (self !== 0) selfPairs.push(w, round(self));
      if (total !== 0) totalPairs.push(w, round(total));
    }
    encoded.push([
      pathRef,
      intern(row.source ?? ''),
      row.parentIndex,
      row.depth,
      round(row.selfMs),
      round(row.totalMs),
      CATEGORY_CODES[row.category],
      selfPairs,
      totalPairs,
    ]);
  });

  const payload: SidecarPayload = {
    v: SIDECAR_VERSION,
    captureSha,
    windows: [...windows],
    dict,
    rows: encoded,
  };
  if (rows.length > 0 && rows.every((r) => r.className !== undefined && r.methodName !== undefined)) {
    const keys: string[] = [];
    const keyIndex = new Map<string, number>();
    payload.k = rows.map((r) => {
      const text = keyString({ rawClass: r.className!, rawMethod: r.methodName!, rawDesc: r.methodDesc ?? '' });
      let id = keyIndex.get(text);
      if (id === undefined) {
        id = keys.length;
        keys.push(text);
        keyIndex.set(text, id);
      }
      return id;
    });
    payload.keys = keys;
  }
  return zstdCompressSync(Buffer.from(JSON.stringify(payload), 'utf8'), {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: SIDECAR_ZSTD_LEVEL },
  });
}

export function decodeSidecar(compressed: Buffer): Sidecar {
  const payload = JSON.parse(zstdDecompressSync(compressed).toString('utf8')) as SidecarPayload;
  if (!READABLE_SIDECAR_VERSIONS.includes(payload.v)) {
    throw new Error(`sidecar version ${payload.v} is not supported by this build (expected ${SIDECAR_VERSION} or older)`);
  }

  const windowCount = payload.windows.length;
  const expand = (pairs: number[]): number[] => {
    const out = new Array<number>(windowCount).fill(0);
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const index = pairs[i]!;
      if (index >= 0 && index < windowCount) out[index] = pairs[i + 1]!;
    }
    return out;
  };

  const rows: SidecarRow[] = [];
  for (const row of payload.rows) {
    const source = payload.dict[row[1]] ?? '';
    let path: string;
    let label: string;
    if (payload.v === 1 || row[0] < 0) {
      path = payload.dict[payload.v === 1 ? row[0] : -row[0] - 1] ?? '';
      const cut = path.lastIndexOf(PATH_SEPARATOR);
      label = cut === -1 ? path : path.slice(cut + PATH_SEPARATOR.length);
    } else {
      const parent = rows[row[2]];
      if (parent === undefined) throw new Error(`sidecar row refers to parent ${row[2]} before it appears`);
      label = payload.dict[row[0]] ?? '';
      path = parent.path + PATH_SEPARATOR + label;
    }
    rows.push({
      path,
      label,
      source: source === '' ? null : source,
      parentIndex: row[2],
      depth: row[3],
      selfMs: row[4],
      totalMs: row[5],
      category: CATEGORY_BY_CODE[row[6]] ?? 'work',
      selfMsByWindow: expand(row[7]),
      totalMsByWindow: expand(row[8]),
    });
  }

  const stored = keysOf(payload);
  const parsed = stored?.keys.map(parseKey);
  return {
    version: payload.v,
    captureSha: payload.captureSha,
    windows: payload.windows,
    rows,
    ...(stored === undefined || parsed === undefined ? {} : { keys: stored.k.map((i) => parsed[i] ?? { rawClass: '', rawMethod: '', rawDesc: '' }) }),
  };
}

/**
 * Per-row sums over some of a capture's minutes. What a time range needs,
 * read without building each row's full path or per-minute arrays, which is
 * most of what decodeSidecar spends its time on.
 */
export interface WindowSums {
  windows: number[];
  rows: number;
  parent: Int32Array;
  /** CATEGORY_BY_CODE index. */
  category: Uint8Array;
  self: Float64Array;
  total: Float64Array;
  /** Included minutes with any time in them. */
  present: Uint16Array;
  label(row: number): string;
  /** The row's raw method key, when the file has keys. */
  key(row: number): RawKey | undefined;
}

export const CATEGORY_NAMES: readonly FrameCategory[] = CATEGORY_BY_CODE;

export function sumSidecarWindows(compressed: Buffer, include: (windowId: number) => boolean): WindowSums {
  const payload = JSON.parse(zstdDecompressSync(compressed).toString('utf8')) as SidecarPayload;
  if (!READABLE_SIDECAR_VERSIONS.includes(payload.v)) {
    throw new Error(`sidecar version ${payload.v} is not supported by this build (expected ${SIDECAR_VERSION} or older)`);
  }
  const windowCount = payload.windows.length;
  const stored = keysOf(payload);
  const inc = new Uint8Array(windowCount);
  payload.windows.forEach((id, i) => (inc[i] = include(id) ? 1 : 0));
  const n = payload.rows.length;
  const out: WindowSums = {
    windows: payload.windows,
    rows: n,
    parent: new Int32Array(n),
    category: new Uint8Array(n),
    self: new Float64Array(n),
    total: new Float64Array(n),
    present: new Uint16Array(n),
    label: (i: number): string => {
      const row = payload.rows[i]!;
      if (payload.v !== 1 && row[0] >= 0) return payload.dict[row[0]] ?? '';
      const path = payload.dict[payload.v === 1 ? row[0] : -row[0] - 1] ?? '';
      const cut = path.lastIndexOf(PATH_SEPARATOR);
      return cut === -1 ? path : path.slice(cut + PATH_SEPARATOR.length);
    },
    key: (i: number): RawKey | undefined => {
      const text = stored === undefined ? undefined : stored.keys[stored.k[i] ?? -1];
      return text === undefined ? undefined : parseKey(text);
    },
  };
  for (let r = 0; r < n; r += 1) {
    const row = payload.rows[r]!;
    out.parent[r] = row[2];
    out.category[r] = row[6] >= 0 && row[6] < CATEGORY_BY_CODE.length ? row[6] : 0;
    const selfPairs = row[7];
    let self = 0;
    for (let i = 0; i + 1 < selfPairs.length; i += 2) {
      const w = selfPairs[i]!;
      if (w >= 0 && w < windowCount && inc[w] === 1) self += selfPairs[i + 1]!;
    }
    const totalPairs = row[8];
    let total = 0;
    let present = 0;
    for (let i = 0; i + 1 < totalPairs.length; i += 2) {
      const w = totalPairs[i]!;
      if (w >= 0 && w < windowCount && inc[w] === 1) {
        const v = totalPairs[i + 1]!;
        total += v;
        if (v !== 0) present += 1;
      }
    }
    out.self[r] = self;
    out.total[r] = total;
    out.present[r] = present;
  }
  return out;
}

function rowsEqual(a: SidecarRow, b: SidecarRow): boolean {
  if (
    a.path !== b.path || a.source !== b.source || a.parentIndex !== b.parentIndex || a.depth !== b.depth ||
    a.selfMs !== b.selfMs || a.totalMs !== b.totalMs || a.category !== b.category ||
    a.selfMsByWindow.length !== b.selfMsByWindow.length
  ) {
    return false;
  }
  for (let i = 0; i < a.selfMsByWindow.length; i += 1) {
    if (a.selfMsByWindow[i] !== b.selfMsByWindow[i] || a.totalMsByWindow[i] !== b.totalMsByWindow[i]) return false;
  }
  return true;
}

/**
 * Rewrite an older sidecar in the current format, in place. The new file is
 * decoded and compared row by row with the old one before it replaces it,
 * and row order is kept, so anything keyed by row index stays valid.
 */
export function upgradeSidecarFile(file: string): 'upgraded' | 'current' {
  const compressed = readFileSync(file);
  const old = decodeSidecar(compressed);
  if (old.version === SIDECAR_VERSION) return 'current';
  const fresh = encodeSidecar(old.captureSha, old.windows, old.rows);
  const check = decodeSidecar(fresh);
  if (check.rows.length !== old.rows.length || check.windows.join() !== old.windows.join()) {
    throw new Error(`${file}: converted copy does not match (rows or windows differ); left unchanged`);
  }
  for (let i = 0; i < old.rows.length; i += 1) {
    if (!rowsEqual(old.rows[i]!, check.rows[i]!)) throw new Error(`${file}: converted copy differs at row ${i}; left unchanged`);
  }
  replaceSidecarFile(file, fresh);
  return 'upgraded';
}

/**
 * Replace a sidecar with a new encoding of the same rows (checked by the
 * caller), atomically: written aside, flushed, then renamed over the old one.
 */
export function replaceSidecarFile(file: string, fresh: Buffer): void {
  const temp = `${file}.replacing`;
  try {
    writeFileSync(temp, fresh, { flush: true });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
