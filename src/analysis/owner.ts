/**
 * Which mod "owns" a piece of time, for the by-mod views.
 *
 * spark tags only some classes with the mod they came from, so most rows of
 * a capture have no source. Rather than calling that time "unattributed",
 * each row takes, in order:
 *   1. spark's own tag for that frame;
 *   2. the mod named in a mixin handler (handler$abc000$modid$method);
 *   3. "Minecraft" for Minecraft's own code;
 *   4. for a class with no tag, the mod spark tagged for another class in the
 *      same package in this capture;
 *   5. for library code (Java, fastutil, Guava...), whoever called it;
 *   6. otherwise the package's organisation, marked as a guess with "?".
 * Rows are in call order (a parent before its children), so one pass works.
 */

const LIBRARY =
  /^(java|javax|jdk|sun|com\.sun|kotlin|kotlinx|scala|it\.unimi|com\.google|org\.apache|org\.slf4j|io\.netty|org\.spongepowered|com\.llamalad7|org\.objectweb|net\.fabricmc\.loader|native|lib[\w-]*)\b|\.so(\.\d+)*\./;
const MINECRAFT = /^(net\.minecraft|com\.mojang)\./;

/**
 * A method Mixin generated inside another class: `<kind>$<hash>$<modid>$<name>`,
 * e.g. "net.minecraft.world.World.handler$cco000$blockswap$isIncompatibleBlock".
 * The one parser for these; everything that asks "is this mod code, and whose?"
 * of a frame uses it, so the answer cannot differ between pages.
 */
export interface MixinFrame {
  /** The class it lives in (the target), e.g. "net.minecraft.world.World". */
  cls: string;
  /** handler, redirect, wrapOperation, modifyArg... */
  kind: string;
  mod: string;
  /** The mod's own name for the method. */
  method: string;
  /** Wraps an existing call and passes it on (the work below is still the call's). */
  wraps: boolean;
}

const MIXIN_FRAME =
  /^(.*?)[.$](?:[A-Za-z]+\$)?(handler|redirect|wrapOperation|wrapMethod|inject|localvar|cancellable|modify[A-Za-z]*)\$[a-z0-9]+\$([A-Za-z0-9_.-]+?)\$(.+)$/;

export function parseMixin(frame: string): MixinFrame | undefined {
  const m = MIXIN_FRAME.exec(frame);
  if (m === null) return undefined;
  const kind = m[2]!;
  return { cls: m[1]!, kind, mod: m[3]!, method: m[4]!, wraps: kind === 'redirect' || kind === 'wrapOperation' || kind === 'wrapMethod' };
}
const TLD = new Set(['com', 'net', 'org', 'io', 'dev', 'me', 'de', 'fr', 'uk', 'ca', 'xyz', 'top', 'gg', 'co', 'nl', 'pl', 'ru', 'cn', 'eu', 'info', 'online', 'site', 'tk', 'ml', 'mod']);

export interface OwnedRow {
  path: string;
  /** The row's own frame, when known; saves taking the path apart. */
  label?: string;
  source: string | null;
  parentIndex: number;
}

/**
 * A hidden lambda class's per-run suffix ("Foo$$Lambda$36855.0x00007e2e..."),
 * which the JVM renumbers every start. The one definition: identity keys
 * group by it (ingest/identity.ts) and attribution ignores it here.
 */
const HIDDEN_CLASS_SUFFIX = /\$\$Lambda(?:\$\d+)?(?:[./]0x[0-9a-fA-F]+)?(?=\.|$)/;

/** "a.Foo$$Lambda$36855.0x00007e2e6c022cb0.apply" -> "a.Foo$$Lambda.apply"; anything else unchanged. */
export function withoutHiddenSuffix(name: string): string {
  return name.replace(HIDDEN_CLASS_SUFFIX, '$$$$Lambda');
}

function packageOf(frame: string): string {
  // "a.b.c.Class.method" -> "a.b.c". A lambda's run number would otherwise
  // split into extra "parts" and make the class look like a package.
  const parts = withoutHiddenSuffix(frame).split('.');
  return parts.slice(0, Math.max(1, parts.length - 2)).join('.');
}

function guessFromPackage(pkg: string): string {
  const parts = pkg.split('.');
  const org = TLD.has(parts[0] ?? '') ? parts[1] : parts[0];
  return `${org ?? pkg}?`;
}

/**
 * One step of attribution: the owner of a frame given its own tag and its
 * caller's owner. `tagged` maps a class's package (first three parts) to the
 * mod spark tagged elsewhere in it, when known.
 */
export function ownerStep(frame: string, source: string | null, parentOwner: string | undefined, tagged?: ReadonlyMap<string, string>): string {
  if (source !== null && source !== '') return source;
  const mixin = parseMixin(frame);
  if (mixin !== undefined) return mixin.mod;
  if (MINECRAFT.test(frame)) return 'Minecraft';
  if (LIBRARY.test(frame)) return parentOwner ?? 'Java';
  const pkg = packageOf(frame);
  return tagged?.get(pkg.split('.').slice(0, 3).join('.')) ?? guessFromPackage(pkg);
}

/** The owning mod of each row, in the same order. */
export function ownersOf(rows: readonly OwnedRow[]): string[] {
  const leaf = (path: string): string => {
    const cut = path.lastIndexOf(' > ');
    return cut === -1 ? path : path.slice(cut + 3);
  };
  // Package prefixes spark did tag, so untagged classes beside them follow.
  const tagged = new Map<string, string>();
  for (const row of rows) {
    if (row.source === null || row.source === '') continue;
    const pkg = packageOf(row.label ?? leaf(row.path)).split('.').slice(0, 3).join('.');
    if (!tagged.has(pkg)) tagged.set(pkg, row.source);
  }
  const owners: string[] = new Array(rows.length);
  rows.forEach((row, i) => {
    const frame = row.label ?? leaf(row.path);
    const parent = row.parentIndex >= 0 && row.parentIndex < i ? owners[row.parentIndex] : undefined;
    let owner: string;
    if (row.source !== null && row.source !== '') owner = row.source;
    else {
      const mixin = parseMixin(frame);
      if (mixin !== undefined) owner = mixin.mod;
      else if (MINECRAFT.test(frame)) owner = 'Minecraft';
      else if (LIBRARY.test(frame)) owner = parent ?? 'Java';
      else {
        const pkg = packageOf(frame);
        owner = tagged.get(pkg.split('.').slice(0, 3).join('.')) ?? guessFromPackage(pkg);
      }
    }
    owners[i] = owner;
  });
  return owners;
}

const NOT_MEANINGFUL = /\$\$Lambda|\.0x[0-9a-f]{6,}|\$Lambda\$|^native\.|lambda\$|\.access\$\d+$/;

/**
 * The nearest frame in a path a person can do something with: skipping
 * library code (Java collections, fastutil, Guava), lambdas and native
 * frames, which say *how* time was spent, not *whose* it was.
 * "HashMap.get" called from "BlockSwap.isIncompatibleBlock" is BlockSwap's.
 */
export function meaningfulFrame(path: string): string {
  const frames = path.split(' > ');
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const f = frames[i]!;
    if (!LIBRARY.test(f) && !NOT_MEANINGFUL.test(f)) return f;
  }
  return frames[frames.length - 1] ?? path;
}

/** "net.minecraft.world.World.handler$cco000$blockswap$isIncompatibleBlock" -> "World.isIncompatibleBlock (blockswap)" */
export function readableMethod(frame: string): string {
  const mixin = parseMixin(frame);
  if (mixin !== undefined) return `${mixin.cls.split('.').pop()}.${mixin.method} (added by ${mixin.mod})`;
  if (frame.startsWith('native.')) {
    const lib = /([A-Za-z0-9_+-]+)\.so\b/.exec(frame)?.[1] ?? frame.slice('native.'.length);
    return `native code (${lib.replace(/^lib/, '')})`;
  }
  const parts = frame.split('.');
  return parts.slice(-2).join('.');
}

export function isLibraryFrame(frame: string): boolean {
  return LIBRARY.test(frame) || NOT_MEANINGFUL.test(frame);
}

/** The owner of a path's last frame, walking it root-first when spark tagged only the leaf (or nothing). */
export function ownerOfPath(path: string, leafSource: string | null): string {
  const frames = path.split(' > ');
  let owner: string | undefined;
  frames.forEach((frame, i) => {
    owner = ownerStep(frame, i === frames.length - 1 ? leafSource : null, owner);
  });
  return owner ?? 'unknown';
}
