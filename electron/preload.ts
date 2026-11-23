/**
 * Preload (sandbox): expone una API mínima y tipada en `window.tl`.
 * Solo puede importar 'electron' en runtime; de /shared se importan únicamente tipos.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { ExportProgress, IpcChannel, MenuAction, TlApi } from '../shared/ipc-contract';

const invoke = <T>(channel: IpcChannel, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

function subscribe<T>(channel: IpcChannel, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: TlApi = {
  pickMediaFiles: () => invoke('media:pick'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  probe: (path) => invoke('media:probe', path),
  thumbnail: (path, at) => invoke('media:thumbnail', path, at),
  waveform: (path) => invoke('media:waveform', path),
  mediaUrl: (path) => `media://local/${encodeURIComponent(path)}`,
  fileExists: (path) => invoke('media:exists', path),

  saveProject: (project, path) => invoke('project:save', project, path),
  openProject: () => invoke('project:open'),

  makeIntermediate: (path) => invoke('media:intermediate', path),

  pickExportPath: (name) => invoke('export:pick-path', name),
  beginExport: (outputPath) => invoke('export:begin', outputPath),
  writeExportChunk: (jobId, position, data) => invoke('export:write', jobId, position, data),
  finishExport: (jobId, project) => invoke('export:finish', jobId, project),
  abortExport: (jobId) => invoke('export:abort', jobId),
  onExportProgress: (cb) => subscribe<ExportProgress>('export:progress', cb),

  onMenuAction: (cb) => subscribe<MenuAction>('menu:action', cb),
  showItemInFolder: (path) => invoke('shell:show-item', path),
};

contextBridge.exposeInMainWorld('tl', api);
