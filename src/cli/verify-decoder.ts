/**
 * `verify-decoder` -- regression-check perfint's decoder against the existing
 * archive's committed `*.summary.json` files.
 *
 * The existing `analyze_sparkprofile.mjs` output has been used to make real
 * optimization decisions, so it is the reference. If perfint
 * disagrees with it on a shared quantity, perfint is wrong until proven
 * otherwise.
 *
 * Strictly read-only: it reads the archive and writes nothing.
 *
 *   node src/cli/verify-decoder.ts <profilesRoot> [--mappings <tiny.gz>] [--verbose]
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { decodeSparkProfile } from '../decode/sparkprofile.ts';
import { aggregateProfile, rollupBy } from '../decode/aggregate.ts';
import { loadTinyMappings, mapFrame, NO_MAPPINGS, type Mappings } from '../decode/mappings.ts';

interface Pair {
  id: string;
  profilePath: string;
  summaryPath: string;
}

/** Capture id is the filename up to the first `__`, `-` group, or extension. */
function captureId(filename: string): string {
  const base = filename.replace(/\.sparkprofile$/i, '').replace(/\.summary\.json$/i, '');
  const cut = base.indexOf('__');
  return cut === -1 ? base : base.slice(0, cut);
}

function findPairs(root: string): Pair[] {
  const pairs: Pair[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const originals = path.join(dir, 'original');
    const summaries = path.join(dir, 'summaries');
    if (!existsSync(originals) || !existsSync(summaries)) continue;

    const summaryById = new Map<string, string>();
    for (const file of readdirSync(summaries)) {
      if (file.endsWith('.json')) summaryById.set(captureId(file), path.join(summaries, file));
    }
    for (const file of readdirSync(originals)) {
      if (!file.endsWith('.sparkprofile')) continue;
      const summaryPath = summaryById.get(captureId(file));
      if (summaryPath !== undefined) {
        pairs.push({ id: captureId(file), profilePath: path.join(originals, file), summaryPath });
      }
    }
  }
  return pairs;
}

interface Check {
  name: string;
  ours: number | string | undefined;
  theirs: number | string | undefined;
  ok: boolean;
  note?: string;
}

/** Relative comparison, tolerant of float formatting but not of real drift. */
function closeEnough(ours: number | undefined, theirs: number | undefined, relTol: number): boolean {
  if (ours === undefined || theirs === undefined) return false;
  if (theirs === 0) return Math.abs(ours) < 1e-9;
  return Math.abs(ours - theirs) / Math.abs(theirs) <= relTol;
}

function verify(pair: Pair, mappings: Mappings, verbose: boolean): { checks: Check[]; failed: number } {
  const profile = decodeSparkProfile(readFileSync(pair.profilePath));
  const agg = aggregateProfile(profile, {
    renameFrame: (c, m) => mapFrame(c, m, mappings),
    mappingsAvailable: mappings.available,
  });
  const summary = JSON.parse(readFileSync(pair.summaryPath, 'utf8')) as Record<string, any>;

  const checks: Check[] = [];
  const add = (name: string, ours: number | string | undefined, theirs: number | string | undefined, ok: boolean, note?: string): void => {
    checks.push(note === undefined ? { name, ours, theirs, ok } : { name, ours, theirs, ok, note });
  };

  // --- structure -----------------------------------------------------------
  const nodeCount = profile.threads.reduce((sum, t) => sum + t.children.length, 0);
  add('nodeCount', nodeCount, summary.profile?.nodeCount, nodeCount === summary.profile?.nodeCount);
  add('threadCount', profile.threads.length, summary.profile?.threadCount, profile.threads.length === summary.profile?.threadCount);
  add('timeWindowCount', profile.timeWindows.length, summary.profile?.timeWindowCount, profile.timeWindows.length === summary.profile?.timeWindowCount);
  add('tickDivisor', agg.divisorTicks, summary.profile?.tickDivisor, agg.divisorTicks === summary.profile?.tickDivisor);

  // --- threads -------------------------------------------------------------
  const theirThreads: Array<Record<string, any>> = summary.rankings?.threads ?? [];
  for (const ourThread of agg.threads) {
    const theirs = theirThreads.find((t) => t.name === ourThread.name);
    add(
      `thread[${ourThread.name}].totalMs`,
      Math.round(ourThread.totalMs),
      theirs?.totalMs,
      closeEnough(ourThread.totalMs, theirs?.totalMs, 1e-6),
    );
  }

  // --- window statistics ---------------------------------------------------
  const theirWindows: Array<Record<string, any>> = summary.statistics?.windows ?? [];
  const ourWindows = [...profile.windowStatistics.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
  add('windowRows', ourWindows.length, theirWindows.length, ourWindows.length === theirWindows.length);
  const windowFields = ['ticks', 'tps', 'msptMedian', 'msptMax', 'players', 'entities', 'chunks'] as const;
  let windowMismatches = 0;
  for (let i = 0; i < Math.min(ourWindows.length, theirWindows.length); i += 1) {
    for (const field of windowFields) {
      const ours = ourWindows[i]?.[field];
      const theirs = theirWindows[i]?.[field];
      if (typeof theirs === 'number' && !closeEnough(ours as number | undefined, theirs, 1e-9)) {
        windowMismatches += 1;
        if (verbose) console.log(`      window[${i}].${field}: ours=${ours} theirs=${theirs}`);
      }
    }
  }
  add('windowFields', windowMismatches === 0 ? 'all match' : `${windowMismatches} differ`, 'all match', windowMismatches === 0);

  // --- self time by method -------------------------------------------------
  // The heart of it: if this agrees, self/total accounting and mod attribution
  // are behaving the same way the reference tool does.
  // Compare against BOTH the mapped and the raw label. The archive's summaries
  // were produced at different times with different naming available, so a
  // reference entry may be either `PalettedContainer.get` or
  // `class_2841.method_12331`; both must count as agreement.
  const ourByMethod = new Map(rollupBy(agg.rows, (r) => r.label).map((e) => [e.key, e.selfMs]));
  const ourByRawMethod = new Map(rollupBy(agg.rows, (r) => r.rawLabel).map((e) => [e.key, e.selfMs]));
  const theirMethods: Array<Record<string, any>> = (summary.rankings?.methodsBySelfTime ?? []).slice(0, 20);
  let methodMismatches = 0;
  for (const entry of theirMethods) {
    const ours = ourByMethod.get(entry.method) ?? ourByRawMethod.get(entry.method);
    if (!closeEnough(ours, entry.selfMs, 1e-6)) {
      methodMismatches += 1;
      if (verbose) console.log(`      method ${entry.method}: ours=${ours?.toFixed(1) ?? 'MISSING'} theirs=${entry.selfMs}`);
    }
  }
  add('top20 methodsBySelfTime', methodMismatches === 0 ? 'all match' : `${methodMismatches}/${theirMethods.length} differ`, 'all match', methodMismatches === 0);

  // --- self time by mod ----------------------------------------------------
  const ourBySource = new Map(rollupBy(agg.rows, (r) => r.source ?? '<unattributed>').map((e) => [e.key, e.selfMs]));
  const theirSources: Array<Record<string, any>> = (summary.rankings?.sourcesBySelfTime ?? []).slice(0, 15);
  let sourceMismatches = 0;
  for (const entry of theirSources) {
    const ours = ourBySource.get(entry.source);
    if (!closeEnough(ours, entry.selfMs, 1e-6)) {
      sourceMismatches += 1;
      if (verbose) console.log(`      source ${entry.source}: ours=${ours?.toFixed(1) ?? 'MISSING'} theirs=${entry.selfMs}`);
    }
  }
  add('top15 sourcesBySelfTime', sourceMismatches === 0 ? 'all match' : `${sourceMismatches}/${theirSources.length} differ`, 'all match', sourceMismatches === 0);

  return { checks, failed: checks.filter((c) => !c.ok).length };
}

function main(): void {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const mappingsFlag = args.indexOf('--mappings');
  const positional = args.filter((a, i) => !a.startsWith('--') && i !== mappingsFlag + 1);
  const root = positional[0];

  if (root === undefined) {
    console.error('usage: node src/cli/verify-decoder.ts <profilesRoot> [--mappings <tiny.gz>] [--verbose]');
    process.exit(2);
  }

  let mappings = NO_MAPPINGS;
  if (mappingsFlag !== -1) {
    const file = args[mappingsFlag + 1];
    if (file !== undefined) {
      mappings = loadTinyMappings(file);
      console.log(`mappings: ${mappings.classes.size} classes, ${mappings.methods.size} methods (${path.basename(file)})`);
    }
  } else {
    console.log('mappings: NONE -- method-name checks will fail for Minecraft frames');
  }

  const pairs = findPairs(root);
  console.log(`found ${pairs.length} profile/summary pairs\n`);

  let totalFailed = 0;
  let totalChecks = 0;
  const failedCaptures: string[] = [];

  for (const pair of pairs) {
    const sizeMb = statSync(pair.profilePath).size / 1048576;
    let result;
    try {
      result = verify(pair, mappings, verbose);
    } catch (error) {
      console.log(`  FAIL  ${pair.id.padEnd(12)} (${sizeMb.toFixed(1)} MB)  decode error: ${(error as Error).message}`);
      failedCaptures.push(pair.id);
      totalFailed += 1;
      continue;
    }
    totalChecks += result.checks.length;
    totalFailed += result.failed;
    const status = result.failed === 0 ? ' ok ' : 'FAIL';
    console.log(`  ${status}  ${pair.id.padEnd(12)} (${sizeMb.toFixed(1).padStart(5)} MB)  ${result.checks.length - result.failed}/${result.checks.length} checks`);
    if (result.failed > 0) {
      failedCaptures.push(pair.id);
      for (const check of result.checks.filter((c) => !c.ok)) {
        console.log(`          ${check.name}: ours=${check.ours} theirs=${check.theirs}`);
      }
    }
  }

  console.log(`\n${totalChecks - totalFailed}/${totalChecks} checks passed across ${pairs.length} captures`);
  if (failedCaptures.length > 0) {
    console.log(`captures with failures: ${failedCaptures.join(', ')}`);
    process.exit(1);
  }
}

main();
