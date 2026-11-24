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

import type { OverlayEffect } from './effects';
import type { TextContent } from './text';
import { isTransitionType, type TransitionType } from './transitions';

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

export type MediaKind = 'video' | 'audio' | 'image';

/** Duración inicial de una imagen al ponerla en la timeline (s). Después se puede estirar sin límite. */
export const DEFAULT_IMAGE_DURATION = 5;

/** Duración con la que entra un medio a la timeline. */
export function initialClipDuration(media: Pick<MediaSource, 'kind' | 'duration'>): number {
  return media.kind === 'image' ? DEFAULT_IMAGE_DURATION : media.duration;
}

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

  /**
   * Transición al inicio del clip. Si hay un clip pegado antes en la misma pista, es una transición
   * cruzada centrada en el corte; si no, es una entrada desde lo que haya debajo (otras pistas o el fondo).
   */
  transitionIn?: Transition;
  /** Transición de salida hacia lo que haya debajo. Solo se usa si no hay un clip pegado después. */
  transitionOut?: Transition;

  /** Si está presente, es un clip de texto (generado, sin archivo: `sourceId` vacío). */
  text?: TextContent;
  /** Si está presente, es un efecto animado superpuesto (corazones, fuegos artificiales…; `sourceId` vacío). */
  overlay?: OverlayEffect;
  /** Posición/escala/rotación/opacidad (valores estáticos; los keyframes tienen prioridad). */
  transform?: Partial<ClipTransform>;
  /** Ajustes de color. */
  adjust?: Partial<ColorAdjust>;
  /**
   * Keyframes por propiedad animable (ver ANIMATABLE_PROPS en shared/animation.ts).
   * `time` es relativo al inicio del clip en la timeline.
   */
  keyframes?: Partial<Record<AnimatableProp, Keyframe[]>>;

  /** Volumen lineal (1 = original, 2 = +6 dB). Animable con keyframes ("volume"). */
  volume?: number;
  /** Fundido de audio al inicio / final del clip (s). */
  audioFadeIn?: number;
  audioFadeOut?: number;
  /** Silencia el audio propio del clip (p. ej. tras "Separar audio"). */
  audioMuted?: boolean;
  /**
   * Velocidad de reproducción (1 = normal, 2 = el doble de rápido). La duración en la timeline es
   * (outPoint - inPoint) / speed; el tiempo dentro del archivo avanza `speed` segundos por segundo.
   */
  speed?: number;

  // ---- Futuro (no implementado todavía) ----
  effects?: Effect[];
}

/**
 * Transformación del clip dentro del cuadro. El clip primero se encaja ("contain") en el cuadro
 * del proyecto y después se aplica esto.
 */
export interface ClipTransform {
  /** Desplazamiento horizontal en fracción del ancho del cuadro (0 = centrado). */
  x: number;
  /** Desplazamiento vertical en fracción del alto del cuadro (0 = centrado, + = abajo). */
  y: number;
  /** Escala relativa al encaje (1 = ocupa el cuadro). */
  scale: number;
  /** Rotación en grados (horario). */
  rotation: number;
  /** 0..1 */
  opacity: number;
}

export interface ColorAdjust {
  /** -1..1 (0 = sin cambio) */
  brightness: number;
  /** 0..2 (1 = sin cambio) */
  contrast: number;
  /** 0..2 (1 = sin cambio) */
  saturation: number;
  /** -1 (frío) .. 1 (cálido) */
  temperature: number;
}

export const DEFAULT_TRANSFORM: ClipTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
export const DEFAULT_ADJUST: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1, temperature: 0 };

export type AnimatableProp = keyof ClipTransform | keyof ColorAdjust | 'volume';

/** Futuro: filtros/efectos aplicados al clip. */
export interface Effect {
  id: Id;
  type: string;
  enabled: boolean;
  params: Record<string, number | string | boolean>;
}

export interface Transition {
  /** Tipo de transición (nombres compatibles con el filtro xfade de FFmpeg). */
  type: TransitionType;
  /** Duración solicitada (s). Al renderizar se limita según la duración de los clips. */
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
  /**
   * Orden visual de arriba hacia abajo. Las pistas de video de arriba se componen encima
   * de las de abajo; el audio de todas las pistas se mezcla.
   */
  tracks: Track[];
  /** Marcadores en la timeline (opcional para compatibilidad con proyectos viejos). */
  markers?: Marker[];
}

export interface Marker {
  id: Id;
  /** Posición en la timeline (s). */
  time: number;
  label: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Helpers puros (usables desde main y renderer)
// ---------------------------------------------------------------------------

/** Velocidad efectiva del clip. */
export function clipSpeed(clip: Clip): number {
  return clip.speed && clip.speed > 0 ? clip.speed : 1;
}

/** Duración en la timeline (tiene en cuenta la velocidad). */
export function clipDuration(clip: Clip): number {
  return (clip.outPoint - clip.inPoint) / clipSpeed(clip);
}

/** Tiempo dentro del archivo fuente para un instante t de la timeline. */
export function sourceTime(clip: Clip, t: number): number {
  return clip.inPoint + (t - clip.start) * clipSpeed(clip);
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
    if (t.kind !== 'video' && t.kind !== 'audio') return `La pista ${t.id} tiene un tipo desconocido.`;
    if (!Array.isArray(t.clips)) return `La pista ${t.id} no tiene clips válidos.`;
    for (const c of t.clips) {
      for (const tr of [c.transitionIn, c.transitionOut]) {
        if (tr && (!isTransitionType(tr.type) || !(tr.duration > 0))) {
          return `El clip ${c.id} tiene una transición inválida.`;
        }
      }
    }
  }
  return null;
}

/** Nombre libre del estilo "Video 2" para una pista nueva. */
export function nextTrackName(project: Project, kind: TrackKind): string {
  const base = kind === 'video' ? 'Video' : 'Audio';
  const used = new Set(project.tracks.map((t) => t.name));
  let n = project.tracks.filter((t) => t.kind === kind).length + 1;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Clip generado por la app (texto o efecto), sin archivo fuente. */
export function isGeneratedClip(clip: Clip): boolean {
  return !!clip.text || !!clip.overlay;
}
