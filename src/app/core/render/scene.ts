import { visualParams } from '../../../../shared/animation';
import { clipDuration, type Clip, type Project, type Track } from '../../../../shared/model';
import { textAnimation } from '../../../../shared/text';
import { resolveTransitions, type ResolvedTransition } from '../../../../shared/transitions';
import { composeTrack, type Layer } from '../playback/compose';
import type { LayerDraw, TrackDraw } from './compositor';

/** Pistas que se dibujan (las de audio no). */
export function visualTracks(project: Project): Track[] {
  return project.tracks.filter((t) => t.kind !== 'audio');
}

/** Cachea transiciones resueltas por referencia de pista (las pistas son inmutables). */
export class TransitionCache {
  private readonly cache = new WeakMap<Track, ResolvedTransition[]>();
  get(track: Track): ResolvedTransition[] {
    let v = this.cache.get(track);
    if (!v) this.cache.set(track, (v = resolveTransitions(track)));
    return v;
  }
}

export interface PlannedTrack {
  track: Track;
  layers: Layer[];
  transition?: { type: ResolvedTransition['type']; kind: ResolvedTransition['kind']; progress: number };
}

/** Qué se ve en el instante t, de la pista de abajo a la de arriba. */
export function planFrame(project: Project, t: number, transitions: TransitionCache): PlannedTrack[] {
  return visualTracks(project)
    .slice()
    .reverse()
    .map((track) => {
      const frame = composeTrack(track, transitions.get(track), t);
      return { track, layers: frame.layers, transition: frame.transition };
    })
    .filter((p) => p.layers.length > 0);
}

export interface ResolvedSource {
  texture: string;
  width: number;
  height: number;
  sourceRotation?: number;
  fit?: 'contain' | 'none';
}

/**
 * Convierte el plan en instrucciones de dibujo. `resolve` sube la textura de cada capa
 * (desde un <video>, un VideoFrame, un canvas de texto…) y devuelve su clave, o null si no hay cuadro.
 */
export function toTrackDraws(
  plan: PlannedTrack[],
  t: number,
  resolve: (track: Track, layer: Layer) => ResolvedSource | null,
): TrackDraw[] {
  const draws: TrackDraw[] = [];
  for (const p of plan) {
    const make = (layer: Layer): LayerDraw | undefined => {
      const src = resolve(p.track, layer);
      if (!src) return undefined;
      const { transform, adjust } = visualParams(layer.clip, clipTime(layer.clip, t));
      if (layer.clip.text) {
        // Animaciones de entrada/salida del texto (se suman a la transformación del clip).
        const anim = textAnimation(layer.clip.text, clipTime(layer.clip, t), clipDuration(layer.clip));
        transform.opacity *= anim.opacity;
        transform.y += anim.dy;
        transform.scale *= anim.scale;
        transform.rotation += anim.rotation;
      }
      return { ...src, transform, adjust, flipX: !!layer.clip.flipH, flipY: !!layer.clip.flipV };
    };
    if (p.transition) {
      const from = p.layers.find((l) => l.role === 'from');
      const to = p.layers.find((l) => l.role === 'to');
      draws.push({
        from: from && make(from),
        to: to && make(to),
        transition: { type: p.transition.type, progress: p.transition.progress },
      });
    } else {
      const main = make(p.layers[0]);
      if (main) draws.push({ main });
    }
  }
  return draws;
}

/** Tiempo transcurrido desde el inicio del clip en la timeline (base de los keyframes). */
export function clipTime(clip: Clip, t: number): number {
  return t - clip.start;
}
