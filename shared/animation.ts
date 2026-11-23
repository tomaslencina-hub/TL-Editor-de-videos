import {
  DEFAULT_ADJUST,
  DEFAULT_TRANSFORM,
  type AnimatableProp,
  type Clip,
  type ColorAdjust,
  type ClipTransform,
  type Keyframe,
} from './model';

/** Dos keyframes a menos de esto se consideran el mismo (≈ medio cuadro a 60 fps). */
export const KEYFRAME_EPS = 1 / 120;

export const TRANSFORM_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const satisfies readonly (keyof ClipTransform)[];
export const ADJUST_PROPS = ['brightness', 'contrast', 'saturation', 'temperature'] as const satisfies readonly (keyof ColorAdjust)[];
export const ANIMATABLE_PROPS: readonly AnimatableProp[] = [...TRANSFORM_PROPS, ...ADJUST_PROPS, 'volume'];

export interface VisualParams {
  transform: ClipTransform;
  adjust: ColorAdjust;
}

function ease(t: number, easing: Keyframe['easing']): number {
  switch (easing) {
    case 'ease-in':
      return t * t;
    case 'ease-out':
      return 1 - (1 - t) * (1 - t);
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    case 'hold':
      return 0;
    default:
      return t;
  }
}

/** Valor de una curva de keyframes en `time` (relativo al inicio del clip). El easing es el del keyframe de salida. */
export function evaluateKeyframes(keys: readonly Keyframe[], time: number): number {
  if (keys.length === 1 || time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      const t = span > 0 ? (time - a.time) / span : 1;
      return a.value + (b.value - a.value) * ease(t, a.easing);
    }
  }
  return last.value;
}

/** Valor de una propiedad del clip en `clipTime` (segundos desde el inicio del clip en la timeline). */
export function propValue(clip: Clip, prop: AnimatableProp, clipTime: number): number {
  const keys = clip.keyframes?.[prop];
  if (keys && keys.length) return evaluateKeyframes(keys, clipTime);
  if (prop === 'volume') return clip.volume ?? 1;
  if (prop in DEFAULT_TRANSFORM) {
    return clip.transform?.[prop as keyof ClipTransform] ?? DEFAULT_TRANSFORM[prop as keyof ClipTransform];
  }
  return clip.adjust?.[prop as keyof ColorAdjust] ?? DEFAULT_ADJUST[prop as keyof ColorAdjust];
}

/** Parámetros visuales completos del clip en un instante. */
export function visualParams(clip: Clip, clipTime: number): VisualParams {
  const transform = { ...DEFAULT_TRANSFORM };
  for (const p of TRANSFORM_PROPS) transform[p] = propValue(clip, p, clipTime);
  const adjust = { ...DEFAULT_ADJUST };
  for (const p of ADJUST_PROPS) adjust[p] = propValue(clip, p, clipTime);
  return { transform, adjust };
}

// ---------------------------------------------------------------------------- edición de clips (dividir / recortar)

/** Desplaza los keyframes cuando cambia el inicio del clip (trim desde el inicio): siguen pegados al contenido. */
export function shiftKeyframes(clip: Clip, delta: number): Clip {
  if (!clip.keyframes || delta === 0) return clip;
  const keyframes: Clip['keyframes'] = {};
  for (const [prop, keys] of Object.entries(clip.keyframes) as [AnimatableProp, Keyframe[]][]) {
    keyframes[prop] = keys.map((k) => ({ ...k, time: k.time - delta }));
  }
  return { ...clip, keyframes };
}

/** Parte los keyframes en `offset` (relativo al clip): la izquierda termina y la derecha empieza con el valor exacto del corte. */
export function splitKeyframes(clip: Clip, offset: number): { left: Clip['keyframes']; right: Clip['keyframes'] } {
  if (!clip.keyframes) return { left: undefined, right: undefined };
  const left: NonNullable<Clip['keyframes']> = {};
  const right: NonNullable<Clip['keyframes']> = {};
  for (const [prop, keys] of Object.entries(clip.keyframes) as [AnimatableProp, Keyframe[]][]) {
    if (!keys.length) continue;
    const at = evaluateKeyframes(keys, offset);
    left[prop] = [...keys.filter((k) => k.time < offset - KEYFRAME_EPS), { time: offset, value: at }];
    right[prop] = [{ time: 0, value: at }, ...keys.filter((k) => k.time > offset + KEYFRAME_EPS).map((k) => ({ ...k, time: k.time - offset }))];
  }
  return { left, right };
}


// ---------------------------------------------------------------------------- audio

/** Ganancia lineal del clip en `clipTime`: volumen (con keyframes) × fundidos de entrada/salida. */
export function audioGain(clip: Clip, clipTime: number, clipDur: number): number {
  let g = propValue(clip, 'volume', clipTime);
  const fin = clip.audioFadeIn ?? 0;
  const fout = clip.audioFadeOut ?? 0;
  if (fin > 0) g *= Math.min(1, Math.max(0, clipTime / fin));
  if (fout > 0) g *= Math.min(1, Math.max(0, (clipDur - clipTime) / fout));
  return Math.max(0, g);
}
