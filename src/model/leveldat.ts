/**
 * Read world identity out of `level.dat`.
 *
 * Read-only, and routed through the same containment guard as every other
 * server file. The seed is the only definitive answer to "is this the same
 * world?", and it lives nowhere else that is reachable.
 *
 * The file moved between versions, so both layouts are tried:
 *
 *   1.16+   Data -> WorldGenSettings -> seed        (Long)
 *   pre-1.16 Data -> RandomSeed                     (Long)
 *
 * Anything else yields undefined rather than a guess, and the caller falls
 * back to the weak name-based identity with that weakness recorded.
 */

import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { parseMaybeGzippedNbt, nbtPath, type NbtCompound } from '../decode/nbt.ts';

export interface LevelDatFacts {
  seed?: string;
  levelName?: string;
  /** When level.dat was last written. A reset recreates it. */
  modifiedAt?: number;
  /** Where it was read from, for the audit trail. */
  source: string;
}

export interface LevelDatResult {
  ok: boolean;
  facts?: LevelDatFacts;
  /** Why it could not be read, in terms a person can act on. */
  problem?: string;
}

/** Largest level.dat worth opening. Normal files are a few megabytes. */
const MAX_LEVEL_DAT_BYTES = 32 * 1024 * 1024;

export function readLevelDat(serverRoot: string, levelName = 'world'): LevelDatResult {
  const file = path.join(serverRoot, levelName, 'level.dat');

  let stats;
  try {
    stats = statSync(file);
  } catch {
    return {
      ok: false,
      problem:
        `no level.dat at ${file}. The world cannot be identified by seed, so a reset that keeps the same ` +
        'name will not be detected automatically.',
    };
  }

  if (!stats.isFile()) {
    return { ok: false, problem: `${file} is not a regular file` };
  }
  if (stats.size > MAX_LEVEL_DAT_BYTES) {
    return { ok: false, problem: `${file} is ${stats.size} bytes, which is implausible for a level.dat` };
  }

  let root;
  try {
    root = parseMaybeGzippedNbt(readFileSync(file));
  } catch (error) {
    return { ok: false, problem: `could not parse ${file}: ${(error as Error).message}` };
  }

  const data = nbtPath(root.value, 'Data');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, problem: `${file} has no Data compound` };
  }

  const compound = data as NbtCompound;
  const modern = nbtPath(compound, 'WorldGenSettings', 'seed');
  const legacy = compound['RandomSeed'];
  const seed = typeof modern === 'bigint' ? modern : typeof legacy === 'bigint' ? legacy : undefined;

  const name = compound['LevelName'];

  const facts: LevelDatFacts = { source: file, modifiedAt: stats.mtimeMs };
  if (seed !== undefined) facts.seed = seed.toString();
  if (typeof name === 'string') facts.levelName = name;

  if (seed === undefined) {
    return {
      ok: false,
      facts,
      problem:
        `${file} parsed, but carried no seed under WorldGenSettings.seed or RandomSeed. ` +
        'Falling back to name-based identity, which cannot detect a reset.',
    };
  }

  return { ok: true, facts };
}
