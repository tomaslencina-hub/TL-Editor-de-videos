/**
 * Operaciones puras sobre las propiedades visuales del clip (transformación, color) y sus keyframes.
 * Los tiempos de keyframe son relativos al inicio del clip en la timeline.
 */
import { ADJUST_PROPS, KEYFRAME_EPS, propValue, TRANSFORM_PROPS } from '../../../../shared/animation';
import {
  DEFAULT_ADJUST,
  DEFAULT_TRANSFORM,
  type AnimatableProp,
  type Clip,
  type ColorAdjust,
  type ClipTransform,
  type Id,
  type Keyframe,
  type Project,
} from '../../../../shared/model';
import { findClip } from './timeline-ops';

export { KEYFRAME_EPS };

const isTransformProp = (p: AnimatableProp): p is keyof ClipTransform => (TRANSFORM_PROPS as readonly string[]).includes(p);

function mapClip(project: Project, clipId: Id, fn: (c: Clip) => Clip): Project {
  const ref = findClip(project, clipId);
  if (!ref) return project;
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === ref.track.id ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) } : t)),
  };
}

function withStatic(clip: Clip, prop: AnimatableProp, value: number): Clip {
  if (prop === 'volume') return { ...clip, volume: value };
  return isTransformProp(prop)
    ? { ...clip, transform: { ...clip.transform, [prop]: value } }
    : { ...clip, adjust: { ...clip.adjust, [prop]: value } };
}

function withKeys(clip: Clip, prop: AnimatableProp, keys: Keyframe[]): Clip {
  const keyframes = { ...clip.keyframes };
  if (keys.length) keyframes[prop] = keys;
  else delete keyframes[prop];
  return { ...clip, keyframes: Object.keys(keyframes).length ? keyframes : undefined };
}

function upsertKey(keys: readonly Keyframe[], time: number, value: number): Keyframe[] {
  const i = keys.findIndex((k) => Math.abs(k.time - time) < KEYFRAME_EPS);
  if (i >= 0) return keys.map((k, j) => (j === i ? { ...k, value } : k));
  return [...keys, { time, value }].sort((a, b) => a.time - b.time);
}

/**
 * Cambia una propiedad. Si la propiedad ya tiene keyframes, agrega/actualiza el keyframe en `clipTime`
 * (auto-key); si no, cambia el valor estático.
 */
export function setClipProp(project: Project, clipId: Id, prop: AnimatableProp, value: number, clipTime: number): Project {
  return mapClip(project, clipId, (c) => {
    const keys = c.keyframes?.[prop];
    return keys?.length ? withKeys(c, prop, upsertKey(keys, clipTime, value)) : withStatic(c, prop, value);
  });
}

/** Agrega un keyframe con el valor actual en `clipTime`, o lo quita si ya hay uno ahí. */
export function toggleKeyframe(project: Project, clipId: Id, prop: AnimatableProp, clipTime: number): Project {
  return mapClip(project, clipId, (c) => {
    const keys = c.keyframes?.[prop] ?? [];
    const current = propValue(c, prop, clipTime);
    const existing = keys.findIndex((k) => Math.abs(k.time - clipTime) < KEYFRAME_EPS);
    if (existing < 0) return withKeys(c, prop, upsertKey(keys, clipTime, current));
    const remaining = keys.filter((_, i) => i !== existing);
    // Sin keyframes, la propiedad queda fija en el valor que tenía en ese instante.
    return remaining.length ? withKeys(c, prop, remaining) : withStatic(withKeys(c, prop, []), prop, current);
  });
}

export function hasKeyframeAt(clip: Clip, prop: AnimatableProp, clipTime: number): boolean {
  return !!clip.keyframes?.[prop]?.some((k) => Math.abs(k.time - clipTime) < KEYFRAME_EPS);
}

/** Tiempos (relativos al clip) de todos los keyframes del clip, sin repetir. */
export function keyframeTimes(clip: Clip): number[] {
  const times: number[] = [];
  for (const keys of Object.values(clip.keyframes ?? {})) {
    for (const k of keys ?? []) if (!times.some((t) => Math.abs(t - k.time) < KEYFRAME_EPS)) times.push(k.time);
  }
  return times.sort((a, b) => a - b);
}

/** Restablece un grupo de propiedades (y sus keyframes). */
export function resetClipProps(project: Project, clipId: Id, group: 'transform' | 'adjust'): Project {
  const props: readonly AnimatableProp[] = group === 'transform' ? TRANSFORM_PROPS : ADJUST_PROPS;
  return mapClip(project, clipId, (c) => {
    let next: Clip = group === 'transform' ? { ...c, transform: undefined } : { ...c, adjust: undefined };
    for (const p of props) next = withKeys(next, p, []);
    return next;
  });
}

/** Aplica varias propiedades de una vez (p. ej. arrastrar en la vista previa mueve x e y). */
export function setClipProps(project: Project, clipId: Id, values: Partial<Record<AnimatableProp, number>>, clipTime: number): Project {
  let p = project;
  for (const [prop, value] of Object.entries(values) as [AnimatableProp, number][]) {
    p = setClipProp(p, clipId, prop, value, clipTime);
  }
  return p;
}

export const DEFAULTS: Record<AnimatableProp, number> = { ...DEFAULT_TRANSFORM, ...DEFAULT_ADJUST } as Record<
  AnimatableProp,
  number
>;
export type { ColorAdjust, ClipTransform };
