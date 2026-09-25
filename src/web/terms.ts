/**
 * How shared concepts look on a page: the fix outlook, the strength of the
 * evidence, an MSPT figure. Defined once so every page shows them the same
 * way; the concepts themselves (labels, rules) live in analysis/priority.ts.
 */

import { esc, num } from './layout.ts';
import { OUTLOOKS, type Outlook, type PriorityBreakdown } from '../analysis/priority.ts';

export const TERMS_STYLE = `<style>
.outlook { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 7px; font-size: 11.5px; font-weight: 650; white-space: nowrap; border: 1px solid transparent; }
.outlook::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.outlook.good { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.outlook.maybe { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.outlook.hard { color: var(--text-dim); background: var(--surface-3); }
.outlook.done { color: var(--text-faint); border-color: var(--border); }
</style>`;

/** The fix outlook as a small labelled tag; its reason on hover. */
export function outlookTag(outlook: Outlook, why?: string): string {
  const o = OUTLOOKS[outlook];
  return `<span class="outlook ${o.tone}"${why === undefined ? '' : ` title="${esc(why)}"`}>${esc(o.label)}</span>`;
}

export function priorityTag(p: PriorityBreakdown): string {
  return outlookTag(p.outlook, p.outlookWhy);
}

/** Evidence strength, shown only when it should change how much a figure is trusted. */
export function evidenceTag(confidence: PriorityBreakdown['confidence']): string {
  return confidence === 'thin' ? '<span class="tag warn" title="Few samples behind this figure">thin evidence</span>' : '';
}

/** An MSPT figure with its unit. */
export function msptText(value: number, digits = 2): string {
  return `${num(value, digits)} MSPT`;
}
