/**
 * Settings persistence.
 *
 * SQLite is the source of truth, not a config file: changes made in the UI
 * persist across restarts and take effect without anyone editing a file or
 * running a command. The TOML file becomes bootstrap defaults plus
 * import/export.
 *
 * Hot reload works through a monotonic version counter. Long-running work
 * (the harvest scheduler, the cleanup job) checks the version before each
 * scheduled action and re-reads if it moved. That is why changing retention
 * from 15 days to 12 applies at the next cleanup with no restart: the cleanup
 * job reads the value when it runs, not when it started.
 *
 * Risky changes are recorded as PENDING rather than applied. Nothing that
 * reaches a live Minecraft server happens because a value changed in a form.
 */

import type { DatabaseSync } from 'node:sqlite';

import { SETTINGS, settingDef, validateSetting, requiresApproval, type SettingDef, type RiskTier } from './registry.ts';

/** [key, old value, new value]: releases moved from veyra-pi-releases into veyra-pi. */
const MOVED_VALUES: ReadonlyArray<readonly [string, SettingValue, SettingValue]> = [
  ['updates.githubRepo', 'dzyfps-git/veyra-pi-releases', 'dzyfps-git/veyra-pi'],
];

export const SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- Changes that must not be applied silently. They sit here, visible, until
-- explicitly approved (or discarded).
CREATE TABLE IF NOT EXISTS setting_pending (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  risk         TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  note         TEXT
);

-- Append-only history. Every change, who made it, and what it replaced.
CREATE TABLE IF NOT EXISTS setting_history (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT NOT NULL,
  risk       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  actor      TEXT,
  approved   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS setting_history_by_key ON setting_history (key, at);
`;

export type SettingValue = string | number | boolean;

export interface AppliedChange {
  key: string;
  from: SettingValue | undefined;
  to: SettingValue;
  risk: RiskTier;
  status: 'applied' | 'pending-approval';
  appliesAt: string;
}

export interface ChangeRejection {
  key: string;
  error: string;
}

export interface ApplyResult {
  changes: AppliedChange[];
  rejected: ChangeRejection[];
  /** New settings version. Watchers compare against this to detect changes. */
  version: number;
}

/**
 * Mask a value that must not travel beyond the settings table.
 *
 * A `secret` setting is stored in `setting` because the application has to
 * be able to use it. Everywhere else -- the audit history, the object
 * returned to the browser, anything that might reach a log -- it is masked.
 *
 * This was not the original behaviour. Applying the Discord webhook wrote
 * the raw URL into `setting_history` and echoed it back in the apply result,
 * which is exactly the "redacted in all logs, never echoed in the UI"
 * requirement being quietly broken by the audit trail meant to make the
 * system trustworthy.
 *
 * The masked form keeps enough to identify WHICH credential it was -- the
 * origin for a URL, a length for anything else -- so history stays useful
 * without being sensitive.
 */
export function maskSecret(value: SettingValue | undefined): SettingValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') return value;
  try {
    return `${new URL(value).origin}/… (redacted)`;
  } catch {
    return `(redacted, ${value.length} characters)`;
  }
}

export class SettingsStore {
  readonly #db: DatabaseSync;
  #cache = new Map<string, SettingValue>();
  #version = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#db.exec(SETTINGS_SCHEMA_SQL);
    this.reload();
    this.#moveRetiredValues();
  }

  /** A saved value that only pointed at something since retired follows it to its new place. */
  #moveRetiredValues(): void {
    for (const [key, from, to] of MOVED_VALUES) {
      if (this.#cache.get(key) === from) this.apply({ [key]: to }, { actor: 'update' });
    }
  }

  /** Monotonic counter; bumped on every committed change. */
  get version(): number {
    return this.#version;
  }

  reload(): void {
    this.#cache = new Map();
    for (const def of SETTINGS) this.#cache.set(def.key, def.default);
    const rows = this.#db.prepare('SELECT key, value FROM setting').all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      const def = settingDef(row.key);
      if (def === undefined) continue; // A setting removed in a newer build.
      const parsed = validateSetting(row.key, JSON.parse(row.value));
      if (parsed.ok && parsed.value !== undefined) this.#cache.set(row.key, parsed.value);
    }
    this.#version += 1;
  }

  get<T extends SettingValue>(key: string): T {
    const value = this.#cache.get(key);
    if (value === undefined) {
      const def = settingDef(key);
      if (def === undefined) throw new Error(`unknown setting "${key}"`);
      return def.default as T;
    }
    return value as T;
  }

  getBoolean(key: string): boolean {
    return this.get<boolean>(key) === true;
  }

  getNumber(key: string): number {
    return Number(this.get<number>(key));
  }

  getString(key: string): string {
    return String(this.get<string>(key));
  }

  /** Every setting with its current value, for rendering the UI. */
  all(): Array<{ def: SettingDef; value: SettingValue; pending: SettingValue | undefined }> {
    const pendingRows = this.#db.prepare('SELECT key, value FROM setting_pending').all() as Array<{
      key: string;
      value: string;
    }>;
    const pending = new Map(pendingRows.map((r) => [r.key, JSON.parse(r.value) as SettingValue]));

    return SETTINGS.map((def) => ({
      def,
      value: this.#cache.get(def.key) ?? def.default,
      pending: pending.get(def.key),
    }));
  }

  /**
   * Apply a batch of changes.
   *
   * Safe changes commit immediately. Risky ones are parked in `setting_pending`
   * and reported as such, so the caller can present them for approval. Invalid
   * values are rejected individually; a bad field never blocks a good one.
   */
  apply(
    updates: Record<string, unknown>,
    options: { actor?: string; approveRisky?: boolean } = {},
  ): ApplyResult {
    const changes: AppliedChange[] = [];
    const rejected: ChangeRejection[] = [];

    const write = this.#db.prepare(
      `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    );
    const park = this.#db.prepare(
      `INSERT INTO setting_pending (key, value, risk, requested_at, note) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, requested_at = excluded.requested_at`,
    );
    const unpark = this.#db.prepare('DELETE FROM setting_pending WHERE key = ?');
    const history = this.#db.prepare(
      'INSERT INTO setting_history (key, old_value, new_value, risk, at, actor, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    const now = Date.now();
    const actor = options.actor ?? 'ui';

    this.#db.exec('BEGIN');
    try {
      for (const [key, raw] of Object.entries(updates)) {
        const def = settingDef(key);
        if (def === undefined) {
          rejected.push({ key, error: 'unknown setting' });
          continue;
        }

        const parsed = validateSetting(key, raw);
        if (!parsed.ok || parsed.value === undefined) {
          rejected.push({ key, error: parsed.error ?? 'invalid value' });
          continue;
        }

        const current = this.#cache.get(key);
        if (current === parsed.value) continue; // No-op; do not churn history.

        const needsApproval = requiresApproval(def) && options.approveRisky !== true;
        if (needsApproval) {
          park.run(key, JSON.stringify(parsed.value), def.risk, now, def.warning ?? null);
          changes.push({
            key,
            from: def.type === 'secret' ? maskSecret(current) : current,
            to: def.type === 'secret' ? (maskSecret(parsed.value) ?? '') : parsed.value,
            risk: def.risk,
            status: 'pending-approval',
            appliesAt: def.appliesAt,
          });
          continue;
        }

        write.run(key, JSON.stringify(parsed.value), now, actor);
        // The audit row records THAT a secret changed, never what it changed to.
        const isSecret = def.type === 'secret';
        history.run(
          key,
          current === undefined ? null : JSON.stringify(isSecret ? maskSecret(current) : current),
          JSON.stringify(isSecret ? maskSecret(parsed.value) : parsed.value),
          def.risk,
          now,
          actor,
          options.approveRisky === true ? 1 : 0,
        );
        unpark.run(key);
        this.#cache.set(key, parsed.value);
        changes.push({
          key,
          from: def.type === 'secret' ? maskSecret(current) : current,
          to: def.type === 'secret' ? (maskSecret(parsed.value) ?? '') : parsed.value,
          risk: def.risk,
          status: 'applied',
          appliesAt: def.appliesAt,
        });
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }

    if (changes.some((c) => c.status === 'applied')) this.#version += 1;
    return { changes, rejected, version: this.#version };
  }

  /** Approve and apply a change previously parked as risky. */
  approvePending(key: string, actor = 'ui'): ApplyResult {
    const row = this.#db.prepare('SELECT value FROM setting_pending WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) return { changes: [], rejected: [{ key, error: 'no pending change' }], version: this.#version };
    return this.apply({ [key]: JSON.parse(row.value) }, { actor, approveRisky: true });
  }

  discardPending(key: string): void {
    this.#db.prepare('DELETE FROM setting_pending WHERE key = ?').run(key);
  }

  pendingCount(): number {
    const row = this.#db.prepare('SELECT count(*) AS c FROM setting_pending').get() as { c: number };
    return row.c;
  }

  /** Reset to the shipped default. */
  reset(key: string, actor = 'ui'): ApplyResult {
    const def = settingDef(key);
    if (def === undefined) return { changes: [], rejected: [{ key, error: 'unknown setting' }], version: this.#version };
    return this.apply({ [key]: def.default }, { actor });
  }

  /** Export non-default values, for backup or moving to another machine. */
  export(): Record<string, SettingValue> {
    const out: Record<string, SettingValue> = {};
    for (const def of SETTINGS) {
      const value = this.#cache.get(def.key);
      if (value !== undefined && value !== def.default) out[def.key] = value;
    }
    return out;
  }
}

/**
 * Watches the settings version so long-running work picks up changes without
 * a restart. Call `changed()` before each scheduled action.
 */
export class SettingsWatcher {
  #seen: number;
  readonly #store: SettingsStore;

  constructor(store: SettingsStore) {
    this.#store = store;
    this.#seen = store.version;
  }

  changed(): boolean {
    if (this.#store.version === this.#seen) return false;
    this.#seen = this.#store.version;
    return true;
  }
}
