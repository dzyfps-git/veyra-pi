/**
 * Branding loader.
 *
 * The public-facing name of this application lives in exactly one file
 * (`config/branding.toml`) and is read through exactly one function (`brand()`).
 * No other module may hardcode it -- `tests/branding.test.ts` enforces that by
 * scanning the source tree.
 *
 * Internal identifiers are the opposite: they are frozen, brand-neutral, and
 * live in `config/internal.frozen.toml`. They appear in paths, the database
 * filename, the user-agent and log lines, so renaming the app must never touch
 * them.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';

export interface Branding {
  name: string;
  shortName: string;
  tagline: string;
  accentColor: string;
  logoPath: string;
  footerNote: string;
  reports: { headingPrefix: string };
}

export interface InternalIdentity {
  appId: string;
  envPrefix: string;
  serviceName: string;
  databaseFile: string;
  schemaVersion: number;
  metricPrefix: string;
  userAgent: string;
}

const DEFAULT_BRANDING: Branding = {
  name: 'Performance Intelligence',
  shortName: 'PerfInt',
  tagline: '',
  accentColor: '#6C8CFF',
  logoPath: '',
  footerNote: '',
  reports: { headingPrefix: '' },
};

function str(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

let cachedBranding: Branding | undefined;
let cachedIdentity: InternalIdentity | undefined;

export function loadBranding(configDir: string): Branding {
  const file = path.join(configDir, 'branding.toml');
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (cause) {
    // Branding is cosmetic. A broken or missing file must never stop the
    // collector -- it falls back to neutral defaults and carries on.
    return { ...DEFAULT_BRANDING };
  }

  const reports = (raw['reports'] ?? {}) as Record<string, unknown>;
  return {
    name: str(raw, 'name', DEFAULT_BRANDING.name),
    shortName: str(raw, 'shortName', DEFAULT_BRANDING.shortName),
    tagline: str(raw, 'tagline', DEFAULT_BRANDING.tagline),
    accentColor: str(raw, 'accentColor', DEFAULT_BRANDING.accentColor),
    logoPath: str(raw, 'logoPath', DEFAULT_BRANDING.logoPath),
    footerNote: str(raw, 'footerNote', DEFAULT_BRANDING.footerNote),
    reports: { headingPrefix: str(reports, 'headingPrefix', DEFAULT_BRANDING.reports.headingPrefix) },
  };
}

export function loadInternalIdentity(configDir: string): InternalIdentity {
  const file = path.join(configDir, 'internal.frozen.toml');
  const raw = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const schemaVersion = raw['schemaVersion'];
  return {
    appId: str(raw, 'appId', 'perfint'),
    envPrefix: str(raw, 'envPrefix', 'PERFINT_'),
    serviceName: str(raw, 'serviceName', 'perfint-collector'),
    databaseFile: str(raw, 'databaseFile', 'perfint.sqlite'),
    schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : 1,
    metricPrefix: str(raw, 'metricPrefix', 'perfint_'),
    userAgent: str(raw, 'userAgent', 'perfint/0.1'),
  };
}

/** Cached accessors for ordinary runtime use. */
export function brand(configDir: string): Branding {
  return (cachedBranding ??= loadBranding(configDir));
}

export function identity(configDir: string): InternalIdentity {
  return (cachedIdentity ??= loadInternalIdentity(configDir));
}

/** Drop the cache so branding edits apply without a restart. */
export function reloadBranding(): void {
  cachedBranding = undefined;
  cachedIdentity = undefined;
}
