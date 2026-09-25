/**
 * How it works: the whole app in plain words.
 *
 * Written for someone who has never opened spark and does not know what
 * MSPT is. Short sections, the answer first, detail after; every term the
 * rest of the app uses is defined here once.
 */

import { panel } from '../layout.ts';

const term = (name: string, text: string): string =>
  `<div class="term"><div class="term-name">${name}</div><div class="term-text">${text}</div></div>`;

export function guidePage(): string {
  return `
<style>
.guide { max-width: 860px; }
.guide p { color: var(--text-dim); margin: 0 0 10px; }
.guide .lead { font-size: 15px; color: var(--text); }
.term { display: grid; grid-template-columns: 200px 1fr; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border-soft); }
.term:last-child { border-bottom: none; }
.term-name { font-weight: 700; color: var(--text-strong); }
.term-text { color: var(--text-dim); }
.toc { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 18px; }
.toc a { padding: 5px 13px; border-radius: 999px; background: var(--surface); font-size: 12.5px; font-weight: 600; color: var(--text-dim); transition: background .2s var(--ease), color .2s var(--ease); }
.toc a:hover { color: var(--text); background: var(--surface-2); text-decoration: none; }
@media (max-width: 700px) { .term { grid-template-columns: 1fr; gap: 4px; } }
</style>
<div class="guide">
<div class="toc">
  <a href="#what">What it does</a><a href="#numbers">The numbers</a><a href="#pages">The pages</a>
  <a href="#health">Is it working?</a><a href="#compare">Did my patch help?</a><a href="#never">What it never does</a>
</div>

${panel('What this app does', `
<p class="lead">It keeps a permanent history of where your server spends its tick time, so slow spots can be found,
fixed, and proven fixed.</p>
<p><b>spark</b> samples the server thread in the background but only remembers the last hour. This app collects
those samples every few minutes, before they are lost, and archives each batch as a <b>capture</b> on this PC.</p>
<p>Everything belongs to one <b>season</b>: one stretch with the same machine, world and modpack. Figures are never
mixed across seasons, because a new machine or a fresh world changes everything.</p>
`, { id: 'what' })}

${panel('The numbers', `
${term('MSPT', 'Milliseconds per tick. The server runs 20 ticks a second, so each has 50 ms; over 50 it falls behind and players feel lag. Every cost in the app is in MSPT, so it can be held against the whole tick.')}
${term('Own MSPT', 'Time inside one method itself. Own times add up to the whole tick. “Including what it calls” overlaps with its children and is never added.')}
${term('Freeze', 'One tick of half a second or more. A minute can look fine on average while one tick froze.')}
${term('Normal', 'What the server usually does with the same number of players.')}
${term('Fix outlook', 'What kind of fix is likely, from facts only: your own mod, a known fix, mod code nobody has checked, or the game’s own work. Nothing is called hard on a guess.')}
${term('Evidence', 'How many samples back a figure. “Thin” means treat it as a lead, not a fact.')}
`, { id: 'numbers' })}

${panel('The pages', `
${term('Overview', 'Is collection working, and how is the server doing against normal. Click the chart to open a minute; drag across it to zoom.')}
${term('A minute', 'What took longer than normal in that minute, part by part. Click any thing inside a part to see its methods and hand it off.')}
${term('Findings', 'Where the tick goes, then every method that costs time. “By method” groups and ranks them; “Every call path” lists every recorded path, down to the smallest.')}
${term('Reports', 'Briefs for whoever will read the code (one method, a thing, or a whole mod), and the leaderboard.')}
${term('Changes', 'What was deployed and when, with before-and-after comparisons.')}
${term('Server &amp; history', 'How this server is monitored, whether its setup is healthy, and its seasons.')}
`, { id: 'pages' })}

${panel('Is it working?', `
<p>The dot beside the server name and the top of the Overview say what collection is doing. <b>Nothing recorded
recently</b> is the one to act on; the others (waiting, restoring background profiling, server not answering)
sort themselves out. Every time range also says how much of it was recorded, so a gap never looks like a quiet
stretch.</p>
`, { id: 'health' })}

${panel('Did my patch help?', `
<p>Changes → Compare puts the time before a change against the time after, using only minutes with a similar
number of players in the same season. It says <b>improved</b> or <b>worse</b> only when the difference is bigger
than the noise; otherwise <b>not enough evidence yet</b>, and why. Whole-server MSPT is shown for context only;
the method the patch targets is what proves it.</p>
`, { id: 'compare' })}

${panel('What it never does', `
${term('Restart anything', 'Changes that need a restart say so and wait for you.')}
${term('Send other commands', 'Only spark profiler commands, only for servers set to Automatic, and only when nobody is typing in the console or profiling.')}
${term('Compete with your server', 'It runs at below-normal priority and its heavy work waits while this PC is busy.')}
${term('Touch other files', 'The only server files it writes are spark’s config and the JVM-flag files (backed up first, undoable). The only files it deletes are profiles it harvested, archived and verified unchanged; profiles you save are never touched.')}
`, { id: 'never' })}
</div>`;
}
