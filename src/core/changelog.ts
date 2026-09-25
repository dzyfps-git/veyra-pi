/**
 * What changed, in plain words, per version. Newest first.
 *
 * Shown on the Updates page and once after an update. Written for the
 * person running the server, not for developers: one short line per change
 * they will notice, and anything they need to do.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Release {
  version: string;
  date: string;
  notes: string[];
}

export const CHANGELOG: Release[] = [
  {
    version: '0.1.25',
    date: '2026-09-25',
    notes: [
      'Per-minute detail is now removed after 90 days (Settings, Retention; 0 keeps it forever) and stored 17% smaller.',
      'When a mod with a known issue updates, the app measures it across the update and shows whether it is still there, on Changes and Findings.',
    ],
  },
  {
    version: '0.1.24',
    date: '2026-09-25',
    notes: ['Known issues show only on the exact mod version they were measured on, since other versions may have fixed them.'],
  },
  {
    version: '0.1.23',
    date: '2026-09-25',
    notes: ['Built-in known issues now cover public mods only. Your settings are unchanged.'],
  },
  {
    version: '0.1.22',
    date: '2026-09-25',
    notes: ['Updates now come from github.com/dzyfps-git/veyra-pi; nothing to change on your side.'],
  },
  {
    version: '0.1.21',
    date: '2026-09-25',
    notes: ['Fixed: the version number and the server’s status in the sidebar are no longer cut off.'],
  },
  {
    version: '0.1.20',
    date: '2026-09-25',
    notes: [
      'Findings: Ctrl-click several things (like /execute and entity selectors) and hand them off together in one brief.',
      'A saved profile Windows cannot see on the server share yet is read at the next collection instead of showing "Harvests failing"; one that still cannot be read gets a Try again button.',
      'Check for updates fits again and shows its answer on the button.',
      'Groundwork for linking with EnvX: each capture records which server run it came from and exact method names (older captures are filled in in the background, only while the PC is calm).',
      'Lambda code no longer gets a guessed mod in the by-mod views.',
    ],
  },
  {
    version: '0.1.19',
    date: '2026-09-24',
    notes: [
      'Install no longer waits for a quiet moment: it lets a running collection finish, holds the next one, and starts by itself.',
      'Check for updates always asks GitHub, even with an older version already waiting.',
      'Overview chart: the players axis is no longer cut off and only labels real counts (0 and the most online).',
      'A new app icon to match the new look.',
    ],
  },
  {
    version: '0.1.18',
    date: '2026-09-23',
    notes: [
      'While playing is now the main view everywhere: Findings, the Overview, Reports, briefs and alerts. Idle minutes are kept, one click away.',
      'While playing, All minutes and Nobody online switch exactly for any range, including whole days and the season.',
      'Every view says which minutes its figures are from.',
      'After updating, your history is separated in the background (a few minutes, only while the PC is calm); until then, days and the season show all minutes.',
      'Fixed: "days seen" was off for some methods when captures arrived out of order.',
    ],
  },
  {
    version: '0.1.17',
    date: '2026-09-23',
    notes: [
      'Fixed: rows of cards on the Overview no longer touch, and freeze rows keep their Open button in line.',
      'Freezes read shorter: what the server waited for, then the cause and players on one quiet line.',
      'Top findings name the mod and fix outlook, the same as Findings.',
      'Less text on several pages.',
    ],
  },
  {
    version: '0.1.16',
    date: '2026-09-23',
    notes: [
      'Fixed: minutes with nobody online were recorded as "players unknown". They are now idle, including your existing history.',
      'Overview: "Typical while playing" replaces the typical minute, with a separate idle baseline, so empty hours never flatter gameplay.',
      'The chart shades stretches with nobody online, and a minute is compared only with minutes at the same load (idle with idle).',
      'Findings: All minutes / While playing / Nobody online for hour ranges; longer ranges say how much of them was idle.',
    ],
  },
  {
    version: '0.1.15',
    date: '2026-09-23',
    notes: [
      'A new look: clearer type, a calmer dark palette, softer surfaces, and the same detail everywhere.',
      'Updates in the sidebar: Check for updates is always there, and a new version shows up ready to install in one click.',
      'Fonts ship with the app, so it looks the same offline.',
    ],
  },
  {
    version: '0.1.14',
    date: '2026-09-23',
    notes: ['New versions now come from GitHub by default and download by themselves; you only press Install.'],
  },
  {
    version: '0.1.13',
    date: '2026-09-23',
    notes: [
      'The Ledger is now part of Findings: switch between “By method” and “Every call path”. Old Ledger links still work.',
      'The first look at a 24-hour range is about twice as fast, and moving it forward is faster still.',
      'Observable (optional): profiles you run in-game show the costliest entities and blocks one by one, with coordinates, under Entities and Block entities in Findings.',
      'Updates can come straight from GitHub: set the repository under Settings, Updates, and new versions download by themselves.',
      'Shorter text across Settings, How it works and other pages; some outdated wording fixed.',
    ],
  },
  {
    version: '0.1.12',
    date: '2026-09-23',
    notes: [
      'Fixed: a 5-minute collection interval really collects every 5 minutes (it skipped every other one), so the chart stays current.',
      'Hand off anything: click a thing in a minute (an entity type, a mod hook, a command) to see the methods inside it, then Hand off for a ready brief. Whole mods too.',
      'Chart: drag to zoom in, the highest minute is marked and clickable, and hovering snaps to spikes.',
      'Fixed: Light and System themes apply straight away, including the window frame and dropdowns.',
      'Server cleanup deletes for real once switched on; dry run is now an advanced option.',
      'Setup says when JVM flags or a new sampling interval are saved but waiting for a server restart.',
      'Shorter release notes.',
    ],
  },
  {
    version: '0.1.11',
    date: '2026-09-23',
    notes: [
      'Fixed: the chart’s “watch” line uses your Watch threshold.',
      'MSPT everywhere, including briefs, the leaderboard and alerts.',
      'Shared definitions behind the scenes, so pages cannot disagree.',
    ],
  },
  {
    version: '0.1.10',
    date: '2026-09-23',
    notes: [
      'Stars replaced by a fix outlook on every finding, such as Your own mod, Mod code not checked yet or Game’s own work.',
      'Nothing is called hard on a guess: a mod anywhere in the call path is named as where to look.',
      'Your own mods are recognised (Settings, Analysis) and marked easiest to fix.',
      'Findings: order by MSPT or by best chance to win it back.',
      'Reports: searchable picker and whole-mod briefs you can copy or download.',
    ],
  },
  {
    version: '0.1.9',
    date: '2026-09-23',
    notes: [
      'Fixed: “Where your MSPT goes” read far too low; it now matches spark’s own timing.',
      'Click any part of the game to see what is inside it, down to methods.',
      'Warns when sampling lines up with the tick and a span cannot be trusted.',
      'Findings is about 20× faster; search suggests as you type.',
      'Chart: 6 hours to 7 days, a 10-minute average, players, and unrecorded time shaded.',
      'Updates lists every earlier version.',
    ],
  },
  {
    version: '0.1.8',
    date: '2026-09-23',
    notes: [
      'Fixed: “Harvests failing … no such file”. The app waits and reads again.',
      'Missed harvests from the last three days are recovered automatically.',
      'Minute views use about a third of the memory.',
    ],
  },
  {
    version: '0.1.7',
    date: '2026-09-23',
    notes: ['Optional all-thread profiles, and an Other threads page for world generation, chunk loading, disk and network.'],
  },
  {
    version: '0.1.6',
    date: '2026-09-23',
    notes: ['Plainer Ledger, Changes, Captures and Reports.', 'Tick cost is called MSPT everywhere.'],
  },
  {
    version: '0.1.5',
    date: '2026-09-23',
    notes: [
      'Findings starts with where your MSPT goes, by part of the game and by mod.',
      'Put problems on hold or mark them resolved; they come back if they get worse.',
      'Mods are identified more reliably.',
    ],
  },
  {
    version: '0.1.4',
    date: '2026-09-23',
    notes: [
      'Update button in the sidebar, and an Updates page.',
      'Overview: the latest minute against normal, and a tick chart with players; click a minute to see what happened.',
      'Freezes page, and MSPT by player count.',
    ],
  },
  {
    version: '0.1.3',
    date: '2026-09-23',
    notes: [
      'Safer console commands: the app waits while you are typing or a backup is running.',
      'Raw captures stored about 13× smaller, and removed locally after 15 days.',
      'Server cleanup added (off until you switch it on).',
    ],
  },
  {
    version: '0.1.2',
    date: '2026-09-23',
    notes: ['Updates from inside the app, with a database backup and a way back.'],
  },
  {
    version: '0.1.1',
    date: '2026-09-23',
    notes: ['Lighter on the PC your server shares.', 'Smaller, faster capture files.', 'Rename a server.'],
  },
  {
    version: '0.1.0',
    date: '2026-09-22',
    notes: ['Redesign: per-server monitoring, history, health and coverage.'],
  },
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The running version, from package.json. */
export const APP_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

export function notesFor(version: string): Release | undefined {
  return CHANGELOG.find((r) => r.version === version);
}

/** Releases after `from` up to and including `to`, newest first. */
export function notesBetween(from: string, to: string): Release[] {
  return CHANGELOG.filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
