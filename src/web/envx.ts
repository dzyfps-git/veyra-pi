/**
 * What envx said about a finding's methods, as HTML.
 *
 * Shown only once envx answers are live (contract.ts) and the answer came
 * from an envx that serves the interface; until then this renders nothing,
 * so a stub's canned answers never read as real attributions.
 */

import { certaintyLabel, ENVX_ANSWERS_LIVE, servesApi, type EnvxCandidate } from '../envx/contract.ts';
import type { Attribution } from '../envx/lookup.ts';
import { esc } from './layout.ts';

const candidate = (c: EnvxCandidate): string => `${c.mod} ${c.version}${c.nested_in.length > 0 ? ` (inside ${c.nested_in.join(', ')})` : ''}`;

/** One line per method: its likely owner, and the mixins that target it. */
export function envxBlock(attributions: readonly Attribution[], live = ENVX_ANSWERS_LIVE): string {
  if (!live) return '';
  const shown = attributions.filter((a) => servesApi({ api: 1, envx: a.envxVersion }));
  if (shown.length === 0) return '';
  const lines = shown.map((a) => {
    const parts: string[] = [];
    if (a.owner !== undefined) {
      const o = a.owner;
      const who =
        o.status === 'none'
          ? 'not in any indexed jar'
          : o.candidates.map(candidate).join(o.status === 'ambiguous' ? ' · ' : ', ');
      const via = o.mixin === null ? '' : `, via ${o.mixin.kind} in ${o.mixin.mixin_class}`;
      parts.push(`<b>${esc(certaintyLabel(o.status))}:</b> ${esc(who)}${esc(via)}`);
    }
    const replaced = a.mixins.filter((m) => m.kind === 'Overwrite');
    const injected = a.mixins.filter((m) => m.kind !== 'Overwrite');
    if (replaced.length > 0) {
      parts.push(`replaced by ${esc(replaced.map((m) => `${m.mod} ${m.version}${m.failed ? ' (did not apply)' : ''}`).join(', '))}`);
    }
    if (injected.length > 0) {
      parts.push(
        `targeted by ${esc(injected.map((m) => `${m.mod} (${m.kind}${m.failed ? ', did not apply' : ''})`).join(', '))}`,
      );
    }
    const name = a.owner?.yarn?.method !== undefined ? `${a.owner.yarn.class.split('.').pop()}.${a.owner.yarn.method}` : a.key.request.method;
    return `<div style="margin-top:4px"><span class="mono faint">${esc(name)}</span> ${parts.join(' · ')}</div>`;
  });
  return `<div class="note" style="margin:8px 0 0"><b>Owner, from envx</b>
    <span class="faint">what the mod jars contain, not what the server loaded</span>${lines.join('')}</div>`;
}
