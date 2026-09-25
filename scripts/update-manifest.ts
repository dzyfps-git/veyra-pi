/**
 * Write the manifest that sits next to an installer: its version, checksum,
 * size and release notes. The app verifies the installer against it before
 * installing, and shows the notes before anything is installed.
 *
 *   node scripts/update-manifest.ts            (the installer for package.json's version)
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { APP_VERSION, CHANGELOG, compareVersions } from '../src/core/changelog.ts';

const installer = path.join('dist', `Veyra Performance Intelligence Setup ${APP_VERSION}.exe`);
const bytes = readFileSync(installer);
if (CHANGELOG[0]?.version !== APP_VERSION) {
  console.error(`The changelog's newest entry is ${CHANGELOG[0]?.version}, not ${APP_VERSION}. Add notes for this version first.`);
  process.exit(1);
}
const manifest = {
  version: APP_VERSION,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: statSync(installer).size,
  notes: CHANGELOG.filter((r) => compareVersions(r.version, APP_VERSION) <= 0),
};
const out = installer.replace(/\.exe$/, '.json');
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`${out}: ${manifest.sha256.slice(0, 16)}… ${manifest.size} bytes`);
