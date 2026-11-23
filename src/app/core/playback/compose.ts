import type { Clip, Track } from '../../../../shared/model';
import type { ResolvedTransition, TransitionType } from '../../../../shared/transitions';
import { clipAt } from '../timeline/timeline-ops';

/**
 * Qué se ve/oye de una pista en el instante t. Módulo puro: lo usa el motor HTML de la v0.x
 * y lo podrá usar un motor WebCodecs/WebGL.
 */
export interface Layer {
  clip: Clip;
  /** Tiempo dentro del archivo fuente (puede quedar fuera de [0, duración] en extensiones de transición). */
  local: number;
  /** 'from' = clip saliente, 'to' = clip entrante, 'main' = sin transición. */
  role: 'main' | 'from' | 'to';
}

export interface TrackFrame {
  layers: Layer[];
  /** Transición activa y su progreso 0..1. */
  transition?: { type: TransitionType; kind: ResolvedTransition['kind']; progress: number };
}

const local = (clip: Clip, t: number) => clip.inPoint + (t - clip.start);

export function composeTrack(track: Track, transitions: ResolvedTransition[], t: number): TrackFrame {
  for (const tr of transitions) {
    if (t < tr.start || t >= tr.end) continue;
    const progress = (t - tr.start) / (tr.end - tr.start);
    const transition = { type: tr.type, kind: tr.kind, progress };
    if (tr.kind === 'cross') {
      return {
        layers: [
          { clip: tr.from, local: local(tr.from, t), role: 'from' },
          { clip: tr.to, local: local(tr.to, t), role: 'to' },
        ],
        transition,
      };
    }
    if (tr.kind === 'in') return { layers: [{ clip: tr.to, local: local(tr.to, t), role: 'to' }], transition };
    return { layers: [{ clip: tr.from, local: local(tr.from, t), role: 'from' }], transition };
  }
  const clip = clipAt(track, t);
  return clip ? { layers: [{ clip, local: local(clip, t), role: 'main' }] } : { layers: [] };
}
