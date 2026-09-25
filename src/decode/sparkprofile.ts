/**
 * Decoder for spark's `.sparkprofile` format (protobuf `SamplerData`).
 *
 * Field numbers follow lucko/spark's `spark_sampler.proto` and `spark.proto`.
 * Unknown fields are skipped rather than rejected, so captures from older and
 * newer spark versions both decode -- important for an archive meant to
 * outlive many modpack rotations.
 *
 * Extends the existing `analyze_sparkprofile.mjs` with `SamplerMetadata.metrics`
 * (field 18): the ~10 s resolution series for TPS, tick duration, CPU, heap,
 * allocation rate, world info and player ping. That series is the cheapest
 * high-resolution telemetry available and is otherwise thrown away.
 */

import { gunzipSync } from 'node:zlib';
import { Reader, WireType, readStringMapEntry } from './reader.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SamplerMode = 'execution' | 'allocation';
export type SamplerEngine = 'java' | 'async';

export interface RollingAverage {
  mean?: number;
  max?: number;
  min?: number;
  median?: number;
  p95?: number;
}

export interface MemoryUsage {
  used?: number;
  committed?: number;
  init?: number;
  max?: number;
}

export interface WorldInfoSample {
  players?: number;
  entities?: number;
  tileEntities?: number;
  chunks?: number;
}

/** A time series with an absolute start and millisecond deltas between samples. */
export interface MetricSeries<T> {
  startTimestampMs: number;
  /** Absolute timestamps, already accumulated from the wire deltas. */
  timestampsMs: number[];
  values: T[];
}

export interface Metrics {
  tps?: MetricSeries<number>;
  tickDuration?: MetricSeries<RollingAverage>;
  cpuProcess?: MetricSeries<number>;
  cpuSystem?: MetricSeries<number>;
  heap?: MetricSeries<MemoryUsage>;
  nonHeap?: MetricSeries<MemoryUsage>;
  allocationRate?: MetricSeries<number>;
  worldInfo?: MetricSeries<WorldInfoSample>;
  playerPing?: MetricSeries<RollingAverage>;
}

export interface WindowStatistics {
  ticks?: number;
  cpuProcess?: number;
  cpuSystem?: number;
  tps?: number;
  msptMedian?: number;
  msptMax?: number;
  players?: number;
  entities?: number;
  tileEntities?: number;
  chunks?: number;
  startTime?: number;
  endTime?: number;
  duration?: number;
}

export interface ModMetadata {
  name?: string;
  version?: string;
  author?: string;
  description?: string;
  builtin?: boolean;
}

export interface PlatformMetadata {
  type?: number;
  name?: string;
  version?: string;
  minecraftVersion?: string;
  sparkVersion?: number;
  brand?: string;
}

export interface SystemStatistics {
  cpu?: { threads?: number; model?: string };
  os?: { arch?: string; name?: string; version?: string };
  java?: { vendor?: string; version?: string; vendorVersion?: string; vmArgs?: string };
  jvm?: { name?: string; vendor?: string; version?: string };
  physicalMemory?: { used?: number; total?: number };
  uptimeMs?: number;
}

export interface ThreadDumperInfo {
  type?: number;
  patterns: string[];
}

export interface DataAggregatorInfo {
  type?: number;
  threadGrouper?: number;
  tickLengthThreshold?: number;
  numberOfIncludedTicks?: number;
}

export interface SamplerMetadata {
  startTime?: number;
  endTime?: number;
  /** Sampling interval in microseconds. */
  intervalMicros?: number;
  comment?: string;
  numberOfTicks?: number;
  samplerMode?: SamplerMode;
  samplerEngine?: SamplerEngine;
  samplerEngineVersion?: string;
  threadDumper?: ThreadDumperInfo;
  dataAggregator?: DataAggregatorInfo;
  platform?: PlatformMetadata;
  system?: SystemStatistics;
  /** Mod/plugin id -> metadata. The basis for season fingerprinting. */
  sources: Map<string, ModMetadata>;
  serverConfigurations: Map<string, string>;
  extraPlatformMetadata: Map<string, string>;
  metrics?: Metrics;
}

/**
 * A node in the sampled call tree.
 *
 * spark emits a *flat pool* of nodes per thread; `childrenRefs` are indices
 * into that pool. Older captures instead nest `children` inline. Both shapes
 * occur in a long-lived archive, so both are supported.
 */
export interface StackNode {
  className?: string;
  methodName?: string;
  methodDesc?: string;
  parentLineNumber?: number;
  lineNumber?: number;
  /** Per-time-window durations in ms, parallel to `SparkProfile.timeWindows`. */
  times: number[];
  /**
   * Pre-windowing captures stored a single scalar duration here instead of
   * `times[]`. The field is reserved upstream now, but old archived captures
   * still carry it, so it is read for backwards compatibility.
   */
  legacyTime?: number;
  childrenRefs: number[];
  inlineChildren: StackNode[];
}

export interface ThreadNode {
  name?: string;
  times: number[];
  /** See `StackNode.legacyTime`. */
  legacyTime?: number;
  childrenRefs: number[];
  /** The flat node pool for this thread. */
  children: StackNode[];
}

export interface SparkProfile {
  metadata: SamplerMetadata;
  threads: ThreadNode[];
  classSources: Map<string, string>;
  methodSources: Map<string, string>;
  lineSources: Map<string, string>;
  /** Window ids, in capture order. Indexes into every `times[]` array. */
  timeWindows: number[];
  windowStatistics: Map<number, WindowStatistics>;
}

// ---------------------------------------------------------------------------
// Small field-set readers
// ---------------------------------------------------------------------------

type NumberFields = Record<number, string>;
type StringFields = Record<number, string>;

function readDoubleFields(buffer: Buffer, names: NumberFields): Record<string, number> {
  const reader = new Reader(buffer);
  const out: Record<string, number> = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    const name = names[field];
    if (name !== undefined && wire === WireType.Fixed64) out[name] = reader.double();
    else reader.skip(wire);
  }
  return out;
}

function readVarintFields(buffer: Buffer, names: NumberFields): Record<string, number> {
  const reader = new Reader(buffer);
  const out: Record<string, number> = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    const name = names[field];
    if (name !== undefined && wire === WireType.Varint) out[name] = reader.int();
    else reader.skip(wire);
  }
  return out;
}

function readStringFields(buffer: Buffer, names: StringFields): Record<string, string> {
  const reader = new Reader(buffer);
  const out: Record<string, string> = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    const name = names[field];
    if (name !== undefined && wire === WireType.LengthDelimited) out[name] = reader.string();
    else reader.skip(wire);
  }
  return out;
}

const readRollingAverage = (b: Buffer): RollingAverage =>
  readDoubleFields(b, { 1: 'mean', 2: 'max', 3: 'min', 4: 'median', 5: 'p95' });

const readMemoryUsage = (b: Buffer): MemoryUsage =>
  readVarintFields(b, { 1: 'used', 2: 'committed', 3: 'init', 4: 'max' });

const readWorldInfoSample = (b: Buffer): WorldInfoSample =>
  readVarintFields(b, { 1: 'players', 2: 'entities', 3: 'tileEntities', 4: 'chunks' });

// ---------------------------------------------------------------------------
// Metric series (SamplerMetadata.metrics, field 18)
// ---------------------------------------------------------------------------

/**
 * All four series shapes share a layout: an absolute start timestamp, packed
 * millisecond deltas, and repeated values. Deltas are accumulated here so
 * downstream code never has to know about the wire encoding.
 */
function readMetricSeries<T>(buffer: Buffer, readValues: (reader: Reader, wire: WireType) => T[]): MetricSeries<T> {
  const reader = new Reader(buffer);
  let startTimestampMs = 0;
  const deltas: number[] = [];
  const values: T[] = [];
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.Varint) startTimestampMs = reader.int();
    else if (field === 2) deltas.push(...reader.uint32s(wire));
    else if (field === 3) values.push(...readValues(reader, wire));
    else reader.skip(wire);
  }

  const timestampsMs: number[] = [];
  let cursor = startTimestampMs;
  for (let i = 0; i < values.length; i += 1) {
    cursor += deltas[i] ?? 0;
    timestampsMs.push(cursor);
  }
  return { startTimestampMs, timestampsMs, values };
}

const doubleValues = (reader: Reader, wire: WireType): number[] => reader.doubles(wire);

function messageValues<T>(read: (b: Buffer) => T): (reader: Reader, wire: WireType) => T[] {
  return (reader, wire) => {
    if (wire !== WireType.LengthDelimited) {
      reader.skip(wire);
      return [];
    }
    return [read(reader.bytes())];
  };
}

function readMetrics(buffer: Buffer): Metrics {
  const reader = new Reader(buffer);
  const out: Metrics = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (wire !== WireType.LengthDelimited) {
      reader.skip(wire);
      continue;
    }
    const payload = reader.bytes();
    if (field === 1) out.tps = readMetricSeries(payload, doubleValues);
    else if (field === 2) out.tickDuration = readMetricSeries(payload, messageValues(readRollingAverage));
    else if (field === 3) out.cpuProcess = readMetricSeries(payload, doubleValues);
    else if (field === 4) out.cpuSystem = readMetricSeries(payload, doubleValues);
    else if (field === 5) out.heap = readMetricSeries(payload, messageValues(readMemoryUsage));
    else if (field === 6) out.nonHeap = readMetricSeries(payload, messageValues(readMemoryUsage));
    else if (field === 7) out.allocationRate = readMetricSeries(payload, doubleValues);
    else if (field === 8) out.worldInfo = readMetricSeries(payload, messageValues(readWorldInfoSample));
    else if (field === 9) out.playerPing = readMetricSeries(payload, messageValues(readRollingAverage));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function readSystemStatistics(buffer: Buffer): SystemStatistics {
  const reader = new Reader(buffer);
  const out: SystemStatistics = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.LengthDelimited) {
      const cpu = new Reader(reader.bytes());
      const parsed: { threads?: number; model?: string } = {};
      while (!cpu.eof) {
        const tag = cpu.tag();
        if (tag.field === 1 && tag.wire === WireType.Varint) parsed.threads = cpu.int();
        else if (tag.field === 4 && tag.wire === WireType.LengthDelimited) parsed.model = cpu.string();
        else cpu.skip(tag.wire);
      }
      out.cpu = parsed;
    } else if (field === 2 && wire === WireType.LengthDelimited) {
      const mem = new Reader(reader.bytes());
      while (!mem.eof) {
        const tag = mem.tag();
        if (tag.field === 1 && tag.wire === WireType.LengthDelimited) {
          out.physicalMemory = readVarintFields(mem.bytes(), { 1: 'used', 2: 'total' });
        } else mem.skip(tag.wire);
      }
    } else if (field === 5 && wire === WireType.LengthDelimited) {
      out.os = readStringFields(reader.bytes(), { 1: 'arch', 2: 'name', 3: 'version' });
    } else if (field === 6 && wire === WireType.LengthDelimited) {
      out.java = readStringFields(reader.bytes(), { 1: 'vendor', 2: 'version', 3: 'vendorVersion', 4: 'vmArgs' });
    } else if (field === 7 && wire === WireType.Varint) {
      out.uptimeMs = reader.int();
    } else if (field === 9 && wire === WireType.LengthDelimited) {
      out.jvm = readStringFields(reader.bytes(), { 1: 'name', 2: 'vendor', 3: 'version' });
    } else reader.skip(wire);
  }
  return out;
}

function readPlatformMetadata(buffer: Buffer): PlatformMetadata {
  const reader = new Reader(buffer);
  const out: PlatformMetadata = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.Varint) out.type = reader.int();
    else if (field === 2 && wire === WireType.LengthDelimited) out.name = reader.string();
    else if (field === 3 && wire === WireType.LengthDelimited) out.version = reader.string();
    else if (field === 4 && wire === WireType.LengthDelimited) out.minecraftVersion = reader.string();
    else if (field === 7 && wire === WireType.Varint) out.sparkVersion = reader.int();
    else if (field === 8 && wire === WireType.LengthDelimited) out.brand = reader.string();
    else reader.skip(wire);
  }
  return out;
}

function readModMetadata(buffer: Buffer): ModMetadata {
  const reader = new Reader(buffer);
  const out: ModMetadata = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.LengthDelimited) out.name = reader.string();
    else if (field === 2 && wire === WireType.LengthDelimited) out.version = reader.string();
    else if (field === 3 && wire === WireType.LengthDelimited) out.author = reader.string();
    else if (field === 4 && wire === WireType.LengthDelimited) out.description = reader.string();
    else if (field === 5 && wire === WireType.Varint) out.builtin = reader.int() !== 0;
    else reader.skip(wire);
  }
  return out;
}

/** Reads a `map<string, PluginOrModMetadata>` entry. */
function readModMapEntry(buffer: Buffer): [string, ModMetadata] {
  const reader = new Reader(buffer);
  let key = '';
  let value: ModMetadata = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.LengthDelimited) key = reader.string();
    else if (field === 2 && wire === WireType.LengthDelimited) value = readModMetadata(reader.bytes());
    else reader.skip(wire);
  }
  return [key, value];
}

/** Reads a `map<int32, WindowStatistics>` entry. Returns -1 when the key is absent. */
function readWindowMapEntry(buffer: Buffer): [number, WindowStatistics] {
  const reader = new Reader(buffer);
  let key = -1;
  let value: WindowStatistics = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.Varint) key = reader.int32();
    else if (field === 2 && wire === WireType.LengthDelimited) value = readWindowStatistics(reader.bytes());
    else reader.skip(wire);
  }
  return [key, value];
}

function readThreadDumper(buffer: Buffer): ThreadDumperInfo {
  const reader = new Reader(buffer);
  const out: ThreadDumperInfo = { patterns: [] };
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.Varint) out.type = reader.int();
    else if (field === 3 && wire === WireType.LengthDelimited) out.patterns.push(reader.string());
    else reader.skip(wire);
  }
  return out;
}

function readDataAggregator(buffer: Buffer): DataAggregatorInfo {
  const reader = new Reader(buffer);
  const out: DataAggregatorInfo = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.Varint) out.type = reader.int();
    else if (field === 2 && wire === WireType.Varint) out.threadGrouper = reader.int();
    else if (field === 3 && wire === WireType.Varint) out.tickLengthThreshold = reader.int();
    else if (field === 4 && wire === WireType.Varint) out.numberOfIncludedTicks = reader.int32();
    else reader.skip(wire);
  }
  return out;
}

function readSamplerMetadata(buffer: Buffer): SamplerMetadata {
  const reader = new Reader(buffer);
  const out: SamplerMetadata = {
    sources: new Map(),
    serverConfigurations: new Map(),
    extraPlatformMetadata: new Map(),
  };
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 2 && wire === WireType.Varint) out.startTime = reader.int();
    else if (field === 3 && wire === WireType.Varint) out.intervalMicros = reader.int32();
    else if (field === 4 && wire === WireType.LengthDelimited) out.threadDumper = readThreadDumper(reader.bytes());
    else if (field === 5 && wire === WireType.LengthDelimited) out.dataAggregator = readDataAggregator(reader.bytes());
    else if (field === 6 && wire === WireType.LengthDelimited) out.comment = reader.string();
    else if (field === 7 && wire === WireType.LengthDelimited) out.platform = readPlatformMetadata(reader.bytes());
    else if (field === 9 && wire === WireType.LengthDelimited) out.system = readSystemStatistics(reader.bytes());
    else if (field === 10 && wire === WireType.LengthDelimited) {
      const [key, value] = readStringMapEntry(reader.bytes());
      out.serverConfigurations.set(key, value);
    } else if (field === 11 && wire === WireType.Varint) out.endTime = reader.int();
    else if (field === 12 && wire === WireType.Varint) out.numberOfTicks = reader.int32();
    else if (field === 13 && wire === WireType.LengthDelimited) {
      const [key, value] = readModMapEntry(reader.bytes());
      if (key !== '') out.sources.set(key, value);
    } else if (field === 14 && wire === WireType.LengthDelimited) {
      const [key, value] = readStringMapEntry(reader.bytes());
      out.extraPlatformMetadata.set(key, value);
    } else if (field === 15 && wire === WireType.Varint) {
      out.samplerMode = reader.int() === 1 ? 'allocation' : 'execution';
    } else if (field === 16 && wire === WireType.Varint) {
      out.samplerEngine = reader.int() === 1 ? 'async' : 'java';
    } else if (field === 17 && wire === WireType.LengthDelimited) {
      out.samplerEngineVersion = reader.string();
    } else if (field === 18 && wire === WireType.LengthDelimited) {
      out.metrics = readMetrics(reader.bytes());
    } else reader.skip(wire);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Call tree
// ---------------------------------------------------------------------------

function readStackNode(buffer: Buffer): StackNode {
  const reader = new Reader(buffer);
  const out: StackNode = { times: [], childrenRefs: [], inlineChildren: [] };
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.Fixed64) out.legacyTime = reader.double();
    else if (field === 2 && wire === WireType.LengthDelimited) out.inlineChildren.push(readStackNode(reader.bytes()));
    else if (field === 3 && wire === WireType.LengthDelimited) out.className = reader.string();
    else if (field === 4 && wire === WireType.LengthDelimited) out.methodName = reader.string();
    else if (field === 5 && wire === WireType.Varint) out.parentLineNumber = reader.int32();
    else if (field === 6 && wire === WireType.Varint) out.lineNumber = reader.int32();
    else if (field === 7 && wire === WireType.LengthDelimited) out.methodDesc = reader.string();
    else if (field === 8) out.times.push(...reader.doubles(wire));
    else if (field === 9) out.childrenRefs.push(...reader.int32s(wire));
    else reader.skip(wire);
  }
  return out;
}

function readThreadNode(buffer: Buffer): ThreadNode {
  const reader = new Reader(buffer);
  const out: ThreadNode = { times: [], childrenRefs: [], children: [] };
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.LengthDelimited) out.name = reader.string();
    else if (field === 2 && wire === WireType.Fixed64) out.legacyTime = reader.double();
    else if (field === 3 && wire === WireType.LengthDelimited) out.children.push(readStackNode(reader.bytes()));
    else if (field === 4) out.times.push(...reader.doubles(wire));
    else if (field === 5) out.childrenRefs.push(...reader.int32s(wire));
    else reader.skip(wire);
  }
  return out;
}

function readWindowStatistics(buffer: Buffer): WindowStatistics {
  const reader = new Reader(buffer);
  const out: WindowStatistics = {};
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (wire === WireType.Fixed64) {
      if (field === 2) out.cpuProcess = reader.double();
      else if (field === 3) out.cpuSystem = reader.double();
      else if (field === 4) out.tps = reader.double();
      else if (field === 5) out.msptMedian = reader.double();
      else if (field === 6) out.msptMax = reader.double();
      else reader.skip(wire);
    } else if (wire === WireType.Varint) {
      if (field === 1) out.ticks = reader.int32();
      else if (field === 7) out.players = reader.int32();
      else if (field === 8) out.entities = reader.int32();
      else if (field === 9) out.tileEntities = reader.int32();
      else if (field === 10) out.chunks = reader.int32();
      else if (field === 11) out.startTime = reader.int();
      else if (field === 12) out.endTime = reader.int();
      else if (field === 13) out.duration = reader.int32();
      else reader.skip(wire);
    } else reader.skip(wire);
  }
  // Protobuf leaves a count of zero out of the message altogether, so a
  // missing count in a window spark did write means zero: nobody online, not
  // "unknown". Reading it as unknown hid every idle minute.
  out.players ??= 0;
  out.entities ??= 0;
  out.tileEntities ??= 0;
  out.chunks ??= 0;
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const GZIP_MAGIC = 0x1f8b;

/** Decodes a `.sparkprofile`. Accepts raw protobuf or gzipped protobuf. */
export function decodeSparkProfile(input: Buffer): SparkProfile {
  const buffer = input.length >= 2 && input.readUInt16BE(0) === GZIP_MAGIC ? gunzipSync(input) : input;

  const reader = new Reader(buffer);
  const profile: SparkProfile = {
    metadata: { sources: new Map(), serverConfigurations: new Map(), extraPlatformMetadata: new Map() },
    threads: [],
    classSources: new Map(),
    methodSources: new Map(),
    lineSources: new Map(),
    timeWindows: [],
    windowStatistics: new Map(),
  };

  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === WireType.LengthDelimited) {
      profile.metadata = readSamplerMetadata(reader.bytes());
    } else if (field === 2 && wire === WireType.LengthDelimited) {
      profile.threads.push(readThreadNode(reader.bytes()));
    } else if (field === 3 && wire === WireType.LengthDelimited) {
      const [key, value] = readStringMapEntry(reader.bytes());
      profile.classSources.set(key, value);
    } else if (field === 4 && wire === WireType.LengthDelimited) {
      const [key, value] = readStringMapEntry(reader.bytes());
      profile.methodSources.set(key, value);
    } else if (field === 5 && wire === WireType.LengthDelimited) {
      const [key, value] = readStringMapEntry(reader.bytes());
      profile.lineSources.set(key, value);
    } else if (field === 6) {
      profile.timeWindows.push(...reader.int32s(wire));
    } else if (field === 7 && wire === WireType.LengthDelimited) {
      const [key, value] = readWindowMapEntry(reader.bytes());
      if (key !== -1) profile.windowStatistics.set(key, value);
    } else reader.skip(wire);
  }

  return profile;
}
