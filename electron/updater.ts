import { app, ipcMain, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateStatus } from '../shared/ipc-contract';

/** Cada cuánto se vuelve a buscar una versión nueva mientras la app está abierta. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Actualización automática desde GitHub Releases (configurado en package.json → build.publish).
 *
 * Canales: el canal sale de la propia versión instalada.
 *  - 0.1.N       (rama production) → solo recibe versiones estables.
 *  - 0.1.N-beta  (rama test)       → recibe betas y también estables más nuevas.
 *
 * La actualización se descarga en segundo plano y se instala al cerrar la app
 * (o al momento, si el usuario elige "Reiniciar y actualizar").
 */
export function initAutoUpdates(getWindow: () => BrowserWindow | null): void {
  let last: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() };
  const send = (status: Omit<UpdateStatus, 'currentVersion'>) => {
    last = { ...status, currentVersion: app.getVersion() };
    getWindow()?.webContents.send('update:status', last);
  };

  ipcMain.handle('update:get-status', () => last);
  ipcMain.handle('update:install', () => {
    // isSilent = false (muestra el instalador), isForceRunAfter = true (vuelve a abrir la app).
    if (last.state === 'ready') autoUpdater.quitAndInstall(false, true);
  });
  ipcMain.handle('update:check', () => check());

  // En desarrollo no hay instalador que actualizar.
  if (!app.isPackaged) {
    send({ state: 'disabled', message: 'Actualizaciones desactivadas en desarrollo.' });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => send({ state: 'up-to-date' }));
  autoUpdater.on('update-available', (info) => send({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) =>
    send({ state: 'downloading', version: last.version, percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => send({ state: 'error', message: err?.message ?? String(err) }));

  async function check(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      send({ state: 'error', message: (e as Error).message });
    }
  }

  // Primera búsqueda unos segundos después de abrir (no compite con el arranque).
  setTimeout(() => void check(), 5000);
  setInterval(() => void check(), CHECK_INTERVAL_MS);
}
