/**
 * Contrato de la API expuesta por el preload en `window.tl`.
 * Solo tipos: el preload (sandbox) no puede importar código en runtime de esta carpeta.
 */
import type { MediaKind, Project } from './model';

export interface ProbeResult {
  path: string;
  name: string;
  kind: MediaKind;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
}

export interface WaveformData {
  /** Picos normalizados 0..1, uno por bucket. */
  peaks: Float32Array;
  /** Cantidad de buckets por segundo de audio. */
  peaksPerSecond: number;
}

export interface ExportProgress {
  /** 0..1 dentro de la fase. */
  ratio: number;
  /** Segundos ya procesados. */
  time: number;
  /** 'video' = composición + codificación en el renderer; 'audio' = mezcla y multiplexado con FFmpeg. */
  phase: 'video' | 'audio';
}

export type ExportResult =
  | { status: 'done'; outputPath: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface OpenProjectResult {
  path: string;
  project: Project;
}

export type MenuAction =
  | 'new'
  | 'open'
  | 'save'
  | 'save-as'
  | 'import'
  | 'export'
  | 'undo'
  | 'redo';

export interface TlApi {
  /** Abre el diálogo de importación y devuelve rutas elegidas (vacío si se cancela). */
  pickMediaFiles(): Promise<string[]>;
  /** Ruta real de un File soltado por drag & drop. */
  getPathForFile(file: File): string;
  probe(path: string): Promise<ProbeResult>;
  /** Devuelve una URL `media://` de una miniatura JPEG (cacheada). */
  thumbnail(path: string, atSeconds: number): Promise<string>;
  waveform(path: string): Promise<WaveformData>;
  /** Convierte una ruta absoluta en URL reproducible por <video>/<audio>. */
  mediaUrl(path: string): string;
  fileExists(path: string): Promise<boolean>;

  saveProject(project: Project, path: string | null): Promise<string | null>;
  openProject(): Promise<OpenProjectResult | null>;

  /** Genera (o reutiliza) una copia H.264 para videos que el renderer no puede decodificar. */
  makeIntermediate(path: string): Promise<string>;

  pickExportPath(suggestedName: string): Promise<string | null>;
  /** Abre un trabajo de exportación; el renderer escribe el video codificado con `writeExportChunk`. */
  beginExport(outputPath: string): Promise<string>;
  writeExportChunk(jobId: string, position: number, data: Uint8Array): Promise<void>;
  /** Mezcla el audio del proyecto y lo multiplexa con el video escrito. */
  finishExport(jobId: string, project: Project): Promise<ExportResult>;
  /** Cancela en cualquier fase y borra archivos parciales. */
  abortExport(jobId: string): Promise<void>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;

  onMenuAction(cb: (action: MenuAction) => void): () => void;
  showItemInFolder(path: string): Promise<void>;
}

/** Nombres de canales IPC (usados como literales en preload y main). */
export type IpcChannel =
  | 'media:pick'
  | 'media:probe'
  | 'media:thumbnail'
  | 'media:waveform'
  | 'media:exists'
  | 'media:intermediate'
  | 'project:save'
  | 'project:open'
  | 'export:pick-path'
  | 'export:begin'
  | 'export:write'
  | 'export:finish'
  | 'export:abort'
  | 'export:progress'
  | 'menu:action'
  | 'shell:show-item';
