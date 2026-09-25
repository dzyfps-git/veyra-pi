/**
 * Publish the built installer and its manifest as a GitHub release, so the
 * app downloads it by itself (runtime/github.ts).
 *
 *   node scripts/publish-release.ts owner/repo
 *
 * Uses the GitHub CLI (`gh`), signed in by you with `gh auth login`; this
 * script never sees a token. Run after the build and scripts/update-manifest.ts.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { APP_VERSION, notesFor } from '../src/core/changelog.ts';

const repo = process.argv[2] ?? '';
if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
  console.error('Usage: node scripts/publish-release.ts owner/repo');
  process.exit(1);
}
const installer = path.join('dist', `Veyra Performance Intelligence Setup ${APP_VERSION}.exe`);
const manifest = installer.replace(/\.exe$/, '.json');
for (const file of [installer, manifest]) {
  if (!existsSync(file)) {
    console.error(`${file} is missing: build first, then run scripts/update-manifest.ts.`);
    process.exit(1);
  }
}
const notes = (notesFor(APP_VERSION)?.notes ?? []).map((n) => `- ${n}`).join('\n');
execFileSync('gh', ['release', 'create', `v${APP_VERSION}`, installer, manifest, '--repo', repo, '--title', APP_VERSION, '--notes', notes], {
  stdio: 'inherit',
});
console.log(`Published ${APP_VERSION} to ${repo}.`);
