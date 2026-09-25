/**
 * The envx machine interface, version 1 (envx's docs/api.md), as types.
 *
 * envx is an optional, separate tool that indexes the server's mods: which jar
 * defines a class, which mixins target a method, what changed between two
 * states of the pack. This app only ASKS it, one way; nothing measured here is
 * ever sent to it, and it stores nothing we send.
 *
 * Written against the draft contract for envx 1.1. Everything here mirrors
 * that document; where an answer does not match it, the client reports a
 * mismatch (client.ts) rather than guessing -- the fix belongs in whichever
 * side is wrong, not in a workaround here.
 */

export const ENVX_API_VERSION = 1;

/**
 * Whether envx answers are shown as findings. Off until envx 1.1 is installed
 * and a real batch has been checked against the contract: until then the only
 * answers are a stub's canned ones, which must never read as real attributions.
 */
export const ENVX_ANSWERS_LIVE = false;

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
      closest?: { snapshot: number; missing: Array<[string, string]>; extra: Array<[string, string]> } | null;
    };

export interface EnvxCandidate {
  mod: string;
  version: string;
  sha256: string;
  file: string;
  loaded: boolean;
  nested_in: string[];
}

export interface EnvxMixinRef {
  mod: string;
  version: string;
  sha256: string;
  mixin_class: string;
  kind: string;
  handler: string;
  target: string;
}

/** envx never answers `exact`: it knows what the jars contain, not which bytes the JVM loaded. */
export type EnvxOwnerStatus = 'probable' | 'ambiguous' | 'none';

export interface EnvxOwner {
  status: EnvxOwnerStatus;
  candidates: EnvxCandidate[];
  class_found: boolean;
  member_found: boolean;
  yarn: { class: string; method?: string; desc?: string } | null;
  mixin: EnvxMixinRef | null;
  hidden_lambda?: boolean;
}

export interface EnvxDeclaredMixin {
  mod: string;
  version: string;
  sha256: string;
  mixin_class: string;
  kind: string;
  handler: string;
  at: string;
  priority: number;
  cancellable: boolean;
  side: string;
  failed: boolean;
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
