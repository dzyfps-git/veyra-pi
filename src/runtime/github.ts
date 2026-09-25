/**
 * New versions from GitHub releases.
 *
 * Each release carries the installer and its manifest (scripts/update-manifest.ts).
 * The newest release is checked every few hours with one small request; a
 * newer version is downloaded in the background into the app's own updates
 * folder, checked against its manifest, and then offered on the Updates page
 * like any other installer. Nothing is installed without a click.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { compareVersions } from '../core/changelog.ts';
import { installerPattern, type Manifest } from './updates.ts';

export interface Release {
  version: string;
  installer: { name: string; url: string; size: number };
  manifest: { name: string; url: string };
}

/** "owner/repo", nothing else, so the setting cannot point a request anywhere but GitHub. */
export const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'perfint-updater' };

/** The newest published release that carries an installer and its manifest. */
export async function latestRelease(repo: string, productName: string, fetcher: typeof fetch = fetch): Promise<Release | undefined> {
  if (!REPO_PATTERN.test(repo)) throw new Error(`"${repo}" is not a GitHub repository (owner/name)`);
  const res = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { assets?: Array<{ name: string; browser_download_url: string; size: number }> };
  const exe = installerPattern(productName, { dotsForSpaces: true });
  for (const asset of body.assets ?? []) {
    const match = exe.exec(asset.name);
    if (match === null) continue;
    const manifestName = asset.name.replace(/\.exe$/, '.json');
    const manifest = (body.assets ?? []).find((a) => a.name === manifestName);
    if (manifest === undefined) continue;
    return {
      version: match[1]!,
      installer: { name: asset.name, url: asset.browser_download_url, size: asset.size },
      manifest: { name: manifest.name, url: manifest.browser_download_url },
    };
  }
  return undefined;
}

/**
 * Download a newer release into `dir` as "<product> Setup <version>.exe" with
 * its manifest beside it. Written to a partial file, checked against the
 * manifest, then renamed, so the Updates page never sees half a file.
 * Returns the installer path, or undefined when it is not newer.
 */
export async function downloadRelease(
  release: Release,
  dir: string,
  productName: string,
  currentVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  if (compareVersions(release.version, currentVersion) <= 0) return undefined;
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${productName} Setup ${release.version}.exe`);
  const manifestPath = target.replace(/\.exe$/, '.json');
  if (existsSync(target) && existsSync(manifestPath) && statSync(target).size === release.installer.size) return target;

  const mres = await fetcher(release.manifest.url, { headers: { 'user-agent': HEADERS['user-agent'] }, signal: AbortSignal.timeout(30_000) });
  if (!mres.ok) throw new Error(`manifest download failed (${mres.status})`);
  const manifestText = await mres.text();
  const manifest = JSON.parse(manifestText) as Manifest;
  if (manifest.version !== release.version || typeof manifest.sha256 !== 'string') throw new Error('the manifest does not match the release');

  const partial = `${target}.partial`;
  try {
    const res = await fetcher(release.installer.url, { headers: { 'user-agent': HEADERS['user-agent'] }, signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok || res.body === null) throw new Error(`installer download failed (${res.status})`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(partial));
    const sha = createHash('sha256').update(readFileSync(partial)).digest('hex');
    if (sha !== manifest.sha256) throw new Error('the downloaded installer does not match its checksum');
    writeFileSync(manifestPath, manifestText);
    renameSync(partial, target);
    return target;
  } finally {
    rmSync(partial, { force: true });
  }
}
