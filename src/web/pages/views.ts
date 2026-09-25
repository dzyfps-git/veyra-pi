/**
 * The Captures page, and the every-call-path table Findings shows.
 *
 * Design rule from docs/ui-design.md that matters most here: confidence is
 * always visible. A figure backed by a handful of samples is rendered visibly
 * weaker than one backed by millions, and a missing value is an em dash rather
 * than a zero.
 */

import { esc, num, bytes, when, duration } from '../layout.ts';
import { FREEZE_MS } from '../../analysis/minute.ts';
import type { DatabaseSync } from 'node:sqlite';
import * as q from '../../query/queries.ts';
import { PathClassifier } from '../../analysis/breakdown.ts';
import { SYSTEMS, explainWait } from '../../analysis/systems.ts';
import { isLibraryFrame, meaningfulFrame, readableMethod } from '../../analysis/owner.ts';
import { classifyPath } from '../../analysis/subjects.ts';


export function capturesPage(db: DatabaseSync, serverId?: string, limit = 200): string {
  const rows = q.captures(db, limit, serverId);
  if (rows.length === 0) return '<div class="empty">No captures yet.</div>';

  // Per capture, from its one-minute windows: the typical minute, the worst
  // single tick, and the most players.
  const windows = db.prepare('SELECT mspt_median, mspt_max, players, end_time FROM capture_window WHERE capture_id = ?');
  const median = (a: number[]): number | null => {
    if (a.length === 0) return null;
    const sorted = [...a].sort((x, y) => x - y);
    return sorted[sorted.length >> 1]!;
  };
  const seconds = duration;

  return `<table>
<tr>
  <th>When</th><th class="n">Minutes</th><th class="n">Typical tick</th><th class="n">Worst tick</th>
  <th class="n">Players</th><th class="n">Waiting</th><th class="n">Size</th><th></th>
</tr>
${rows
  .map((r) => {
    const w = windows.all(r.id) as Array<{ mspt_median: number | null; mspt_max: number | null; players: number | null; end_time: number | null }>;
    const typical = median(w.map((x) => x.mspt_median).filter((v): v is number => v !== null));
    const worst = w.reduce<number | null>((m, x) => (x.mspt_max === null ? m : Math.max(m ?? 0, x.mspt_max)), null);
    const players = w.reduce<number | null>((m, x) => (x.players === null ? m : Math.max(m ?? 0, x.players)), null);
    const end = w.reduce<number | null>((m, x) => (x.end_time === null ? m : Math.max(m ?? 0, x.end_time)), null);
    const waiting =
      r.blocked_ms_per_tick !== null && r.blocked_ms_per_tick > 0.05
        ? `<span class="tag bad">${num(r.blocked_ms_per_tick, 2)}</span>`
        : num(r.blocked_ms_per_tick, 2);
    return `<tr>
      <td><a href="/capture?id=${r.id}">${esc(when(r.started_at))}${end === null ? '' : `–${esc(when(end).slice(11))}`}</a>${r.is_manual === 1 ? ' <span class="tag">yours</span>' : ''}
        <div class="faint mono" style="font-size:11px">${esc(r.source_name)}</div></td>
      <td class="n">${r.window_count}</td>
      <td class="n"><strong>${num(typical, 1)}</strong> <span class="faint">MSPT</span></td>
      <td class="n ${worst !== null && worst >= FREEZE_MS ? '' : 'dim'}">${worst !== null && worst >= FREEZE_MS ? `<span class="tag bad">${esc(seconds(worst))}</span>` : esc(seconds(worst))}</td>
      <td class="n">${players ?? '—'}</td>
      <td class="n">${waiting}</td>
      <td class="n faint">${bytes(r.raw_bytes)}</td>
      <td><a href="/capture?id=${r.id}">Details</a></td>
    </tr>`;
  })
  .join('')}
</table>
<div class="faint" style="font-size:12px;margin-top:8px">
  <b>Typical tick</b> is the capture’s median minute; <b>worst tick</b> its slowest single tick (half a second or more is a freeze);
  <b>waiting</b> the MSPT spent stopped, for example for a chunk load.
</div>`;
}

/**
 * Describe a season the way a reader can actually identify it.
 *
 * The ordinal alone is not enough: seasons are detected per environment, so
 * two unrelated seasons can both be "season 1". The machine is the thing that
 * distinguishes them.
 */
/**
 * Every call path, one row each: the "every call path" view of Findings (it
 * was the Ledger page). Nothing is grouped or thresholded, so the smallest
 * recorded path can be found here. Filters by part of the game, thing and
 * mod are applied after reading, the way Findings applies them.
 */
export function callPathsTable(
  db: DatabaseSync,
  query: q.LedgerQuery,
  opts: { showBetween: boolean; betweenHref: string; system?: string | undefined; subject?: string | undefined; mod?: string | undefined },
): string {
  const classifier = new PathClassifier(db);
  const filtered = opts.system !== undefined || opts.mod !== undefined;
  const limit = query.limit ?? 150;
  const described = new Map<number, { title: string; owner: string; part: string; via: string }>();
  const rows = q
    .ledger(db, { ...query, limit: limit * (filtered ? 20 : 3) })
    .filter((r) => {
      const system = classifier.systemOf(r.path_id, r.category);
      if (system === undefined && !opts.showBetween) return false;
      if (opts.system !== undefined && system !== opts.system) return false;
      const frames = classifier.frames(r.path_id);
      if (opts.subject !== undefined && classifyPath(frames, r.category, explainWait).subject !== opts.subject) return false;
      const owner = r.source_mod ?? classifier.ownerOf(r.path_id) ?? '—';
      if (opts.mod !== undefined && owner !== opts.mod) return false;
      const path = frames.join(' > ');
      const caller = meaningfulFrame(path);
      const title = isLibraryFrame(r.label) && caller !== r.label ? `${readableMethod(caller)}, in ${readableMethod(r.label)}` : readableMethod(r.label);
      const parent = frames.length >= 2 ? meaningfulFrame(frames.slice(0, -1).join(' > ')) : '';
      described.set(r.path_id, {
        title,
        owner,
        part: system === undefined ? 'between ticks (not tick time)' : SYSTEMS[system].name,
        via: parent === '' || isLibraryFrame(r.label) || readableMethod(parent) === title ? '' : readableMethod(parent),
      });
      return true;
    })
    .slice(0, limit);

  if (rows.length === 0) return '<div class="empty">Nothing matches.</div>';
  return `<style>
table.ledger .lt { font-weight: 560; }
table.ledger .ls { font-size: 11.5px; color: var(--text-faint); }
</style>
<table class="ledger">
<tr>
  <th>Method</th><th>Mod</th><th class="n">MSPT own</th><th class="n">s/day</th>
  <th class="n">In minutes</th><th class="n">Samples</th><th></th>
</tr>
${rows
  .map((r) => {
    const persistence = r.windows_total > 0 ? r.windows_present / r.windows_total : 0;
    // Sample count drives how confident the figure is; show it rather than
    // letting a thin measurement look as solid as a heavy one.
    const samples = Math.round(r.total_ms / 10);
    const weak = samples < 50;
    const info = described.get(r.path_id)!;
    return `<tr>
      <td><div class="lt" title="${esc(r.label)}">${esc(info.title)}</div><div class="ls">${esc(info.part)}${info.via === '' ? '' : ` · via ${esc(info.via)}`}</div></td>
      <td class="dim">${esc(info.owner)}</td>
      <td class="n"><strong>${num(r.self_ms_per_tick, 3)}</strong></td>
      <td class="n dim">${num(r.seconds_per_day, 1)}</td>
      <td class="n">${num(persistence * 100, 0)}%</td>
      <td class="n ${weak ? 'faint' : 'dim'}">${samples.toLocaleString('en-US')}</td>
      <td>${weak ? '<span class="tag warn" title="Few samples: treat this figure as provisional">thin</span>' : ''}${r.category === 'blocked' ? ' <span class="tag bad">waiting</span>' : ''}</td>
    </tr>`;
  })
  .join('')}
</table>
<div class="faint" style="font-size:12px;margin-top:10px">
  One row per call path, so a method reached from two places is two rows. Own times add up.
  ${opts.showBetween ? '' : `Idle time between ticks is hidden (<a href="${esc(opts.betweenHref)}">show it</a>).`}
</div>`;
}
