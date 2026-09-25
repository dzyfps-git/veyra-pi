/**
 * `seasons` -- replay every capture in an archive in chronological order and
 * print the season/revision boundaries that would be detected.
 *
 * Read-only. Used to sanity-check detection against a known upgrade history
 * before any of it is written to a database.
 *
 *   node src/cli/seasons.ts <profilesRoot>
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { decodeSparkProfile } from '../decode/sparkprofile.ts';
import {
  extractEnvironment,
  classifyBoundary,
  environmentKey,
  groupByEnvironment,
  type EnvironmentFacts,
} from '../model/season.ts';

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

function main(): void {
  const root = process.argv[2];
  if (root === undefined || !existsSync(root)) {
    console.error('usage: node src/cli/seasons.ts <profilesRoot>');
    process.exit(2);
  }

  interface Entry { file: string; startTime: number; env: EnvironmentFacts }
  const entries: Entry[] = [];

  for (const file of findProfiles(root)) {
    try {
      const profile = decodeSparkProfile(readFileSync(file));
      const env = extractEnvironment(profile);
      entries.push({
        file,
        startTime: profile.metadata.startTime ?? statSync(file).mtimeMs,
        env,
      });
    } catch (error) {
      console.log(`  skip ${path.basename(file)}: ${(error as Error).message}`);
    }
  }

  entries.sort((a, b) => a.startTime - b.startTime);

  const groups = groupByEnvironment(entries, (e) => e.env);
  console.log(`${entries.length} captures across ${groups.size} distinct environment(s)`);
  console.log('');

  // Order environments by first appearance so the output reads chronologically.
  const ordered = [...groups.entries()].sort(
    (a, b) => (a[1][0]?.startTime ?? 0) - (b[1][0]?.startTime ?? 0),
  );

  for (const [key, group] of ordered) {
    const sample = group[0]!.env;
    console.log(
      `ENVIRONMENT ${key.slice(0, 6)}  ${sample.osName} | ${sample.cpuModel || '<cpu unknown>'} ` +
      `(${sample.cpuThreads}t) | mc ${sample.minecraftVersion} ${sample.loaderName} ${sample.loaderVersion} ` +
      `| java ${sample.javaMajor}  -- ${group.length} capture(s)`,
    );

    let previous: EnvironmentFacts | undefined;
    let season = 0;
    let revision = 0;

    for (const entry of group) {
      const decision = classifyBoundary(previous, entry.env);
      if (decision.kind === 'season' || decision.kind === 'first') {
        season += 1;
        revision = 1;
      } else if (decision.kind === 'revision') {
        revision += 1;
      }

      const when = new Date(entry.startTime).toISOString().replace('T', ' ').slice(0, 16);
      const marker =
        decision.kind === 'season' ? ' <<< NEW SEASON' :
        decision.kind === 'revision' ? ' <- revision' : '';

      console.log(
        `  ${when}  s${season}.r${String(revision).padEnd(2)} ` +
        `${path.basename(entry.file).slice(0, 36).padEnd(36)} ` +
        `mods=${String(entry.env.modCount).padStart(3)} heap=${entry.env.heapMaxMb ?? '?'}M${marker}`,
      );
      for (const reason of decision.reasons) {
        if (decision.kind !== 'first') console.log(`                       ${reason}`);
      }
      if (decision.needsConfirmation) console.log('                       NEEDS CONFIRMATION (near threshold)');

      previous = entry.env;
    }
    console.log('');
  }

  if (groups.size > 1) {
    console.log('NOTE: more than one environment is present. These are different machines,');
    console.log('      not a sequence of seasons. Aggregate MSPT is not comparable between');
    console.log('      them, and each needs assigning to a server (or marking as foreign).');
  }
}

main();
