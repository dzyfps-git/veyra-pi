/**
 * The shell: updates in the top bar, the version at the foot of the rail, and the app's own fonts.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { layout } from '../src/web/layout.ts';

const BRAND = { name: 'Veyra Performance Intelligence', shortName: 'Veyra PI', tagline: '', accentColor: '#6C8CFF', logoPath: '' };
const page = (extra: Record<string, string>): string =>
  layout({ branding: BRAND, title: 'Overview', active: '/', nav: [], body: '', version: '0.1.15', ...extra } as unknown as Parameters<typeof layout>[0]);

describe('the update card', () => {
  test('a ready version installs from the top bar in one click', () => {
    const html = page({ update: '0.1.16' });
    assert.match(html, /Install 0\.1\.16/);
    assert.match(html, /class="small js-install-now" data-version="0\.1\.16"/);
  });
  test('a download in progress says so and refreshes itself', () => {
    const html = page({ downloading: '0.1.16' });
    assert.match(html, /Downloading 0\.1\.16/);
    assert.match(html, /data-state="downloading"/);
  });
  test('otherwise the version and a Check button', () => {
    const html = page({});
    assert.match(html, /Version 0\.1\.15/);
    assert.match(html, /js-check-updates/);
  });
  test('fonts come from the app itself, not the internet', () => {
    const html = page({});
    assert.match(html, /url\(\/fonts\/figtree\.woff2\)/);
    assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  });
});
