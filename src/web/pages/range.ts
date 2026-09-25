/**
 * The time-range picker shared by the Ledger and Findings.
 *
 * A plain GET form, so a range is a link that can be bookmarked or sent, and
 * works with scripts off (the custom fields are simply always visible then).
 *
 * Hours and custom date-and-time spans are read minute by minute from the
 * captures' per-minute detail; whole days come from the permanent daily
 * ledger. The line under the picker always states exactly what was used.
 */

import { esc } from '../layout.ts';
import { RANGE_PRESETS, localInputValue, type DayRange, type ResolvedRange } from '../../query/range.ts';
import type { HourlyCoverage } from '../../query/hourly.ts';
import { coverageWords, type Coverage } from '../../store/health.ts';
import { when } from '../layout.ts';

/** The range's own query parameters, for carrying it on other links. */
export function rangeParams(resolved: ResolvedRange, params: URLSearchParams): Record<string, string> {
  if (resolved.preset === 'season' || resolved.problem !== undefined) return {};
  const out: Record<string, string> = { range: resolved.preset };
  if (resolved.preset === 'custom') {
    const from = params.get('from');
    const to = params.get('to');
    if (from !== null) out['from'] = from;
    if (to !== null) out['to'] = to;
  }
  return out;
}

export function rangeControls(
  action: string,
  hidden: Record<string, string>,
  resolved: ResolvedRange,
  bounds: DayRange | undefined,
  params: URLSearchParams,
  latestMoment?: number,
  coverage?: HourlyCoverage,
  /** Shown on the same row, before the range (a season picker). */
  leading = '',
): string {
  if (bounds === undefined) return '';
  const custom = resolved.preset === 'custom';
  const defaultTo = latestMoment ?? Date.parse(`${bounds.toDay}T23:59:00`);
  const from = params.get('from')?.includes('T')
    ? params.get('from')!
    : localInputValue(resolved.time?.fromMs ?? defaultTo - 5 * 3_600_000);
  const to = params.get('to')?.includes('T') ? params.get('to')! : localInputValue(resolved.time?.toMs ?? defaultTo);

  const groups = [...new Set(RANGE_PRESETS.map((p) => p.group))];
  const options = groups
    .map((group) => {
      const items = RANGE_PRESETS.filter((p) => p.group === group)
        .map((p) => `<option value="${p.id}"${p.id === resolved.preset ? ' selected' : ''}>${esc(p.label)}</option>`)
        .join('');
      return group === 'All' || group === 'Custom' ? items : `<optgroup label="${esc(group)}">${items}</optgroup>`;
    })
    .join('');

  const detail =
    coverage === undefined
      ? ''
      : coverage.capturesWithDetail === 0
        ? ' <span style="color:var(--warn)">No per-minute detail covers this span, so there is nothing to show.</span>'
        : ` ${coverage.minutes} minute${coverage.minutes === 1 ? '' : 's'} from ${coverage.capturesWithDetail} capture${coverage.capturesWithDetail === 1 ? '' : 's'}` +
          (coverage.capturesWithDetail < coverage.captures
            ? `; ${coverage.captures - coverage.capturesWithDetail} more overlap it but no longer have per-minute detail`
            : '') +
          '.';

  return `${leading === '' ? '' : `<div class="picker-row">${leading}`}<form method="get" action="${esc(action)}" class="range-form"
    style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
  ${Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('')}
  <label class="faint" style="font-size:12px">Time range</label>
  <select name="range" style="max-width:190px" onchange="
    const custom = this.value === 'custom';
    this.form.querySelector('.range-dates').style.display = custom ? 'flex' : 'none';
    if (!custom) this.form.submit();">
    ${options}
  </select>
  <span class="range-dates" style="display:${custom ? 'flex' : 'none'};gap:6px;align-items:center;flex-wrap:wrap">
    <input type="datetime-local" name="from" value="${esc(from)}" style="width:auto">
    <span class="faint">to</span>
    <input type="datetime-local" name="to" value="${esc(to)}" style="width:auto">
    <button type="submit" class="ghost" style="padding:6px 12px">Show</button>
  </span>
  <noscript><style>.range-dates{display:flex !important}</style></noscript>
</form>${leading === '' ? '' : '</div>'}
${
  resolved.problem === undefined
    ? ''
    : `<div class="note warn">${esc(resolved.problem)} Showing the whole season instead.</div>`
}
<div class="faint" style="font-size:12px;margin:${leading === '' ? '-4px' : '6px'} 0 14px">
  Showing ${esc(resolved.description)}.${detail}
  ${
    resolved.time !== undefined
      ? ''
      : `This season has data from ${esc(bounds.fromDay)} to ${esc(bounds.toDay)}.`
  }
</div>`;
}

/**
 * How much of the span is actually behind the figures, and where the holes
 * are. Shown under every range, because missing data must never make a
 * period look better than it was.
 */
export function coverageBlock(c: Coverage | undefined): string {
  if (c === undefined || c.spanMs <= 0) return '';
  const pct = Math.round(c.fraction * 100);
  const tone = c.fraction >= 0.9 ? 'ok' : c.fraction >= 0.6 ? 'warn' : 'bad';
  const gaps = c.gaps
    .slice(0, 8)
    .map((g) => {
      const mins = Math.round((g.toMs - g.fromMs) / 60_000);
      const len = mins >= 120 ? `${(mins / 60).toFixed(1)} h` : `${mins} min`;
      return `<li><span class="mono">${esc(when(g.fromMs))} → ${esc(when(g.toMs).slice(11))}</span> · ${esc(len)} — ${esc(g.reason)}</li>`;
    })
    .join('');
  return `<div class="coverage tone-${tone}">
  <div class="coverage-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
  <div class="coverage-text"><strong>${esc(coverageWords(c))}.</strong>
    ${
      tone === 'ok'
        ? 'Figures cover nearly all of this span.'
        : tone === 'warn'
          ? 'Some of this span was not recorded; figures describe only the recorded part.'
          : 'Most of this span was not recorded, so treat these figures as a sample, not the whole picture.'
    }
    ${
      c.gaps.length === 0
        ? ''
        : `<details style="margin-top:4px"><summary>${c.gaps.length} gap${c.gaps.length === 1 ? '' : 's'} longer than 10 minutes</summary><ul style="margin:6px 0 0;padding-left:18px">${gaps}</ul>${
            c.gaps.length > 8 ? `<div class="faint">…and ${c.gaps.length - 8} more.</div>` : ''
          }</details>`
    }
  </div>
</div>`;
}

export const COVERAGE_STYLE = `<style>
.coverage { display:flex; gap:12px; align-items:flex-start; margin:0 0 16px; padding:10px 14px; border:1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); font-size: 12.5px; color: var(--text-dim); }
.coverage-bar { flex: 0 0 90px; height: 6px; margin-top: 7px; border-radius: 999px; background: var(--well); box-shadow: var(--well-shadow); overflow: hidden; }
.coverage-bar i { display: block; height: 100%; }
.coverage.tone-ok .coverage-bar i { background: var(--ok); }
.coverage.tone-warn .coverage-bar i { background: var(--warn); }
.coverage.tone-bad .coverage-bar i { background: var(--bad); }
.coverage.tone-warn { border-color: color-mix(in srgb, var(--warn) 30%, var(--border)); }
.coverage.tone-bad { border-color: color-mix(in srgb, var(--bad) 35%, var(--border)); }
.coverage-text { flex: 1; }
</style>`;

/** The span a resolved range stands for, in milliseconds. */
export function spanOf(
  resolved: ResolvedRange,
  seasonSpan: { fromMs: number; toMs: number } | undefined,
): { fromMs: number; toMs: number } | undefined {
  if (resolved.time !== undefined) return resolved.time;
  if (resolved.range !== undefined) {
    return {
      fromMs: Date.parse(`${resolved.range.fromDay}T00:00:00Z`),
      toMs: Date.parse(`${resolved.range.toDay}T00:00:00Z`) + 86_400_000,
    };
  }
  return seasonSpan;
}
