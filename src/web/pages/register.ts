/**
 * Register page: what has actually been tried, and what it actually did.
 *
 * The page exists to keep one distinction visible that is very easy to lose:
 * *implemented* is not *proven to have helped*. So the layout separates them
 * physically — entries awaiting evidence sit in their own group, and a
 * verdict is never rendered as a badge on its own. It always appears with the
 * delta, the confidence interval, how many matched windows it rests on, and
 * the sentence explaining it.
 *
 * Two things are deliberately hard to do here:
 *   - There is no control that sets a measured status. The engine assigns it
 *     from data or nobody does; the status dropdown omits those options and
 *     the API refuses them a second time.
 *   - A synthetic benchmark can be attached, but it renders as a note that
 *     says outright it is not evidence about the server, and it cannot move
 *     the status.
 */

import { esc, num, when } from '../layout.ts';
import type { DatabaseSync } from 'node:sqlite';
import { Register, type Optimization, type OptimizationStatus } from '../../analysis/register.ts';

/** Statuses a person may choose. The measured ones are absent by design. */
const SETTABLE: readonly OptimizationStatus[] = ['proposed', 'investigating', 'implemented', 'reverted'];

const STATUS_TAG: Record<OptimizationStatus, { cls: string; text: string }> = {
  proposed: { cls: '', text: 'proposed' },
  investigating: { cls: 'accent', text: 'investigating' },
  implemented: { cls: 'warn', text: 'implemented — unproven' },
  'measured-improvement': { cls: 'ok', text: 'measured improvement' },
  'no-measurable-change': { cls: '', text: 'no measurable change' },
  regressed: { cls: 'bad', text: 'regressed' },
  reverted: { cls: '', text: 'reverted' },
};

type GroupKey = 'open' | 'awaiting' | 'measured' | 'archived';

const GROUP_OF: Record<OptimizationStatus, GroupKey> = {
  proposed: 'open',
  investigating: 'open',
  implemented: 'awaiting',
  'measured-improvement': 'measured',
  'no-measurable-change': 'measured',
  regressed: 'measured',
  reverted: 'archived',
};

function card(k: string, v: string, note?: string): string {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${
    note === undefined ? '' : `<div class="n">${esc(note)}</div>`
  }</div>`;
}

/**
 * The validation result, rendered with its evidence attached.
 *
 * A bare verdict is exactly the thing this system is supposed to not produce,
 * so the interval and the window counts are not optional detail behind a
 * disclosure — they are part of the result.
 */
function verdictBlock(o: Optimization): string {
  if (o.verdict === null) return '';

  const tone =
    o.verdict === 'improved' ? 'ok' : o.verdict === 'regressed' ? 'bad' : o.verdict === 'inconclusive' ? 'warn' : '';

  const interval =
    o.ci_low === null || o.ci_high === null
      ? ''
      : `<span class="mono">[${num(o.ci_low, 4)}, ${num(o.ci_high, 4)}]</span> 95% CI · `;

  const delta =
    o.delta_ms_per_tick === null
      ? '—'
      : `${o.delta_ms_per_tick >= 0 ? '+' : ''}${num(o.delta_ms_per_tick, 4)} MSPT`;

  return `<div class="note ${tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : ''}" style="margin-top:10px">
    <strong>Measured: ${esc(o.verdict)}</strong> — <span class="mono">${esc(delta)}</span><br>
    <span class="faint" style="font-size:11.5px">
      ${interval}${o.before_windows ?? 0} windows before, ${o.after_windows ?? 0} after · validated ${esc(when(o.validated_at))}
    </span>
    <div style="margin-top:6px">${esc(o.validation_note ?? '')}</div>
  </div>`;
}

function syntheticBlock(o: Optimization): string {
  if (o.synthetic_note === null || o.synthetic_note === '') return '';
  return `<div class="note warn" style="margin-top:10px">
    <strong>Synthetic benchmark</strong> — recorded, but <em>not</em> evidence about the live server.
    A microbenchmark showing a function got faster says nothing about the tick budget, so this can
    never set a verdict.
    <div style="margin-top:6px" class="mono" style="font-size:12px">${esc(o.synthetic_note)}</div>
  </div>`;
}

function eventsBlock(reg: Register, o: Optimization): string {
  const events = reg.events(o.id).slice(0, 8);
  if (events.length === 0) return '';
  return `<details style="margin-top:10px">
    <summary class="faint" style="cursor:pointer;font-size:12px">History (${events.length})</summary>
    <table style="margin-top:8px">
      ${events
        .map(
          (e) => `<tr>
            <td class="dim" style="width:130px">${esc(when(e.at))}</td>
            <td style="width:120px">${esc(e.kind)}</td>
            <td class="faint">${esc(e.detail ?? '')}</td>
            <td class="faint" style="width:80px;text-align:right">${esc(e.actor ?? '')}</td>
          </tr>`,
        )
        .join('')}
    </table>
  </details>`;
}

function entry(reg: Register, o: Optimization): string {
  const tag = STATUS_TAG[o.status];
  const canValidate = o.deployed_at !== null && o.target_path_text !== null && o.target_path_text !== '';

  // A measured status is not in the settable list, so without this the
  // dropdown would fall back to its first option and quietly misreport a
  // validated entry as "proposed". The real status is shown, and shown as
  // unselectable, which is also the clearest statement of the rule.
  const measured = !SETTABLE.includes(o.status);
  const options =
    (measured ? `<option selected disabled>${esc(tag.text)} — set by the engine</option>` : '') +
    SETTABLE.map(
      (s) => `<option value="${s}"${!measured && s === o.status ? ' selected' : ''}>${esc(s)}</option>`,
    ).join('');

  return `<div class="setting" id="entry-${o.id}" data-id="${o.id}" style="scroll-margin-top:16px;grid-template-columns:1fr 250px">
  <div>
    <div class="label">
      <strong>${esc(o.title)}</strong>
      <span class="tag ${tag.cls}">${esc(tag.text)}</span>
      ${o.feasibility === 'unknown' ? '<span class="tag">feasibility unknown</span>' : `<span class="tag accent">${esc(o.feasibility)}</span>`}
      ${o.risk === 'high' ? '<span class="tag bad">high risk</span>' : ''}
    </div>
    ${o.target_label === null ? '' : `<div class="help mono" style="font-size:11.5px;color:var(--text-faint)" title="${esc(o.target_path_text ?? '')}">${esc(o.target_label)}</div>`}
    ${o.hypothesis === null ? '' : `<div class="help"><strong>Hypothesis:</strong> ${esc(o.hypothesis)}</div>`}
    ${o.approach === null ? '' : `<div class="help"><strong>Approach:</strong> ${esc(o.approach)}</div>`}
    ${o.notes === null ? '' : `<div class="help faint">${esc(o.notes)}</div>`}
    ${verdictBlock(o)}
    ${syntheticBlock(o)}
    ${eventsBlock(reg, o)}
  </div>
  <div class="control" style="gap:6px;align-items:stretch">
    <div class="faint" style="font-size:11.5px;text-align:right">
      created ${esc(when(o.created_at))}<br>
      ${o.deployed_at === null ? 'not deployed' : `deployed ${esc(when(o.deployed_at))}`}
    </div>
    <select class="js-status">${options}</select>
    <button class="ghost js-deploy">${o.deployed_at === null ? 'Mark deployed now' : 'Update deploy time'}</button>
    <button class="ghost js-synthetic">Attach benchmark note</button>
    <button class="js-validate"${canValidate ? '' : ' disabled title="Needs a deploy time and a target call path"'}>Run validation</button>
  </div>
</div>`;
}

export function registerPage(db: DatabaseSync, params: URLSearchParams): string {
  const reg = new Register(db);
  const all = reg.list();
  // Its own parameter: this list is embedded in Changes, whose `view` is the
  // tab ("tracked"). Reading `view` here filtered everything away.
  const requested = params.get('status') ?? 'all';
  const view = (['all', 'open', 'awaiting', 'measured', 'archived'].includes(requested) ? requested : 'all') as GroupKey | 'all';

  const counts: Record<GroupKey, number> = { open: 0, awaiting: 0, measured: 0, archived: 0 };
  for (const o of all) counts[GROUP_OF[o.status]] += 1;

  const improved = all.filter((o) => o.status === 'measured-improvement').length;
  const nothing = all.filter((o) => o.status === 'no-measurable-change').length;
  const worse = all.filter((o) => o.status === 'regressed').length;

  const list = view === 'all' ? all : all.filter((o) => GROUP_OF[o.status] === view);

  const tabs = (
    [
      ['all', `All (${all.length})`],
      ['open', `Open (${counts.open})`],
      ['awaiting', `Awaiting evidence (${counts.awaiting})`],
      ['measured', `Measured (${counts.measured})`],
      ['archived', `Reverted (${counts.archived})`],
    ] as const
  )
    .map(([k, label]) => `<a href="/changes?view=tracked&status=${k}" class="${view === k ? 'active' : ''}">${esc(label)}</a>`)
    .join('');

  return `
<div class="cards">
  ${card('Tracked', String(all.length), 'nothing is ever deleted')}
  ${card('Awaiting evidence', String(counts.awaiting), 'deployed, not yet measured')}
  ${card('Measured improvements', String(improved), 'proven against matched windows')}
  ${card('Did nothing / regressed', `${nothing} / ${worse}`, 'kept, because a negative result is a result')}
</div>

<div class="tabs" style="margin-top:22px">${tabs}</div>

<div class="note">
  <strong>Implemented is not the same as proven.</strong> A measured status can only be assigned by the
  validation engine, from matched before-and-after windows — there is no control on this page that sets
  one, and the API refuses it if asked. Entries sit in <em>awaiting evidence</em> for as long as that
  takes, which is the honest state. Nothing is deleted: a reverted change keeps its history so a
  problem that comes back finds the work already done.
</div>

<details style="margin:18px 0">
  <summary style="cursor:pointer">Add an entry</summary>
  <div class="setting" style="grid-template-columns:1fr;margin-top:12px">
    <div style="display:grid;gap:8px;max-width:640px">
      <input type="text" id="new-title" placeholder="Title — what change is being proposed?">
      <input type="text" id="new-target" placeholder="Target method (optional), e.g. lootr.config.ConfigManager.get">
      <input type="text" id="new-path" placeholder="Full call path (optional) — required later to validate">
      <input type="text" id="new-hypothesis" placeholder="Hypothesis — why is this cost avoidable?">
      <input type="text" id="new-approach" placeholder="Approach — what would actually change?">
      <div style="display:flex;gap:8px;align-items:center">
        <select id="new-feasibility">
          <option value="unknown" selected>feasibility unknown</option>
          <option value="likely">likely</option>
          <option value="unlikely">unlikely</option>
          <option value="proven">proven</option>
        </select>
        <select id="new-risk">
          <option value="unknown" selected>risk unknown</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
        <button id="new-save">Add</button>
      </div>
      <div class="help faint">
        Feasibility and risk default to unknown and stay there until someone reads the source.
        An unknown is not a gap to be filled in with a guess.
      </div>
    </div>
  </div>
</details>

${
  list.length === 0
    ? `<div class="empty">Nothing here yet. Findings become entries once someone decides to act on one.</div>`
    : list.map((o) => entry(reg, o)).join('')
}

<div id="register-status" class="note" style="display:none"></div>

<script>
(() => {
  const status = document.getElementById('register-status');
  const say = (message, bad) => {
    status.textContent = message;
    status.className = 'note' + (bad ? ' bad' : '');
    status.style.display = 'block';
  };

  const post = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, data: await res.json() };
  };

  const idOf = (el) => Number(el.closest('[data-id]').dataset.id);

  for (const el of document.querySelectorAll('.js-status')) {
    el.addEventListener('change', async () => {
      const { data } = await post('/api/register/status', { id: idOf(el), status: el.value });
      if (data.ok) location.reload();
      else say(data.error || 'refused', true);
    });
  }

  for (const el of document.querySelectorAll('.js-deploy')) {
    el.addEventListener('click', async () => {
      const entered = await perfint.ask('Deploy time (ISO 8601, or blank for now):', '');
      if (entered === null) return;
      const at = entered.trim() === '' ? Date.now() : Date.parse(entered);
      if (!Number.isFinite(at)) return say('That is not a date I can read.', true);
      const { data } = await post('/api/register/deploy', { id: idOf(el), deployedAt: at });
      if (data.ok) location.reload();
      else say(data.error || 'failed', true);
    });
  }

  for (const el of document.querySelectorAll('.js-synthetic')) {
    el.addEventListener('click', async () => {
      const note = await perfint.ask('Benchmark result. Recorded, but it cannot set a verdict:', '');
      if (note === null || note.trim() === '') return;
      const { data } = await post('/api/register/synthetic', { id: idOf(el), note });
      if (data.ok) location.reload();
      else say(data.error || 'failed', true);
    });
  }

  for (const el of document.querySelectorAll('.js-validate')) {
    el.addEventListener('click', async () => {
      el.disabled = true;
      say('Collecting matched windows from the archive…');
      const { data } = await post('/api/register/validate', { id: idOf(el) });
      el.disabled = false;
      if (data.ok) location.reload();
      else say(data.error || 'validation failed', true);
    });
  }

  const save = document.getElementById('new-save');
  save?.addEventListener('click', async () => {
    const value = (id) => document.getElementById(id).value.trim();
    if (value('new-title') === '') return say('A title is required.', true);
    const { data } = await post('/api/register/create', {
      title: value('new-title'),
      targetLabel: value('new-target') || undefined,
      targetPathText: value('new-path') || undefined,
      hypothesis: value('new-hypothesis') || undefined,
      approach: value('new-approach') || undefined,
      feasibility: value('new-feasibility'),
      risk: value('new-risk'),
    });
    if (data.ok) location.reload();
    else say(data.error || 'failed', true);
  });
})();
</script>
`;
}
