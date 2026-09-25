/**
 * New versions from GitHub releases: found, downloaded, checked, never trusted
 * without their checksum.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { downloadRelease, latestRelease } from '../src/runtime/github.ts';
import { findInstallers } from '../src/runtime/updates.ts';

const PRODUCT = 'Veyra Performance Intelligence';
const INSTALLER = Buffer.alloc(12_000_000, 7);
const SHA = createHash('sha256').update(INSTALLER).digest('hex');

/** A fake GitHub: the API answer, the manifest, the installer. */
function fakeGithub(options: { sha?: string } = {}): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/releases/latest')) {
      return new Response(
        JSON.stringify({
          assets: [
            { name: 'Veyra.Performance.Intelligence.Setup.0.2.0.exe', browser_download_url: 'https://example/exe', size: INSTALLER.length },
            { name: 'Veyra.Performance.Intelligence.Setup.0.2.0.json', browser_download_url: 'https://example/json', size: 100 },
          ],
        }),
      );
    }
    if (u === 'https://example/json') return new Response(JSON.stringify({ version: '0.2.0', sha256: options.sha ?? SHA, size: INSTALLER.length, notes: [] }));
    if (u === 'https://example/exe') return new Response(INSTALLER);
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

describe('GitHub releases', () => {
  test('the newest release is found by its installer and manifest, even with GitHub’s dotted names', async () => {
    const r = await latestRelease('someone/veyra-releases', PRODUCT, fakeGithub());
    assert.equal(r?.version, '0.2.0');
  });
  test('only owner/name is accepted, so the setting cannot send a request elsewhere', async () => {
    await assert.rejects(latestRelease('https://evil.example/x', PRODUCT, fakeGithub()));
  });
  test('a newer version is downloaded, checked, and then offered like any other installer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'perfint-gh-'));
    const r = (await latestRelease('someone/veyra-releases', PRODUCT, fakeGithub()))!;
    const file = await downloadRelease(r, dir, PRODUCT, '0.1.13', fakeGithub());
    assert.equal(path.basename(file!), `${PRODUCT} Setup 0.2.0.exe`);
    const found = findInstallers([dir], PRODUCT);
    assert.equal(found[0]?.version, '0.2.0');
    assert.equal(found[0]?.manifest?.sha256, SHA);
  });
  test('an installer that does not match its checksum is thrown away', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'perfint-gh-'));
    const r = (await latestRelease('someone/veyra-releases', PRODUCT, fakeGithub({ sha: 'f'.repeat(64) })))!;
    await assert.rejects(downloadRelease(r, dir, PRODUCT, '0.1.13', fakeGithub({ sha: 'f'.repeat(64) })), /checksum/);
    assert.deepEqual(readdirSync(dir), [], 'nothing is left behind');
  });
  test('the same or an older version is not downloaded', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'perfint-gh-'));
    const r = (await latestRelease('someone/veyra-releases', PRODUCT, fakeGithub()))!;
    assert.equal(await downloadRelease(r, dir, PRODUCT, '0.2.0', fakeGithub()), undefined);
    assert.equal(existsSync(path.join(dir, `${PRODUCT} Setup 0.2.0.exe`)), false);
  });
});
