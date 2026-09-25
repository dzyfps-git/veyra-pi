/**
 * Import the hand-maintained markdown workflow.
 *
 * `PATCH_LEADERBOARD.md` and `INDEX.md` are the record of roughly six weeks
 * of manual analysis. They predate this system and are the reason it exists,
 * so the first thing it should do is inherit them rather than start empty.
 *
 * The parsing is deliberately forgiving and deliberately lossy in one
 * direction: anything it cannot confidently read is **reported and skipped**,
 * never guessed at. A half-understood row silently entered into the register
 * would be worse than no row, because the register's whole value is that
 * what is in it is true.
 *
 * Imported entries are marked with an `imported:` note so they are
 * distinguishable forever from entries this system produced itself.
 */

import { readFileSync, existsSync } from 'node:fs';

import { Register, type OptimizationStatus } from '../analysis/register.ts';
import type { Feasibility } from '../analysis/detectors.ts';
import type { Risk } from '../analysis/priority.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface ImportResult {
  created: number;
  skipped: number;
  alreadyPresent: number;
  thresholds: WatchThreshold[];
  captures: LegacyCapture[];
  warnings: string[];
}

export interface WatchThreshold {
  metric: string;
  normal: string;
  watch: string;
  bad: string;
}

export interface LegacyCapture {
  received: string;
  profile: string;
  capture: string;
  result: string;
  reportLink: string | null;
}

/** Split a markdown table row into trimmed cells. */
function cells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  return trimmed
    .slice(1, trimmed.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim());
}

/** Strip markdown emphasis and inline code so a title reads as plain text. */
function plain(text: string): string {
  return text
    .replaceAll('`', '')
    .replaceAll('**', '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/**
 * Pull the first ms/tick figure out of a cost cell.
 *
 * Cells read like "2.03 MSPT in `aBcDeF1234`; 5.30 MSPT mean across the
 * preceding four runs" or "**Completed:** 0.00217 MSPT live, down from
 * roughly 1.98-2.67 MSPT". The first number is the current/representative
 * one in every row of the existing file, and a range like "0.51-0.67" takes
 * its lower bound. Anything else yields undefined rather than a guess.
 */
export function parseMspt(cell: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*(?:[-–]\s*\d+(?:\.\d+)?\s*)?MSPT/i.exec(cell);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Map the leaderboard's priority column onto a register status.
 *
 * "COMPLETE" is the only one that implies work was done. Note what it does
 * NOT become: `measured-improvement`. That status is reserved for this
 * system's own A/B engine, and an imported claim — however well evidenced in
 * the markdown — is not a measurement this system made. The evidence is
 * preserved in the notes instead.
 */
function statusFor(priority: string): { status: OptimizationStatus; feasibility: Feasibility; risk: Risk } {
  const upper = priority.toUpperCase();
  if (upper.includes('COMPLETE')) return { status: 'implemented', feasibility: 'proven', risk: 'low' };
  if (upper.includes('INVESTIGATE') || upper.includes('AUDIT')) {
    return { status: 'investigating', feasibility: 'unknown', risk: 'unknown' };
  }
  if (upper.includes('GAMEPLAY')) return { status: 'proposed', feasibility: 'likely', risk: 'high' };
  if (upper.startsWith('P0')) return { status: 'proposed', feasibility: 'likely', risk: 'medium' };
  if (upper.startsWith('P1')) return { status: 'proposed', feasibility: 'likely', risk: 'unknown' };
  if (upper.startsWith('P2') || upper.startsWith('P3')) {
    return { status: 'proposed', feasibility: 'likely', risk: 'low' };
  }
  if (upper.includes('STABILITY')) return { status: 'proposed', feasibility: 'likely', risk: 'medium' };
  return { status: 'proposed', feasibility: 'unknown', risk: 'unknown' };
}

/** Rows of the first table under a heading that starts with `## <name>`. */
function tableUnder(lines: readonly string[], headingPrefix: string): string[][] {
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(headingPrefix.toLowerCase()));
  if (start === -1) return [];

  const rows: string[][] = [];
  let seenHeader = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim().startsWith('## ')) break;
    if (isSeparator(line)) {
      seenHeader = true;
      continue;
    }
    const row = cells(line);
    if (row.length === 0) {
      if (rows.length > 0) break; // table ended
      continue;
    }
    if (!seenHeader) continue; // this is the header row itself
    rows.push(row);
  }
  return rows;
}

export function parseLeaderboard(markdown: string): {
  entries: Array<{
    rank: string;
    target: string;
    current: string;
    worst: string;
    priority: string;
    why: string;
  }>;
  thresholds: WatchThreshold[];
} {
  const lines = markdown.split(/\r?\n/);

  const entries = tableUnder(lines, '## Current priority')
    .filter((row) => row.length >= 6)
    .map((row) => ({
      rank: row[0]!,
      target: row[1]!,
      current: row[2]!,
      worst: row[3]!,
      priority: row[4]!,
      why: row[5]!,
    }));

  const thresholds = tableUnder(lines, '## Watch thresholds')
    .filter((row) => row.length >= 4)
    .map((row) => ({ metric: plain(row[0]!), normal: plain(row[1]!), watch: plain(row[2]!), bad: plain(row[3]!) }));

  return { entries, thresholds };
}

export function parseIndex(markdown: string): LegacyCapture[] {
  const lines = markdown.split(/\r?\n/);
  const rows: string[][] = [];
  let seenHeader = false;
  for (const line of lines) {
    if (isSeparator(line)) {
      seenHeader = true;
      continue;
    }
    const row = cells(line);
    if (row.length < 5) continue;
    if (!seenHeader) continue;
    rows.push(row);
  }

  return rows.map((row) => {
    const link = /\[[^\]]*\]\(([^)]+)\)/.exec(row[4] ?? '');
    return {
      received: plain(row[0]!),
      profile: plain(row[1]!),
      capture: plain(row[2]!),
      result: plain(row[3]!),
      reportLink: link === null ? null : link[1]!,
    };
  });
}

export interface ImportOptions {
  leaderboardPath: string;
  indexPath?: string;
  serverId: string;
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
}

export function importLegacy(db: DatabaseSync, options: ImportOptions): ImportResult {
  const result: ImportResult = {
    created: 0,
    skipped: 0,
    alreadyPresent: 0,
    thresholds: [],
    captures: [],
    warnings: [],
  };

  if (!existsSync(options.leaderboardPath)) {
    result.warnings.push(`leaderboard not found at ${options.leaderboardPath}`);
    return result;
  }

  const { entries, thresholds } = parseLeaderboard(readFileSync(options.leaderboardPath, 'utf8'));
  result.thresholds = thresholds;

  if (options.indexPath !== undefined && existsSync(options.indexPath)) {
    result.captures = parseIndex(readFileSync(options.indexPath, 'utf8'));
  }

  const register = new Register(db);
  const existing = new Set(register.list().map((o) => o.title));

  for (const entry of entries) {
    const title = plain(entry.target);
    if (title === '') {
      result.skipped += 1;
      result.warnings.push(`row ${entry.rank}: no readable target, skipped`);
      continue;
    }
    if (existing.has(title)) {
      result.alreadyPresent += 1;
      continue;
    }

    const msPerTick = parseMspt(entry.current);
    const worst = parseMspt(entry.worst);
    const { status, feasibility, risk } = statusFor(entry.priority);

    const notes = [
      `imported: PATCH_LEADERBOARD.md rank ${plain(entry.rank)}, priority ${plain(entry.priority)}`,
      msPerTick === undefined
        ? `cost as recorded: ${plain(entry.current)} (no MSPT figure could be read)`
        : `cost as recorded: ${msPerTick} MSPT — ${plain(entry.current)}`,
      worst === undefined ? '' : `worst minute observed: ${worst} MSPT`,
    ]
      .filter((line) => line !== '')
      .join('\n');

    if (options.dryRun === true) {
      result.created += 1;
      continue;
    }

    const id = register.create({
      serverId: options.serverId,
      title,
      targetLabel: title,
      hypothesis: plain(entry.why),
      feasibility,
      risk,
      notes,
    });

    // Imported entries that were already done land on `implemented`, never
    // on a measured status: this system did not measure them.
    if (status !== 'proposed') {
      const moved = register.setStatus(id, status, 'import');
      if (!moved.ok) result.warnings.push(`row ${entry.rank}: ${moved.error}`);
    }
    result.created += 1;
  }

  return result;
}
