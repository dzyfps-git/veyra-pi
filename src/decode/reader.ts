/**
 * Minimal protobuf wire-format reader.
 *
 * Dependency-free and schema-less: we decode spark's messages by field number
 * directly. That is deliberate. spark's schema evolves (fields have been
 * reserved and replaced over time), and a hand-rolled reader that skips
 * unknown fields keeps decoding old captures long after the upstream schema
 * has moved on -- which matters when the archive is meant to outlive several
 * modpack rotations.
 *
 * Adapted from the reader in the existing `analyze_sparkprofile.mjs`, which
 * has been validated against a real capture archive.
 */

export const WireType = {
  Varint: 0,
  Fixed64: 1,
  LengthDelimited: 2,
  Fixed32: 5,
} as const;

export type WireType = (typeof WireType)[keyof typeof WireType];

export interface Tag {
  field: number;
  wire: WireType;
}

export class ProtoReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtoReadError';
  }
}

export class Reader {
  readonly buffer: Buffer;
  pos = 0;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get eof(): boolean {
    return this.pos >= this.buffer.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buffer.length) throw new ProtoReadError('unexpected EOF in varint');
      const byte = this.buffer[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new ProtoReadError('varint too long');
    }
  }

  /** Varint as a JS number. Safe for every field spark uses (timestamps, byte counts). */
  int(): number {
    return Number(this.varint());
  }

  /** Two's-complement 32-bit interpretation, for proto int32 fields. */
  int32(): number {
    const n = Number(this.varint() & 0xffffffffn);
    return n > 0x7fffffff ? n - 0x100000000 : n;
  }

  tag(): Tag {
    const tag = Number(this.varint());
    return { field: tag >>> 3, wire: (tag & 7) as WireType };
  }

  bytes(): Buffer {
    const length = Number(this.varint());
    const end = this.pos + length;
    if (end > this.buffer.length) throw new ProtoReadError('length-delimited field exceeds input');
    const value = this.buffer.subarray(this.pos, end);
    this.pos = end;
    return value;
  }

  string(): string {
    return this.bytes().toString('utf8');
  }

  double(): number {
    if (this.pos + 8 > this.buffer.length) throw new ProtoReadError('unexpected EOF in double');
    const value = this.buffer.readDoubleLE(this.pos);
    this.pos += 8;
    return value;
  }

  /** Reads a repeated double, packed or unpacked. */
  doubles(wire: WireType): number[] {
    if (wire === WireType.Fixed64) return [this.double()];
    if (wire !== WireType.LengthDelimited) throw new ProtoReadError(`bad wire type ${wire} for repeated double`);
    const packed = new Reader(this.bytes());
    const values: number[] = [];
    while (!packed.eof) values.push(packed.double());
    return values;
  }

  /** Reads a repeated int32, packed or unpacked. */
  int32s(wire: WireType): number[] {
    if (wire === WireType.Varint) return [this.int32()];
    if (wire !== WireType.LengthDelimited) throw new ProtoReadError(`bad wire type ${wire} for repeated int32`);
    const packed = new Reader(this.bytes());
    const values: number[] = [];
    while (!packed.eof) values.push(packed.int32());
    return values;
  }

  /** Reads a repeated uint32, packed or unpacked. */
  uint32s(wire: WireType): number[] {
    if (wire === WireType.Varint) return [this.int()];
    if (wire !== WireType.LengthDelimited) throw new ProtoReadError(`bad wire type ${wire} for repeated uint32`);
    const packed = new Reader(this.bytes());
    const values: number[] = [];
    while (!packed.eof) values.push(packed.int());
    return values;
  }

  skip(wire: WireType): void {
    switch (wire) {
      case WireType.Varint:
        this.varint();
        break;
      case WireType.Fixed64:
        this.pos += 8;
        break;
      case WireType.LengthDelimited: {
        // Read the length into a local first. `this.pos += this.varint()`
        // evaluates the left-hand side before varint() advances pos, which
        // lands mid-field whenever the length itself is multi-byte.
        const length = Number(this.varint());
        this.pos += length;
        break;
      }
      case WireType.Fixed32:
        this.pos += 4;
        break;
      default:
        throw new ProtoReadError(`unsupported wire type ${wire}`);
    }
    if (this.pos > this.buffer.length) throw new ProtoReadError('field exceeds input');
  }
}

/** Reads a protobuf `map<string, string>` entry. */
export function readStringMapEntry(buffer: Buffer): [string, string] {
  const reader = new Reader(buffer);
  let key = '';
  let value = '';
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.LengthDelimited) key = reader.string();
    else if (field === 2 && wire === WireType.LengthDelimited) value = reader.string();
    else reader.skip(wire);
  }
  return [key, value];
}

/** Reads a protobuf `map<K, Message>` entry with a caller-supplied value parser. */
export function readMessageMapEntry<K extends string | number, V>(
  buffer: Buffer,
  readKey: (reader: Reader, wire: WireType) => K,
  readValue: (buffer: Buffer) => V,
  emptyKey: K,
  emptyValue: V,
): [K, V] {
  const reader = new Reader(buffer);
  let key = emptyKey;
  let value = emptyValue;
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1) key = readKey(reader, wire);
    else if (field === 2 && wire === WireType.LengthDelimited) value = readValue(reader.bytes());
    else reader.skip(wire);
  }
  return [key, value];
}
