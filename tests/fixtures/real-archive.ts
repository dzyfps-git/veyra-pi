/**
 * Where a real capture archive lives, for the tests that replay one.
 *
 * Read from `tests/fixtures/real-archive.local.json`, which is git-ignored:
 * archive paths and capture names belong to one machine, not the repository.
 * Without the file those tests skip, so a fresh checkout still passes.
 *
 * {
 *   "profiles": "D:/somewhere/profiles",           // walked for .sparkprofile files
 *   "mappings": "D:/somewhere/yarn-1.20.1-tiny.gz", // optional
 *   "machines": 2,                                  // environments the archive spans
 *   "headline": [{ "file": "...", "tickMsPerTick": 11.407, "idleMsPerTick": 37.613 }]
 * }
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HeadlineExpectation {
  file: string;
  /** Inclusive time of MinecraftServer.tick, ms/tick, derived by hand. */
  tickMsPerTick: number;
  /** Deliberate tick-wait, ms/tick. Undefined where not independently known. */
  idleMsPerTick?: number;
}

export interface RealArchive {
  profiles?: string;
  mappings?: string;
  machines?: number;
  headline?: HeadlineExpectation[];
}

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-archive.local.json');

export const REAL_ARCHIVE: RealArchive = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as RealArchive) : {};
