/**
 * Modelo del proyecto: única fuente de verdad.
 * La vista previa y la exportación se derivan de este JSON.
 *
 * Convenciones:
 *  - Todos los tiempos están en SEGUNDOS (number, float).
 *  - Los objetos se tratan como inmutables: cada cambio produce un Project nuevo
 *    (structural sharing), lo que hace barato el historial de deshacer.
 *  - Los campos marcados como "futuro" son opcionales y hoy se ignoran; existen para
 *    que sumar texto, transiciones, filtros y keyframes no requiera migrar el formato.
 */

export const PROJECT_FORMAT_VERSION = 1;

export type Id = string;

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  /** Frecuencia de muestreo de audio de salida. */
  sampleRate: number;
  /** Color de fondo cuando no hay video (formato CSS/FFmpeg: #rrggbb). */
  backgroundColor: string;
}

export type MediaKind = 'video' | 'audio';

/** Archivo fuente importado al panel de medios. */
export interface MediaSource {
  id: Id;
  /** Ruta absoluta en disco. */
  path: string;
  name: string;
  kind: MediaKind;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  /** Futuro: imágenes fijas, secuencias, etc. */
}

export type TrackKind = 'video' | 'audio';
// Futuro: 'text' | 'adjustment' | 'overlay'

export interface Track {
  id: Id;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  /** Ordenados por `start`, sin superposición dentro de la misma pista. */
  clips: Clip[];
  /** Futuro: volumen de pista, opacidad, modo de fusión... */
}

export interface Clip {
  id: Id;
  sourceId: Id;
  /** Posición en la timeline (s). */
  start: number;
  /** Punto de entrada dentro del archivo fuente (s). */
  inPoint: number;
  /** Punto de salida dentro del archivo fuente (s). Duración = outPoint - inPoint. */
  outPoint: number;

  // ---- Futuro (no implementado en v0.1) ----
  /** Volumen lineal (1 = original). */
  volume?: number;
  /** Velocidad de reproducción (1 = normal). */
  speed?: number;
  effects?: Effect[];
  transitionIn?: Transition;
  /** Keyframes por propiedad animable, p. ej. "opacity", "transform.x", "effects.<id>.amount". */
  keyframes?: Record<string, Keyframe[]>;
}

/** Futuro: filtros/efectos aplicados al clip. */
export interface Effect {
  id: Id;
  type: string;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
}

/** Futuro: transición al inicio del clip (con el clip anterior). */
export interface Transition {
  type: string;
  duration: number;
}

/** Futuro: keyframe genérico; `time` es relativo al inicio del clip. */
export interface Keyframe {
  time: number;
  value: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold';
}

export interface Project {
  formatVersion: number;
  name: string;
  settings: ProjectSettings;
  media: MediaSource[];
  /** Orden visual de arriba hacia abajo. */
  tracks: Track[];
}

// ---------------------------------------------------------------------------
// Helpers puros (usables desde main y renderer)
// ---------------------------------------------------------------------------

export function clipDuration(clip: Clip): number {
  return clip.outPoint - clip.inPoint;
}

export function clipEnd(clip: Clip): number {
  return clip.start + clipDuration(clip);
}

export function projectDuration(project: Project): number {
  let end = 0;
  for (const t of project.tracks) {
    for (const c of t.clips) end = Math.max(end, clipEnd(c));
  }
  return end;
}

export function createEmptyProject(name = 'Proyecto sin título'): Project {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name,
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      sampleRate: 48000,
      backgroundColor: '#000000',
    },
    media: [],
    tracks: [
      { id: 'track-video-1', kind: 'video', name: 'Video 1', muted: false, locked: false, clips: [] },
      { id: 'track-audio-1', kind: 'audio', name: 'Audio 1', muted: false, locked: false, clips: [] },
    ],
  };
}

/** Validación mínima al abrir un .vproj. Devuelve un mensaje de error o null. */
export function validateProject(data: unknown): string | null {
  if (!data || typeof data !== 'object') return 'El archivo no contiene un objeto JSON.';
  const p = data as Partial<Project>;
  if (typeof p.formatVersion !== 'number') return 'Falta formatVersion.';
  if (p.formatVersion > PROJECT_FORMAT_VERSION) {
    return `El proyecto usa el formato v${p.formatVersion}, más nuevo que el soportado (v${PROJECT_FORMAT_VERSION}).`;
  }
  if (!p.settings || !Array.isArray(p.media) || !Array.isArray(p.tracks)) {
    return 'Estructura de proyecto inválida (settings/media/tracks).';
  }
  for (const t of p.tracks) {
    if (!Array.isArray(t.clips)) return `La pista ${t.id} no tiene clips válidos.`;
  }
  return null;
}
