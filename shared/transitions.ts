import type { Clip, Track } from './model';

/**
 * Tipos de transición soportados. Los nombres (y las fórmulas) siguen al filtro `xfade` de FFmpeg;
 * se dibujan con shaders WebGL en el renderer (src/app/core/render/shaders.ts), los mismos para
 * la vista previa y la exportación.
 */
export const TRANSITION_TYPES = [
  'fade',
  'fadeblack',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'smoothleft',
  'smoothright',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'circleopen',
  'circleclose',
  'radial',
  'zoomin',
  'pixelize',
  // ---- propias de SHOTON (no existen en xfade) ----
  'fadewhite',
  'fadegrays',
  'flash',
  'zoomout',
  'blur',
  'spin',
  'swirl',
  'ripple',
  'glitch',
  'heart',
  'circlecrop',
  'rectopen',
  'horzopen',
  'vertopen',
  'diagtl',
  'diagbr',
  'blinds',
  'hblinds',
  'squares',
  'squeezeh',
  'doorway',
  'whipleft',
  'whipright',
] as const;

export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  fade: 'Fundido cruzado',
  fadeblack: 'Fundido a negro',
  dissolve: 'Disolver',
  smoothleft: 'Barrido suave (izq.)',
  smoothright: 'Barrido suave (der.)',
  radial: 'Radial',
  pixelize: 'Pixelar',
  wipeleft: 'Barrido a la izquierda',
  wiperight: 'Barrido a la derecha',
  wipeup: 'Barrido hacia arriba',
  wipedown: 'Barrido hacia abajo',
  slideleft: 'Deslizar a la izquierda',
  slideright: 'Deslizar a la derecha',
  slideup: 'Deslizar hacia arriba',
  slidedown: 'Deslizar hacia abajo',
  circleopen: 'Círculo (abrir)',
  circleclose: 'Círculo (cerrar)',
  zoomin: 'Zoom',
  fadewhite: 'Fundido a blanco',
  fadegrays: 'Fundido en grises',
  flash: 'Destello',
  zoomout: 'Alejar',
  blur: 'Desenfoque',
  spin: 'Giro',
  swirl: 'Remolino',
  ripple: 'Onda',
  glitch: 'Glitch',
  heart: 'Corazón',
  circlecrop: 'Iris',
  rectopen: 'Rectángulo',
  horzopen: 'Abrir horizontal',
  vertopen: 'Abrir vertical',
  diagtl: 'Diagonal',
  diagbr: 'Diagonal (inversa)',
  blinds: 'Persianas',
  hblinds: 'Persianas horizontales',
  squares: 'Mosaico',
  squeezeh: 'Comprimir',
  doorway: 'Puertas',
  whipleft: 'Barrido rápido (izq.)',
  whipright: 'Barrido rápido (der.)',
};

export const DEFAULT_TRANSITION_DURATION = 1;
export const MIN_TRANSITION_DURATION = 0.05;

/** Dos clips se consideran pegados si el hueco entre ellos es menor a esto (s). */
export const ADJACENT_EPS = 1e-3;

export function isTransitionType(value: unknown): value is TransitionType {
  return typeof value === 'string' && (TRANSITION_TYPES as readonly string[]).includes(value);
}

/**
 * Transición ya resuelta en el tiempo de la timeline.
 *  - cross: entre `from` y `to`, centrada en el corte; ventana [start, end] = [corte - d/2, corte + d/2].
 *    Durante la ventana `from` se extiende más allá de su final y `to` empieza antes (con material
 *    extra del archivo fuente o, si no hay, congelando el primer/último cuadro).
 *  - in: entrada de `to` desde lo que haya debajo; ventana [inicio, inicio + d].
 *  - out: salida de `from` hacia lo que haya debajo; ventana [fin - d, fin].
 */
export type ResolvedTransition =
  | { kind: 'cross'; type: TransitionType; duration: number; start: number; end: number; from: Clip; to: Clip }
  | { kind: 'in'; type: TransitionType; duration: number; start: number; end: number; to: Clip }
  | { kind: 'out'; type: TransitionType; duration: number; start: number; end: number; from: Clip };

// Igual que clipDuration (model.ts); se repite para no crear una dependencia circular en runtime.
const dur = (c: Clip) => (c.outPoint - c.inPoint) / (c.speed && c.speed > 0 ? c.speed : 1);
const end = (c: Clip) => c.start + dur(c);

/**
 * Calcula las transiciones efectivas de una pista. Las duraciones se limitan para que las
 * ventanas de transición de un mismo clip nunca se superpongan.
 */
export function resolveTransitions(track: Track): ResolvedTransition[] {
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  const out: ResolvedTransition[] = [];
  /** Tiempo del clip ya consumido por su transición de inicio. */
  const usedAtStart = new Map<string, number>();

  clips.forEach((clip, i) => {
    const prev = clips[i - 1];
    const next = clips[i + 1];
    const prevAdjacent = !!prev && Math.abs(end(prev) - clip.start) < ADJACENT_EPS;
    const nextAdjacent = !!next && Math.abs(end(clip) - next.start) < ADJACENT_EPS;

    if (clip.transitionIn) {
      const { type, duration } = clip.transitionIn;
      if (prevAdjacent) {
        const availablePrev = 2 * (dur(prev) - (usedAtStart.get(prev.id) ?? 0));
        const d = Math.min(duration, availablePrev, dur(clip));
        if (d >= MIN_TRANSITION_DURATION) {
          const cut = clip.start;
          out.push({ kind: 'cross', type, duration: d, start: cut - d / 2, end: cut + d / 2, from: prev, to: clip });
          usedAtStart.set(clip.id, d / 2);
        }
      } else {
        const d = Math.min(duration, dur(clip));
        if (d >= MIN_TRANSITION_DURATION) {
          out.push({ kind: 'in', type, duration: d, start: clip.start, end: clip.start + d, to: clip });
          usedAtStart.set(clip.id, d);
        }
      }
    }

    if (clip.transitionOut && !nextAdjacent) {
      const { type, duration } = clip.transitionOut;
      const d = Math.min(duration, dur(clip) - (usedAtStart.get(clip.id) ?? 0));
      if (d >= MIN_TRANSITION_DURATION) {
        out.push({ kind: 'out', type, duration: d, start: end(clip) - d, end: end(clip), from: clip });
      }
    }
  });
  return out;
}

/** Extensión (s) que necesita cada clip antes de su inicio y después de su final por transiciones cruzadas. */
export function crossExtensions(transitions: ResolvedTransition[]): Map<string, { head: number; tail: number }> {
  const map = new Map<string, { head: number; tail: number }>();
  const get = (id: string) => {
    let v = map.get(id);
    if (!v) map.set(id, (v = { head: 0, tail: 0 }));
    return v;
  };
  for (const t of transitions) {
    if (t.kind !== 'cross') continue;
    get(t.from.id).tail = t.duration / 2;
    get(t.to.id).head = t.duration / 2;
  }
  return map;
}
