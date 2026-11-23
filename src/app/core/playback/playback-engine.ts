import { InjectionToken } from '@angular/core';
import type { Project } from '../../../../shared/model';

/**
 * Superficie donde el motor dibuja. El motor HTML (v0.x) crea sus <video> dentro de `container`;
 * un futuro motor WebCodecs + WebGL dibujará en un <canvas> dentro del mismo contenedor.
 */
export interface PlaybackSurface {
  container: HTMLElement;
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
