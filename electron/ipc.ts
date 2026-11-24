import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { OpenProjectResult } from '../shared/ipc-contract';
import { validateProject, type Project } from '../shared/model';
import { ExportManager } from './ffmpeg/export';
import { makeIntermediate } from './ffmpeg/intermediate';
import { probe } from './ffmpeg/probe';
import { thumbnail } from './ffmpeg/thumbnail';
import { waveform } from './ffmpeg/waveform';
import { toMediaUrl } from './media-protocol';

const MEDIA_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const thumbsDir = path.join(app.getPath('userData'), 'cache', 'thumbs');
  const decodeDir = path.join(app.getPath('userData'), 'cache', 'decode');
  const exports = new ExportManager();

  ipcMain.handle('media:pick', async () => {
    const win = getWindow();
    const opts: Electron.OpenDialogOptions = {
      title: 'Importar medios',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video, audio e imágenes', extensions: MEDIA_EXTENSIONS },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('media:probe', (_e, filePath: string) => probe(filePath));

  ipcMain.handle('media:thumbnail', async (_e, filePath: string, at: number) =>
    toMediaUrl(await thumbnail(thumbsDir, filePath, at)),
  );

  ipcMain.handle('media:waveform', (_e, filePath: string) => waveform(filePath));

  ipcMain.handle('media:intermediate', (_e, filePath: string) => makeIntermediate(decodeDir, filePath));

  ipcMain.handle('media:exists', async (_e, filePath: string) => {
    try {
      return (await fs.promises.stat(filePath)).isFile();
    } catch {
      return false;
    }
  });

  ipcMain.handle('project:save', async (_e, project: Project, currentPath: string | null) => {
    let target = currentPath;
    if (!target) {
      const win = getWindow();
      const opts: Electron.SaveDialogOptions = {
        title: 'Guardar proyecto',
        defaultPath: `${project.name || 'proyecto'}.vproj`,
        filters: [{ name: 'Proyecto SHOTON', extensions: ['vproj'] }],
      };
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }
    // Escritura atómica: primero a un temporal, luego rename.
    const tmp = `${target}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(project, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
    return target;
  });

  ipcMain.handle('project:open', async (): Promise<OpenProjectResult | null> => {
    const win = getWindow();
    const opts: Electron.OpenDialogOptions = {
      title: 'Abrir proyecto',
      properties: ['openFile'],
      filters: [{ name: 'Proyecto SHOTON', extensions: ['vproj'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    const filePath = res.filePaths[0];
    const data: unknown = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    const error = validateProject(data);
    if (error) throw new Error(error);
    return { path: filePath, project: data as Project };
  });

  ipcMain.handle('export:pick-path', async (_e, suggestedName: string) => {
    const win = getWindow();
    const opts: Electron.SaveDialogOptions = {
      title: 'Exportar video',
      defaultPath: `${suggestedName || 'video'}.mp4`,
      filters: [{ name: 'Video MP4', extensions: ['mp4'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return res.canceled || !res.filePath ? null : res.filePath;
  });

  ipcMain.handle('export:begin', (_e, outputPath: string) => exports.begin(outputPath));
  ipcMain.handle('export:write', (_e, id: string, position: number, data: Uint8Array) => exports.write(id, position, data));
  ipcMain.handle('export:finish', (e, id: string, project: Project) =>
    exports.finish(id, project, (p) => {
      if (!e.sender.isDestroyed()) e.sender.send('export:progress', p);
    }),
  );
  ipcMain.handle('export:abort', (_e, id: string) => exports.abort(id));

  ipcMain.handle('shell:show-item', (_e, filePath: string) => shell.showItemInFolder(filePath));
}
