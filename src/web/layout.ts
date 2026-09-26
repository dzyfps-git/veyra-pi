/**
 * HTML rendering primitives and the application shell.
 *
 * Server-rendered, no build step, no framework, no client bundle. The pages
 * are dense numeric tables and a few charts; a SPA would add a toolchain to
 * maintain for years across modpack rotations and buy nothing.
 *
 * ## Design: HUD
 *
 * A dark command-center look over a live server, with every mark real data:
 *
 *   - One hue in view, the focus colour (a setting: neutral blue, ice or
 *     warm). It lights what can be acted on and "you are here". Status
 *     colours (ok, warn, bad) only ever mean status, and always come with
 *     a word.
 *   - A full-bleed ground under glass panels; recessed wells inside glass
 *     hold data (charts, chips, pick lists). Glass never nests.
 *   - Condensed display type for titles and figures, wide-tracked mono for
 *     captions, Figtree for sentences.
 *   - Every number that could be misread says what it is, where it comes
 *     from (server, machine, world, season) and over what time.
 *   - Nothing moves on its own. The design's animated field, turning rings
 *     and pulses are drawn still: this app shares its PC with the server, so
 *     it must cost nothing while it sits open.
 */

import type { Branding } from '../core/brand.ts';

/** Escape for HTML text and quoted attribute contexts. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Fixed-precision number, or an em dash when absent. Never invents a value. */
export function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
  // Whole numbers where the fraction adds nothing: "50 GB", not "50.00 GB";
  // and terabytes once a figure would otherwise read "2181.38 GB".
  const trim = (n: number, digits: number): string => n.toFixed(digits).replace(/\.0+$/, '');
  const gb = value / 1073741824;
  if (gb < 1000) return `${trim(gb, gb < 10 ? 2 : 1)} GB`;
  return `${trim(gb / 1024, 2)} TB`;
}

/**
 * A moment, in this computer's local time.
 *
 * Was UTC with no label, which put every time on every page four hours away
 * from the clock on the wall. The app and the person reading it are on the
 * same machine, so local time is simply right. The day ranges on the Ledger
 * and Findings are the exception and say "UTC" where they appear, because
 * the long-term ledger is keyed by UTC day.
 */
/** A duration: "740 ms", "2.9 s". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** A time of day: "12:27 AM". */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** A short day: "Sep 23". */
export function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The status dot's colour for a tone (store/health.ts STATE_WORDS tones). */
export function dotClass(tone: 'ok' | 'info' | 'warn' | 'bad'): 'ok' | 'warn' | 'off' {
  return tone === 'ok' ? 'ok' : tone === 'warn' || tone === 'bad' ? 'warn' : 'off';
}

export function when(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "12 minutes ago", "3 hours ago", "yesterday", or the date. */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  return when(ms).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Icons: a small hand-drawn set, 20px, 1.6 stroke, currentColor.
// ---------------------------------------------------------------------------

const ICON_PATHS: Record<string, string> = {
  overview: '<path d="M3 13h5V3H3zM12 17h5V8h-5zM3 17h5v-1H3zM12 4h5v1h-5z"/>',
  findings: '<circle cx="9" cy="9" r="5.5"/><path d="m13 13 4 4"/>',
  ledger: '<path d="M4 4h12M4 8h12M4 12h8M4 16h10"/>',
  changes: '<path d="M4 6h9l-3-3M16 14H7l3 3"/>',
  server: '<rect x="3" y="3.5" width="14" height="5" rx="1.5"/><rect x="3" y="11.5" width="14" height="5" rx="1.5"/><path d="M6 6h.01M6 14h.01"/>',
  servers: '<rect x="2.5" y="4" width="10" height="5" rx="1.5"/><rect x="7.5" y="11" width="10" height="5" rx="1.5"/>',
  reports: '<path d="M6 3h6l4 4v10H6z"/><path d="M12 3v4h4M8.5 11h5M8.5 14h5"/>',
  settings: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>',
  guide: '<circle cx="10" cy="10" r="7"/><path d="M8 7.8a2.2 2.2 0 1 1 3 2c-.7.3-1 .8-1 1.5M10 14h.01"/>',
  chevron: '<path d="m6 8 4 4 4-4"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  alert: '<path d="M10 3 2.5 16.5h15z"/><path d="M10 8v4M10 14.5h.01"/>',
  pause: '<path d="M7 4v12M13 4v12"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  folder: '<path d="M2.5 6V15a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1H9.5L8 4.5H3.5a1 1 0 0 0-1 1z"/>',
};

export function icon(name: string, size = 18): string {
  const paths = ICON_PATHS[name] ?? '';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// ---------------------------------------------------------------------------
// Reusable pieces.
// ---------------------------------------------------------------------------

/** A panel: a titled surface. `meta` sits at the right of the title. */
export function panel(title: string, body: string, options: { meta?: string; id?: string; tone?: 'ok' | 'warn' | 'bad' } = {}): string {
  return `<section class="panel${options.tone === undefined ? '' : ` tone-${options.tone}`}"${options.id === undefined ? '' : ` id="${esc(options.id)}"`}>
  <header class="panel-head"><h2>${title}</h2>${options.meta === undefined ? '' : `<div class="panel-meta">${options.meta}</div>`}</header>
  <div class="panel-body">${body}</div>
</section>`;
}

/** A single figure with its label and what it means. */
export function stat(label: string, value: string, unit?: string, note?: string, tone?: 'ok' | 'warn' | 'bad'): string {
  return `<div class="stat${tone === undefined ? '' : ` tone-${tone}`}">
  <div class="stat-label">${esc(label)}</div>
  <div class="stat-value">${value}${unit === undefined ? '' : `<span class="stat-unit">${esc(unit)}</span>`}</div>
  ${note === undefined ? '' : `<div class="stat-note">${note}</div>`}
</div>`;
}

/** A status line: coloured dot, strong lead, supporting text. */
export function banner(tone: 'ok' | 'warn' | 'bad' | 'info', lead: string, text: string, action?: string): string {
  const glyph = tone === 'ok' ? 'check' : tone === 'info' ? 'guide' : 'alert';
  return `<div class="banner tone-${tone}">
  <span class="banner-icon">${icon(glyph, 18)}</span>
  <div class="banner-text"><strong>${lead}</strong> ${text}</div>
  ${action === undefined ? '' : `<div class="banner-action">${action}</div>`}
</div>`;
}

/**
 * The focus palettes: the one hue in view, and the ground tinted toward it.
 * Status colours (ok, warn, bad) never change with it. The desktop shell
 * (desktop/app/main.js) repeats the grounds so the window opens without a flash.
 */
export const FOCUS_PALETTES = {
  neutral: { ground: '#08090d', focus: '#6c8cff', focus2: '#a9b9ff', rgb: '108,140,255' },
  ice: { ground: '#05090c', focus: '#58d6ff', focus2: '#b4f1ff', rgb: '88,214,255' },
  warm: { ground: '#0c0806', focus: '#ff8f5e', focus2: '#ffc58a', rgb: '255,143,94' },
} as const;

export type FocusPalette = keyof typeof FOCUS_PALETTES;

/** The palette for a stored Focus colour setting; anything else (an old Dark/Light value) is neutral. */
export function focusPalette(value: string | undefined): FocusPalette {
  return value === 'ice' || value === 'warm' ? value : 'neutral';
}

export function css(_branding: Branding): string {
  const palette = (name: FocusPalette): string => {
    const p = FOCUS_PALETTES[name];
    return `--ground: ${p.ground}; --focus: ${p.focus}; --focus-2: ${p.focus2}; --focus-rgb: ${p.rgb};`;
  };
  return `
@font-face { font-family: "Figtree"; font-style: normal; font-weight: 300 900; font-display: swap; src: url(/fonts/figtree.woff2) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url(/fonts/jetbrains-mono-400.woff2) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 500; font-display: swap; src: url(/fonts/jetbrains-mono-500.woff2) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 700; font-display: swap; src: url(/fonts/jetbrains-mono-700.woff2) format("woff2"); }
/* Bahnschrift ships with Windows; condensed to width 75 it is the display face. Elsewhere, Figtree. */
@font-face { font-family: "HUD Display"; src: local("Bahnschrift"); font-weight: 300 700; font-stretch: 75% 100%; }
:root {
  ${palette('neutral')}
  --focus-soft: rgba(var(--focus-rgb), .14);
  --focus-line: rgba(var(--focus-rgb), .22);
  --focus-glow: 0 0 22px rgba(var(--focus-rgb), .45);
  --on-focus: #07090C;
  --glass: linear-gradient(160deg, rgba(255,255,255,.055), rgba(255,255,255,.015));
  --glass-edge: rgba(255,255,255,.07);
  --glass-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 20px 50px -30px rgba(0,0,0,.9);
  --rule: rgba(255,255,255,.07);
  /* Recessed things inside glass: chips, tracks, charts, pick lists. */
  --well: rgba(0,0,0,.3);
  --well-shadow: inset 0 2px 8px -4px rgba(0,0,0,.9);
  --text: #E3E5E8;
  --text-strong: #F5F7FA;
  --text-dim: #9EA6B3;
  /* Captions only: about 4:1, never for sentences someone must read. */
  --text-faint: #6B7480;
  --ok: #3FC46A;
  --warn: #F2A633;
  --bad: #F0554D;
  --radius-glass: 18px;
  --radius-tile: 12px;
  --topbar-h: 64px;
  --rail-w: 76px;
  /* Solid stand-ins for glass where something must cover what is under it: menus, tips, dialogs. */
  --surface: color-mix(in srgb, #fff 5%, var(--ground));
  --surface-2: color-mix(in srgb, #fff 8%, var(--ground));
  --surface-3: color-mix(in srgb, #fff 11%, var(--ground));
  --bg: var(--ground);
  --border: rgba(255,255,255,.1);
  --border-soft: var(--glass-edge);
  --accent: var(--focus);
  --accent-soft: var(--focus-soft);
  --info: var(--focus);
  --radius: 14px;
  --radius-sm: 11px;
  --shadow: var(--glass-shadow);
  --ease: cubic-bezier(.2,.8,.2,1);
  --sans: "Figtree", "Segoe UI Variable Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
  --display: "HUD Display", Bahnschrift, "Figtree", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
  /* 0..1, from real state where a page knows one; it only sets how strongly the focus glows. */
  --energy: .5;
  color-scheme: dark;
}
:root[data-focus="ice"] { ${palette('ice')} }
:root[data-focus="warm"] { ${palette('warm')} }

* { box-sizing: border-box; }
/* Components set display; an element marked hidden must still disappear. */
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; background: var(--ground); }
body {
  margin: 0; background: var(--ground); color: var(--text);
  font: 14px/1.6 var(--sans);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--focus); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
::selection { background: rgba(var(--focus-rgb), .3); }
.icon { flex: none; display: block; }
.display { font-family: var(--display); font-stretch: 75%; font-variation-settings: "wdth" 75; }
.cap { font: 500 10px/1.2 var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--text-faint); }

/* ---------------------------------------------------------------- field
   The ground: a focus glow, a field of linked points and a grid floor. It
   carries no information and never moves: drawn once, on its own layer, so
   it costs nothing while the app sits open on the PC that runs the server. */
.field { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; contain: strict;
  background:
    radial-gradient(60% 70% at 72% 10%, rgba(var(--focus-rgb), calc(.07 + .1 * var(--energy))), transparent 70%),
    radial-gradient(40% 40% at 6% 100%, rgba(var(--focus-rgb), .06), transparent 70%); }
.field canvas { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .75; }
.field .floor { position: absolute; left: -40%; right: -40%; bottom: -4%; height: 44%;
  background-image: linear-gradient(rgba(var(--focus-rgb), .13) 1px, transparent 1px), linear-gradient(90deg, rgba(var(--focus-rgb), .13) 1px, transparent 1px);
  background-size: 64px 64px; transform: perspective(420px) rotateX(64deg); transform-origin: 50% 100%;
  -webkit-mask-image: linear-gradient(to top, #000, transparent 80%); mask-image: linear-gradient(to top, #000, transparent 80%); }
.field .vignette { position: absolute; inset: 0; background: radial-gradient(120% 95% at 50% 35%, transparent 55%, rgba(0,0,0,.55)); }

/* ---------------------------------------------------------------- frame */
.frame { position: relative; z-index: 1; display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); grid-template-rows: var(--topbar-h) auto; min-height: 100vh; }
.topbar {
  grid-column: 1 / -1; position: sticky; top: 0; z-index: 30;
  display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 18px;
  height: var(--topbar-h); padding: 0 24px 0 20px;
  border-bottom: 1px solid var(--focus-line); background: color-mix(in srgb, var(--ground) 92%, transparent);
}
.brandline { display: flex; align-items: center; gap: 18px; min-width: 0; }
.wordmark { font: 600 28px/1 var(--display); font-stretch: 75%; font-variation-settings: "wdth" 75; letter-spacing: .06em; text-transform: uppercase; color: var(--text-strong); white-space: nowrap; }
.wordmark:hover { text-decoration: none; }
.wordmark span { color: var(--focus); text-shadow: 0 0 18px var(--focus); }
.statusline { font: 500 10px/1.2 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--text-dim); display: flex; align-items: center; gap: 9px; min-width: 0; }
.statusline .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--focus); box-shadow: 0 0 10px var(--focus); flex: none; }
.pulse.warn { background: var(--warn); box-shadow: 0 0 10px var(--warn); }
.pulse.off { background: var(--text-faint); box-shadow: none; }

/* The server in focus: a pill in a track, its menu below. */
.focus-switch { position: relative; justify-self: center; }
.focus-switch > summary {
  list-style: none; cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 4px 14px 4px 4px;
  border-radius: 999px; border: 1px solid var(--focus-line); background: var(--well);
}
.focus-switch > summary::-webkit-details-marker { display: none; }
.focus-switch .pill {
  display: flex; align-items: center; gap: 9px; padding: 8px 18px 8px 14px; border-radius: 999px; min-width: 0;
  background: linear-gradient(135deg, rgba(var(--focus-rgb), .32), rgba(var(--focus-rgb), .12));
  box-shadow: var(--focus-glow), inset 0 0 0 1px rgba(var(--focus-rgb), .6);
  font: 600 11px/1.2 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--text-strong);
}
.focus-switch .pill .n { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.focus-switch .k { font: 500 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--text-faint); white-space: nowrap; }
.focus-switch > summary .icon { color: var(--text-faint); }
.focus-switch[open] > summary { border-color: rgba(var(--focus-rgb), .5); }
.focus-switch .menu {
  position: absolute; left: 50%; top: calc(100% + 8px); transform: translateX(-50%); z-index: 40; min-width: 320px;
  background: var(--surface); border: 1px solid var(--glass-edge); border-radius: 16px; box-shadow: 0 24px 60px -24px rgba(0,0,0,.9); padding: 6px;
}
.focus-switch .menu a { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; color: var(--text); font-size: 13px; }
.focus-switch .menu a:hover { background: var(--focus-soft); text-decoration: none; }
.focus-switch .menu a.current { background: var(--focus-soft); color: var(--text-strong); }
.focus-switch .menu .k { margin-left: auto; }
.focus-switch .menu .sep { height: 1px; background: var(--rule); margin: 6px 4px; }
.focus-switch .menu .group { padding: 8px 12px 2px; }
.sdot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); flex: none; display: inline-block; }
.sdot.ok { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.sdot.info { background: var(--focus); box-shadow: 0 0 8px var(--focus); }
.sdot.warn { background: var(--warn); box-shadow: 0 0 8px var(--warn); }
.sdot.off { background: none; border: 1px solid var(--text-faint); }
.add-server { justify-self: center; }

.topright { justify-self: end; display: flex; align-items: center; gap: 20px; min-width: 0; }
.clock { text-align: right; line-height: 1; white-space: nowrap; }
.clock .time { font: 300 32px/1 var(--display); font-stretch: 75%; font-variation-settings: "wdth" 75; color: var(--text-strong); font-variant-numeric: tabular-nums; }
.clock .time span { font-size: 14px; color: var(--focus); margin-left: 4px; vertical-align: top; letter-spacing: .06em; }
.clock .date { font: 500 9.5px var(--mono); letter-spacing: .22em; text-transform: uppercase; color: var(--text-faint); margin-top: 5px; }
/* Updates: a quiet check, a download in progress, or one click to install. */
.upd-card { display: flex; align-items: center; gap: 10px; }
.upd-card .check { background: none; border: 0; box-shadow: none; padding: 4px 0; color: var(--text-faint); font: 500 10px var(--mono); letter-spacing: .16em; text-transform: uppercase; }
.upd-card .check:hover { color: var(--text); filter: none; }
.upd-card .check:disabled { background: none; color: var(--text-faint); }
.upd-card .chip { display: inline-flex; align-items: center; gap: 8px; }
.upd-card .whatsnew { font: 500 10px var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--text-dim); }

/* ---------------------------------------------------------------- rail */
.rail {
  grid-row: 2; position: sticky; top: var(--topbar-h); height: calc(100vh - var(--topbar-h)); overflow-y: auto; scrollbar-width: none;
  display: flex; flex-direction: column; gap: 4px; padding: 14px 8px 12px;
  border-right: 1px solid var(--focus-line); background: linear-gradient(to right, rgba(0,0,0,.3), transparent);
}
.rail-gap { height: 12px; flex: none; }
.rail-item {
  color: var(--text-faint); display: flex; flex-direction: column; align-items: center; gap: 5px; flex: none;
  padding: 10px 0 8px; border-radius: var(--radius-tile); position: relative;
  font: 500 8.5px/1.2 var(--mono); letter-spacing: .14em; text-transform: uppercase; text-align: center;
  transition: background .2s var(--ease), color .2s var(--ease);
}
.rail-item:hover { background: rgba(255,255,255,.04); color: var(--text); text-decoration: none; }
.rail-item.active { color: var(--focus); background: var(--focus-soft); }
.rail-item.active::before { content: ""; position: absolute; left: -8px; top: 12px; bottom: 12px; width: 2px; border-radius: 2px; background: var(--focus); box-shadow: 0 0 12px var(--focus); }
.rail-item .badge { position: absolute; top: 4px; right: 9px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
  background: var(--warn); color: #15171C; font: 700 9.5px/16px var(--mono); letter-spacing: 0; }
.rail-foot { margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 12px; }
.rail-foot .version { font: 500 9px var(--mono); letter-spacing: .08em; color: var(--text-faint); }
.rail-foot .version:hover { color: var(--text); text-decoration: none; }

main.stage { grid-column: 2; min-width: 0; padding: 26px 30px 90px; }
.page { max-width: 1320px; margin: 0 auto; animation: rise .5s var(--ease) both; }
/* Movement only: a page shown while the window is hidden must never be left invisible. */
@keyframes rise { from { transform: translateY(8px); } }

/* ---------------------------------------------------------------- page head */
.page-head { display: flex; align-items: flex-end; gap: 20px; margin-bottom: 26px; }
.page-head .titles { flex: 1; min-width: 0; }
.context { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
.context .crumb { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px; border-radius: 999px; background: var(--well); border: 1px solid rgba(255,255,255,.06);
  font: 500 10px/1.2 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); white-space: nowrap; }
.context .crumb b { color: var(--text); font-weight: 500; }
.context a.crumb:hover { color: var(--text); border-color: var(--focus-line); text-decoration: none; }
h1 { font: 600 54px/.95 var(--display); font-stretch: 75%; font-variation-settings: "wdth" 75; letter-spacing: .01em; text-transform: uppercase; margin: 0; color: var(--text-strong); overflow-wrap: anywhere; }
.sub { color: var(--text-dim); font-size: 14px; margin-top: 12px; max-width: 760px; }
.page-actions { display: flex; gap: 8px; flex-wrap: wrap; }

h2 { font: 500 11px/1.4 var(--mono); letter-spacing: .18em; text-transform: uppercase; margin: 30px 0 12px; color: var(--text-dim); }
h3 { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: var(--text-strong); }
strong, b { color: var(--text-strong); font-weight: 650; }
h1 strong, h2 strong, .stat-value strong, .card .v strong { color: inherit; font-weight: inherit; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
code { background: var(--well); border: 1px solid var(--glass-edge); border-radius: 6px; padding: 0 5px; }

/* ---------------------------------------------------------------- glass */
.panel, .stat, .banner, .card, .setting, .glass {
  background: var(--glass); border: 1px solid var(--glass-edge); border-radius: var(--radius-glass); box-shadow: var(--glass-shadow);
}
.panel { margin: 0 0 18px; }
/* Glass never nests: inside a panel, the same pieces are recessed instead. */
.panel .panel, .panel .stat, .panel .banner, .panel .card, .panel .setting { background: var(--well); box-shadow: none; border-color: rgba(255,255,255,.06); border-radius: var(--radius-tile); }
.panel-head { display: flex; align-items: center; gap: 12px; padding: 16px 18px 0; min-height: 36px; }
.panel-head h2 { margin: 0; flex: 1; }
/* A caption: small, uppercase, quiet. Controls placed in it keep their own type. */
.panel-meta { font: 500 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--text-faint); }
.panel-meta .button, .panel-meta button { font-family: var(--sans); text-transform: none; letter-spacing: 0; }
.panel-body { padding: 12px 18px 18px; }
.panel.tone-warn { border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
.panel.tone-bad { border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.list-row { display: flex; align-items: baseline; gap: 12px; padding: 9px 2px; border-bottom: 1px dashed var(--rule); }
.list-row:last-child { border-bottom: none; }
.list-row .main { flex: 1; min-width: 0; }
.list-row .main .t { font-weight: 600; color: var(--text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-row .main .s { font-size: 12px; color: var(--text-dim); }
.list-row .fig { font-family: var(--mono); font-size: 13px; font-weight: 700; color: var(--text-strong); white-space: nowrap; font-variant-numeric: tabular-nums; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 18px; }
.grid-3 { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; margin-bottom: 18px; }
.grid-2 > .panel, .grid-3 > .panel { margin: 0; }
/* Grid items may shrink below their content, so long names ellipsize instead of widening the page. */
.grid-2 > *, .grid-3 > *, .stats > * { min-width: 0; }

/* Vitals: a caption, the figure in the display face, and what it covers. */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 18px; }
.stat { padding: 14px 16px 15px; display: flex; flex-direction: column; gap: 8px; }
.stat-label { font: 500 10px/1.2 var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--text-faint); }
.stat-value { font: 500 44px/.92 var(--display); font-stretch: 75%; font-variation-settings: "wdth" 75; font-variant-numeric: tabular-nums; color: var(--text-strong); }
.stat-unit { font: 500 10.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--text-faint); margin-left: 7px; }
/* A figure that opens something stays a figure; the underline says it is a link. */
.stat-value a, .card .v a { color: inherit; text-decoration: underline; text-decoration-color: rgba(var(--focus-rgb), .35); text-underline-offset: 6px; text-decoration-thickness: 2px; }
.stat-value a:hover, .card .v a:hover { text-decoration-color: var(--focus); }
/* A stat whose value is words (a machine, a world), not a figure. */
.stat-text { display: block; font: 600 15px/1.35 var(--sans); letter-spacing: 0; overflow-wrap: anywhere; }
.stat-note { font-size: 12px; color: var(--text-dim); line-height: 1.5; }
.stat.tone-warn .stat-value { color: var(--warn); }
.stat.tone-bad .stat-value { color: var(--bad); }
.stat.tone-ok .stat-value { color: var(--ok); }
.meter { height: 3px; border-radius: 3px; background: rgba(255,255,255,.07); overflow: hidden; }
.meter > span { display: block; height: 100%; background: linear-gradient(90deg, rgba(var(--focus-rgb), .5), var(--focus)); box-shadow: 0 0 10px var(--focus); }

.banner { display: flex; align-items: center; gap: 12px; padding: 14px 16px; margin: 0 0 18px; }
.banner-icon { flex: none; }
.banner-text { flex: 1; color: var(--text-dim); }
.banner-action { flex: none; display: flex; gap: 8px; }
.banner.tone-ok { border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.banner.tone-ok .banner-icon { color: var(--ok); }
.banner.tone-warn { border-color: color-mix(in srgb, var(--warn) 38%, transparent); }
.banner.tone-warn .banner-icon { color: var(--warn); }
.banner.tone-bad { border-color: color-mix(in srgb, var(--bad) 42%, transparent); }
.banner.tone-bad .banner-icon { color: var(--bad); }
.banner.tone-info .banner-icon { color: var(--focus); }

/* Legacy card grid, the same as vitals. */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 14px; }
.card { padding: 14px 16px; }
.card .k { font: 500 10px var(--mono); letter-spacing: .2em; text-transform: uppercase; color: var(--text-faint); }
.card .v { font: 500 36px/1 var(--display); font-stretch: 75%; font-variation-settings: "wdth" 75; margin-top: 8px; font-variant-numeric: tabular-nums; color: var(--text-strong); }
.card .u { font: 500 10.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--text-faint); margin-left: 5px; }
.card .n { color: var(--text-dim); font-size: 12px; margin-top: 4px; }

/* ---------------------------------------------------------------- tables */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; color: var(--text-faint); font: 500 10px var(--mono); letter-spacing: .14em; text-transform: uppercase;
  padding: 10px 12px; border-bottom: 1px solid var(--rule); white-space: nowrap;
}
td { padding: 10px 12px; border-bottom: 1px dashed var(--rule); vertical-align: top; }
tr:last-child td { border-bottom: none; }
tbody tr:hover td, table tr:hover td { background: rgba(var(--focus-rgb), .05); }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 12.5px; }
td.mono { font-family: var(--mono); font-size: 12px; }
.dim { color: var(--text-dim); }
.faint { color: var(--text-faint); }

/* ---------------------------------------------------------------- chips, notes, switches */
.tag, .chip {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px;
  font: 500 10px/1.5 var(--mono); letter-spacing: .12em; text-transform: uppercase;
  border: 1px solid rgba(255,255,255,.1); color: var(--text); background: var(--well); white-space: nowrap;
}
.chip { padding: 6px 12px; font-size: 10.5px; letter-spacing: .14em; }
.tag.ok   { color: var(--ok);   border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.tag.warn, .chip.off { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.tag.bad, .chip.bad  { color: var(--bad);  border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.tag.accent, .chip.live { color: var(--focus-2); border-color: rgba(var(--focus-rgb), .5); box-shadow: 0 0 14px var(--focus-soft) inset; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }

.note {
  background: var(--well); border: 1px solid var(--glass-edge); border-radius: var(--radius-tile);
  padding: 12px 16px; color: var(--text-dim); font-size: 13.5px; margin: 12px 0;
}
.note.faint { background: transparent; }
.note.warn { border-color: color-mix(in srgb, var(--warn) 38%, transparent); }
.note.bad  { border-color: color-mix(in srgb, var(--bad) 42%, transparent); }
.note strong { color: var(--text-strong); }
details > summary { cursor: pointer; }

/* Tabs and view switches: labels in a recessed track, the chosen one lit. */
.tabs, .seg, .segmented { display: flex; width: fit-content; max-width: 100%; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 999px; background: var(--well); border: 1px solid rgba(255,255,255,.07); }
.tabs { margin-bottom: 22px; padding: 4px; border-color: var(--focus-line); flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
.seg { display: inline-flex; }
.segmented { display: inline-flex; }
.tabs a, .seg a, .segmented span {
  display: block; white-space: nowrap; border-radius: 999px; color: var(--text-dim); cursor: pointer;
  font: 600 10.5px/1.4 var(--mono); letter-spacing: .12em; text-transform: uppercase;
  padding: 6px 14px; transition: background .2s var(--ease), color .2s var(--ease);
}
.tabs a { padding: 8px 18px; }
.tabs a:hover, .seg a:hover, .segmented span:hover { color: var(--text); text-decoration: none; }
.tabs a.active, .seg a.on, .segmented input:checked + span {
  color: var(--text-strong);
  background: linear-gradient(135deg, rgba(var(--focus-rgb), .32), rgba(var(--focus-rgb), .12));
  box-shadow: 0 0 16px rgba(var(--focus-rgb), .3), inset 0 0 0 1px rgba(var(--focus-rgb), .6);
}
.seg.small a { padding: 4px 11px; font-size: 10px; }
.segmented label { position: relative; }
.segmented input { position: absolute; opacity: 0; pointer-events: none; }
.segmented input:focus-visible + span { outline: 2px solid var(--focus); }

/* ---------------------------------------------------------------- settings rows (and similar) */
.group { margin-bottom: 30px; }
.group > h3 { font: 500 10px var(--mono); text-transform: uppercase; letter-spacing: .2em; color: var(--text-faint); margin: 0 0 10px; }
.setting { display: grid; grid-template-columns: 1fr 260px; gap: 22px; align-items: start; padding: 16px 18px; margin-bottom: 8px; border-radius: var(--radius-tile); }
.setting.risky { border-color: color-mix(in srgb, var(--warn) 28%, transparent); }
.setting .label { font-weight: 600; font-size: 14px; color: var(--text-strong); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.setting .help { color: var(--text-dim); font-size: 12.5px; margin-top: 4px; line-height: 1.5; }
.setting .applies { color: var(--text-faint); font: 400 10.5px var(--mono); letter-spacing: .03em; margin-top: 6px; }
.setting .control { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.setting .unit { color: var(--text-faint); font-size: 11.5px; text-align: right; }

input[type=text], input[type=search], input[type=number], input[type=password], input[type=date], input[type=datetime-local], select, textarea {
  background: var(--well); border: 1px solid rgba(255,255,255,.1); color: var(--text);
  border-radius: var(--radius-tile); padding: 9px 13px; font: inherit; font-size: 13.5px; width: 100%;
  transition: border-color .2s var(--ease), box-shadow .2s var(--ease); font-variant-numeric: tabular-nums;
}
select option { background: var(--surface-2); color: var(--text); }
input[type=search] { border-radius: 999px; padding-left: 16px; }
input:focus, select:focus, textarea:focus { outline: none; border-color: rgba(var(--focus-rgb), .6); box-shadow: 0 0 0 3px var(--focus-soft); }
input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--focus); }
:focus-visible { outline: 2px solid rgba(var(--focus-rgb), .8); outline-offset: 2px; }

/* A real toggle: the checkbox is the switch. */
.toggle { position: relative; display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
.toggle input { appearance: none; -webkit-appearance: none; width: 38px; height: 22px; margin: 0; border-radius: 999px;
  background: var(--well); border: 1px solid rgba(255,255,255,.14); position: relative; cursor: pointer; transition: background .15s, border-color .15s; flex: none; }
.toggle input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--text-dim); transition: transform .15s, background .15s; }
.toggle input:checked { background: rgba(var(--focus-rgb), .35); border-color: rgba(var(--focus-rgb), .8); box-shadow: 0 0 14px rgba(var(--focus-rgb), .35); }
.toggle input:checked::after { transform: translateX(16px); background: #fff; }
.toggle input:disabled { opacity: .5; cursor: not-allowed; }
.toggle .toggle-text { font: 500 10px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); min-width: 24px; }

button, .button {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  background: var(--focus); color: var(--on-focus); border: 1px solid transparent;
  border-radius: 999px; padding: 9px 18px; font: 700 13px/1.3 var(--sans); cursor: pointer; white-space: nowrap;
  box-shadow: 0 0 18px rgba(var(--focus-rgb), .32);
  transition: filter .2s var(--ease), background .2s var(--ease), border-color .2s var(--ease), color .2s var(--ease);
}
button:hover, .button:hover { filter: brightness(1.08); text-decoration: none; }
button.ghost, .button.ghost { background: rgba(255,255,255,.04); color: var(--text); border-color: rgba(255,255,255,.1); box-shadow: none; }
button.ghost:hover, .button.ghost:hover { background: var(--focus-soft); border-color: rgba(var(--focus-rgb), .4); color: var(--text-strong); filter: none; }
button.small, .button.small { padding: 4px 12px; font-size: 12px; }
button.quiet { background: transparent; color: var(--focus); border: none; padding: 4px 6px; box-shadow: none; }
button.danger { background: var(--bad); color: #1A0E0E; box-shadow: 0 0 18px rgba(240,85,77,.3); }
button:disabled, button:disabled:hover { background: var(--well); color: var(--text-faint); border-color: rgba(255,255,255,.06); box-shadow: none; cursor: not-allowed; filter: none; }
select:disabled, option:disabled { color: var(--text-faint); }

.sticky-save {
  position: sticky; bottom: 0; margin-top: 22px; z-index: 5;
  background: color-mix(in srgb, var(--ground) 94%, transparent);
  border-top: 1px solid var(--focus-line); padding: 12px 0; display: flex; gap: 10px; align-items: center;
}
.sticky-save .status { color: var(--text-dim); font-size: 12.5px; }

.empty { color: var(--text-dim); padding: 34px; text-align: center; border: 1px dashed rgba(255,255,255,.12); border-radius: var(--radius-glass); font-size: 13px; }
.bar { height: 5px; background: rgba(255,255,255,.07); border-radius: 3px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--focus); box-shadow: 0 0 8px rgba(var(--focus-rgb), .6); }

/* ---------------------------------------------------------------- timeline */
.timeline { position: relative; margin: 4px 0 0 6px; padding-left: 22px; border-left: 1px solid var(--focus-line); }
.tl-node { position: relative; padding: 2px 0 18px; }
.tl-node::before { content: ''; position: absolute; left: -28px; top: 7px; width: 11px; height: 11px; border-radius: 50%; background: var(--ground); border: 2px solid rgba(255,255,255,.2); }
.tl-node.machine::before { border-color: var(--text-dim); }
.tl-node.current::before { border-color: var(--focus); background: var(--focus); box-shadow: 0 0 12px var(--focus); }
.tl-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; color: var(--text-strong); }
.tl-meta { color: var(--text-dim); font-size: 12px; margin-top: 2px; }
.tl-card { margin-top: 8px; background: var(--well); border: 1px solid var(--glass-edge); border-radius: var(--radius-tile); padding: 11px 14px; }
.tl-card .row { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-dim); margin-top: 6px; }
.tl-card .row b { color: var(--text); font-variant-numeric: tabular-nums; }

/* ---------------------------------------------------------------- dialog */
dialog.confirm { border: 1px solid var(--glass-edge); border-radius: var(--radius-glass); background: var(--surface); color: var(--text); padding: 22px 24px; max-width: 480px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 30px 70px -20px rgba(0,0,0,.8), 0 0 0 1px rgba(var(--focus-rgb), .12); }
dialog.confirm::backdrop { background: rgba(0,0,0,.6); }
dialog.confirm h3 { font: 600 26px/1 var(--display); font-stretch: 75%; font-variation-settings: "wdth" 75; text-transform: uppercase; letter-spacing: .02em; margin: 0 0 10px; }
dialog.confirm p { color: var(--text-dim); margin: 0 0 16px; }
dialog.confirm .actions { display: flex; gap: 8px; justify-content: flex-end; }
dialog.confirm input[type=text] { width: 100%; margin: 0 0 16px; }

.toast { position: fixed; right: 22px; bottom: 22px; z-index: 50; background: var(--surface-2); border: 1px solid rgba(var(--focus-rgb), .3); border-radius: 999px;
  padding: 10px 18px; box-shadow: 0 20px 50px -24px rgba(0,0,0,.9); font-size: 13px; display: none; align-items: center; gap: 9px; max-width: 420px; }
.toast.show { display: flex; animation: toast-in .18s ease-out; }
.toast.bad { border-color: color-mix(in srgb, var(--bad) 50%, transparent); }
@keyframes toast-in { from { transform: translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }

/* Charts, briefs and pick lists sit in a recessed well. */
.chart-wrap, .brief-out, .picks { background: var(--well); border-radius: var(--radius-tile); box-shadow: var(--well-shadow); }
.chart-wrap { padding: 10px 6px 4px; }
.picks { border-color: var(--glass-edge) !important; }

@media (max-width: 1000px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }
@media (max-width: 1100px) { .statusline, .clock .date { display: none; } }
@media (max-width: 900px) {
  .frame { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto; }
  .topbar { grid-template-columns: auto minmax(0, 1fr); height: auto; padding: 10px 14px; }
  .topright { display: none; }
  .rail { grid-row: auto; position: static; height: auto; flex-direction: row; overflow-x: auto; padding: 6px 8px; border-right: 0; border-bottom: 1px solid var(--focus-line); }
  .rail-gap { width: 8px; height: auto; }
  .rail-item { min-width: 64px; }
  .rail-item.active::before { display: none; }
  .rail-foot { display: none; }
  main.stage { grid-column: 1; padding: 20px 16px 60px; }
  h1 { font-size: 40px; }
  .setting { grid-template-columns: 1fr; gap: 12px; }
  .page-head { flex-direction: column; align-items: stretch; }
}
@media (prefers-reduced-motion: reduce) {
  .page, .toast.show { animation: none; }
  * { transition: none !important; }
}
`;
}

export interface NavItem {
  href: string;
  label: string;
  /** The rail's label under the icon: a word or two, about nine letters at most. */
  short?: string;
  badge?: string;
  icon?: string;
  /** Starts a new group on the rail. */
  section?: string;
}

export interface ShellServer {
  id: string;
  name: string;
  kind: string;
  collection: string;
  visible: boolean;
  /** What monitoring is doing right now, in words, and how it reads. */
  state?: string;
  tone?: 'ok' | 'info' | 'warn' | 'bad';
}

function collectionDot(server: ShellServer | undefined, paused: boolean): string {
  if (server === undefined || server.collection === 'off') return 'off';
  if (paused) return 'warn';
  if (server.tone === 'bad' || server.tone === 'warn') return 'warn';
  return server.tone === 'info' ? 'info' : 'ok';
}

function collectionWords(server: ShellServer, paused: boolean): string {
  if (paused && server.collection !== 'off') return 'paused';
  return (server.state ?? server.collection).toLowerCase();
}

/**
 * Updates, at the right of the top bar. Ready: one click installs (the
 * database is backed up and the moment is chosen underneath). Downloading:
 * says so and refreshes itself. Otherwise a quiet Check.
 */
function updateCard(update: string | undefined, downloading: string | undefined): string {
  if (update !== undefined) {
    return `<div class="upd-card" id="upd-card" data-state="ready">
      <a class="whatsnew" href="/updates">What is new</a>
      <button type="button" class="small js-install-now" data-version="${esc(update)}" title="${esc(update)} is ready. Installing takes about a minute; Minecraft is not touched.">Install ${esc(update)}</button>
    </div>`;
  }
  if (downloading !== undefined) {
    return `<div class="upd-card" id="upd-card" data-state="downloading">
      <span class="chip live" title="It turns into an Install button here when it is done."><span class="sdot info"></span>Downloading ${esc(downloading)}</span>
    </div>`;
  }
  return `<div class="upd-card" id="upd-card" data-state="idle"><button type="button" class="check js-check-updates">Check for updates</button></div>`;
}

/** The product name for the top bar: the last word lit in focus. */
function wordmark(shortName: string): string {
  const cut = shortName.lastIndexOf(' ');
  return cut <= 0
    ? `${esc(shortName.slice(0, -1))}<span>${esc(shortName.slice(-1))}</span>`
    : `${esc(shortName.slice(0, cut + 1))}<span>${esc(shortName.slice(cut + 1))}</span>`;
}

export function layout(input: {
  branding: Branding;
  title: string;
  subtitle?: string;
  active: string;
  nav: NavItem[];
  body: string;
  head?: string;
  /** The Focus colour setting: neutral | ice | warm. */
  theme?: string;
  servers?: ShellServer[];
  currentServerId?: string;
  /** Path the server switcher links back to (the current page). */
  here?: string;
  paused?: boolean;
  /** Pre-rendered context line (see contextLine). */
  context?: string;
  /** Pre-rendered buttons shown at the right of the title. */
  actions?: string;
  /** A page that draws its own head (the Overview's hero): no title block. */
  bare?: boolean;
  /** The running version, always shown at the foot of the rail. */
  version?: string;
  /** A newer version ready to install, if one was found. */
  update?: string;
  /** A newer version being downloaded right now. */
  downloading?: string;
}): string {
  const { branding } = input;
  const paused = input.paused === true;
  const items = input.nav
    .map(
      (item, i) =>
        (item.section === undefined || i === 0 ? '' : `<div class="rail-gap" aria-hidden="true"></div>`) +
        `<a class="rail-item${item.href === input.active ? ' active' : ''}" href="${esc(item.href)}" title="${esc(item.label)}"${item.href === input.active ? ' aria-current="page"' : ''}>` +
        (item.icon === undefined ? '' : icon(item.icon)) +
        `<span>${esc(item.short ?? item.label)}</span>` +
        (item.badge === undefined ? '' : `<span class="badge" aria-label="${esc(item.badge)} waiting">${esc(item.badge)}</span>`) +
        `</a>`,
    )
    .join('');

  const servers = input.servers ?? [];
  const current = servers.find((s) => s.id === input.currentServerId);
  const here = input.here ?? '/';
  const switchLink = (s: ShellServer): string => {
    const target = new URL(here, 'http://x');
    target.searchParams.delete('season');
    target.searchParams.set('server', s.id);
    return `<a href="${esc(target.pathname + target.search)}" class="${s.id === current?.id ? 'current' : ''}">
      <span class="sdot ${collectionDot(s, paused)}"></span><span>${esc(s.name)}</span><span class="k">${esc(s.kind)}</span></a>`;
  };
  const visible = servers.filter((s) => s.visible);
  const hidden = servers.filter((s) => !s.visible);
  const monitored = servers.filter((s) => s.collection !== 'off').length;
  const switcher =
    servers.length === 0
      ? `<a class="button ghost small add-server" href="/servers">${icon('plus', 16)}Add a server</a>`
      : `<details class="focus-switch">
    <summary title="The server every page shows">
      <span class="pill"><span class="sdot ${collectionDot(current, paused)}"></span><span class="n">${esc(current?.name ?? 'Choose a server')}</span></span>
      <span class="k">${esc(current?.kind ?? '')}</span>
      ${icon('chevron', 14)}
    </summary>
    <div class="menu">
      ${visible.map(switchLink).join('')}
      ${hidden.length === 0 ? '' : `<div class="group cap">Hidden</div>${hidden.map(switchLink).join('')}`}
      <div class="sep"></div>
      <a href="/servers">${icon('servers', 16)}<span>Manage servers</span></a>
    </div>
  </details>`;
  const status = paused
    ? { dot: 'warn', words: 'All monitoring paused' }
    : current === undefined
      ? { dot: monitored > 0 ? '' : 'off', words: servers.length === 0 ? 'No server yet' : `${monitored} of ${servers.length} monitored` }
      : {
          dot: collectionDot(current, false) === 'ok' || collectionDot(current, false) === 'info' ? '' : collectionDot(current, false),
          words: `${collectionWords(current, false)} · ${monitored} of ${servers.length} server${servers.length === 1 ? '' : 's'} monitored`,
        };
  const now = new Date();
  const hh = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const [clockMain, clockHalf] = [hh.replace(/\s?[AP]M$/i, ''), (/[AP]M$/i.exec(hh)?.[0] ?? '').toUpperCase()];

  return `<!doctype html>
<html lang="en" data-focus="${focusPalette(input.theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} · ${esc(branding.shortName)}</title>
<link rel="preload" href="/fonts/figtree.woff2" as="font" type="font/woff2" crossorigin>
<style>${css(branding)}</style>
${input.head ?? ''}
</head>
<body>
<div class="field" aria-hidden="true"><canvas id="field-points"></canvas><div class="floor"></div><div class="vignette"></div></div>
<div class="frame">
  <header class="topbar">
    <div class="brandline">
      <a class="wordmark" href="/" title="${esc(branding.name)}">${wordmark(branding.shortName)}</a>
      <div class="statusline"><span class="pulse ${status.dot}"></span><span class="txt">${esc(status.words)}</span></div>
    </div>
    ${switcher}
    <div class="topright">
      ${updateCard(input.update, input.downloading)}
      <div class="clock" id="clock"><div class="time">${esc(clockMain)}<span>${esc(clockHalf)}</span></div>
        <div class="date">${esc(now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</div></div>
    </div>
  </header>
  <nav class="rail" aria-label="Pages">
    ${items}
    <div class="rail-foot">
      <span class="sdot ${paused ? 'warn' : monitored > 0 ? 'ok' : 'off'}" title="${esc(paused ? 'All monitoring paused' : `${monitored} of ${servers.length} servers monitored`)}"></span>
      ${input.version === undefined ? '' : `<a class="version" href="/updates" title="Version ${esc(input.version)}: what is new, and earlier versions">v${esc(input.version)}</a>`}
    </div>
  </nav>
  <main class="stage">
    <div class="page">
      ${
        input.bare === true
          ? ''
          : `<header class="page-head">
        <div class="titles">
          ${input.context ?? ''}
          <h1>${esc(input.title)}</h1>
          ${input.subtitle === undefined || input.subtitle === '' ? '' : `<div class="sub">${esc(input.subtitle)}</div>`}
        </div>
        ${input.actions === undefined ? '' : `<div class="page-actions">${input.actions}</div>`}
      </header>`
      }
      ${input.body}
    </div>
  </main>
</div>
<div class="toast" id="toast" role="status"></div>
<dialog class="confirm" id="confirm"><h3></h3><p></p><div class="actions">
  <button class="ghost" value="cancel" type="button">Cancel</button><button value="ok" type="button">Confirm</button></div></dialog>
<dialog class="confirm" id="ask"><form method="dialog"><h3></h3><input type="text" autocomplete="off"><div class="actions">
  <button class="ghost" value="cancel" type="button">Cancel</button><button value="ok" type="submit">Save</button></div></form></dialog>
<script>
// The field: points linked when close, drawn once (same seed on every page, so
// nothing jumps between pages) and again only when the window is resized.
(() => {
  const c = document.getElementById('field-points');
  if (!c || !c.getContext) return;
  const draw = () => {
    const w = innerWidth, h = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const rgb = css.getPropertyValue('--focus-rgb').trim() || '108,140,255';
    const energy = parseFloat(css.getPropertyValue('--energy')) || 0.5;
    let s = 20240917;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const n = Math.round((50 + 120 * energy) * Math.min(1.2, (w * h) / (1440 * 900)));
    const pts = [];
    for (let i = 0; i < n; i += 1) pts.push([rnd() * w, rnd() * h, 0.6 + rnd() * 1.1]);
    g.lineWidth = 1;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], d = Math.sqrt(dx * dx + dy * dy);
      if (d > 130) continue;
      g.strokeStyle = 'rgba(' + rgb + ',' + ((1 - d / 130) * 0.16).toFixed(3) + ')';
      g.beginPath(); g.moveTo(pts[i][0], pts[i][1]); g.lineTo(pts[j][0], pts[j][1]); g.stroke();
    }
    g.fillStyle = 'rgba(' + rgb + ',.55)';
    for (const p of pts) { g.beginPath(); g.arc(p[0], p[1], p[2], 0, Math.PI * 2); g.fill(); }
  };
  draw();
  let t = 0;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 250); }, { passive: true });
  window.perfintRedrawField = draw;
})();
// The clock: minutes only, so it wakes once a minute.
(() => {
  const el = document.getElementById('clock');
  if (!el) return;
  const time = el.querySelector('.time'), date = el.querySelector('.date');
  const fmtT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const fmtD = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const tick = () => {
    const now = new Date();
    const parts = fmtT.format(now).split(' ');
    time.firstChild.nodeValue = parts[0];
    time.querySelector('span').textContent = parts[1] || '';
    date.textContent = fmtD.format(now);
    setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  };
  tick();
})();
// Small shared helpers: a toast, and a confirmation dialog that returns a promise.
window.perfint = {
  toast(text, bad) {
    const t = document.getElementById('toast');
    t.textContent = text; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(window.perfint._t); window.perfint._t = setTimeout(() => { t.className = 'toast'; }, bad ? 6000 : 3000);
  },
  confirm(title, text, okLabel) {
    const d = document.getElementById('confirm');
    d.querySelector('h3').textContent = title; d.querySelector('p').textContent = text;
    const [cancel, ok] = d.querySelectorAll('button'); ok.textContent = okLabel || 'Confirm';
    return new Promise((resolve) => {
      const done = (v) => { d.close(); cancel.onclick = ok.onclick = null; resolve(v); };
      cancel.onclick = () => done(false); ok.onclick = () => done(true);
      d.oncancel = () => done(false);
      d.showModal();
    });
  },
  // In place of prompt(), which the desktop window does not support.
  // Resolves to the entered text, or null when cancelled.
  ask(title, value, okLabel) {
    const d = document.getElementById('ask');
    const input = d.querySelector('input');
    d.querySelector('h3').textContent = title; input.value = value || '';
    const [cancel, ok] = d.querySelectorAll('button'); ok.textContent = okLabel || 'Save';
    return new Promise((resolve) => {
      const done = (v) => { d.close(); cancel.onclick = null; d.onsubmit = null; resolve(v); };
      cancel.onclick = () => done(null);
      d.oncancel = (e) => { e.preventDefault(); done(null); };
      d.querySelector('form').onsubmit = (e) => { e.preventDefault(); done(input.value); };
      d.showModal(); input.focus(); input.select();
    });
  },
  async post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  },
  // One click: back up, let a running collection finish (new ones wait), install.
  // The same path for the top bar and the Updates page.
  async installUpdate(version, btn) {
    const desktop = window.perfintDesktop;
    if (!desktop || typeof desktop.runInstaller !== 'function') { perfint.toast('Open the desktop app to install.', true); return; }
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Preparing…';
    let data;
    for (;;) {
      data = await perfint.post('/api/update/prepare', { version });
      if (data.ok) break;
      if (!data.wait) { perfint.toast(data.error || 'Could not prepare the update.', true); btn.disabled = false; btn.textContent = label; return; }
      btn.textContent = 'Installs in a moment…'; btn.title = 'Finishing the current collection first (' + data.wait + '); it starts by itself.';
      await new Promise((r) => setTimeout(r, 4000));
    }
    btn.textContent = 'Installing…';
    const result = await desktop.runInstaller({ installer: data.installer });
    if (!result || !result.ok) { perfint.toast((result && result.error) || 'The installer could not be started.', true); btn.disabled = false; btn.textContent = label; }
  },
  // Checks in place: a found version shows the Install button, a download shows
  // its progress, and the answer shows on the button itself for a moment.
  async checkUpdates(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    let data;
    try { data = await perfint.post('/api/update/check', {}); } catch { data = { error: 'the app did not answer' }; }
    if (data.version || data.downloading) { location.reload(); return; }
    if (data.error) perfint.toast('Could not check GitHub: ' + data.error, true);
    if (btn) {
      btn.textContent = data.error ? 'Could not check' : 'Up to date';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Check for updates'; }, 3000);
    }
  },
  // A harvest problem: give given-up files their tries back and collect now.
  async retryHarvest(btn) {
    btn.disabled = true;
    const data = await perfint.post('/api/harvest/retry', {});
    if (!data.ok) { perfint.toast(data.error || 'Could not try again.', true); btn.disabled = false; return; }
    btn.textContent = 'Trying…';
    perfint.toast(data.scheduled ? 'Collecting now; this page refreshes in a minute.' : 'Will try again at the next collection.');
    setTimeout(() => location.reload(), data.scheduled ? 60000 : 3000);
  },
};
document.addEventListener('click', (e) => {
  const install = e.target.closest && e.target.closest('.js-install-now');
  if (install) { perfint.installUpdate(install.dataset.version, install); return; }
  const check = e.target.closest && e.target.closest('.js-check-updates');
  if (check) { perfint.checkUpdates(check); return; }
  const retry = e.target.closest && e.target.closest('.js-retry-harvest');
  if (retry) perfint.retryHarvest(retry);
});
// While a download runs, the top bar refreshes itself when it is ready.
(() => {
  const card = document.getElementById('upd-card');
  if (!card || card.dataset.state !== 'downloading') return;
  const timer = setInterval(async () => {
    try {
      const s = await (await fetch('/api/update/status')).json();
      if (s.ready || !s.downloading) { clearInterval(timer); location.reload(); }
    } catch { /* try again */ }
  }, 8000);
})();
// Renaming a server works from any page that shows a Rename button.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('.js-rename-server');
  if (!btn) return;
  const name = await perfint.ask('Rename this server', btn.dataset.current, 'Rename');
  if (name === null || name.trim() === '' || name.trim() === btn.dataset.current) return;
  const data = await perfint.post('/api/servers/update', { id: btn.dataset.id, displayName: name.trim() });
  if (data.ok) location.reload(); else perfint.toast(data.error || 'Could not rename.', true);
});
// Close the server switcher when clicking elsewhere.
document.addEventListener('click', (e) => {
  const s = document.querySelector('.focus-switch');
  if (s && s.open && !s.contains(e.target)) s.open = false;
});
</script>
</body>
</html>`;
}

/**
 * The line above a title that says exactly what the page is showing:
 * server, machine, world and season. Anything unknown is left out rather
 * than guessed.
 */
export function contextLine(parts: Array<{ label: string; value: string; href?: string } | undefined>): string {
  const crumbs = parts
    .filter((p): p is { label: string; value: string; href?: string } => p !== undefined && p.value !== '')
    .map((p) => {
      const inner = `<span>${esc(p.label)}</span><b>${esc(p.value)}</b>`;
      return p.href === undefined ? `<span class="crumb">${inner}</span>` : `<a class="crumb" href="${esc(p.href)}">${inner}</a>`;
    });
  return crumbs.length === 0 ? '' : `<div class="context">${crumbs.join('')}</div>`;
}
