/**
 * `ingest` -- backfill an archive of .sparkprofile files into the store.
 *
 * Read-only with respect to the source: files are read and copied, never
 * modified or deleted. Safe to re-run; captures are keyed by content hash.
 *
 *   node src/cli/ingest.ts <profilesRoot> [--db <file>] [--archive <dir>]
 *                          [--mappings <tiny.gz>] [--server <uuid>] [--raw]
 *                          [--server-root <dir>]  # enables world identification by seed
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import * as path from 'node:path';

import { Store } from '../store/db.ts';
import { ingestFile } from '../ingest/pipeline.ts';
import { loadTinyMappings, NO_MAPPINGS, type Mappings } from '../decode/mappings.ts';
import { decodeSparkProfile } from '../decode/sparkprofile.ts';
import { readFileSync } from 'node:fs';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function findProfiles(root: string): string[] {
  // A single file is accepted as well as a directory. The first live harvest
  // produced exactly one file and passing it directly failed with ENOTDIR,
  // which is a pointlessly sharp edge on the most obvious thing to type.
  const stats = statSync(root);
  if (stats.isFile()) {
    return root.endsWith('.sparkprofile') ? [root] : [];
  }

  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
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
    console.error('usage: node src/cli/ingest.ts <profilesRoot> [--db f] [--archive d] [--mappings f] [--server uuid] [--raw]');
    process.exit(2);
  }

  const dbFile = flag('db', 'data/perfint.sqlite')!;
  // Default: an "archive" folder beside the database, wherever that is.
  const archiveDir = flag('archive', 'archive')!;
  const serverId = flag('server', '00000000-0000-0000-0000-000000000001')!;
  const mappingsFile = flag('mappings');
  // Supplying the live server directory lets the world be identified by seed,
  // which is the only way a world reset is detected automatically.
  const serverRoot = flag('server-root');
  const archiveRaw = process.argv.includes('--raw');

  let mappings: Mappings = NO_MAPPINGS;
  if (mappingsFile !== undefined) mappings = loadTinyMappings(mappingsFile);

  const store = new Store({ file: dbFile });
  store.upsertServer(serverId, 'main', 'Veyra Main');

  // Chronological order matters: season and revision boundaries are decided
  // against the previous capture, so ingesting out of order would record
  // nonsense transitions.
  const files = findProfiles(root)
    .map((file) => {
      let startedAt = statSync(file).mtimeMs;
      try {
        startedAt = decodeSparkProfile(readFileSync(file)).metadata.startTime ?? startedAt;
      } catch {
        // Unreadable captures are reported by the ingest attempt below.
      }
      return { file, startedAt };
    })
    .sort((a, b) => a.startedAt - b.startedAt);

  console.log(`ingesting ${files.length} captures into ${dbFile}`);
  console.log(`mappings: ${mappings.available ? path.basename(mappings.source ?? '') : 'NONE (headline figures will be null)'}`);
  console.log('');

  let ingested = 0;
  let duplicates = 0;
  let failed = 0;
  const started = Date.now();

  for (const { file } of files) {
    try {
      const result = ingestFile(file, {
        store,
        serverId,
        mappings,
        archiveDir,
        archiveRaw,
        ...(serverRoot === undefined ? {} : { serverRoot }),
      });
      if (result.status === 'duplicate') {
        duplicates += 1;
        console.log(`  dup   ${path.basename(file).slice(0, 40)}`);
      } else {
        ingested += 1;
        const marks = [result.newSeason ? 'SEASON' : '', result.newRevision ? 'rev' : ''].filter(Boolean).join(' ');
        console.log(`  ok    ${path.basename(file).slice(0, 40).padEnd(40)} ${String(result.paths).padStart(7)} paths  ${marks}`);
      }
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${path.basename(file).slice(0, 40)}: ${(error as Error).message}`);
    }
  }

  const seconds = (Date.now() - started) / 1000;
  console.log('');
  console.log(`${ingested} ingested, ${duplicates} duplicate, ${failed} failed in ${seconds.toFixed(1)}s`);

  const counts = store.db
    .prepare(
      `SELECT (SELECT count(*) FROM capture) captures,
              (SELECT count(*) FROM environment) environments,
              (SELECT count(*) FROM season) seasons,
              (SELECT count(*) FROM revision) revisions,
              (SELECT count(*) FROM capture_window) windows,
              (SELECT count(*) FROM path) paths,
              (SELECT count(*) FROM path_daily) ledger,
              (SELECT count(*) FROM mod) mods`,
    )
    .get() as Record<string, number>;
  console.log(`store: ${JSON.stringify(counts)}`);
  if (existsSync(dbFile)) {
    console.log(`db size: ${(statSync(dbFile).size / 1048576).toFixed(1)} MB`);
  }
  store.close();
}

main();
