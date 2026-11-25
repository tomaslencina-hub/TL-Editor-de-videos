import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionData } from '../shared/ipc-contract';

/**
 * Sesión de trabajo: la app guarda sola el estado de edición (proyecto, archivo, playhead, zoom)
 * y lo recupera al abrir, aunque el usuario no haya guardado o la app se haya cerrado de golpe.
 */
export function registerSession(): void {
  const file = path.join(app.getPath('userData'), 'session.json');
  const tmp = `${file}.tmp`;

  const write = (data: SessionData) => {
    // Escritura atómica: si se corta a mitad, queda la sesión anterior intacta.
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  };

  ipcMain.handle('session:load', async (): Promise<SessionData | null> => {
    try {
      return JSON.parse(await fs.promises.readFile(file, 'utf8')) as SessionData;
    } catch {
      return null;
    }
  });

  // Guardado periódico (asíncrono desde el renderer, sin esperar respuesta).
  ipcMain.on('session:save', (_e, data: SessionData) => {
    try {
      write(data);
    } catch (err) {
      console.warn('No se pudo guardar la sesión', err);
    }
  });

  // Al cerrar: sincrónico, para que el último cambio quede escrito antes de que la ventana se destruya.
  ipcMain.on('session:save-sync', (e, data: SessionData) => {
    try {
      write(data);
      e.returnValue = true;
    } catch (err) {
      console.warn('No se pudo guardar la sesión', err);
      e.returnValue = false;
    }
  });
}
