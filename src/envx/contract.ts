/**
 * The envx machine interface, version 1 (envx's docs/api.md, envx 1.1.0), as types.
 *
 * envx is an optional, separate tool that indexes the server's mods: which jar
 * defines a class, which mixins target a method, what changed between two
 * states of the pack. This app only ASKS it, one way; nothing measured here is
 * ever sent to it, and it stores nothing we send.
 *
 * Everything here mirrors that document; where an answer does not match it, the client reports a
 * mismatch (client.ts) rather than guessing -- the fix belongs in whichever
 * side is wrong, not in a workaround here.
 */

export const ENVX_API_VERSION = 1;

/**
 * Whether envx answers are shown as findings. Turned on once envx 1.1.0 was
 * installed and a real batch matched the contract (no mismatches); before
 * that the only answers were a stub's canned ones. Answers still show only
 * from an envx that serves the interface (servesApi).
 */
export const ENVX_ANSWERS_LIVE = true;

/** More items than this in one request is refused by envx (`too_many`). */
export const ENVX_MAX_ITEMS = 5000;

/** A method as the capture recorded it: runtime (intermediary) class, name, JVM descriptor. */
export interface EnvxKey {
  class: string;
  method: string;
  desc: string;
}

export interface EnvxTarget {
  class: string;
  method?: string;
  desc?: string;
}

export type EnvxRequest =
  | { id: string; op: 'snapshots'; env?: string }
  | { id: string; op: 'match'; env?: string; mods: Array<[string, string]> }
  | { id: string; op: 'owner'; env?: string; fingerprint: string; keys: EnvxKey[] }
  | { id: string; op: 'mixins'; env?: string; fingerprint: string; targets: EnvxTarget[] }
  | { id: string; op: 'diff'; env?: string; from: number; to: number };

export type EnvxErrorCode = 'bad_request' | 'unknown_op' | 'unknown_env' | 'unknown_snapshot' | 'too_many' | 'internal';

export interface EnvxResponse {
  api: number;
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: { code: EnvxErrorCode | string; message: string };
}

export interface EnvxSnapshot {
  id: number;
  fingerprint: string;
  modset: string | null;
  label: string | null;
  kind: 'sync' | 'import';
  taken_at: string;
  checked_at: string;
  current: boolean;
}

export type EnvxMatch =
  | { status: 'match'; modset: string; snapshots: number[] }
  | {
      status: 'none';
      modset: string;
      /** For display only, never an answer. Absent when envx has no snapshot with a loader list. */
      closest?: {
        snapshot: number;
        only_in_request_count: number;
        only_in_request: Array<[string, string]>;
        only_in_snapshot_count: number;
        only_in_snapshot: Array<[string, string]>;
      };
    };

/** A jar that bundles another. */
export interface EnvxJarRef {
  mod: string | null;
  version: string | null;
  sha256: string;
}

export interface EnvxCandidate {
  /** Null for a library without fabric.mod.json: identified by sha256 and nested_in. */
  mod: string | null;
  version: string | null;
  sha256: string;
  file: string;
  /** False for a copy the server does not load (an older nested duplicate, a client-only library). */
  loaded: boolean;
  nested_in: EnvxJarRef[];
}

/** A declared mixin: the `mixin` block of a merged frame and each row of `mixins`. */
export interface EnvxDeclaredMixin {
  mod: string | null;
  version: string | null;
  sha256: string;
  /** Present on `mixins` rows. */
  nested_in?: EnvxJarRef[];
  mixin_class: string;
  config: string;
  kind: string;
  handler: string;
  target: string;
  at: string;
  priority: number;
  cancellable: boolean;
  side: string;
  /** From the current server's log; null for past snapshots (no log evidence). */
  failed: boolean | null;
}

/** envx never answers `exact`: it knows what the jars contain, not which bytes the JVM loaded. */
export type EnvxOwnerStatus = 'probable' | 'ambiguous' | 'none';

export interface EnvxOwner {
  /** Counts loaded candidates only: probable = one, ambiguous = several, none = zero. */
  status: EnvxOwnerStatus;
  candidates: EnvxCandidate[];
  class_found: boolean;
  /** Null when no method was sent. */
  member_found: boolean | null;
  yarn: { class: string | null; method: string | null; desc: string | null } | null;
  mixin: EnvxDeclaredMixin | null;
  hidden_lambda?: boolean;
}

/** A snapshot as answers refer to it. */
export interface EnvxSnapshotRef {
  id: number;
  env: string;
  fingerprint: string;
  modset: string | null;
}

export interface EnvxVersion {
  api: number;
  envx: string;
}

/**
 * The one wording of how sure an owner is, for every page. There is no
 * "exact": that needs the bytes the JVM loaded, which envx does not see.
 */
export function certaintyLabel(status: EnvxOwnerStatus): string {
  switch (status) {
    case 'probable':
      return 'Likely';
    case 'ambiguous':
      return 'Ambiguous';
    default:
      return 'Unknown';
  }
}

/** A released envx that serves this interface: 1.1.0 or later, not a pre-release. */
export function servesApi(version: EnvxVersion | undefined): boolean {
  if (version === undefined || version.api !== ENVX_API_VERSION) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.envx);
  if (m === null) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 1 || (major === 1 && minor >= 1);
}
