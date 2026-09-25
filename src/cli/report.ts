/**
 * `report` -- generate the markdown files, and import the hand-written ones.
 *
 *   node src/cli/report.ts leaderboard [--out <file>]
 *   node src/cli/report.ts index       [--out <file>]
 *   node src/cli/report.ts handoff --label <frame> [--out <file>] [--project-dir <dir>]
 *   node src/cli/report.ts import-legacy --leaderboard <file> [--index <file>] [--apply]
 *
 * `import-legacy` is a DRY RUN unless `--apply` is passed. It writes only to
 * perfint's own database and never touches the files it reads.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

import { Store } from '../store/db.ts';
import { findings } from '../analysis/findings.ts';
import { renderLeaderboard, renderIndex } from '../report/markdown.ts';
import { renderHandoff } from '../report/handoff.ts';
import { importLegacy } from '../ingest/legacy.ts';
import * as q from '../query/queries.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const command = process.argv[2] ?? '';
const store = new Store({ file: flag('db') ?? 'data/perfint.sqlite' });

function emit(text: string): void {
  const out = flag('out');
  if (out === undefined) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, text, 'utf8');
  console.log(`wrote ${out} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)`);
}

switch (command) {
  case 'leaderboard': {
    const seasonRaw = flag('season');
    emit(
      renderLeaderboard(store.db, {
        ...(seasonRaw === undefined ? {} : { seasonId: Number(seasonRaw) }),
        limit: Number(flag('limit') ?? 40),
      }),
    );
    break;
  }

  case 'index':
    emit(renderIndex(store.db, Number(flag('limit') ?? 400)));
    break;

  case 'handoff': {
    const label = flag('label');
    if (label === undefined) {
      console.error('--label is required. Give the frame label exactly as the ledger shows it.');
      process.exit(2);
    }
    const list = findings(store.db, { limit: 500 });
    const match = list.find((f) => f.label === label) ?? list.find((f) => f.label.includes(label));
    if (match === undefined) {
      console.error(`No finding matches "${label}".`);
      console.error('The top few are:');
      for (const f of list.slice(0, 8)) console.error(`  ${f.label}`);
      process.exit(1);
    }

    const options: Parameters<typeof renderHandoff>[2] = {};
    for (const [key, value] of [
      ['projectDir', flag('project-dir')],
      ['mappingsPath', flag('mappings')],
      ['jarPath', flag('jar')],
      ['evidencePath', flag('evidence')],
    ] as const) {
      if (value !== undefined) options[key] = value;
    }
    emit(renderHandoff(store.db, match, options));
    break;
  }

  case 'import-legacy': {
    const leaderboardPath = flag('leaderboard');
    if (leaderboardPath === undefined) {
      console.error('--leaderboard <file> is required.');
      process.exit(2);
    }
    const serverId = flag('server') ?? store.firstServerId();
    if (serverId === undefined) {
      console.error('No server is configured yet. Ingest a capture first, or pass --server <id>.');
      process.exit(2);
    }

    const dryRun = !has('apply');
    const indexPath = flag('index');
    const result = importLegacy(store.db, {
      leaderboardPath,
      ...(indexPath === undefined ? {} : { indexPath }),
      serverId,
      dryRun,
    });

    console.log(dryRun ? 'DRY RUN — nothing was written. Pass --apply to commit.' : 'Imported.');
    console.log(`  register entries ${dryRun ? 'that would be created' : 'created'}: ${result.created}`);
    console.log(`  already present: ${result.alreadyPresent}`);
    console.log(`  skipped: ${result.skipped}`);
    console.log(`  watch thresholds read: ${result.thresholds.length}`);
    console.log(`  historical captures read: ${result.captures.length}`);
    for (const warning of result.warnings) console.log(`  ! ${warning}`);

    if (result.thresholds.length > 0) {
      console.log('\nWatch thresholds found in the markdown. These are NOT imported automatically:');
      console.log('the registry has its own threshold settings, and silently overwriting them');
      console.log('with values from a file would change alerting behaviour without asking.\n');
      for (const t of result.thresholds) {
        console.log(`  ${t.metric.padEnd(24)} normal ${t.normal} | watch ${t.watch} | bad ${t.bad}`);
      }
    }
    break;
  }

  default:
    console.log('usage: report <leaderboard|index|handoff|import-legacy> [options]');
    console.log('');
    console.log('  leaderboard     ranked targets for the current season');
    console.log('  index           one row per archived capture');
    console.log('  handoff         agent brief for one finding (--label <frame>)');
    console.log('  import-legacy   read PATCH_LEADERBOARD.md into the register (dry run unless --apply)');
    console.log('');
    console.log(`seasons available: ${q.seasonOptions(store.db).map((s) => `${s.id} (${s.os_name})`).join(', ')}`);
    process.exit(command === '' ? 0 : 2);
}

store.close();
