import { app, BrowserWindow, dialog, Menu } from 'electron';
import path from 'node:path';
import { checkFfmpegAvailable } from './ffmpeg/process';
import { registerIpc } from './ipc';
import { handleMediaProtocol, registerMediaSchemePrivileges } from './media-protocol';
import { buildMenu } from './menu';
import { initAutoUpdates } from './updater';

/** En desarrollo se pasa `--dev-url=http://localhost:4200`; en producción se carga el build de Angular. */
const devUrl = process.argv.find((a) => a.startsWith('--dev-url='))?.slice('--dev-url='.length);

/** Ícono de ventana/barra de tareas (resources/ está en la raíz del proyecto). */
const APP_ICON = path.join(__dirname, '..', '..', 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

let mainWindow: BrowserWindow | null = null;

// En desarrollo, sin caché HTTP: evita que Chromium sirva un bundle viejo tras recompilar.
if (devUrl) app.commandLine.appendSwitch('disable-http-cache');

// En Windows agrupa la ventana en la barra de tareas con identidad (e ícono) propia, no la de Electron.
if (process.platform === 'win32') app.setAppUserModelId('com.shoton.editor');
app.setName('SHOTON');

registerMediaSchemePrivileges();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#16171b',
    title: 'SHOTON',
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // La reproducción usa requestAnimationFrame: que no se congele si la ventana queda tapada.
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Seguridad: la ventana nunca navega fuera de la app ni abre ventanas nuevas
  // (también evita que soltar un archivo fuera de una zona de drop "abra" el video).
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // El renderer bloquea el cierre (beforeunload) si hay cambios sin guardar; acá se pregunta.
  mainWindow.webContents.on('will-prevent-unload', (e) => {
    // En desarrollo el live-reload recarga la página a cada cambio de código: no se pregunta.
    if (devUrl) {
      e.preventDefault();
      return;
    }
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Salir sin guardar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Cambios sin guardar',
      message: 'El proyecto tiene cambios sin guardar. ¿Salir de todas formas?',
    });
    if (choice === 0) e.preventDefault(); // ignora el beforeunload y continúa
  });

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'tl-editor', 'browser', 'index.html'));
  }

  mainWindow.on('closed', () => (mainWindow = null));
}

void app.whenReady().then(() => {
  const ffmpegError = checkFfmpegAvailable();
  if (ffmpegError) dialog.showErrorBox('FFmpeg no disponible', ffmpegError);

  handleMediaProtocol();
  registerIpc(() => mainWindow);
  Menu.setApplicationMenu(buildMenu(() => mainWindow));
  initAutoUpdates(() => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
