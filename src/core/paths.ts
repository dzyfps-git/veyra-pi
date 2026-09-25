/**
 * Path containment guard.
 *
 * This is the module that makes `writeScope` a structural property rather than
 * a convention. Every write and every unlink performed against a monitored
 * Minecraft server goes through `ServerFileGuard`. If it is not reachable from
 * here, it cannot happen.
 *
 * Threat model (in rough order of likelihood):
 *   - a bug builds a path by string concatenation and escapes the spark dir
 *   - a config typo points `sparkDir` somewhere dangerous
 *   - a filename from an untrusted source contains `..` or an absolute path
 *   - a symlink inside the spark dir points at the world or mods directory
 *
 * The guard is deliberately paranoid and deliberately boring.
 */

import { realpathSync, lstatSync } from 'node:fs';
import * as path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

export class PathGuardError extends Error {
  readonly attempted: string;
  readonly reason: string;

  constructor(attempted: string, reason: string) {
    super(`refused path "${attempted}": ${reason}`);
    this.name = 'PathGuardError';
    this.attempted = attempted;
    this.reason = reason;
  }
}

/** Normalise for comparison. Windows filesystems are case-insensitive. */
function comparable(p: string): string {
  const normalised = path.resolve(p);
  return IS_WINDOWS ? normalised.toLowerCase() : normalised;
}

/**
 * True when `child` is the same as, or nested inside, `parent`.
 *
 * Uses path.relative rather than string prefixing, so `/a/bc` is correctly
 * rejected against a parent of `/a/b`.
 */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(comparable(parent), comparable(child));
  if (rel === '') return true; // identical
  if (rel.startsWith('..')) return false; // escapes upward
  if (path.isAbsolute(rel)) return false; // different root/drive
  return true;
}

export interface ServerFileGuardOptions {
  /** Server root, e.g. "S:/". */
  root: string;
  /** Paths (relative to root) that may ever be written to or deleted within. */
  writeScope: readonly string[];
  /** Filenames inside writeScope that perfint is allowed to manage. */
  managedFilePattern: RegExp;
}

export class ServerFileGuard {
  readonly root: string;
  /** Absolute, resolved write-scope roots. Empty means strictly read-only. */
  readonly writeScope: readonly string[];
  readonly managedFilePattern: RegExp;

  constructor(options: ServerFileGuardOptions) {
    this.root = path.resolve(options.root);
    this.writeScope = options.writeScope.map((entry) => {
      if (path.isAbsolute(entry)) {
        throw new PathGuardError(entry, 'writeScope entries must be relative to the server root');
      }
      const resolved = path.resolve(this.root, entry);
      if (!isWithin(this.root, resolved)) {
        throw new PathGuardError(entry, 'writeScope entry escapes the server root');
      }
      return resolved;
    });
    this.managedFilePattern = options.managedFilePattern;
  }

  /** True when this server is configured as strictly read-only. */
  get isReadOnly(): boolean {
    return this.writeScope.length === 0;
  }

  /**
   * Resolve a path that is only going to be read.
   *
   * Reads are still constrained to the server root, so a bad config cannot
   * make perfint wander the host filesystem.
   */
  resolveForRead(relativeOrAbsolute: string): string {
    const resolved = path.resolve(this.root, relativeOrAbsolute);
    if (!isWithin(this.root, resolved)) {
      throw new PathGuardError(relativeOrAbsolute, 'resolves outside the server root');
    }
    return resolved;
  }

  /**
   * Resolve a path that is going to be written to or deleted, applying every
   * containment check.
   *
   * `mustExist` is true for deletions: we resolve symlinks via realpath so a
   * link planted inside the spark directory cannot redirect us at the world
   * folder. For creations the file does not exist yet, so we validate the
   * parent directory instead.
   */
  resolveForWrite(relativeOrAbsolute: string, opts: { mustExist: boolean }): string {
    if (this.isReadOnly) {
      throw new PathGuardError(relativeOrAbsolute, 'this server is configured read-only (empty writeScope)');
    }

    const resolved = path.resolve(this.root, relativeOrAbsolute);

    // Check the lexical path first. This catches `..` traversal before we
    // touch the filesystem at all.
    if (!this.#inAnyScope(resolved)) {
      throw new PathGuardError(relativeOrAbsolute, 'resolves outside every configured writeScope');
    }

    if (opts.mustExist) {
      // Refuse symlinks outright rather than following them.
      let stat;
      try {
        stat = lstatSync(resolved);
      } catch {
        throw new PathGuardError(relativeOrAbsolute, 'does not exist');
      }
      if (stat.isSymbolicLink()) {
        throw new PathGuardError(relativeOrAbsolute, 'is a symbolic link');
      }
      if (!stat.isFile()) {
        throw new PathGuardError(relativeOrAbsolute, 'is not a regular file');
      }

      // Re-check after resolving the real path, in case a *parent* component
      // is a symlink pointing out of scope.
      const real = realpathSync(resolved);
      if (!this.#inAnyScope(real)) {
        throw new PathGuardError(relativeOrAbsolute, 'real path escapes writeScope (symlinked parent)');
      }
      return real;
    }

    return resolved;
  }

  /**
   * Full check for a file perfint intends to delete.
   *
   * On top of containment, the filename itself must match the managed
   * pattern. Anything perfint did not create is reported, never removed.
   */
  resolveForDelete(relativeOrAbsolute: string): string {
    const resolved = this.resolveForWrite(relativeOrAbsolute, { mustExist: true });
    const base = path.basename(resolved);
    if (!this.managedFilePattern.test(base)) {
      throw new PathGuardError(relativeOrAbsolute, `filename does not match the managed pattern ${this.managedFilePattern}`);
    }
    return resolved;
  }

  #inAnyScope(absolute: string): boolean {
    return this.writeScope.some((scope) => isWithin(scope, absolute));
  }
}
