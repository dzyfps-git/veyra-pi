/**
 * `measure-storage` -- ground the storage design in real numbers.
 *
 * The plan estimated a 20-50x reduction from raw `.sparkprofile` to decoded
 * columnar form. This measures it against the actual archive instead, and
 * reports the row volumes that decide whether per-capture path rows can live
 * in SQLite or need a sidecar.
 *
 * Read-only.
 *
 *   node src/cli/measure-storage.ts <profilesRoot> [--limit N] [--mappings yarn-tiny.gz]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { zstdCompressSync, gzipSync } from 'node:zlib';
import * as path from 'node:path';

import { decodeSparkProfile } from '../decode/sparkprofile.ts';
import { aggregateProfile } from '../decode/aggregate.ts';
import { loadTinyMappings, mapFrame, NO_MAPPINGS } from '../decode/mappings.ts';

function findProfiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.sparkprofile')) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Encode per-path per-window series the way the sidecar would: a string
 * dictionary plus sparse (window, value) pairs, since most cells are zero.
 */
function encodeSidecar(rows: ReturnType<typeof aggregateProfile>['rows'], windows: number[]): Buffer {
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

  const records: unknown[] = [];
  for (const row of rows) {
    const self: number[] = [];
    const total: number[] = [];
    for (let w = 0; w < windows.length; w += 1) {
      const s = row.selfMsByWindow[w] ?? 0;
      const t = row.totalMsByWindow[w] ?? 0;
      if (s !== 0) self.push(w, Math.round(s * 1000) / 1000);
      if (t !== 0) total.push(w, Math.round(t * 1000) / 1000);
    }
    records.push([
      intern(row.path),
      intern(row.source ?? ''),
      row.parentIndex,
      row.depth,
      Math.round(row.selfMs * 1000) / 1000,
      Math.round(row.totalMs * 1000) / 1000,
      row.category === 'work' ? 0 : row.category === 'idle' ? 1 : row.category === 'blocked' ? 2 : 3,
      self,
      total,
    ]);
  }

  return Buffer.from(JSON.stringify({ windows, dict, records }), 'utf8');
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(2);
}

function main(): void {
  const root = process.argv[2];
  const limitFlag = process.argv.indexOf('--limit');
  const limit = limitFlag === -1 ? Infinity : Number(process.argv[limitFlag + 1] ?? Infinity);
  if (root === undefined) {
    console.error('usage: node src/cli/measure-storage.ts <profilesRoot> [--limit N] [--mappings yarn-tiny.gz]');
    process.exit(2);
  }

  const mappingsFlag = process.argv.indexOf('--mappings');
  let mappings = NO_MAPPINGS;
  try {
    if (mappingsFlag !== -1) mappings = loadTinyMappings(process.argv[mappingsFlag + 1] ?? '');
  } catch {
    // Mapping availability does not affect the volumes being measured.
  }

  const files = findProfiles(root).slice(0, limit);
  console.log(
    'capture'.padEnd(22),
    'ms'.padStart(4),
    'raw MB'.padStart(7),
    'gz'.padStart(6),
    'zstd'.padStart(6),
    'paths'.padStart(7),
    'win'.padStart(4),
    'cells%'.padStart(7),
    'side MB'.padStart(8),
    'ratio'.padStart(6),
  );

  interface Sample {
    intervalMicros: number;
    rawBytes: number;
    rawZstdBytes: number;
    sidecarZstdBytes: number;
    paths: number;
    minutes: number;
  }
  const samples: Sample[] = [];

  for (const file of files) {
    const bytes = readFileSync(file);
    const rawSize = statSync(file).size;
    const profile = decodeSparkProfile(bytes);
    const agg = aggregateProfile(profile, {
      renameFrame: (c, m) => mapFrame(c, m, mappings),
      mappingsAvailable: mappings.available,
    });

    const windowCount = profile.timeWindows.length;
    const sidecarZstd = zstdCompressSync(encodeSidecar(agg.rows, profile.timeWindows));
    const rawZstd = zstdCompressSync(bytes);
    const rawGzip = gzipSync(bytes);

    let nonZero = 0;
    for (const row of agg.rows) {
      for (let w = 0; w < windowCount; w += 1) if ((row.totalMsByWindow[w] ?? 0) !== 0) nonZero += 1;
    }
    const cells = agg.rows.length * Math.max(windowCount, 1);
    const minutes =
      profile.metadata.startTime !== undefined && profile.metadata.endTime !== undefined
        ? (profile.metadata.endTime - profile.metadata.startTime) / 60000
        : windowCount;

    samples.push({
      intervalMicros: profile.metadata.intervalMicros ?? 0,
      rawBytes: rawSize,
      rawZstdBytes: rawZstd.length,
      sidecarZstdBytes: sidecarZstd.length,
      paths: agg.rows.length,
      minutes,
    });

    console.log(
      path.basename(file).slice(0, 22).padEnd(22),
      String((profile.metadata.intervalMicros ?? 0) / 1000).padStart(4),
      mb(rawSize).padStart(7),
      mb(rawGzip.length).padStart(6),
      mb(rawZstd.length).padStart(6),
      String(agg.rows.length).padStart(7),
      String(windowCount).padStart(4),
      (cells === 0 ? 0 : (nonZero / cells) * 100).toFixed(1).padStart(7),
      mb(sidecarZstd.length).padStart(8),
      (rawSize / Math.max(sidecarZstd.length, 1)).toFixed(1).padStart(6),
    );
  }

  // Project per sampling interval. The background profiler runs at 10 ms, so
  // the 4 ms manual captures are NOT a valid basis for continuous collection:
  // they carry ~2.5x the samples and correspondingly more distinct paths.
  const byInterval = new Map<number, Sample[]>();
  for (const sample of samples) {
    const bucket = byInterval.get(sample.intervalMicros);
    if (bucket === undefined) byInterval.set(sample.intervalMicros, [sample]);
    else bucket.push(sample);
  }

  const GB = 1073741824;
  for (const [interval, group] of [...byInterval.entries()].sort((a, b) => a[0] - b[0])) {
    const minutes = group.reduce((s, x) => s + x.minutes, 0);
    const raw = group.reduce((s, x) => s + x.rawBytes, 0);
    const rawZstd = group.reduce((s, x) => s + x.rawZstdBytes, 0);
    const side = group.reduce((s, x) => s + x.sidecarZstdBytes, 0);
    const pathsMin = Math.min(...group.map((x) => x.paths));
    const pathsMax = Math.max(...group.map((x) => x.paths));

    const perHour = (bytes: number): number => (bytes / minutes) * 60;
    console.log('');
    console.log(`--- projection at ${interval / 1000} ms interval  (${group.length} captures, ${minutes.toFixed(0)} min) ---`);
    console.log(`  raw                    ${mb(perHour(raw))} MB/hour   ${(perHour(raw) * 24 / GB).toFixed(2)} GB/day`);
    console.log(`  raw + zstd             ${mb(perHour(rawZstd))} MB/hour   ${(perHour(rawZstd) * 24 / GB).toFixed(2)} GB/day   15-day window: ${(perHour(rawZstd) * 24 * 15 / GB).toFixed(2)} GB`);
    console.log(`  decoded sidecar (zstd) ${mb(perHour(side))} MB/hour   ${(perHour(side) * 24 / GB).toFixed(2)} GB/day   1 year: ${(perHour(side) * 24 * 365 / GB).toFixed(1)} GB`);
    console.log(`  raw -> sidecar         ${(raw / side).toFixed(1)}x reduction`);
    console.log(`  distinct paths         ${pathsMin}-${pathsMax} observed per capture (does NOT scale linearly with duration)`);
  }

  console.log('');
  console.log('NOTE: the background profiler runs at 10 ms. Use the 10 ms row above as');
  console.log('      the basis for continuous collection; 4 ms figures are manual captures.');
}

main();
