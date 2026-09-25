import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';

import { pingServer } from '../src/runtime/ping.ts';

/**
 * A minimal stand-in for a Minecraft server's status endpoint. Validates the
 * varint framing and packet layout without touching a real server.
 */
function fakeMinecraft(response: object): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.once('data', () => {
        const json = Buffer.from(JSON.stringify(response), 'utf8');
        const varint = (n: number): Buffer => {
          const out: number[] = [];
          let v = n >>> 0;
          for (;;) {
            if ((v & ~0x7f) === 0) { out.push(v); break; }
            out.push((v & 0x7f) | 0x80);
            v >>>= 7;
          }
          return Buffer.from(out);
        };
        const body = Buffer.concat([varint(0x00), varint(json.length), json]);
        socket.write(Buffer.concat([varint(body.length), body]));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  });
}

describe('server list ping', () => {
  test('parses a status response, including a multi-byte length', async () => {
    // A realistic MOTD pushes the JSON past 127 bytes, which exercises
    // multi-byte varint length decoding -- the easy thing to get wrong.
    const { server, port } = await fakeMinecraft({
      version: { name: '1.20.1', protocol: 763 },
      players: { online: 4, max: 20, sample: [] },
      description: { text: 'x'.repeat(300) },
    });
    try {
      const result = await pingServer({ host: '127.0.0.1', port, timeoutMs: 3000 });
      assert.equal(result.online, true);
      assert.equal(result.versionName, '1.20.1');
      assert.equal(result.protocol, 763);
      assert.equal(result.playersOnline, 4);
      assert.equal(result.playersMax, 20);
      assert.ok(result.latencyMs >= 0);
    } finally {
      server.close();
    }
  });

  test('a closed port reports offline rather than throwing', async () => {
    const { server, port } = await fakeMinecraft({});
    await new Promise<void>((r) => server.close(() => r()));
    const result = await pingServer({ host: '127.0.0.1', port, timeoutMs: 1500 });
    assert.equal(result.online, false);
    assert.ok(result.error !== undefined);
  });

  test('a silent socket times out instead of hanging', async () => {
    const server = createServer(() => { /* accept and never answer */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const started = Date.now();
      const result = await pingServer({ host: '127.0.0.1', port, timeoutMs: 600 });
      assert.equal(result.online, false);
      assert.equal(result.error, 'timeout');
      assert.ok(Date.now() - started < 3000, 'must not hang past its timeout');
    } finally {
      server.close();
    }
  });
});
