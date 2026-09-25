# Desktop shell

The window. It contains **no application logic** — everything lives in the
collector and is reached over loopback HTTP. That is deliberate: the shell was
already swapped once (WebView2 → Electron) without touching a line of the
application, and could be swapped again.

## Why Electron, when it looked like the heavy option

Three shells were built and measured against the same page on the target
machine. Private bytes, which is the honest figure — summed working set
double-counts pages shared between Chromium processes:

| Shell | processes | working set | private |
|---|---|---|---|
| `msedge --app=` | 14 | 678 MB | 353 MB |
| WebView2 host (SDK, via PowerShell) | 13 | 882 MB | 492 MB |
| **Electron** | **4** | **328 MB** | **156 MB** |

This is the opposite of the intuition that reusing an already-installed
runtime must be lighter. `msedge --app=` starts *all* of Edge's browser
services — sync, identity, SmartScreen, collections — and merely hides the
chrome. Electron ships only the rendering engine, hence 4 processes instead
of 14. The WebView2 host was worst of the three: Chromium's full process tree
plus a 112 MB .NET/PowerShell host.

Electron costs ~368 MB of disk for that. On this machine disk is abundant and
RAM is not, so it is the right trade — and it brings the tray, native
notifications and an auto-update path that the others would have needed
bolted on.

## Layout

| File | Purpose |
|---|---|
| `app/main.js` | The Electron shell: window, tray, single instance. |
| `app.ico` | Generated icon (no image toolchain needed). |
| `launch.ps1` | Starts the collector and opens a window without Electron. |
| `install.ps1` | Shortcuts plus a hidden logon task. |
| `uninstall.ps1` | Removes both. Never touches collected data. |

`launch.ps1` and `tray.ps1` are kept as a dependency-free fallback: they can
start and drive the collector on a machine with no Electron build.

## Running

```
npm run collector     # background process alone
npm run app           # Electron shell (starts the collector if needed)
npm run dist          # build a Windows installer
```

Every npm script calls its tool's entry point through `node` rather than the
generated `.cmd` shim, because this project's directory name contains `&`,
which the shims split on. `electron-builder` fails with
`Cannot find module 'D:\electron-builder\cli.js'` otherwise.

## Packaging

Two things about the packaged build are not the electron-builder defaults,
and both follow from the collector being a **separate process**:

**`asar: false`.** The collector is spawned with `ELECTRON_RUN_AS_NODE`, which
makes it plain Node — and plain Node cannot read inside an asar archive. It
needs `src/`, `config/` and `node_modules/` as real files. `asarUnpack` would
also work, but it splits the payload across two trees to protect a few hundred
KB of TypeScript sitting next to a 369 MB runtime.

**Data lives outside the install directory.** A packaged build keeps its
archive in `%APPDATA%\Veyra Performance Intelligence\data`, not next to the
executable: the installer lets the user choose that directory, it may be
somewhere unwritable, and an upgrade replaces its contents. Run from a
checkout the layout is unchanged (`<repo>/data`), so an existing archive keeps
working. `PERFINT_DATA_DIR` overrides both.

Verified end to end: 111 MB NSIS installer, 369 MB unpacked. The packaged
collector starts from the packaged Electron binary, opens `node:sqlite` and
serves every route; the shell opens onto it at 4 processes / 161 MB private,
matching the development measurement.

## Behaviour

- **Closing the window does not stop monitoring.** The collector is spawned
  detached and outlives the shell. Verified by killing the shell and
  confirming the collector keeps serving.
- **Close hides to the tray** by default (`desktop.closeToTray`). Hiding frees
  the renderer: 156 MB → 126 MB.
- **Single instance.** A second launch focuses the existing window.
- **External links** open in the real browser, never inside the shell.
- The tray offers Open, Pause monitoring, Open data folder, and two distinct
  quit actions — one that leaves monitoring running and one that stops it.
