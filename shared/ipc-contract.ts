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

// ---- Subtítulos automáticos (Whisper) ----
export type WhisperModelId = 'base' | 'small' | 'large-v3-turbo';

export interface SubtitleModelInfo {
  id: WhisperModelId;
  label: string;
  sizeMB: number;
  downloaded: boolean;
}

export interface SubtitleRequest {
  model: WhisperModelId;
  /** Código ISO ('es', 'en', 'pt'…) o 'auto'. */
  language: string;
  /** Tramo de la timeline a transcribir (s). Sin valores = toda la timeline. */
  start?: number;
  end?: number;
  /** Largo máximo aproximado de cada subtítulo (caracteres). */
  maxChars: number;
}

/** Un subtítulo, en tiempo de timeline (s). */
export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

export interface SubtitleProgress {
  phase: 'download' | 'transcribe';
  ratio: number;
}

/** Estado de edición que se recupera al volver a abrir la app. */
export interface SessionData {
  version: 1;
  project: Project;
  /** Archivo .vproj abierto (null si nunca se guardó). */
  filePath: string | null;
  /** Había cambios sin guardar en el .vproj. */
  dirty: boolean;
  playhead: number;
  /** Zoom de la timeline (px/s). */
  pps: number;
  savedAt: string;
}

/** Estado de la actualización automática. */
export interface UpdateStatus {
  state: 'idle' | 'disabled' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error';
  currentVersion: string;
  /** Versión nueva (si hay). */
  version?: string;
  /** 0..100 durante la descarga. */
  percent?: number;
  message?: string;
}

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

  listSubtitleModels(): Promise<SubtitleModelInfo[]>;
  /** Transcribe el audio de la timeline (lo que se escucha) y devuelve los subtítulos. */
  transcribe(project: Project, req: SubtitleRequest): Promise<SubtitleSegment[]>;
  cancelTranscription(): Promise<void>;
  onSubtitleProgress(cb: (p: SubtitleProgress) => void): () => void;
  /** Guarda un archivo .srt (abre el diálogo). Devuelve la ruta o null si se cancela. */
  saveSrt(segments: SubtitleSegment[], suggestedName: string): Promise<string | null>;

  loadSession(): Promise<SessionData | null>;
  /** Guardado en segundo plano (no espera respuesta). */
  saveSession(data: SessionData): void;
  /** Guardado sincrónico (al cerrar la ventana). */
  saveSessionSync(data: SessionData): void;

  getUpdateStatus(): Promise<UpdateStatus>;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  /** Cierra la app, instala la versión descargada y la vuelve a abrir. */
  installUpdate(): Promise<void>;
  checkForUpdates(): Promise<void>;
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
  | 'shell:show-item'
  | 'subtitles:models'
  | 'subtitles:transcribe'
  | 'subtitles:cancel'
  | 'subtitles:progress'
  | 'subtitles:save-srt'
  | 'session:load'
  | 'session:save'
  | 'session:save-sync'
  | 'update:status'
  | 'update:get-status'
  | 'update:install'
  | 'update:check';
