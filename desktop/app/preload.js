/**
 * The page's only reach into the desktop: pick a folder or file, show a
 * folder in Explorer, and run an update the collector has prepared.
 *
 * Everything else the interface does goes over HTTP to the collector. These
 * three exist because a web page cannot open a native picker or Explorer, and
 * a path typed by hand ("data/archive") is exactly what made the storage
 * settings unreadable. In a plain browser `window.perfintDesktop` is absent
 * and the page falls back to typing and copying paths.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('perfintDesktop', {
  pickFolder: (options) => ipcRenderer.invoke('perfint:pick', { ...(options ?? {}), kind: 'folder' }),
  pickFile: (options) => ipcRenderer.invoke('perfint:pick', { ...(options ?? {}), kind: 'file' }),
  openFolder: (target) => ipcRenderer.invoke('perfint:open-folder', String(target ?? '')),
  // Only installers the collector kept in the data folder are ever run.
  runInstaller: (options) => ipcRenderer.invoke('perfint:run-installer', options ?? {}),
  // The window frame and native controls follow the app's theme, not only Windows'.
  setTheme: (theme) => ipcRenderer.invoke('perfint:theme', String(theme ?? '')),
});
