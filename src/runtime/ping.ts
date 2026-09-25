/**
 * Minecraft Server List Ping.
 *
 * Determining whether a server is actually running turned out to be the
 * subtle part of the link layer. The first attempt used the freshness of
 * `latest.log`, which is wrong: an idle server with no players can stay
 * silent for hours, so a quiet-but-healthy server would be classified as
 * stopped -- and collection would switch off during exactly the low-load
 * baseline periods that are most worth recording.
 *
 * Server List Ping is the protocol every server browser uses. Properties that
 * make it the right probe here:
 *
 *   - It is definitive. A response means the server is accepting connections.
 *   - It is handled on netty I/O threads, not the game thread, so it does not
 *     consume tick budget.
 *   - Vanilla logs nothing for it.
 *   - It returns the player count, which is useful context for free.
 *
 * Read-only: no login, no authentication, no state change on the server.
 */

import { connect } from 'node:net';

export interface PingResult {
  online: boolean;
  latencyMs: number;
  versionName?: string;
  protocol?: number;
  playersOnline?: number;
  playersMax?: number;
  error?: string;
}

/** Protobuf-style varint, as used by the Minecraft protocol. */
function writeVarInt(value: number): Buffer {
  const out: number[] = [];
  let v = value >>> 0;
  for (;;) {
    if ((v & ~0x7f) === 0) {
      out.push(v);
      break;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(out);
}

function readVarInt(buffer: Buffer, offset: number): { value: number; size: number } | undefined {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buffer.length) return undefined; // Need more bytes.
    const byte = buffer[offset + size]!;
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size > 5) return undefined;
  }
  return { value, size };
}

function writeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** Wrap a payload in the protocol's [length][payload] framing. */
function packet(...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([writeVarInt(body.length), body]);
}

export interface PingOptions {
  host: string;
  port: number;
  timeoutMs?: number;
  /**
   * Protocol version to claim. -1 means "undetermined", which every server
   * answers, and avoids pretending to be a specific client version.
   */
  protocolVersion?: number;
}

export function pingServer(options: PingOptions): Promise<PingResult> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const started = Date.now();

  return new Promise<PingResult>((resolve) => {
    let settled = false;
    const finish = (result: PingResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - started });
    };

    const socket = connect({ host: options.host, port: options.port });
    socket.setTimeout(timeoutMs);

    socket.on('timeout', () => finish({ online: false, latencyMs: 0, error: 'timeout' }));
    socket.on('error', (error) => finish({ online: false, latencyMs: 0, error: error.message }));

    socket.on('connect', () => {
      const handshake = packet(
        writeVarInt(0x00),
        writeVarInt(options.protocolVersion ?? -1),
        writeString(options.host),
        Buffer.from([(options.port >> 8) & 0xff, options.port & 0xff]),
        writeVarInt(1), // next state: status
      );
      const statusRequest = packet(writeVarInt(0x00));
      socket.write(Buffer.concat([handshake, statusRequest]));
    });

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      const frame = readVarInt(buffer, 0);
      if (frame === undefined) return;
      if (buffer.length < frame.size + frame.value) return; // Await the rest.

      let cursor = frame.size;
      const id = readVarInt(buffer, cursor);
      if (id === undefined) return;
      cursor += id.size;

      const jsonLength = readVarInt(buffer, cursor);
      if (jsonLength === undefined) return;
      cursor += jsonLength.size;

      const json = buffer.subarray(cursor, cursor + jsonLength.value).toString('utf8');
      try {
        const parsed = JSON.parse(json) as {
          version?: { name?: string; protocol?: number };
          players?: { online?: number; max?: number };
        };
        const result: PingResult = { online: true, latencyMs: 0 };
        if (parsed.version?.name !== undefined) result.versionName = parsed.version.name;
        if (parsed.version?.protocol !== undefined) result.protocol = parsed.version.protocol;
        if (parsed.players?.online !== undefined) result.playersOnline = parsed.players.online;
        if (parsed.players?.max !== undefined) result.playersMax = parsed.players.max;
        finish(result);
      } catch {
        // A malformed body still proves something is listening and speaking
        // the protocol, which is all liveness requires.
        finish({ online: true, latencyMs: 0, error: 'unparsable status response' });
      }
    });

    socket.on('close', () => finish({ online: false, latencyMs: 0, error: 'closed before responding' }));
  });
}
