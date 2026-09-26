/**
 * Desktop shell.
 *
 * Contains no application logic by design. Its whole job is to make sure the
 * background collector is running and to put a window in front of it. Every
 * feature -- storage, settings, analysis, the interface itself -- lives in the
 * collector and is reached over loopback HTTP.
 *
 * That separation is what makes the shell disposable: it was swapped from a
 * WebView2 host to Electron without touching a line of the application, and
 * could be swapped again.
 *
 * Measured on this machine against the same page:
 *
 *    msedge --app       14 processes   353 MB private
 *    WebView2 host      13 processes   492 MB private
 *    Electron            4 processes   156 MB private
 *
 * Electron wins because it ships only the rendering engine. `--app` mode
 * starts all of Edge's browser services (sync, identity, SmartScreen,
 * collections) and merely hides the chrome.
 */

const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog, ipcMain, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

// The Minecraft server often runs on this same PC (in a VM, say), and Windows
// schedules a VM's CPUs as ordinary threads. Below-normal priority lets it win.
// (The collector lowers its own priority as well.)
try {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Not worth failing to start over.
}

const ROOT = path.resolve(__dirname, '..', '..');
const ICON = path.join(__dirname, '..', 'app.ico');

/**
 * Where application data lives.
 *
 * Installed, this must NOT be the install directory. The installer lets the
 * user pick that directory, it may be somewhere unwritable, and an upgrade
 * replaces its contents -- none of which is acceptable for an archive meant
 * to outlive several modpack rotations. So a packaged build keeps its data
 * under the per-user application data directory.
 *
 * Run from a checkout, the layout stays exactly as it was (`<repo>/data`),
 * so an existing archive keeps working with no migration.
 *
 * `PERFINT_DATA_DIR` overrides both, which is also how a second instance is
 * pointed at a different archive.
 */
const DATA_DIR =
  process.env.PERFINT_DATA_DIR ??
  (app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(ROOT, 'data'));

const STATE_FILE = path.join(DATA_DIR, 'window-state.json');

/**
 * Read the public name from the branding config.
 *
 * The shell needs a window title and a tray tooltip BEFORE the collector is
 * reachable, so it cannot ask over HTTP like it does for everything else. It
 * reads the one file that owns the name instead.
 *
 * Only two keys are extracted, with a narrow line match rather than a TOML
 * parser: the shell is CommonJS and the project's TOML library is ESM-only,
 * and pulling in a parser to read two strings would be the heavier mistake.
 * A missing or unreadable file falls back to the frozen internal name, which
 * is always correct even if it is not pretty.
 */
function readBranding() {
  const fallback = { name: 'perfint', shortName: 'perfint' };
  for (const candidate of [
    path.join(ROOT, 'config', 'branding.toml'),
    path.join(process.resourcesPath ?? '', 'app', 'config', 'branding.toml'),
  ]) {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      const pick = (key) => {
        const m = new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"', 'm').exec(text);
        return m === null ? undefined : m[1];
      };
      const name = pick('name');
      const shortName = pick('shortName');
      if (name !== undefined && name !== '') {
        return { name, shortName: shortName === undefined || shortName === '' ? name : shortName };
      }
    } catch {
      // Try the next location.
    }
  }
  return fallback;
}

const BRAND = readBranding();

let tray = null;
let win = null;
let endpoint = { host: '127.0.0.1', port: 9101 };
let quitting = false;

// --- talking to the collector ---------------------------------------------

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: urlPath,
        method,
        timeout: 4000,
        headers: payload === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const health = () => request('GET', '/api/health');

async function collectorAlive() {
  try {
    const result = await health();
    return result.ok === true;
  } catch {
    return false;
  }
}

/**
 * Start the collector as a DETACHED process.
 *
 * Detached and unref'd on purpose: the collector must outlive this window.
 * Closing or quitting the shell never stops monitoring.
 */
function startCollector() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Paths are passed explicitly rather than inherited from the working
  // directory. The child runs as plain Node, which knows nothing about
  // Electron's packaging, so it must be told exactly where things are.
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, 'src', 'cli', 'collector.ts'),
      '--db', path.join(DATA_DIR, 'perfint.sqlite'),
      '--config', path.join(ROOT, 'config'),
    ],
    {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      // ELECTRON_RUN_AS_NODE makes the bundled Electron binary behave as plain
      // Node, so the collector does not need a separate Node installation.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  child.unref();
}

// Generous, because the first start after an upgrade can do one-off work
// (a ledger rebuild takes ~15 s on a month of history) before it answers.
async function ensureCollector(timeoutMs = 120000) {
  if (await collectorAlive()) return true;
  startCollector();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await collectorAlive()) return true;
  }
  return false;
}

// --- window ----------------------------------------------------------------

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { width: 1440, height: 940 };
  }
}

function saveWindowState() {
  if (win === null || win.isDestroyed() || win.isMinimized()) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...win.getBounds(), maximized: win.isMaximized() }));
  } catch {
    // Window geometry is a convenience; never fail over it.
  }
}

function createWindow() {
  if (win !== null && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }

  const state = readWindowState();
  win = new BrowserWindow({
    width: state.width ?? 1440,
    height: state.height ?? 940,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    // Matches the interface ground so there is no flash on open.
    backgroundColor: GROUNDS.neutral,
    title: BRAND.name,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (state.maximized === true) win.maximize();
  win.removeMenu();
  win.loadURL(`http://${endpoint.host}:${endpoint.port}/`);
  win.once('ready-to-show', () => win.show());

  win.on('close', async (event) => {
    if (quitting) return;
    let closeToTray = true;
    try {
      const result = await request('GET', '/api/settings/value?key=desktop.closeToTray');
      if (result.value === false) closeToTray = false;
    } catch {
      // Unreachable collector: fall back to hiding, which is recoverable.
    }
    if (closeToTray && tray !== null) {
      event.preventDefault();
      saveWindowState();
      win.hide();
    }
  });

  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);

  // External links open in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

// --- pickers and Explorer, for the page -------------------------------------
//
// Answered only for the collector's own page, and deliberately limited: a
// picker returns a path, and "open" shows a folder -- or reveals a file in its
// folder -- but never runs anything.

function fromOurPage(event) {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith(`http://${endpoint.host}:${endpoint.port}/`);
}

function nearestExisting(candidate) {
  let probe = typeof candidate === 'string' && candidate !== '' ? path.resolve(candidate) : '';
  while (probe !== '') {
    if (fs.existsSync(probe)) return probe;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return undefined;
}

/**
 * The ground of each Focus colour (src/web/layout.ts FOCUS_PALETTES). The
 * interface is dark only, so native parts (menus, scrollbars) are too.
 */
const GROUNDS = { neutral: '#08090D', ice: '#05090C', warm: '#0C0806' };

/** The window ground for the app's Focus colour setting; anything else is neutral. */
function applyTheme(theme) {
  nativeTheme.themeSource = 'dark';
  if (win !== null && !win.isDestroyed()) win.setBackgroundColor(GROUNDS[theme] ?? GROUNDS.neutral);
}

ipcMain.handle('perfint:theme', async (event, theme) => {
  applyTheme(theme);
});

ipcMain.handle('perfint:pick', async (event, options) => {
  if (!fromOurPage(event)) return null;
  const folder = options?.kind === 'folder';
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: typeof options?.title === 'string' ? options.title : folder ? 'Choose a folder' : 'Choose a file',
    defaultPath: nearestExisting(options?.defaultPath),
    properties: folder ? ['openDirectory', 'createDirectory'] : ['openFile'],
    filters: Array.isArray(options?.filters) ? options.filters : undefined,
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('perfint:open-folder', async (event, target) => {
  if (!fromOurPage(event) || typeof target !== 'string' || target === '') return false;
  try {
    const stats = fs.statSync(target);
    if (stats.isDirectory()) return (await shell.openPath(target)) === '';
    shell.showItemInFolder(target);
    return true;
  } catch {
    const near = nearestExisting(target);
    if (near === undefined) return false;
    return (await shell.openPath(near)) === '';
  }
});

// --- updates -----------------------------------------------------------------
//
// The collector prepares (backs up the database, keeps the installer, and for
// going back, stages the restored database); this runs the installer, because
// the installer replaces this very executable and the collector's too. Order:
// stop the collector and wait for its process to exit, swap the database when
// going back, start the installer silently, quit. The installer reopens the
// app when it is done. Minecraft is never involved.

// electron-builder names installers "<productName> Setup <version>.exe"; the
// product name is the brand, so it is read, not written here.
const INSTALLER_NAME = new RegExp(
  `^${BRAND.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Setup \\d+\\.\\d+\\.\\d+\\.exe$`,
);
const STAGED_NAME = /^rollback-to-[\w.-]+\.sqlite$/;

function insideFolder(file, folder) {
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function stopCollectorAndWait(timeoutMs = 45000) {
  let pid;
  try { pid = (await health()).pid; } catch { /* not running */ }
  try { await request('POST', '/api/shutdown', {}); } catch { /* already gone */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await collectorAlive();
    if (!up && (typeof pid !== 'number' || !processAlive(pid))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function moveAside(file, target) {
  if (fs.existsSync(file)) fs.renameSync(file, target);
}

ipcMain.handle('perfint:run-installer', async (event, options) => {
  if (!fromOurPage(event)) return { ok: false, error: 'Not allowed.' };
  const installer = typeof options?.installer === 'string' ? options.installer : '';
  const restore = typeof options?.restore === 'string' ? options.restore : undefined;
  const kept = path.join(DATA_DIR, 'updates', 'installers');
  if (!insideFolder(installer, kept) || !INSTALLER_NAME.test(path.basename(installer)) || !fs.existsSync(installer)) {
    return { ok: false, error: 'That installer is not one this app prepared.' };
  }
  if (restore !== undefined && (!insideFolder(restore, path.join(DATA_DIR, 'updates')) || !STAGED_NAME.test(path.basename(restore)) || !fs.existsSync(restore))) {
    return { ok: false, error: 'The restored database is not one this app prepared.' };
  }

  if (!(await stopCollectorAndWait())) {
    await ensureCollector();
    return { ok: false, error: 'Monitoring did not stop in time, so nothing was changed. Try again in a minute.' };
  }

  if (restore !== undefined) {
    const db = path.join(DATA_DIR, 'perfint.sqlite');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = path.join(DATA_DIR, 'backups', `before-going-back-${stamp}.sqlite`);
    const moved = [];
    try {
      fs.mkdirSync(path.dirname(aside), { recursive: true });
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(db + suffix)) { moveAside(db + suffix, aside + suffix); moved.push(suffix); }
      }
      fs.renameSync(restore, db);
    } catch (error) {
      // Put everything back as it was and carry on as before.
      for (const suffix of moved) { try { moveAside(aside + suffix, db + suffix); } catch { /* reported below */ } }
      await ensureCollector();
      return { ok: false, error: `Could not restore the database (${error.message}); nothing was changed.` };
    }
  }

  try {
    const child = spawn(installer, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    await ensureCollector();
    return { ok: false, error: `Could not start the installer: ${error.message}` };
  }
  quitting = true;
  setTimeout(() => app.quit(), 300);
  return { ok: true };
});

// --- starting with Windows ---------------------------------------------------
//
// "Start monitoring when Windows starts" used to be a setting nothing read:
// after a reboot nothing ran until someone opened the app. It is now the
// ordinary per-user startup entry for this app, which starts the shell in the
// tray (and so the collector) without opening the window -- unless "Open the
// window at login" asks for it. Re-read every minute, so changing it in
// Settings applies without restarting anything.

async function applyLoginItem() {
  // A checkout would register electron.exe itself; only the installed app
  // registers.
  if (!app.isPackaged) return;
  try {
    const start = await request('GET', '/api/settings/value?key=desktop.startCollectorAtLogin');
    const open = await request('GET', '/api/settings/value?key=desktop.openWindowAtLogin');
    if (typeof start.value !== 'boolean') return;
    app.setLoginItemSettings({
      openAtLogin: start.value,
      args: open.value === true ? [] : ['--hidden'],
    });
  } catch {
    // Collector unreachable: leave the current registration as it is.
  }
}

// --- tray ------------------------------------------------------------------

async function buildTrayMenu() {
  let paused = false;
  let summary = 'Collector unreachable';
  try {
    const result = await health();
    paused = result.paused === true;
    const servers = Array.isArray(result.servers) ? result.servers : [];
    summary =
      servers.length === 0
        ? 'No servers configured'
        : servers.map((s) => `${s.displayName}: ${s.description ?? s.state}`).join('\n');
  } catch {
    // Leave the default summary.
  }

  const menu = Menu.buildFromTemplate([
    { label: summary, enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => createWindow() },
    {
      label: paused ? 'Resume monitoring' : 'Pause monitoring',
      click: async () => {
        try {
          await request('POST', '/api/settings', { 'limits.paused': !paused });
        } catch {
          dialog.showErrorBox(BRAND.name, 'Could not reach the collector.');
        }
        void refreshTray();
      },
    },
    { label: 'Open data folder', click: () => void shell.openPath(DATA_DIR) },
    { type: 'separator' },
    {
      label: 'Quit (keeps monitoring)',
      click: () => { quitting = true; app.quit(); },
    },
    {
      label: 'Quit and stop monitoring',
      click: async () => {
        try { await request('POST', '/api/shutdown', {}); } catch { /* already gone */ }
        quitting = true;
        app.quit();
      },
    },
  ]);

  if (tray !== null) {
    tray.setContextMenu(menu);
    tray.setToolTip(paused ? `${BRAND.shortName} — paused` : BRAND.shortName);
  }
}

async function refreshTray() {
  await buildTrayMenu();
}

function createTray() {
  const image = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip(BRAND.shortName);
  tray.on('double-click', () => createWindow());
  void refreshTray();
  // Cheap: a few loopback requests a minute, only to keep the menu and the
  // startup registration honest.
  setInterval(() => { void refreshTray(); void applyLoginItem(); }, 60000);
}

// --- lifecycle -------------------------------------------------------------

// A second launch focuses the existing window rather than starting a rival.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => createWindow());

  app.whenReady().then(async () => {
    const ok = await ensureCollector();
    if (!ok) {
      dialog.showErrorBox(
        BRAND.name,
        `The background collector did not start.\n\nDetails are in ${path.join(DATA_DIR, 'logs', 'collector.log')}`,
      );
      app.quit();
      return;
    }

    try {
      applyTheme((await request('GET', '/api/settings/value?key=interface.theme')).value);
    } catch { /* keeps Windows' own setting */ }

    let showTray = true;
    try {
      const result = await request('GET', '/api/settings/value?key=desktop.showTrayIcon');
      if (result.value === false) showTray = false;
    } catch { /* default to showing it */ }

    void applyLoginItem();
    if (showTray) createTray();
    // Started by Windows at sign-in: stay in the tray. Without a tray there
    // would be no way back to the window, so it opens after all.
    if (!process.argv.includes('--hidden') || tray === null) createWindow();
    if (tray === null) setInterval(() => void applyLoginItem(), 60000);
  });

  // Closing the last window must NOT quit while the tray is live, and must
  // never stop the collector either way.
  app.on('window-all-closed', () => {
    if (tray === null) app.quit();
  });

  app.on('before-quit', () => { quitting = true; saveWindowState(); });
}
