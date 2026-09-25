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

const jar = (j: { mod: string | null; version: string | null; sha256: string }): string =>
  j.mod === null ? `a library (${j.sha256.slice(0, 8)})` : `${j.mod}${j.version === null ? '' : ` ${j.version}`}`;
const candidate = (c: EnvxCandidate): string =>
  `${jar(c)}${c.nested_in.length > 0 ? ` (inside ${c.nested_in.map(jar).join(', ')})` : ''}`;

/** One line per method: its likely owner, and the mixins that target it. */
export function envxBlock(attributions: readonly Attribution[], live = ENVX_ANSWERS_LIVE): string {
  if (!live) return '';
  const shown = attributions.filter((a) => servesApi({ api: 1, envx: a.envxVersion }));
  if (shown.length === 0) return '';
  const lines = shown.map((a) => {
    const parts: string[] = [];
    if (a.owner !== undefined) {
      const o = a.owner;
      // The status counts loaded copies only; copies the server does not load are left out.
      const loaded = o.candidates.filter((c) => c.loaded);
      const who =
        o.status === 'none' ? 'no loaded jar defines it' : loaded.map(candidate).join(o.status === 'ambiguous' ? ' · ' : ', ');
      const via = o.mixin === null ? '' : `, via ${o.mixin.kind} in ${o.mixin.mixin_class}`;
      parts.push(`<b>${esc(certaintyLabel(o.status))}:</b> ${esc(who)}${esc(via)}`);
    }
    const replaced = a.mixins.filter((m) => m.kind === 'Overwrite');
    // One entry per mod and kind: a mod often has several handlers of one kind here.
    const counted = new Map<string, number>();
    for (const m of a.mixins.filter((m) => m.kind !== 'Overwrite')) {
      const label = `${jar(m)} (${m.kind}${m.failed === true ? ', did not apply' : ''}`;
      counted.set(label, (counted.get(label) ?? 0) + 1);
    }
    const injected = [...counted].map(([label, n]) => `${label}${n > 1 ? ` ×${n}` : ''})`);
    if (replaced.length > 0) {
      parts.push(`replaced by ${esc(replaced.map((m) => `${jar(m)}${m.failed === true ? ' (did not apply)' : ''}`).join(', '))}`);
    }
    if (injected.length > 0) {
      parts.push(
        `targeted by ${esc(injected.join(', '))}`,
      );
    }
    const yarn = a.owner?.yarn;
    const name =
      yarn !== undefined && yarn !== null && yarn.class !== null && yarn.method !== null
        ? `${yarn.class.split('.').pop()}.${yarn.method}`
        : a.key.request.method;
    return `<div style="margin-top:4px"><span class="mono faint">${esc(name)}</span> ${parts.join(' · ')}</div>`;
  });
  // Overloads of one method usually read the same; each line once.
  return `<div class="note" style="margin:8px 0 0"><b>Owner, from envx</b>
    <span class="faint">what the mod jars contain, not what the server loaded</span>${[...new Set(lines)].join('')}</div>`;
}
