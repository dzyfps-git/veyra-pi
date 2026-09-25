/**
 * A minimal NBT reader, for one purpose: identifying a world.
 *
 * `level.dat` is the only place that holds a world's seed, and the seed is
 * the only thing that distinguishes "the same modpack, a brand new world"
 * from "the same world, later". spark's metadata cannot tell them apart --
 * `level-name` stays "world" across a reset and `level-seed` is blank in
 * server.properties once the world exists -- so without reading this file the
 * system would silently pool a fresh world's measurements with the old
 * world's, which is exactly the kind of misleading comparison it exists to
 * prevent.
 *
 * Scope is deliberately narrow:
 *
 *   - Reads only. Nothing here can write, and the file is opened through the
 *     read guard like any other server file.
 *   - Parses the whole tree but refuses anything implausible: a depth limit,
 *     an array-length limit and a total-size limit, so a corrupt or hostile
 *     file cannot exhaust memory. `level.dat` is normally a couple of
 *     megabytes decompressed.
 *   - No writer, no round-trip, no general NBT library. If this file ever
 *     needs to do more than answer "which world is this?", that is a sign it
 *     should be a real dependency instead.
 */

import { gunzipSync } from 'node:zlib';

export const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;

export type NbtValue =
  | number
  | bigint
  | string
  | Uint8Array
  | number[]
  | bigint[]
  | NbtValue[]
  | NbtCompound;

export interface NbtCompound {
  [key: string]: NbtValue;
}

export class NbtError extends Error {
  constructor(message: string) {
    super(`NBT: ${message}`);
    this.name = 'NbtError';
  }
}

const MAX_DEPTH = 64;
const MAX_ARRAY = 8_000_000;
const MAX_DECOMPRESSED = 64 * 1024 * 1024;

class Reader {
  #buf: Buffer;
  #pos = 0;

  constructor(buf: Buffer) {
    this.#buf = buf;
  }

  #need(bytes: number): void {
    if (this.#pos + bytes > this.#buf.length) {
      throw new NbtError(`truncated: wanted ${bytes} bytes at ${this.#pos} of ${this.#buf.length}`);
    }
  }

  byte(): number {
    this.#need(1);
    return this.#buf.readInt8(this.#pos++);
  }

  short(): number {
    this.#need(2);
    const v = this.#buf.readInt16BE(this.#pos);
    this.#pos += 2;
    return v;
  }

  ushort(): number {
    this.#need(2);
    const v = this.#buf.readUInt16BE(this.#pos);
    this.#pos += 2;
    return v;
  }

  int(): number {
    this.#need(4);
    const v = this.#buf.readInt32BE(this.#pos);
    this.#pos += 4;
    return v;
  }

  long(): bigint {
    this.#need(8);
    const v = this.#buf.readBigInt64BE(this.#pos);
    this.#pos += 8;
    return v;
  }

  float(): number {
    this.#need(4);
    const v = this.#buf.readFloatBE(this.#pos);
    this.#pos += 4;
    return v;
  }

  double(): number {
    this.#need(8);
    const v = this.#buf.readDoubleBE(this.#pos);
    this.#pos += 8;
    return v;
  }

  string(): string {
    const length = this.ushort();
    this.#need(length);
    // Modified UTF-8 differs from UTF-8 only for NUL and supplementary
    // characters, neither of which appears in the keys this reader cares
    // about. Decoding as UTF-8 is correct for every realistic level.dat.
    const value = this.#buf.toString('utf8', this.#pos, this.#pos + length);
    this.#pos += length;
    return value;
  }

  bytes(length: number): Uint8Array {
    this.#need(length);
    const slice = this.#buf.subarray(this.#pos, this.#pos + length);
    this.#pos += length;
    return new Uint8Array(slice);
  }

  get done(): boolean {
    return this.#pos >= this.#buf.length;
  }
}

function checkLength(length: number, what: string): void {
  if (length < 0 || length > MAX_ARRAY) throw new NbtError(`implausible ${what} length ${length}`);
}

function readPayload(r: Reader, type: number, depth: number): NbtValue {
  if (depth > MAX_DEPTH) throw new NbtError(`nesting deeper than ${MAX_DEPTH}`);

  switch (type) {
    case TAG.Byte:
      return r.byte();
    case TAG.Short:
      return r.short();
    case TAG.Int:
      return r.int();
    case TAG.Long:
      return r.long();
    case TAG.Float:
      return r.float();
    case TAG.Double:
      return r.double();
    case TAG.String:
      return r.string();

    case TAG.ByteArray: {
      const length = r.int();
      checkLength(length, 'byte array');
      return r.bytes(length);
    }

    case TAG.IntArray: {
      const length = r.int();
      checkLength(length, 'int array');
      const out = new Array<number>(length);
      for (let i = 0; i < length; i += 1) out[i] = r.int();
      return out;
    }

    case TAG.LongArray: {
      const length = r.int();
      checkLength(length, 'long array');
      const out = new Array<bigint>(length);
      for (let i = 0; i < length; i += 1) out[i] = r.long();
      return out;
    }

    case TAG.List: {
      const itemType = r.byte();
      const length = r.int();
      checkLength(length, 'list');
      const out: NbtValue[] = [];
      // A zero-length list may declare TAG_End as its type; that is legal.
      if (itemType === TAG.End) {
        if (length !== 0) throw new NbtError('non-empty list of TAG_End');
        return out;
      }
      for (let i = 0; i < length; i += 1) out.push(readPayload(r, itemType, depth + 1));
      return out;
    }

    case TAG.Compound: {
      const out: NbtCompound = {};
      for (;;) {
        const childType = r.byte();
        if (childType === TAG.End) return out;
        const name = r.string();
        out[name] = readPayload(r, childType, depth + 1);
      }
    }

    default:
      throw new NbtError(`unknown tag type ${type}`);
  }
}

export interface NbtRoot {
  name: string;
  value: NbtCompound;
}

/** Parse uncompressed NBT. */
export function parseNbt(buffer: Buffer): NbtRoot {
  const r = new Reader(buffer);
  const type = r.byte();
  if (type !== TAG.Compound) throw new NbtError(`root tag is ${type}, expected a compound`);
  const name = r.string();
  const value = readPayload(r, TAG.Compound, 0);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NbtError('root compound did not parse to a compound');
  }
  return { name, value: value as NbtCompound };
}

/**
 * Parse NBT that may be gzip-compressed.
 *
 * `level.dat` is gzipped in every Minecraft version this targets, but an
 * uncompressed file is accepted too rather than failing on a detail that
 * does not matter.
 */
export function parseMaybeGzippedNbt(buffer: Buffer): NbtRoot {
  const gzipped = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (!gzipped) return parseNbt(buffer);

  const inflated = gunzipSync(buffer, { maxOutputLength: MAX_DECOMPRESSED });
  return parseNbt(inflated);
}

/** Walk a path of compound keys, returning undefined rather than throwing. */
export function nbtPath(root: NbtCompound, ...keys: readonly string[]): NbtValue | undefined {
  let current: NbtValue | undefined = root;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || current instanceof Uint8Array) {
      return undefined;
    }
    current = (current as NbtCompound)[key];
    if (current === undefined) return undefined;
  }
  return current;
}
