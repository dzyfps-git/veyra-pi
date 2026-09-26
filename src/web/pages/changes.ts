/**
 * Changes: what was deployed, and whether it helped.
 *
 * Three views of one question.
 *
 *   Detected   Every mod-set or JVM-flag change the archive saw, newest
 *              first, with your own mods listed first. Nothing to set up:
 *              the archive already records the mod list with every capture.
 *
 *   Tracked    Changes you have decided to follow -- detected ones you
 *              clicked "Track", and ones recorded by hand (a config edit,
 *              a datapack) that the mod list cannot see.
 *
 *   Compare    Before against after, inside one season, over a window you
 *              choose.
 *
 * ## The comparison shows two things, and only one of them is evidence
 *
 * Measured on a real archive, around a patch deploy: whole-server tick
 * time read "+3.99 ms/tick" over three days and "no measurable change" over
 * seven -- for a patch that removed about 2 ms/tick from its own path. Whole
 * server tick time moves with what players are doing. It is shown as
 * context, with its numbers, and deliberately WITHOUT a verdict word, because
 * "regressed" printed next to a patch is exactly the conclusion it cannot
 * support.
 *
 * The verdict belongs to the call path the change was meant to affect. That
 * is the view that can see a 0.2 ms/tick improvement, and the one whose
 * result can be recorded against the change.
 */

import type { DatabaseSync } from 'node:sqlite';

import { esc, num, when } from '../layout.ts';
import { registerPage } from './register.ts';
import { detectedChanges, compareAround, WINDOW_PRESETS, presetMs, type ChangeComparison } from '../../analysis/changes.ts';
import { findings } from '../../analysis/findings.ts';
import type { ValidationResult } from '../../analysis/validate.ts';
import { assessConfidence, type Confidence } from '../../analysis/confidence.ts';
import { coverage } from '../../store/health.ts';
import type { SettingsStore } from '../../settings/store.ts';
import type { Store } from '../../store/db.ts';
import { ownModPrefixes } from '../../analysis/priority.ts';
import { KNOWLEDGE } from '../../analysis/knowledge.ts';
import { pendingRechecks, recheckText, storedRechecks } from '../../analysis/recheck.ts';

function prefixes(settings: SettingsStore): string[] {
  return ownModPrefixes(settings.getString('analysis.ownMods'));
}

function symbol(kind: string): string {
  return kind === 'added' ? '+' : kind === 'removed' ? '−' : '~';
}

// ---------------------------------------------------------------- detected

function detectedView(store: Store, settings: SettingsStore, serverId?: string): string {
  const changes = detectedChanges(store.db, {
    inHousePrefixes: prefixes(settings),
    limit: 40,
    ...(serverId === undefined ? {} : { serverId }),
  });
  // Seasons by what a person calls them, never by an internal number; the
  // machine too, since two seasons can share an ordinal on different machines.
  const seasonNames = new Map(
    (
      store.db
        .prepare('SELECT s.id, s.ordinal, s.label, e.os_name FROM season s JOIN environment e ON e.id = s.environment_id')
        .all() as Array<{ id: number; ordinal: number; label: string | null; os_name: string }>
    ).map((r) => [r.id, r.label ?? `Season ${r.ordinal} · ${r.os_name.split(' ')[0]}`]),
  );
  // Known issues whose mod this change updated: measured across it, or waiting to be.
  const rechecks = storedRechecks(store.db);
  const pending = pendingRechecks(store.db, rechecks);
  const titleOf = (id: string): string => KNOWLEDGE.find((e) => e.id === id)?.title ?? id;
  const knownIssues = (revisionId: number): string =>
    [
      ...rechecks
        .filter((r) => r.revisionId === revisionId)
        .map(
          (r) => `<div class="help" style="margin-top:6px"><span class="tag accent">known issue</span> ${esc(titleOf(r.entryId))}:
            <b title="${esc(r.explanation)}">${esc(recheckText(r, (v) => num(v, 2)))}</b>${
              r.otherChanges > 0 ? `<span class="faint">, measured with ${r.otherChanges} other mod change${r.otherChanges === 1 ? '' : 's'} in the same update</span>` : ''
            }.${r.state === 'unclear' ? ` <span class="faint">${esc(r.explanation)}</span>` : ''}</div>`,
        ),
      ...pending
        .filter((p) => p.revisionId === revisionId)
        .map(
          (p) => `<div class="help" style="margin-top:6px"><span class="tag">known issue</span> ${esc(titleOf(p.entry.id))}:
            ${p.readyAt > Date.now() ? `re-checked on ${esc(p.to)} after ${esc(when(p.readyAt))}` : `being re-checked on ${esc(p.to)}`}.</div>`,
        ),
    ].join('');

  if (changes.length === 0) {
    return `<div class="empty">No mod or JVM changes detected yet. They appear here automatically when the
      mod list in a capture differs from the one before it, within the same season.</div>`;
  }

  return changes
    .map((c) => {
      const mine = c.changes.filter((m) => m.inHouse);
      const shown = c.changes.slice(0, 8);
      const rest = c.changes.slice(8);
      const row = (m: (typeof c.changes)[number]): string => {
        const version = m.kind === 'updated' ? `${m.from} → ${m.to}` : (m.to ?? m.from ?? '');
        return `<div class="mono" style="font-size:12px;color:${m.inHouse ? 'var(--text-strong)' : 'var(--text-dim)'}">
          ${symbol(m.kind)} ${esc(m.modId)} <span class="faint">${esc(version)}</span>${m.inHouse ? ' <span class="tag accent">yours</span>' : ''}
        </div>`;
      };

      return `<div class="setting" style="grid-template-columns:1fr 230px">
      <div>
        <div class="label">
          <strong>${esc(when(c.at))}</strong>
          <span class="tag">${esc(seasonNames.get(c.seasonId) ?? 'season')}</span>
          <span class="faint" style="font-size:12px">${c.changes.length} mod change${c.changes.length === 1 ? '' : 's'}${
            mine.length > 0 ? `, ${mine.length} of yours` : ''
          }</span>
          ${c.runtimeChanges.length > 0 ? '<span class="tag warn">JVM flags changed</span>' : ''}
        </div>
        ${
          c.runtimeChanges.length > 0
            ? `<div class="help">JVM flags: <span class="mono">${esc(c.runtimeChanges.join('   '))}</span> — the server
               ran differently from here, so a comparison straddling this point may reflect the flag rather than a mod.</div>`
            : ''
        }
        <div style="margin-top:8px">${shown.map(row).join('')}</div>
        ${
          rest.length === 0
            ? ''
            : `<details style="margin-top:4px"><summary class="faint" style="cursor:pointer;font-size:12px">and ${rest.length} more</summary>${rest
                .map(row)
                .join('')}</details>`
        }
        ${knownIssues(c.revisionId)}
        ${wholeServer(store, serverId, c)}
        <div class="help faint" style="margin-top:4px">
          Went live between ${esc(when(c.previousSeenAt))} and ${esc(when(c.at))}.
        </div>
      </div>
      <div class="control" style="gap:6px;align-items:stretch">
        <a href="/changes?view=compare&change=${c.revisionId}"><button class="ghost" style="width:100%">Compare before / after</button></a>
        ${
          c.trackedId === undefined
            ? `<button class="ghost js-track-change" data-revision="${c.revisionId}">Track as a patch</button>`
            : `<a href="/changes?view=tracked"><button class="ghost" style="width:100%">Tracked as #${c.trackedId}</button></a>`
        }
      </div>
    </div>`;
    })
    .join('');
}

/**
 * A first look at a change: the whole server's typical MSPT before and after,
 * only at player counts seen on both sides (three days each way, same
 * season). Context, not proof -- many things move the whole server; Compare
 * tests a specific method properly.
 */
function wholeServer(store: Store, serverId: string | undefined, c: { seasonId: number; at: number; previousSeenAt: number | undefined }): string {
  if (serverId === undefined || c.previousSeenAt === undefined) return '';
  const side = (from: number, to: number): Map<number, number[]> => {
    const rows = store.db
      .prepare(
        `SELECT w.players AS p, w.mspt_median AS v FROM capture_window w JOIN capture c ON c.id = w.capture_id
          WHERE c.server_id = ? AND c.season_id = ? AND w.start_time >= ? AND w.start_time < ?
            AND w.players IS NOT NULL AND w.mspt_median IS NOT NULL`,
      )
      .all(serverId, c.seasonId, from, to) as Array<{ p: number; v: number }>;
    const by = new Map<number, number[]>();
    for (const r of rows) by.set(r.p, [...(by.get(r.p) ?? []), r.v]);
    return by;
  };
  const med = (a: number[]): number => {
    const s = [...a].sort((x, y) => x - y);
    return s[s.length >> 1]!;
  };
  const before = side(c.previousSeenAt - 3 * 86_400_000, c.previousSeenAt);
  const after = side(c.at, c.at + 3 * 86_400_000);
  let weight = 0;
  let b = 0;
  let a = 0;
  for (const [players, list] of before) {
    const other = after.get(players);
    if (other === undefined || list.length < 5 || other.length < 5) continue;
    const w = Math.min(list.length, other.length);
    weight += w;
    b += med(list) * w;
    a += med(other) * w;
  }
  if (weight < 20) {
    return '<div class="help faint" style="margin-top:8px">Too few recorded minutes at the same player counts on both sides to compare the whole server.</div>';
  }
  const delta = (a - b) / weight;
  const cls = Math.abs(delta) < 0.5 ? '' : delta > 0 ? 'bad' : 'ok';
  return `<div class="help" style="margin-top:8px">Whole server at the same player counts:
    <b>${num(b / weight, 1)} → ${num(a / weight, 1)} MSPT</b> <span class="tag ${cls}">${delta >= 0 ? '+' : '−'}${num(Math.abs(delta), 1)}</span>
    <span class="faint">(${weight} matched minutes; context only, since players’ activity moves this too. Compare tests one method properly.)</span></div>`;
}

// ---------------------------------------------------------------- compare

function windowPicker(current: { before: string; after: string }, carry: string): string {
  const options = (selected: string): string =>
    WINDOW_PRESETS.map(
      (p) => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${esc(p.label)}</option>`,
    ).join('');
  return `<form method="get" action="/changes" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:14px 0">
    <input type="hidden" name="view" value="compare">
    ${carry}
    <label class="faint" style="font-size:12.5px">Before
      <select name="before" onchange="this.form.submit()">${options(current.before)}</select></label>
    <label class="faint" style="font-size:12.5px">After
      <select name="after" onchange="this.form.submit()">${options(current.after)}</select></label>
    <span class="faint" style="font-size:12px">
      Independent of retention: this chooses how much of what is kept to look at, not how long anything is kept.
    </span>
  </form>`;
}

/** Numbers without a verdict, for the view that cannot support one. */
function contextBlock(result: ValidationResult | undefined): string {
  if (result === undefined) return '';
  const delta =
    result.beforeMedian === undefined || result.afterMedian === undefined
      ? undefined
      : result.afterMedian - result.beforeMedian;
  // Say why there is nothing, rather than showing dashes: usually the window
  // is shorter than the gap between captures, and a wider one will find data.
  if (result.beforeWindows === 0 || result.afterWindows === 0) {
    return `<div class="setting" style="grid-template-columns:1fr">
    <div>
      <div class="label"><strong>Whole-server tick time</strong> <span class="tag">context only</span></div>
      <div class="help">
        No player-matched minutes on ${result.beforeWindows === 0 && result.afterWindows === 0 ? 'either side' : result.beforeWindows === 0 ? 'the before side' : 'the after side'}
        in this window (${result.beforeWindows} vs ${result.afterWindows}). Nothing was captured there with a
        comparable player count — try a wider window.
      </div>
    </div>
  </div>`;
  }
  return `<div class="setting" style="grid-template-columns:1fr">
    <div>
      <div class="label"><strong>Whole-server tick time</strong> <span class="tag">context only</span></div>
      <div class="help">
        Median ${num(result.beforeMedian, 2)} ms before, ${num(result.afterMedian, 2)} ms after
        ${delta === undefined ? '' : `(${delta >= 0 ? '+' : ''}${num(delta, 2)} ms)`}
        ${
          result.ciLow === undefined || result.ciHigh === undefined
            ? ''
            : ` · 95% interval [${num(result.ciLow, 2)}, ${num(result.ciHigh, 2)}]`
        }
        · ${result.beforeWindows} vs ${result.afterWindows} player-matched minutes${
          result.bucketsCompared.length === 0 ? '' : ` (player buckets ${result.bucketsCompared.join(', ')})`
        }
      </div>
      <div class="help faint">
        This moves with what players are doing, where they are, and how much is loaded. A patch worth 0.2 MSPT
        is far inside that noise, and a busy evening after a deploy looks like a regression. It is shown so the
        conditions are visible — it is <strong>not</strong> a verdict on the change.
      </div>
    </div>
  </div>`;
}

function verdictBlock(result: ValidationResult, targetLabel: string, confidence: Confidence): string {
  const tone: Record<string, string> = {
    verified: 'ok',
    likely: 'ok',
    'not-enough': 'warn',
    'no-change': '',
    worse: 'bad',
  };
  const t = tone[confidence.level] ?? '';
  const checks = confidence.checks
    .map(
      (c) => `<li style="display:flex;gap:8px;align-items:flex-start;margin:4px 0">
        <span style="color:var(--${c.ok ? 'ok' : 'warn'});flex:none">${c.ok ? '✓' : '!'}</span><span>${esc(c.text)}</span></li>`,
    )
    .join('');
  return `<div class="panel${t === 'bad' ? ' tone-bad' : t === 'warn' ? ' tone-warn' : ''}" style="padding:16px 18px">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span class="tag ${t}" style="font-size:12.5px;padding:3px 11px">${esc(confidence.headline)}</span>
      <span class="mono" style="font-size:12.5px">${esc(targetLabel)}</span>
    </div>
    <div class="dim" style="margin-top:8px">${esc(result.explanation)}</div>
    <div class="faint" style="font-size:12px;margin-top:4px">
      Median ${num(result.beforeMedian, 4)} → ${num(result.afterMedian, 4)} MSPT on this method, own time.
    </div>
    <div style="margin-top:12px;font-size:12.5px;color:var(--text-dim)"><b>Why this verdict</b>
      <ul style="list-style:none;padding:0;margin:6px 0 0">${checks}</ul></div>
    ${
      confidence.level === 'likely' || confidence.level === 'not-enough'
        ? '<div class="faint" style="font-size:12px;margin-top:8px">More recorded time after the change, at player counts seen before it, is what firms this up. A wider window can help.</div>'
        : ''
    }
  </div>`;
}

function compareView(store: Store, settings: SettingsStore, params: URLSearchParams): string {
  const reg = store.db;
  const changeId = Number(params.get('change'));
  const entryId = Number(params.get('entry'));
  const before = params.get('before') ?? '24h';
  const after = params.get('after') ?? '24h';

  // Resolve what is being compared: a detected change, or a tracked entry.
  let at: number | undefined;
  let title = '';
  let targetPath: string | null = null;
  let targetLabel: string | null = null;
  let trackedId: number | undefined;
  let carry = '';

  if (Number.isFinite(entryId) && entryId > 0) {
    const row = reg
      .prepare('SELECT id, title, deployed_at, target_path_text, target_label FROM optimization WHERE id = ?')
      .get(entryId) as
      | { id: number; title: string; deployed_at: number | null; target_path_text: string | null; target_label: string | null }
      | undefined;
    if (row === undefined) return '<div class="empty">No such tracked change.</div>';
    if (row.deployed_at === null) {
      return `<div class="note warn">"${esc(row.title)}" has no deploy time yet, so there is no "before" and "after"
        to compare. Set when it went live on the <a href="/changes?view=tracked">Tracked</a> tab.</div>`;
    }
    at = row.deployed_at;
    title = row.title;
    targetPath = row.target_path_text;
    targetLabel = row.target_label;
    trackedId = row.id;
    carry = `<input type="hidden" name="entry" value="${row.id}">`;
  } else if (Number.isFinite(changeId) && changeId > 0) {
    const change = detectedChanges(reg, { inHousePrefixes: prefixes(settings), limit: 200 }).find(
      (c) => c.revisionId === changeId,
    );
    if (change === undefined) return '<div class="empty">No such detected change.</div>';
    at = change.at;
    const mine = change.changes.filter((m) => m.inHouse).map((m) => m.modId);
    title = mine.length > 0 ? mine.slice(0, 3).join(', ') : `${change.changes.length} mod change(s)`;
    carry = `<input type="hidden" name="change" value="${change.revisionId}">`;
    if (change.trackedId !== undefined) {
      const row = reg
        .prepare('SELECT target_path_text, target_label FROM optimization WHERE id = ?')
        .get(change.trackedId) as { target_path_text: string | null; target_label: string | null } | undefined;
      targetPath = row?.target_path_text ?? null;
      targetLabel = row?.target_label ?? null;
      trackedId = change.trackedId;
    }
  } else {
    return `<div class="empty">Choose a change to compare from the <a href="/changes">Detected</a> or
      <a href="/changes?view=tracked">Tracked</a> tab.</div>`;
  }

  // The server the change belongs to -- not simply the first one.
  const serverId =
    (Number.isFinite(entryId) && entryId > 0
      ? (reg.prepare('SELECT server_id FROM optimization WHERE id = ?').get(entryId) as { server_id: string } | undefined)?.server_id
      : (reg.prepare('SELECT s.server_id FROM revision r JOIN season s ON s.id = r.season_id WHERE r.id = ?').get(changeId) as
          | { server_id: string }
          | undefined)?.server_id) ?? '';
  const comparison: ChangeComparison = compareAround(reg, {
    serverId,
    at,
    beforeMs: presetMs(before),
    afterMs: presetMs(after),
    targetPath,
    gate: {
      minEffect: settings.getNumber('analysis.validation.minEffectMsPerTick'),
      minWindowsPerSide: settings.getNumber('analysis.validation.minWindowsPerSide'),
      playerBucketSize: settings.getNumber('analysis.validation.playerBucketSize'),
    },
    resolvePath: (stored) => store.resolveDataPath(stored),
  });

  const header = `<div class="note">
    Comparing <strong>${esc(title)}</strong>, live at ${esc(when(at))}.
    Before: ${esc(when(comparison.before.fromMs))} → ${esc(when(comparison.before.toMs))} ·
    After: ${esc(when(comparison.after.fromMs))} → ${esc(when(comparison.after.toMs))}.
    Minutes are only compared against minutes with a similar player count, and only inside one season.
  </div>`;

  if (!comparison.ok) {
    return `${header}${windowPicker({ before, after }, carry)}
      <div class="note bad"><strong>This comparison can't be made.</strong> ${esc(comparison.refused ?? '')}</div>`;
  }

  // The part that can be evidence.
  let targetSection: string;
  if (comparison.target !== undefined) {
    const sideCoverage = (span: { fromMs: number; toMs: number }) =>
      coverage(reg, { serverId, ...span, ...(comparison.seasonId === undefined ? {} : { seasonId: comparison.seasonId }) });
    const confidence = assessConfidence(comparison.target, {
      minWindows: settings.getNumber('analysis.validation.minWindowsPerSide'),
      minEffect: settings.getNumber('analysis.validation.minEffectMsPerTick'),
      before: sideCoverage(comparison.before),
      after: sideCoverage({ fromMs: comparison.after.fromMs, toMs: Math.min(comparison.after.toMs, Date.now()) }),
    });
    targetSection = `${verdictBlock(comparison.target, targetLabel ?? comparison.targetPath ?? 'Target', confidence)}
      ${
        trackedId === undefined
          ? ''
          : `<button class="js-record" data-entry="${trackedId}" data-before="${presetMs(before)}" data-after="${presetMs(after)}">
              Record this result on the change</button>
             <span class="faint" style="font-size:12px;margin-left:8px">Only a result recorded here can mark a change as proven.</span>`
      }`;
  } else {
    const season = comparison.seasonId;
    const candidates = season === undefined ? [] : findings(reg, { seasonId: season, limit: 40 });
    targetSection = `<div class="note">
      <strong>No target call path yet.</strong> The whole-server figure below can't show whether a patch helped;
      the call path it was meant to affect can. ${
        trackedId === undefined
          ? 'Track this change first, then choose its target.'
          : `Choose it here:
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
              <select id="target-pick" style="max-width:560px">${candidates
                .map(
                  (f) =>
                    `<option value="${esc(f.path)}" data-label="${esc(f.label)}">${esc(f.label)} — ${num(f.msPerTick, 3)} MSPT</option>`,
                )
                .join('')}</select>
              <button class="js-set-target" data-entry="${trackedId}">Use this target</button>
            </div>`
      }
    </div>`;
  }

  return `${header}${windowPicker({ before, after }, carry)}
    ${targetSection}
    ${contextBlock(comparison.overall)}`;
}

// ---------------------------------------------------------------- page

export function changesPage(store: Store, settings: SettingsStore, params: URLSearchParams, serverId?: string): string {
  const view = params.get('view') ?? 'detected';

  const tabs = [
    ['detected', 'Detected'],
    ['tracked', 'Tracked'],
    ['compare', 'Compare'],
  ]
    .map(([k, label]) => `<a href="/changes?view=${k}" class="${view === k ? 'active' : ''}">${esc(label!)}</a>`)
    .join('');

  let body: string;
  if (view === 'tracked') {
    body = `<div class="note faint">
      Changes you are following. A detected change you click "Track" lands here with its deploy time already
      set; anything the mod list can't see — a config edit, a datapack, a gamerule — can be added by hand.
    </div>
    <details style="margin:12px 0">
      <summary style="cursor:pointer">Record a change by hand</summary>
      <div class="setting" style="grid-template-columns:1fr;margin-top:10px">
        <div style="display:grid;gap:8px;max-width:560px">
          <input type="text" id="manual-title" placeholder="What changed? e.g. lowered entity-broadcast-range to 80%">
          <label class="faint" style="font-size:12.5px">When it went live
            <input type="datetime-local" id="manual-at"></label>
          <input type="text" id="manual-notes" placeholder="Notes (optional)">
          <div><button id="manual-save">Record</button></div>
        </div>
      </div>
    </details>
    ${registerPage(store.db, params)}`;
  } else if (view === 'compare') {
    body = compareView(store, settings, params);
  } else {
    body = `<div class="note">
      Every mod or JVM-flag change, newest first, detected from each capture; your own mods first.
      <strong>Compare</strong> shows before against after; <strong>Track</strong> follows it as a patch.
    </div>${detectedView(store, settings, serverId)}`;
  }

  return `<div class="tabs">${tabs}</div>
${body}
<div id="changes-status" class="note" style="display:none"></div>
<script>
(() => {
  const status = document.getElementById('changes-status');
  const say = (text, bad) => { status.textContent = text; status.className = 'note' + (bad ? ' bad' : ''); status.style.display = 'block'; };
  const post = async (url, body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  };

  for (const el of document.querySelectorAll('.js-track-change')) {
    el.addEventListener('click', async () => {
      el.disabled = true;
      const data = await post('/api/changes/track', { revisionId: Number(el.dataset.revision) });
      if (data.ok) location.reload(); else { el.disabled = false; say(data.error || 'failed', true); }
    });
  }

  document.getElementById('manual-save')?.addEventListener('click', async () => {
    const title = document.getElementById('manual-title').value.trim();
    const at = Date.parse(document.getElementById('manual-at').value);
    if (title === '') return say('Describe what changed.', true);
    if (!Number.isFinite(at)) return say('Say when it went live.', true);
    const data = await post('/api/changes/record', { title, at, notes: document.getElementById('manual-notes').value.trim() });
    if (data.ok) location.reload(); else say(data.error || 'failed', true);
  });

  for (const el of document.querySelectorAll('.js-set-target')) {
    el.addEventListener('click', async () => {
      const pick = document.getElementById('target-pick');
      const option = pick.options[pick.selectedIndex];
      const data = await post('/api/register/target', {
        id: Number(el.dataset.entry), targetPathText: option.value, targetLabel: option.dataset.label,
      });
      if (data.ok) location.reload(); else say(data.error || 'failed', true);
    });
  }

  for (const el of document.querySelectorAll('.js-record')) {
    el.addEventListener('click', async () => {
      el.disabled = true;
      say('Recording the result…');
      const data = await post('/api/register/validate', {
        id: Number(el.dataset.entry), beforeMs: Number(el.dataset.before), afterMs: Number(el.dataset.after),
      });
      if (data.ok) say('Recorded: ' + data.verdict + '. See the Tracked tab.'); else { el.disabled = false; say(data.error || 'failed', true); }
    });
  }
})();
</script>`;
}
