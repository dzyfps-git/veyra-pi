/**
 * `decode` -- inspect a single .sparkprofile.
 *
 * Read-only. Prints what perfint extracts from a capture, so a decode can be
 * eyeballed against spark's own viewer or against the existing
 * `analyze_sparkprofile.mjs` output before trusting it.
 *
 *   node src/cli/decode.ts <file.sparkprofile> [--json]
 */

import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { decodeSparkProfile, type MetricSeries } from '../decode/sparkprofile.ts';

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function cadence<T>(series: MetricSeries<T>): string {
  const n = series.timestampsMs.length;
  if (n < 2) return 'n/a';
  const first = series.timestampsMs[0]!;
  const last = series.timestampsMs[n - 1]!;
  return `${((last - first) / (n - 1) / 1000).toFixed(1)}s`;
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (file === undefined) {
    console.error('usage: node src/cli/decode.ts <file.sparkprofile> [--json]');
    process.exit(2);
  }

  const bytes = readFileSync(file);
  const started = performance.now();
  const profile = decodeSparkProfile(bytes);
  const decodeMs = performance.now() - started;

  if (args.includes('--json')) {
    console.log(
      JSON.stringify(
        profile,
        (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value),
        2,
      ),
    );
    return;
  }

  const meta = profile.metadata;
  const nodeCount = profile.threads.reduce((sum, thread) => sum + thread.children.length, 0);
  const durationSec =
    meta.startTime !== undefined && meta.endTime !== undefined
      ? (meta.endTime - meta.startTime) / 1000
      : undefined;

  const row = (label: string, value: unknown): void => {
    console.log(`  ${label.padEnd(16)} ${value ?? '-'}`);
  };

  console.log(`\n${path.basename(file)}  (${mb(statSync(file).size)}, decoded in ${decodeMs.toFixed(0)} ms)\n`);

  console.log('capture');
  row('mode/engine', `${meta.samplerMode ?? '?'} / ${meta.samplerEngine ?? '?'} ${meta.samplerEngineVersion ?? ''}`);
  row('interval', meta.intervalMicros !== undefined ? `${meta.intervalMicros / 1000} ms` : undefined);
  row('duration', durationSec !== undefined ? `${durationSec.toFixed(0)} s` : undefined);
  row('ticks', `${meta.numberOfTicks ?? '?'} (included ${meta.dataAggregator?.numberOfIncludedTicks ?? 0})`);
  row('comment', meta.comment || undefined);

  console.log('\nenvironment');
  row('platform', `${meta.platform?.name ?? '?'} ${meta.platform?.version ?? ''} | mc ${meta.platform?.minecraftVersion ?? '?'}`);
  row('brand', meta.platform?.brand);
  row('java', `${meta.system?.java?.version ?? '?'} (${meta.system?.java?.vendor ?? '?'})`);
  row('vmArgs', meta.system?.java?.vmArgs);
  row('os', `${meta.system?.os?.name ?? '?'} ${meta.system?.os?.arch ?? ''}`);
  row('cpu', `${meta.system?.cpu?.threads ?? '?'} threads | ${meta.system?.cpu?.model ?? '?'}`);
  row('mods', meta.sources.size);

  console.log('\ntree');
  row('threads', profile.threads.length);
  row('nodes', nodeCount);
  row('time windows', profile.timeWindows.length);
  row('window stats', profile.windowStatistics.size);
  for (const thread of profile.threads) {
    const total = thread.times.reduce((sum, value) => sum + value, 0);
    console.log(`    ${(thread.name ?? '?').padEnd(28)} pool=${String(thread.children.length).padStart(6)}  roots=${String(thread.childrenRefs.length).padStart(4)}  ${total.toFixed(0)} ms`);
  }

  console.log('\nmetrics series (proto field 18)');
  if (meta.metrics === undefined) {
    console.log('  ABSENT -- this spark version does not embed the metrics series');
  } else {
    for (const [name, series] of Object.entries(meta.metrics)) {
      if (series === undefined) continue;
      console.log(`  ${name.padEnd(16)} n=${String(series.values.length).padStart(5)}  every ~${cadence(series)}`);
    }
  }

  const windows = [...profile.windowStatistics.entries()].sort((a, b) => a[0] - b[0]);
  if (windows.length > 0) {
    console.log('\nwindow statistics (first 3)');
    for (const [id, w] of windows.slice(0, 3)) {
      console.log(
        `  #${id}  ticks=${w.ticks ?? '-'} tps=${w.tps?.toFixed(2) ?? '-'} mspt med/max=${w.msptMedian?.toFixed(2) ?? '-'}/${w.msptMax?.toFixed(2) ?? '-'} players=${w.players ?? '-'} entities=${w.entities ?? '-'} chunks=${w.chunks ?? '-'}`,
      );
    }
  }
  console.log('');
}

main();
