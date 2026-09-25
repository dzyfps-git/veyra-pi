/**
 * `serve` -- start the web interface.
 *
 *   node src/cli/serve.ts [--db <file>] [--config <dir>]
 */

import { Store } from '../store/db.ts';
import { SettingsStore } from '../settings/store.ts';
import { loadBranding } from '../core/brand.ts';
import { createWebServer } from '../web/server.ts';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const store = new Store({ file: flag('db', 'data/perfint.sqlite') });
const settings = new SettingsStore(store.db);
const branding = loadBranding(flag('config', 'config'));

const host = settings.getString('interface.host');
const port = settings.getNumber('interface.port');

const server = createWebServer({ store, settings, branding, host, port });
server.listen(port, host, () => {
  console.log(`${branding.name} -> http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
