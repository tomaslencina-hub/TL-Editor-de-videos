import { InjectionToken } from '@angular/core';
import type { Project } from '../../../../shared/model';

/**
 * Superficies donde el motor dibuja/reproduce. La implementación v0.1 usa <video>/<audio>;
 * una futura implementación WebCodecs + WebGL usará el <canvas> y un AudioContext.
 */
export interface PlaybackSurface {
  video: HTMLVideoElement;
  audio: HTMLAudioElement;
  canvas?: HTMLCanvasElement;
}

/**
 * Motor de reproducción: dado el modelo y un tiempo de timeline, produce la salida.
 * El reloj (play/pausa/seek) vive en PlaybackService, así el motor es intercambiable.
 */
export interface PlaybackEngine {
  attach(surface: PlaybackSurface): void;
  detach(): void;
  /** Llamado en cada frame mientras se reproduce y en cada seek estando en pausa. */
  sync(project: Project, time: number, playing: boolean): void;
  /** Detiene toda salida (pausa elementos, silencia). */
  halt(): void;
}

export const PLAYBACK_ENGINE = new InjectionToken<PlaybackEngine>('PLAYBACK_ENGINE');
