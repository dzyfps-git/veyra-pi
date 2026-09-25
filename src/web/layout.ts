/**
 * HTML rendering primitives and the application shell.
 *
 * Server-rendered, no build step, no framework, no client bundle. The pages
 * are dense numeric tables and a few charts; a SPA would add a toolchain to
 * maintain for years across modpack rotations and buy nothing.
 *
 * ## Design
 *
 * A calm instrument, not a dashboard of widgets. The rules:
 *
 *   - One accent colour, used for what can be acted on and for "you are
 *     here". Status colours (ok, warn, bad) only ever mean status.
 *   - Hierarchy from type and space, not boxes. A page reads: where am I
 *     (context line) -> what is this (title) -> what matters (first panel)
 *     -> detail on demand.
 *   - Every number that could be misread says what it is, where it comes
 *     from (server, machine, world, season) and over what time.
 *   - Tabular figures everywhere a number can line up with another.
 *   - Nothing animates except to confirm an action.
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

export function css(branding: Branding): string {
  return `
@font-face { font-family: "Figtree"; font-style: normal; font-weight: 300 900; font-display: swap; src: url(/fonts/figtree.woff2) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 400; font-display: swap; src: url(/fonts/jetbrains-mono-400.woff2) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 500; font-display: swap; src: url(/fonts/jetbrains-mono-500.woff2) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-style: normal; font-weight: 700; font-display: swap; src: url(/fonts/jetbrains-mono-700.woff2) format("woff2"); }
:root {
  --bg: #0B0B0D;
  --surface: #14171B;
  --surface-2: #191D22;
  --surface-3: #20252B;
  /* Recessed areas that hold data: the chart, a brief, a pick list. */
  --well: #0E1013;
  --border: rgba(255,255,255,.085);
  --border-soft: rgba(255,255,255,.05);
  --text: #E3E5E8;
  --text-dim: #9EA6B3;
  --text-faint: #6B7480;
  /* Headings, figures and emphasis. */
  --text-strong: #F5F7FA;
  --accent: ${branding.accentColor};
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
  --ok: #3FC46A;
  --warn: #F2A633;
  --bad: #F0554D;
  --info: var(--accent);
  --radius: 16px;
  --radius-sm: 11px;
  /* A faint lit top edge and a soft drop, instead of heavy borders. */
  --shadow: 0 1px 0 rgba(255,255,255,.035) inset, 0 12px 30px -22px rgba(0,0,0,.9);
  --well-shadow: inset 0 2px 8px -4px rgba(0,0,0,.9);
  --ease: cubic-bezier(.32,.72,0,1);
  --sans: "Figtree", "Segoe UI Variable Text", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
  --display: "Figtree", "Segoe UI Variable Display", "Segoe UI", ui-sans-serif, system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
  /* Native parts (dropdown lists, scrollbars, date pickers) follow the theme too. */
  color-scheme: dark;
}
:root[data-theme="system"] { color-scheme: light dark; }
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #F6F7F9; --surface: #FFFFFF; --surface-2: #F1F3F6; --surface-3: #E8EBEF; --well: #EEF0F3;
  --border: rgba(10,20,40,.10); --border-soft: rgba(10,20,40,.07);
  --text: #1A1F29; --text-strong: #0E121A; --text-dim: #4D5668; --text-faint: #7D8699;
  --ok: #12925A; --warn: #B7700B; --bad: #D33B3B;
  --shadow: 0 1px 2px rgba(20,24,33,.05), 0 10px 26px -18px rgba(20,24,33,.25);
  --well-shadow: inset 0 1px 4px -2px rgba(20,24,33,.18);
}
@media (prefers-color-scheme: light) {
  :root[data-theme="system"] {
    --bg: #F6F7F9; --surface: #FFFFFF; --surface-2: #F1F3F6; --surface-3: #E8EBEF; --well: #EEF0F3;
    --border: rgba(10,20,40,.10); --border-soft: rgba(10,20,40,.07);
    --text: #1A1F29; --text-strong: #0E121A; --text-dim: #4D5668; --text-faint: #7D8699;
    --ok: #12925A; --warn: #B7700B; --bad: #D33B3B;
    --shadow: 0 1px 2px rgba(20,24,33,.05), 0 10px 26px -18px rgba(20,24,33,.25);
    --well-shadow: inset 0 1px 4px -2px rgba(20,24,33,.18);
  }
}

* { box-sizing: border-box; }
/* Components set display; an element marked hidden must still disappear. */
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14.5px/1.6 var(--sans);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 2px; }
::selection { background: var(--accent-soft); }
.icon { flex: none; display: block; }

/* ---------------------------------------------------------------- shell */
.shell { display: flex; min-height: 100vh; }
nav.side {
  width: 244px; flex: 0 0 244px; position: sticky; top: 0; height: 100vh; overflow-y: auto;
  background: var(--bg); border-right: 1px solid var(--border-soft);
  padding: 22px 14px 16px; display: flex; flex-direction: column; gap: 4px;
}
.brand { padding: 2px 10px 14px; }
.brand .name { font: 800 15px/1.25 var(--display); letter-spacing: -0.02em; color: var(--text-strong); }
.brand .tagline { color: var(--text-faint); font-size: 12px; margin-top: 3px; line-height: 1.45; }

.switcher { position: relative; margin: 0 2px 12px; }
.switcher > summary {
  list-style: none; cursor: pointer; display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow);
  transition: border-color .2s var(--ease);
}
.switcher > summary::-webkit-details-marker { display: none; }
.switcher > summary:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
.switcher .who { min-width: 0; flex: 1; }
.switcher .who .n { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The kind and what collection is doing: wraps rather than hiding the state. */
.switcher .who .k { font-size: 11.5px; line-height: 1.35; color: var(--text-faint); overflow-wrap: anywhere; }
.switcher[open] > summary { border-color: var(--accent); }
.switcher .menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 20;
  background: var(--surface); border: 1px solid var(--border-soft); border-radius: 14px; box-shadow: 0 24px 60px -24px rgba(0,0,0,.9);
  padding: 6px;
}
.switcher .menu a { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 10px; color: var(--text); font-size: 13px; }
.switcher .menu a:hover { background: var(--surface-2); text-decoration: none; }
.switcher .menu a.current { background: var(--accent-soft); }
.switcher .menu .sep { height: 1px; background: var(--border); margin: 6px 4px; }
.switcher .menu .group { font: 500 10px var(--mono); text-transform: uppercase; letter-spacing: .09em; color: var(--text-faint); padding: 6px 10px 2px; }

.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex: none; }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
.dot.info { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.dot.warn { background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 18%, transparent); }
.dot.off { background: var(--text-faint); }

.nav-label { font: 500 10px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--text-faint); padding: 14px 14px 5px; }
nav.side a.item {
  display: flex; align-items: center; gap: 11px; padding: 8px 14px; border-radius: 999px;
  color: var(--text-dim); font-size: 14px; font-weight: 500; transition: background .2s var(--ease), color .2s var(--ease);
}
nav.side a.item:hover { background: var(--surface); color: var(--text); text-decoration: none; }
nav.side a.item.active { background: var(--surface-2); color: var(--text-strong); font-weight: 600; box-shadow: var(--shadow); }
nav.side a.item.active .icon { color: var(--accent); }
nav.side .pill {
  margin-left: auto; background: var(--warn); color: #15171C; border-radius: 999px;
  font-size: 10.5px; font-weight: 700; padding: 0 7px; line-height: 18px;
}
.side-foot { margin-top: auto; padding: 12px 10px 2px; font-size: 11.5px; color: var(--text-faint); display: flex; flex-direction: column; gap: 8px; }
.side-foot .row { display: flex; align-items: center; gap: 8px; }
.side-foot .version { color: var(--text-faint); font-family: var(--mono); font-size: 11px; }
.side-foot .version:hover { color: var(--text); text-decoration: none; }
/* Updates, at the foot of the sidebar: up to date, downloading, or ready to install in one click. */
.upd-card { border-radius: 14px; padding: 12px 13px; background: var(--surface); border: 1px solid var(--border-soft); box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 8px; }
.upd-card .t { display: flex; align-items: center; gap: 8px; color: var(--text-strong); font-weight: 700; font-size: 13px; }
.upd-card .s { color: var(--text-faint); font-size: 11.5px; line-height: 1.45; }
.upd-card .row2 { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.upd-card .version { font: 500 11px var(--mono); color: var(--text-faint); }
.upd-card .version:hover { color: var(--text); text-decoration: none; }
.upd-card button { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upd-card .check { width: auto; flex: none; overflow: visible; background: transparent; color: var(--text-dim); padding: 3px 0; font-weight: 600; font-size: 12px; border-radius: 0; }
.upd-card .check:disabled { background: transparent; color: var(--text-faint); }
.upd-card .row2 .version { white-space: nowrap; }
.upd-card .check:hover { color: var(--text-strong); filter: none; }
.upd-card.ready { border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 9%, var(--surface)); }
.upd-card.ready .t .spark { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.upd-card .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: spin 0.9s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }

main { flex: 1; min-width: 0; padding: 38px 48px 90px; }
.page { max-width: 1240px; margin: 0 auto; }

/* ---------------------------------------------------------------- page head */
.page-head { display: flex; align-items: flex-end; gap: 20px; margin-bottom: 28px; }
.page-head .titles { flex: 1; min-width: 0; }
.context { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; font: 500 10.5px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--text-faint); }
.context .crumb { display: inline-flex; align-items: center; gap: 7px; padding: 3px 10px; border-radius: 999px; background: var(--surface-2); color: var(--text-faint); white-space: nowrap; }
.context .crumb b { color: var(--text); font-weight: 500; }
.context a.crumb:hover { color: var(--text); text-decoration: none; }
.context .sep { color: var(--border); }
h1 { font: 800 30px/1.1 var(--display); letter-spacing: -0.035em; margin: 0; color: var(--text-strong); }
.sub { color: var(--text-dim); font-size: 14.5px; margin-top: 8px; max-width: 760px; }
.page-actions { display: flex; gap: 8px; flex-wrap: wrap; }

h2 { font: 700 16px/1.3 var(--display); margin: 32px 0 12px; color: var(--text-strong); letter-spacing: -0.02em; }
h3 { font-size: 13px; font-weight: 600; margin: 0 0 8px; }
strong, b { color: var(--text-strong); font-weight: 650; }
h1 strong, h2 strong, .stat-value strong, .card .v strong { color: inherit; font-weight: inherit; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
code { background: var(--well); border: 1px solid var(--border-soft); border-radius: 6px; padding: 0 5px; }

/* ---------------------------------------------------------------- panels */
.panel { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 18px; margin: 0 0 18px; box-shadow: var(--shadow); }
.panel-head { display: flex; align-items: baseline; gap: 12px; padding: 18px 22px 0; }
.panel-head h2 { margin: 0; font-size: 16px; flex: 1; }
/* A caption: small, uppercase, quiet. Controls placed in it keep their own type. */
.panel-meta { font: 500 10.5px var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--text-faint); }
.panel-meta .seg, .panel-meta .button, .panel-meta button { font-family: var(--sans); text-transform: none; letter-spacing: 0; }
.panel-body { padding: 14px 22px 20px; }
.panel.tone-warn { border-color: color-mix(in srgb, var(--warn) 35%, var(--border)); }
.panel.tone-bad { border-color: color-mix(in srgb, var(--bad) 40%, var(--border)); }
.list-row { display: flex; align-items: baseline; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--border-soft); }
.list-row:last-child { border-bottom: none; }
.list-row .main { flex: 1; min-width: 0; }
.list-row .main .t { font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-row .main .s { font-size: 12px; color: var(--text-faint); }
.list-row .fig { font-family: var(--mono); font-size: 13px; font-weight: 700; color: var(--text-strong); white-space: nowrap; font-variant-numeric: tabular-nums; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 18px; }
.grid-3 { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; margin-bottom: 18px; }
.grid-2 > .panel, .grid-3 > .panel { margin: 0; }
/* Grid items may shrink below their content, so long names ellipsize instead of widening the page. */
.grid-2 > *, .grid-3 > *, .stats > * { min-width: 0; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 18px; }
.stat { background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--radius); padding: 16px 18px 15px; box-shadow: var(--shadow); }
.stat-label { font: 500 10.5px var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--text-faint); }
.stat-value { font: 800 30px/1.1 var(--display); letter-spacing: -0.035em; margin-top: 8px; font-variant-numeric: tabular-nums; color: var(--text-strong); }
.stat-unit { font: 500 11.5px var(--mono); color: var(--text-faint); margin-left: 5px; letter-spacing: 0; }
/* A figure that opens something stays a figure; the underline says it is a link. */
.stat-value a, .card .v a { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 25%, transparent); text-underline-offset: 5px; text-decoration-thickness: 2px; }
.stat-value a:hover, .card .v a:hover { text-decoration-color: var(--accent); }
/* A stat whose value is words (a machine, a world), not a figure. */
.stat-text { display: block; font: 600 15px/1.35 var(--sans); letter-spacing: 0; overflow-wrap: anywhere; }
.stat-note { font-size: 12.5px; color: var(--text-faint); margin-top: 5px; line-height: 1.5; }
.stat.tone-warn .stat-value { color: var(--warn); }
.stat.tone-bad .stat-value { color: var(--bad); }
.stat.tone-ok .stat-value { color: var(--ok); }

.banner { display: flex; align-items: flex-start; gap: 12px; padding: 15px 18px; border-radius: var(--radius); border: 1px solid var(--border-soft); background: var(--surface); margin: 0 0 18px; box-shadow: var(--shadow); }
.banner-icon { margin-top: 1px; }
.banner-text { flex: 1; color: var(--text-dim); }
.banner-action { flex: none; }
.banner.tone-ok { border-color: color-mix(in srgb, var(--ok) 30%, var(--border)); background: color-mix(in srgb, var(--ok) 6%, var(--surface)); }
.banner.tone-ok .banner-icon { color: var(--ok); }
.banner.tone-warn { border-color: color-mix(in srgb, var(--warn) 35%, var(--border)); background: color-mix(in srgb, var(--warn) 6%, var(--surface)); }
.banner.tone-warn .banner-icon { color: var(--warn); }
.banner.tone-bad { border-color: color-mix(in srgb, var(--bad) 40%, var(--border)); background: color-mix(in srgb, var(--bad) 7%, var(--surface)); }
.banner.tone-bad .banner-icon { color: var(--bad); }
.banner.tone-info .banner-icon { color: var(--accent); }

/* Legacy card grid, restyled to match stats. */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 12px; }
.card { background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--radius); padding: 16px 18px; box-shadow: var(--shadow); }
.card .k { font: 500 10.5px var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--text-faint); }
.card .v { font: 800 28px/1.1 var(--display); margin-top: 8px; font-variant-numeric: tabular-nums; letter-spacing: -0.035em; color: var(--text-strong); }
.card .u { font: 500 12px var(--sans); color: var(--text-faint); margin-left: 3px; }
.card .n { color: var(--text-faint); font-size: 12px; margin-top: 4px; }

/* ---------------------------------------------------------------- tables */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; color: var(--text-faint); font: 500 10.5px var(--mono); letter-spacing: .08em; text-transform: uppercase;
  padding: 10px 12px; border-bottom: 1px solid var(--border-soft); white-space: nowrap;
}
td { padding: 11px 12px; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
tr:last-child td { border-bottom: none; }
tbody tr:hover td, table tr:hover td { background: color-mix(in srgb, var(--text) 3%, transparent); }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 12.5px; }
td.mono { font-family: var(--mono); font-size: 12px; }
.dim { color: var(--text-dim); }
.faint { color: var(--text-faint); }

/* ---------------------------------------------------------------- chips, notes, tabs */
.tag {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 6px;
  font: 700 10px/18px var(--mono); letter-spacing: .07em; text-transform: uppercase;
  border: 1px solid var(--border-soft); color: var(--text-dim); background: var(--surface-2); white-space: nowrap;
}
.tag.ok   { color: var(--ok);   border-color: color-mix(in srgb, var(--ok) 35%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent); }
.tag.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 8%, transparent); }
.tag.bad  { color: var(--bad);  border-color: color-mix(in srgb, var(--bad) 35%, transparent); background: color-mix(in srgb, var(--bad) 8%, transparent); }
.tag.accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: var(--accent-soft); }

.note {
  background: var(--surface); border: 1px solid var(--border-soft); border-radius: 14px;
  padding: 12px 16px; color: var(--text-dim); font-size: 13.5px; margin: 12px 0;
}
.note.faint { background: transparent; }
.note.warn { border-color: color-mix(in srgb, var(--warn) 35%, var(--border)); background: color-mix(in srgb, var(--warn) 5%, var(--surface)); }
.note.bad  { border-color: color-mix(in srgb, var(--bad) 40%, var(--border)); background: color-mix(in srgb, var(--bad) 6%, var(--surface)); }
.note strong { color: var(--text-strong); }
details > summary { cursor: pointer; }

.tabs { display: flex; gap: 6px; margin-bottom: 20px; overflow-x: auto; scrollbar-width: none; }
.tabs a { white-space: nowrap; padding: 7px 16px; border-radius: 999px; color: var(--text-dim); font-size: 13.5px; font-weight: 600; background: var(--surface); }
.tabs a:hover { color: var(--text); text-decoration: none; background: var(--surface-2); }
.tabs a.active { color: var(--bg); background: var(--text-strong); }

/* Links that switch a view (Findings order, Reports mode, chart span). */
.seg { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.seg a { padding: 6px 14px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--text-dim); background: var(--surface-2); transition: background .2s var(--ease), color .2s var(--ease); }
.seg a.on { background: var(--text-strong); color: var(--bg); }
.seg a:hover { text-decoration: none; color: var(--text); }
.seg a.on:hover { color: var(--bg); }
.seg.small a { padding: 3px 11px; font-size: 12px; }
.segmented { display: inline-flex; padding: 3px; gap: 2px; background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 999px; }
.segmented label { position: relative; }
.segmented input { position: absolute; opacity: 0; pointer-events: none; }
.segmented span { display: block; padding: 6px 14px; border-radius: 999px; font-size: 13px; color: var(--text-dim); cursor: pointer; white-space: nowrap; }
.segmented input:checked + span { background: var(--surface); color: var(--text); font-weight: 560; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
.segmented input:focus-visible + span { outline: 2px solid var(--accent); }

/* ---------------------------------------------------------------- settings rows (and similar) */
.group { margin-bottom: 30px; }
.group > h3 { font: 500 10.5px var(--mono); text-transform: uppercase; letter-spacing: .1em; color: var(--text-faint); margin: 0 0 10px; }
.setting {
  display: grid; grid-template-columns: 1fr 260px; gap: 22px; align-items: start;
  padding: 16px 20px; background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--radius); margin-bottom: 8px; box-shadow: var(--shadow);
}
.setting.risky { border-color: color-mix(in srgb, var(--warn) 25%, var(--border)); }
.setting .label { font-weight: 650; font-size: 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.setting .help { color: var(--text-dim); font-size: 12.5px; margin-top: 4px; line-height: 1.5; }
.setting .applies { color: var(--text-faint); font-size: 11.5px; margin-top: 6px; }
.setting .control { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.setting .unit { color: var(--text-faint); font-size: 11.5px; text-align: right; }

input[type=text], input[type=search], input[type=number], input[type=password], input[type=date], input[type=datetime-local], select, textarea {
  background: var(--well); border: 1px solid var(--border-soft); color: var(--text);
  border-radius: 12px; padding: 9px 13px; font: inherit; font-size: 13.5px; width: 100%; transition: border-color .2s var(--ease), box-shadow .2s var(--ease);
  font-variant-numeric: tabular-nums;
}
input[type=search] { border-radius: 999px; padding-left: 16px; }
input:focus, select:focus, textarea:focus { outline: none; border-color: color-mix(in srgb, var(--accent) 60%, transparent); box-shadow: 0 0 0 3px var(--accent-soft); }
input[type=checkbox] { width: 17px; height: 17px; accent-color: var(--accent); }

/* A real toggle: the checkbox is the switch. */
.toggle { position: relative; display: inline-flex; align-items: center; gap: 10px; cursor: pointer; }
.toggle input { appearance: none; -webkit-appearance: none; width: 38px; height: 22px; margin: 0; border-radius: 999px;
  background: var(--surface-3); border: 1px solid var(--border); position: relative; cursor: pointer; transition: background .15s; flex: none; }
.toggle input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--text-dim); transition: transform .15s, background .15s; }
.toggle input:checked { background: var(--accent); border-color: var(--accent); }
.toggle input:checked::after { transform: translateX(16px); background: #fff; }
.toggle input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.toggle input:disabled { opacity: .5; cursor: not-allowed; }
.toggle .toggle-text { font-size: 12.5px; color: var(--text-dim); min-width: 22px; }

button, .button {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  background: var(--accent); color: #0B0E14; border: 1px solid transparent;
  border-radius: 999px; padding: 9px 18px; font: inherit; font-weight: 700; font-size: 13px; cursor: pointer; white-space: nowrap;
  transition: filter .2s var(--ease), background .2s var(--ease);
}
button:hover, .button:hover { filter: brightness(1.07); text-decoration: none; }
button.ghost, .button.ghost { background: var(--surface-3); color: var(--text); border-color: transparent; }
button.small, .button.small { padding: 4px 12px; font-size: 12px; }
button.ghost:hover, .button.ghost:hover { background: color-mix(in srgb, var(--text) 10%, var(--surface-3)); filter: none; }
button.quiet { background: transparent; color: var(--accent); border: none; padding: 4px 6px; }
button.danger { background: var(--bad); color: #1A0E0E; }
button:disabled, button:disabled:hover { background: var(--surface-2); color: var(--text-faint); border-color: transparent; cursor: not-allowed; filter: none; }
select:disabled, option:disabled { color: var(--text-faint); }

.sticky-save {
  position: sticky; bottom: 0; margin-top: 22px; z-index: 5;
  background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px);
  border-top: 1px solid var(--border); padding: 12px 0; display: flex; gap: 10px; align-items: center;
}
.sticky-save .status { color: var(--text-faint); font-size: 12.5px; }

.empty { color: var(--text-faint); padding: 34px; text-align: center; border: 1px dashed var(--border); border-radius: var(--radius); }
.bar { height: 5px; background: var(--well); border-radius: 3px; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--accent); }

/* ---------------------------------------------------------------- timeline */
.timeline { position: relative; margin: 4px 0 0 6px; padding-left: 22px; border-left: 1px solid var(--border); }
.tl-node { position: relative; padding: 2px 0 18px; }
.tl-node::before { content: ''; position: absolute; left: -28px; top: 7px; width: 11px; height: 11px; border-radius: 50%; background: var(--surface); border: 2px solid var(--border); }
.tl-node.machine::before { border-color: var(--text-dim); }
.tl-node.current::before { border-color: var(--accent); background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.tl-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-weight: 600; }
.tl-meta { color: var(--text-faint); font-size: 12px; margin-top: 2px; }
.tl-card { margin-top: 8px; background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 10px; padding: 11px 14px; }
.tl-card .row { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-dim); margin-top: 6px; }
.tl-card .row b { color: var(--text); font-variant-numeric: tabular-nums; }

/* ---------------------------------------------------------------- dialog */
dialog.confirm { border: 1px solid var(--border-soft); border-radius: 20px; background: var(--surface); color: var(--text); padding: 22px 24px; max-width: 480px; box-shadow: 0 24px 60px -20px rgba(0,0,0,0.6); }
dialog.confirm::backdrop { background: rgba(8,10,14,0.55); backdrop-filter: blur(2px); }
dialog.confirm h3 { font: 800 18px var(--display); letter-spacing: -0.02em; margin: 0 0 8px; }
dialog.confirm p { color: var(--text-dim); margin: 0 0 16px; }
dialog.confirm .actions { display: flex; gap: 8px; justify-content: flex-end; }
dialog.confirm input[type=text] { width: 100%; margin: 0 0 16px; }

.toast { position: fixed; right: 22px; bottom: 22px; z-index: 50; background: var(--surface-2); border: 1px solid var(--border-soft); border-radius: 999px;
  padding: 10px 18px; box-shadow: var(--shadow); font-size: 13px; display: none; align-items: center; gap: 9px; max-width: 420px; }
.toast.show { display: flex; animation: toast-in .18s ease-out; }
.toast.bad { border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); }
@keyframes toast-in { from { transform: translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }

/* Charts, briefs and pick lists sit in a recessed well. */
.chart-wrap, .brief-out, .picks { background: var(--well); border-radius: 14px; box-shadow: var(--well-shadow); }
.chart-wrap { padding: 10px 6px 4px; }
.picks { border-color: var(--border-soft) !important; }

@media (max-width: 1000px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }
@media (max-width: 900px) {
  .shell { flex-direction: column; }
  nav.side { width: auto; flex: none; height: auto; position: static; flex-direction: row; flex-wrap: wrap; align-items: center; }
  .brand, .nav-label, .side-foot { display: none; }
  .switcher { flex: 1 1 100%; }
  main { padding: 20px 16px 60px; }
  .setting { grid-template-columns: 1fr; gap: 12px; }
  .page-head { flex-direction: column; align-items: stretch; }
}
`;
}

export interface NavItem {
  href: string;
  label: string;
  badge?: string;
  icon?: string;
  /** Section heading shown above this item. */
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
 * The update card at the foot of the sidebar. Ready: one click installs (the
 * database is backed up and the moment is chosen underneath). Downloading:
 * says so and refreshes itself. Otherwise the version and a Check button.
 */
function updateCard(version: string | undefined, update: string | undefined, downloading: string | undefined): string {
  const versionLink = version === undefined ? '' : `<a class="version" href="/updates" title="Version ${esc(version)}: what is new, and earlier versions">v${esc(version)}</a>`;
  if (update !== undefined) {
    return `<div class="upd-card ready" id="upd-card" data-state="ready">
      <div class="t"><span class="spark"></span>New version available</div>
      <div class="s">${esc(update)} is ready. Installing takes about a minute; Minecraft is not touched.</div>
      <button type="button" class="js-install-now" data-version="${esc(update)}">Install ${esc(update)}</button>
      <div class="row2"><a class="version" href="/updates">What is new</a>${versionLink}</div>
    </div>`;
  }
  if (downloading !== undefined) {
    return `<div class="upd-card" id="upd-card" data-state="downloading">
      <div class="t"><span class="spin"></span>Downloading ${esc(downloading)}…</div>
      <div class="s">It appears here, ready to install, when it is done.</div>
      <div class="row2">${versionLink}</div>
    </div>`;
  }
  return `<div class="upd-card" id="upd-card" data-state="idle">
    <div class="row2">${versionLink}<button type="button" class="check js-check-updates">Check for updates</button></div>
  </div>`;
}

export function layout(input: {
  branding: Branding;
  title: string;
  subtitle?: string;
  active: string;
  nav: NavItem[];
  body: string;
  head?: string;
  /** dark | light | system */
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
  /** The running version, always shown at the foot of the sidebar. */
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
      (item) =>
        (item.section === undefined ? '' : `<div class="nav-label">${esc(item.section)}</div>`) +
        `<a class="item ${item.href === input.active ? 'active' : ''}" href="${esc(item.href)}">` +
        (item.icon === undefined ? '' : icon(item.icon)) +
        `<span>${esc(item.label)}</span>` +
        (item.badge === undefined ? '' : `<span class="pill">${esc(item.badge)}</span>`) +
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
      <span class="dot ${collectionDot(s, paused)}"></span><span>${esc(s.name)}</span>
      <span class="faint" style="margin-left:auto;font-size:11px">${esc(s.kind)}</span></a>`;
  };
  const visible = servers.filter((s) => s.visible);
  const hidden = servers.filter((s) => !s.visible);
  const switcher =
    servers.length === 0
      ? `<a class="item" href="/servers">${icon('plus')}<span>Add a server</span></a>`
      : `<details class="switcher">
    <summary>
      <span class="dot ${collectionDot(current, paused)}"></span>
      <div class="who"><div class="n">${esc(current?.name ?? 'Choose a server')}</div>
        <div class="k">${esc(current === undefined ? '' : `${current.kind} · ${collectionWords(current, paused)}`)}</div></div>
      ${icon('chevron', 16)}
    </summary>
    <div class="menu">
      ${visible.map(switchLink).join('')}
      ${hidden.length === 0 ? '' : `<div class="group">Hidden</div>${hidden.map(switchLink).join('')}`}
      <div class="sep"></div>
      <a href="/servers">${icon('servers', 16)}<span>Manage servers</span></a>
    </div>
  </details>`;

  return `<!doctype html>
<html lang="en" data-theme="${esc(['light', 'system'].includes(input.theme ?? '') ? input.theme : 'dark')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)} · ${esc(branding.shortName)}</title>
<link rel="preload" href="/fonts/figtree.woff2" as="font" type="font/woff2" crossorigin>
<style>${css(branding)}</style>
${input.head ?? ''}
</head>
<body>
<div class="shell">
  <nav class="side">
    <div class="brand">
      <div class="name">${esc(branding.name)}</div>
      ${branding.tagline === '' ? '' : `<div class="tagline">${esc(branding.tagline)}</div>`}
    </div>
    ${switcher}
    ${items}
    <div class="side-foot">
      <div class="row">${
        paused
          ? `<span class="dot warn"></span> All monitoring paused`
          : `<span class="dot ${visible.some((s) => s.collection !== 'off') ? 'ok' : 'off'}"></span> ${
              servers.filter((s) => s.collection !== 'off').length
            } of ${servers.length} server${servers.length === 1 ? '' : 's'} monitored`
      }</div>
      ${updateCard(input.version, input.update, input.downloading)}
    </div>
  </nav>
  <main>
    <div class="page">
      <header class="page-head">
        <div class="titles">
          ${input.context ?? ''}
          <h1>${esc(input.title)}</h1>
          ${input.subtitle === undefined || input.subtitle === '' ? '' : `<div class="sub">${esc(input.subtitle)}</div>`}
        </div>
        ${input.actions === undefined ? '' : `<div class="page-actions">${input.actions}</div>`}
      </header>
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
  // The same path for the sidebar card and the Updates page.
  async installUpdate(version, btn) {
    const desktop = window.perfintDesktop;
    if (!desktop || typeof desktop.runInstaller !== 'function') { perfint.toast('Open the desktop app to install.', true); return; }
    const label = btn.textContent;
    const card = btn.closest('.upd-card');
    const note = card ? card.querySelector('.s') : null;
    btn.disabled = true; btn.textContent = 'Preparing…';
    let data;
    for (;;) {
      data = await perfint.post('/api/update/prepare', { version });
      if (data.ok) break;
      if (!data.wait) { perfint.toast(data.error || 'Could not prepare the update.', true); btn.disabled = false; btn.textContent = label; return; }
      btn.textContent = 'Installs in a moment…'; btn.title = 'Waiting while ' + data.wait;
      if (note) note.textContent = 'Finishing the current collection first; it starts by itself.';
      await new Promise((r) => setTimeout(r, 4000));
    }
    btn.textContent = 'Installing…';
    const result = await desktop.runInstaller({ installer: data.installer });
    if (!result || !result.ok) { perfint.toast((result && result.error) || 'The installer could not be started.', true); btn.disabled = false; btn.textContent = label; }
  },
  // Checks in place: a found version shows the Install card, a download shows
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
// While a download runs, the card refreshes itself when it is ready.
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
  const s = document.querySelector('.switcher');
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
