/**
 * Generate the two markdown files the manual workflow produced by hand.
 *
 * The point is not to replace them with a web page. They are read by coding
 * agents and by a person scrolling a repo, they diff cleanly in git, and they
 * survive this application being uninstalled. So the system keeps producing
 * them, in the same shape, from the ledger.
 *
 * Two rules carried over from the hand-written originals, because they are
 * what made those files trustworthy:
 *
 *   - **Costs from different profiles or nested branches are never added.**
 *     Every figure here is a single path's self time over its own ticks.
 *   - **A correction is a section, not an edit.** When a number turns out to
 *     have been wrong, the old one stays visible with an explanation. That is
 *     why the original file has an "Important correction" heading, and why
 *     `corrections` is a first-class input here rather than something that
 *     silently overwrites history.
 */

import { ACTIVITY_WORDS, DEFAULT_ACTIVITY } from '../analysis/activity.ts';
import { effectiveActivity } from '../store/rollups.ts';
import { findings, type Finding } from '../analysis/findings.ts';

import { OUTLOOK_ORDER, OUTLOOKS } from '../analysis/priority.ts';
import { outcomeText } from '../analysis/knowledge.ts';
import * as q from '../query/queries.ts';
import type { DatabaseSync } from 'node:sqlite';

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Escape a pipe so a cell cannot break the table it sits in. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function n(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/**
 * Render the mod column so the strength of the claim is visible.
 *
 * "attributed to X" is a fact from the capture. "via X" means X is merely the
 * deepest mod in the call path, which is frequently a tick wrapper passing
 * through rather than the cause. Printing both the same way would present a
 * guess as a finding.
 */
function attributionText(f: Finding): string {
  if (f.source === null || f.source === '') return '—';
  switch (f.attribution) {
    case 'mixin':
      return `${f.source} (mixin)`;
    case 'declared':
      return f.source;
    case 'via-path':
      return `via ${f.source}`;
    case 'none':
      return '—';
  }
}

export interface LeaderboardOptions {
  seasonId?: number;
  /** Which mods are yours (analysis/priority.ts ownModMatcher). */
  ownMod?: (mod: string | null | undefined) => boolean;
  /** How many ranked targets to list. */
  limit?: number;
  /** Corrections to prior published figures, kept visible rather than applied silently. */
  corrections?: Array<{ subject: string; wrong: string; right: string; why: string }>;
}

/**
 * The patch leaderboard.
 *
 * Ranked by the best chance to win MSPT back -- cost times how likely its fix
 * outlook is to pay off -- and it says so, with both the cost and the outlook
 * on every row so the order can be argued with.
 */
export function renderLeaderboard(db: DatabaseSync, options: LeaderboardOptions = {}): string {
  const seasonId = options.seasonId ?? q.latestSeasonId(db);
  if (seasonId === undefined) return '# Patch leaderboard\n\nNo captures have been ingested yet.\n';

  const season = q.seasonOptions(db).find((s) => s.id === seasonId);
  // The same minutes findings() reads by default, named as they are everywhere.
  const activity = effectiveActivity(db, seasonId, DEFAULT_ACTIVITY);

  // Pulled wide, then collapsed to one row per FRAME.
  //
  // Findings are per call path, which is right for investigation -- the same
  // method reached two ways can be two different problems. But a leaderboard
  // is a list of targets, and five rows of `AbstractCriterion.trigger` is one
  // target crowding out four others.
  //
  // The representative row is the costliest single path, NOT the sum. Summing
  // self time across distinct paths to the same frame would be arithmetically
  // defensible, but the moment a figure in this file is a sum, the next
  // person to read it has to know which kind of figure it is. Keeping every
  // number "one path's own self time" means that question never arises.
  const wide = findings(db, {
    seasonId,
    limit: Math.max((options.limit ?? 40) * 8, 200),
    ...(options.ownMod === undefined ? {} : { ownMod: options.ownMod }),
  });

  const byFrame = new Map<string, { best: Finding; paths: number }>();
  for (const f of wide) {
    const seen = byFrame.get(f.label);
    if (seen === undefined) byFrame.set(f.label, { best: f, paths: 1 });
    else {
      seen.paths += 1;
      if (f.priority.winBack > seen.best.priority.winBack) seen.best = f;
    }
  }

  const collapsed = [...byFrame.values()].sort((a, b) => b.best.priority.winBack - a.best.priority.winBack);
  const ranked = collapsed.slice(0, options.limit ?? 40);
  const list = ranked.map((r) => r.best);

  const environment =
    season === undefined
      ? 'unknown environment'
      : `${season.os_name}, ${season.loader_name} ${season.mc_version}, ${season.captures} capture${
          season.captures === 1 ? '' : 's'
        }`;

  const rows = ranked
    .map(({ best: f, paths }, index) => {
      const knowledge =
        f.knowledge.length === 0
          ? ''
          : ` **Seen before:** ${f.knowledge.map((k) => `${k.entry.title} (${outcomeText(k.entry.outcome)})`).join('; ')}.`;
      const tracked =
        f.tracked.length === 0 ? '' : ` **In register:** #${f.tracked[0]!.id} (${f.tracked[0]!.status}).`;
      const routes = paths === 1 ? '' : ` Reached by ${paths} distinct call paths; the figure is the largest single one.`;
      const why = f.priority.rationale.join(' ');

      return `| ${index + 1} | \`${cell(f.label)}\` | ${cell(attributionText(f))} | ${n(f.msPerTick, 4)} | ${n(
        f.secondsPerDay,
        1,
      )} | ${Math.round(f.persistence * 100)}% | ${cell(OUTLOOKS[f.priority.outlook].label)} | ${n(f.priority.winBack, 3)} | ${cell(
        why + routes + knowledge + tracked,
      )} |`;
    })
    .join('\n');

  // Computed from the WIDE list, not the truncated one: the whole point of
  // this section is the costs that never make a top-40 by any measure.
  const smallConstant = wide.filter((f) => f.msPerTick < 0.1 && f.persistence > 0.8);
  const seenBefore = list.filter((f) => f.knowledge.length > 0);

  const corrections =
    options.corrections === undefined || options.corrections.length === 0
      ? ''
      : `\n## Corrections\n\nPrevious figures that turned out to be wrong. Kept visible rather than quietly replaced.\n\n` +
        `| Subject | Published | Correct | Why |\n|---|---|---|---|\n` +
        options.corrections
          .map((c) => `| ${cell(c.subject)} | ${cell(c.wrong)} | ${cell(c.right)} | ${cell(c.why)} |`)
          .join('\n') +
        '\n';

  return `# Patch leaderboard

Generated: ${isoDay(Date.now())} · ${environment}

Figures are ${ACTIVITY_WORDS[activity]}${activity === 'playing' ? ' (minutes with nobody online are kept apart)' : ''}.

Ranked by the **best chance to win MSPT back**: each row's own cost times how
likely its fix outlook is to pay off (${OUTLOOK_ORDER.map((o) => `${OUTLOOKS[o].label.toLowerCase()} ×${OUTLOOKS[o].weight}`).join('; ')}).
Both the cost and the outlook are on every row. Nothing is called hard on a
guess: "checked: needed" only ever comes from an earlier investigation, and a
mod anywhere in the call path is named as where to look.

Costs from different profiles or nested branches are never added together.
Each figure below is one call path's own self time over its own ticks.

## Ranked targets

| # | Target | Attributed | MSPT | s/day | Present | Fix outlook | Win-back MSPT | Why |
|---:|---|---|---:|---:|---:|---|---|---|
${rows === '' ? '| — | _nothing recorded yet_ | | | | | | | |' : rows}

## Small but constant

${
  smallConstant.length === 0
    ? 'Nothing currently under 0.1 MSPT with above-80% presence.'
    : `${smallConstant.length} path${smallConstant.length === 1 ? '' : 's'} below 0.1 MSPT present in more than 80% of
observed windows. Individually trivial, permanently there — the category a
time-sorted profile buries and the reason this archive exists.

${smallConstant
  .slice(0, 15)
  .map((f) => `- \`${f.label}\` — ${n(f.msPerTick, 4)} MSPT, ${n(f.secondsPerDay, 1)} s/day of tick budget`)
  .join('\n')}`
}

## Seen before

Earlier figures come from individual captures taken on a mix of machines at a
mix of player counts, and most of these costs scale with load. A direction of
travel here is a prompt to look, **not** a measured change — the A/B validator
is what measures a change, against matched windows.

${
  seenBefore.length === 0
    ? 'Nothing in the current list matches a prior investigation.'
    : seenBefore
        .map(
          (f) =>
            `- \`${f.label}\` — ${f.knowledge
              .map(
                (k) =>
                  `${k.entry.title} (${outcomeText(k.entry.outcome)}, ${k.entry.when})${
                    k.comparison === 'unknown'
                      ? ''
                      : k.comparison === 'similar'
                        ? `; about the same as the ${k.entry.lastMsPerTick} MSPT recorded before`
                        : `; now ${k.comparison} than the ${k.entry.lastMsPerTick} MSPT recorded before`
                  }${k.entry.measuredUnder === undefined ? '' : `, measured ${k.entry.measuredUnder}`}`,
              )
              .join('; ')}`,
        )
        .join('\n')
}
${corrections}
## How to read this

- **MSPT** is exclusive self time: milliseconds per tick for that path alone, not counting what it calls.
- **s/day** is server-thread seconds per day at 20 TPS. A constant 0.15 MSPT
  is about 13 seconds of tick budget every day.
- **Present** is the share of one-minute windows the path appeared in.
- **Fix outlook** says what kind of fix is likely, from facts only: whose code it
  is, a known fix, a fixable pattern, or an earlier investigation. Mod code nobody
  has read yet is never assumed hard.
- **Win-back MSPT** is the cost times the outlook's weight, reduced for thin
  evidence. It orders the list; the cost itself is always shown beside it.
`;
}

/**
 * The capture index.
 *
 * One row per archived capture, which is what the hand-maintained INDEX.md
 * was. Headline figures come from the tick anchor, not thread wall time, so
 * the numbers here match what the rest of the system reports.
 */
export function renderIndex(db: DatabaseSync, limit = 400): string {
  const captures = q.captures(db, limit);
  if (captures.length === 0) return '# Capture index\n\nNo captures have been ingested yet.\n';

  const rows = captures
    .map((c) => {
      const engine =
        c.sampler_engine ?? (c.engine_inferred === 'async' ? 'async (inferred)' : 'unknown');
      const interval = c.interval_micros === null ? '—' : `${(c.interval_micros / 1000).toFixed(0)} ms`;
      return `| ${c.started_at === null ? '—' : new Date(c.started_at).toISOString().replace('T', ' ').slice(0, 16)} | \`${cell(
        c.source_name,
      )}\` | ${c.window_count} | ${interval} | ${n(c.tick_ms_per_tick ?? NaN, 2)} | ${n(
        c.idle_ms_per_tick ?? NaN,
        2,
      )} | ${n(c.blocked_ms_per_tick ?? NaN, 3)} | ${cell(c.os_name)} | ${cell(engine)} | ${
        c.is_manual === 1 ? 'manual' : 'harvested'
      } |`;
    })
    .join('\n');

  return `# Capture index

Generated: ${isoDay(Date.now())} · ${captures.length} capture${captures.length === 1 ? '' : 's'}

**Tick** is the inclusive time of \`MinecraftServer.tick\` — the headline figure.
It is not thread wall time, which includes deliberate waiting and is the most
misleading number in a profile. **Idle** is time parked under
\`waitForTasks\`, which is the tick loop waiting on purpose. **Blocked** is the
tick stalled on something else, and that *is* lost tick time.

An engine of \`unknown\` means the capture did not record one. spark 1.10.53
omits the field entirely, so absence is never read as "Java sampler".

| Started | Profile | Windows | Interval | Tick | Idle | Blocked | Host | Engine | Source |
|---|---|---:|---:|---:|---:|---:|---|---|---|
${rows}
`;
}
