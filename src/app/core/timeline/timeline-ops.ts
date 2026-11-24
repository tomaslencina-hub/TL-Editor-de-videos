/**
 * Operaciones puras sobre el modelo (Project -> Project).
 * No dependen de Angular: son la "lógica de timeline" y se pueden testear aisladas.
 *
 * Política de superposición v0.1: "sobrescribir" (como un NLE clásico).
 * Al soltar/mover un clip sobre otros, los clips debajo se recortan, dividen o eliminan.
 * El trim, en cambio, se limita a los vecinos (nunca sobrescribe).
 */
import {
  clipDuration,
  clipEnd,
  clipSpeed,
  initialClipDuration,
  nextTrackName,
  sourceTime,
  type Clip,
  type Id,
  type Marker,
  type MediaSource,
  type Project,
  type ProjectSettings,
  type Track,
  type TrackKind,
  type Transition,
} from '../../../../shared/model';
import { shiftKeyframes, splitKeyframes } from '../../../../shared/animation';
import { DEFAULT_OVERLAY_DURATION, type OverlayEffect } from '../../../../shared/effects';
import { subtitleText, type SubtitleStyle, type TextContent } from '../../../../shared/text';
import { ADJACENT_EPS } from '../../../../shared/transitions';

export const EPS = 1e-6;

export interface ClipRef {
  track: Track;
  clip: Clip;
}

export function newId(prefix: string): Id {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function findClip(project: Project, clipId: Id): ClipRef | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function findMedia(project: Project, sourceId: Id): MediaSource | undefined {
  return project.media.find((m) => m.id === sourceId);
}

/** ¿Puede un medio ir en una pista de este tipo? */
export function isCompatible(media: Pick<MediaSource, 'hasVideo' | 'hasAudio'>, track: Track): boolean {
  return track.kind === 'video' ? media.hasVideo : media.hasAudio;
}

export function clipAt(track: Track, t: number): Clip | undefined {
  return track.clips.find((c) => t >= c.start - EPS && t < clipEnd(c) - EPS);
}

function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

function updateTrack(project: Project, trackId: Id, fn: (t: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

/**
 * Libera el rango [start, end) en una lista de clips: recorta, divide o elimina lo que se superpone.
 */
export function clearRange(clips: Clip[], start: number, end: number, excludeId?: Id): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const cs = c.start;
    const ce = clipEnd(c);
    if (c.id === excludeId || ce <= start + EPS || cs >= end - EPS) {
      out.push(c);
      continue;
    }
    const sp = clipSpeed(c);
    // Parte izquierda que queda antes del rango (conserva la transición de entrada).
    if (cs < start - EPS) {
      out.push(withoutTransition({ ...c, outPoint: c.inPoint + (start - cs) * sp }, 'out'));
    }
    // Parte derecha que queda después del rango (conserva la transición de salida).
    if (ce > end + EPS) {
      const right: Clip = shiftKeyframes(withoutTransition({ ...c, start: end, inPoint: c.inPoint + (end - cs) * sp }, 'in'), end - cs);
      // Si también hubo parte izquierda, la derecha es un clip nuevo.
      if (cs < start - EPS) right.id = newId('clip');
      out.push(right);
    }
  }
  return out;
}

/** Inserta un clip en modo sobrescritura. */
export function insertClip(project: Project, trackId: Id, clip: Clip): Project {
  return updateTrack(project, trackId, (t) => ({
    ...t,
    clips: sortClips([...clearRange(t.clips, clip.start, clipEnd(clip)), clip]),
  }));
}

/** Mueve un clip (posible cambio de pista del mismo tipo) en modo sobrescritura. */
export function moveClip(project: Project, clipId: Id, toTrackId: Id, newStart: number): Project {
  const ref = findClip(project, clipId);
  if (!ref) return project;
  const moved: Clip = { ...ref.clip, start: Math.max(0, newStart) };
  const removed = updateTrack(project, ref.track.id, (t) => ({
    ...t,
    clips: t.clips.filter((c) => c.id !== clipId),
  }));
  return insertClip(removed, toTrackId, moved);
}

export type TrimEdge = 'start' | 'end';

export interface TrimLimits {
  /** Rango permitido para la posición del borde en la timeline. */
  min: number;
  max: number;
}

/** Límites para el borde que se recorta: duración del archivo fuente, vecinos y duración mínima (1 frame). */
export function trimLimits(project: Project, clipId: Id, edge: TrimEdge): TrimLimits | null {
  const ref = findClip(project, clipId);
  if (!ref) return null;
  const { clip, track } = ref;
  const media = findMedia(project, clip.sourceId);
  // Texto e imágenes no tienen un final de material: se pueden estirar sin límite.
  const sourceDuration =
    clip.text || clip.overlay || media?.kind === 'image' ? Number.POSITIVE_INFINITY : (media?.duration ?? clip.outPoint);
  const sp = clipSpeed(clip);
  const minDur = 1 / project.settings.fps;
  const others = track.clips.filter((c) => c.id !== clipId);

  if (edge === 'start') {
    const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= clip.start + EPS).map(clipEnd));
    const min = Math.max(prevEnd, clip.start - clip.inPoint / sp);
    const max = clipEnd(clip) - minDur;
    return { min, max };
  }
  const nextStart = Math.min(Infinity, ...others.filter((c) => c.start >= clipEnd(clip) - EPS).map((c) => c.start));
  const min = clip.start + minDur;
  const max = Math.min(nextStart, clip.start + (sourceDuration - clip.inPoint) / sp);
  return { min, max };
}

/** Recorta un borde del clip para que quede en `edgeTime` (posición en la timeline). */
export function trimClip(project: Project, clipId: Id, edge: TrimEdge, edgeTime: number): Project {
  const ref = findClip(project, clipId);
  const limits = trimLimits(project, clipId, edge);
  if (!ref || !limits) return project;
  const t = Math.min(limits.max, Math.max(limits.min, edgeTime));
  const { clip, track } = ref;
  const updated: Clip =
    edge === 'start'
      ? shiftKeyframes({ ...clip, start: t, inPoint: sourceTime(clip, t) }, t - clip.start)
      : { ...clip, outPoint: sourceTime(clip, t) };
  return updateTrack(project, track.id, (tr) => ({
    ...tr,
    clips: tr.clips.map((c) => (c.id === clipId ? updated : c)),
  }));
}

/** Divide un clip en `t`. Devuelve el proyecto sin cambios si `t` no cae dentro del clip. */
export function splitClip(project: Project, clipId: Id, t: number): Project {
  const ref = findClip(project, clipId);
  if (!ref) return project;
  const { clip, track } = ref;
  const minDur = 1 / project.settings.fps;
  if (t <= clip.start + minDur - EPS || t >= clipEnd(clip) - minDur + EPS) return project;
  const cut = sourceTime(clip, t);
  const keys = splitKeyframes(clip, t - clip.start);
  const left: Clip = withoutTransition({ ...clip, outPoint: cut, keyframes: keys.left }, 'out');
  const right: Clip = withoutTransition({ ...clip, id: newId('clip'), start: t, inPoint: cut, keyframes: keys.right }, 'in');
  return updateTrack(project, track.id, (tr) => ({
    ...tr,
    clips: sortClips(tr.clips.flatMap((c) => (c.id === clipId ? [left, right] : [c]))),
  }));
}

export function deleteClips(project: Project, clipIds: Id[]): Project {
  const ids = new Set(clipIds);
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      t.clips.some((c) => ids.has(c.id)) ? { ...t, clips: t.clips.filter((c) => !ids.has(c.id)) } : t,
    ),
  };
}

/**
 * Borrado "ripple": quita los clips y corre hacia la izquierda lo que viene después en su pista,
 * cerrando el hueco (no toca las otras pistas).
 */
export function rippleDelete(project: Project, clipIds: Id[]): Project {
  const ids = new Set(clipIds);
  return {
    ...project,
    tracks: project.tracks.map((t) => {
      const removed = t.clips.filter((c) => ids.has(c.id)).sort((a, b) => a.start - b.start);
      if (!removed.length || t.locked) return t;
      const kept = t.clips.filter((c) => !ids.has(c.id));
      return {
        ...t,
        clips: kept.map((c) => {
          // Cuánto tiempo borrado hay antes de este clip.
          const shift = removed.filter((r) => clipEnd(r) <= c.start + EPS).reduce((acc, r) => acc + clipDuration(r), 0);
          return shift > 0 ? { ...c, start: Math.max(0, c.start - shift) } : c;
        }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------- portapapeles

/** Clips copiados: posición relativa al primero y pista de origen. */
export interface ClipboardData {
  items: { trackId: Id; trackKind: TrackKind; offset: number; clip: Clip }[];
}

export function copyClips(project: Project, clipIds: Id[]): ClipboardData | null {
  const refs = clipIds.map((id) => findClip(project, id)).filter((r): r is ClipRef => !!r);
  if (!refs.length) return null;
  const first = Math.min(...refs.map((r) => r.clip.start));
  return {
    items: refs.map((r) => ({ trackId: r.track.id, trackKind: r.track.kind, offset: r.clip.start - first, clip: r.clip })),
  };
}

/**
 * Pega en `at`: cada clip vuelve a su pista (o a la primera del mismo tipo si ya no existe), en modo
 * sobrescritura. Devuelve los ids nuevos para seleccionarlos.
 */
export function pasteClips(project: Project, data: ClipboardData, at: number): { project: Project; ids: Id[] } {
  let p = project;
  const ids: Id[] = [];
  for (const item of data.items) {
    const track =
      p.tracks.find((t) => t.id === item.trackId && !t.locked) ?? p.tracks.find((t) => t.kind === item.trackKind && !t.locked);
    if (!track) continue;
    const clip: Clip = { ...item.clip, id: newId('clip'), start: Math.max(0, at + item.offset) };
    p = insertClip(p, track.id, clip);
    ids.push(clip.id);
  }
  return { project: p, ids };
}

// ---------------------------------------------------------------------------- marcadores y pistas

const MARKER_COLORS = ['#ffd84d', '#19c3b0', '#ff4dd2', '#4d9bff', '#ff8a3d'];

export function addMarker(project: Project, time: number): { project: Project; marker: Marker } {
  const markers = project.markers ?? [];
  const existing = markers.find((m) => Math.abs(m.time - time) < 1e-3);
  if (existing) return { project, marker: existing };
  const marker: Marker = {
    id: newId('marker'),
    time,
    label: `Marcador ${markers.length + 1}`,
    color: MARKER_COLORS[markers.length % MARKER_COLORS.length],
  };
  return { project: { ...project, markers: [...markers, marker].sort((a, b) => a.time - b.time) }, marker };
}

export function removeMarker(project: Project, id: Id): Project {
  return { ...project, markers: (project.markers ?? []).filter((m) => m.id !== id) };
}

/** Mueve una pista una posición arriba/abajo, sin mezclar las de video con las de audio. */
export function moveTrack(project: Project, trackId: Id, direction: -1 | 1): Project {
  const i = project.tracks.findIndex((t) => t.id === trackId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= project.tracks.length || project.tracks[j].kind !== project.tracks[i].kind) return project;
  const tracks = [...project.tracks];
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  return { ...project, tracks };
}

export function addMedia(project: Project, media: MediaSource[]): Project {
  return { ...project, media: [...project.media, ...media] };
}

/** Quita un medio y todos los clips que lo usan. */
export function removeMedia(project: Project, sourceId: Id): Project {
  return {
    ...project,
    media: project.media.filter((m) => m.id !== sourceId),
    tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.sourceId !== sourceId) })),
  };
}

export function updateSettings(project: Project, patch: Partial<ProjectSettings>): Project {
  return { ...project, settings: { ...project.settings, ...patch } };
}

export function updateTrackProps(project: Project, trackId: Id, patch: Partial<Pick<Track, 'muted' | 'locked' | 'name'>>): Project {
  return updateTrack(project, trackId, (t) => ({ ...t, ...patch }));
}

export function renameProject(project: Project, name: string): Project {
  return { ...project, name };
}

// ---------------------------------------------------------------------------- pistas

/** Agrega una pista: las de video arriba de las de video existentes, las de audio al final. */
export function addTrack(project: Project, kind: TrackKind, name = nextTrackName(project, kind)): { project: Project; track: Track } {
  const track: Track = { id: newId('track'), kind, name, muted: false, locked: false, clips: [] };
  const tracks = [...project.tracks];
  if (kind === 'video') {
    const firstVideo = tracks.findIndex((t) => t.kind === 'video');
    tracks.splice(firstVideo < 0 ? 0 : firstVideo, 0, track);
  } else {
    tracks.push(track);
  }
  return { project: { ...project, tracks }, track };
}

/** Quita una pista (y sus clips). Siempre deja al menos una pista de cada tipo. */
export function removeTrack(project: Project, trackId: Id): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || !canRemoveTrack(project, trackId)) return project;
  return { ...project, tracks: project.tracks.filter((t) => t.id !== trackId) };
}

export function canRemoveTrack(project: Project, trackId: Id): boolean {
  const track = project.tracks.find((t) => t.id === trackId);
  return !!track && project.tracks.filter((t) => t.kind === track.kind).length > 1;
}

// ---------------------------------------------------------------------------- transiciones

export type ClipEdge = 'in' | 'out';

function withoutTransition(clip: Clip, edge: ClipEdge): Clip {
  const key = edge === 'in' ? 'transitionIn' : 'transitionOut';
  if (!clip[key]) return clip;
  const copy = { ...clip };
  delete copy[key];
  return copy;
}

/** El clip pegado inmediatamente antes/después en la misma pista, si existe. */
export function adjacentClip(track: Track, clip: Clip, side: 'prev' | 'next'): Clip | undefined {
  return side === 'prev'
    ? track.clips.find((c) => c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < ADJACENT_EPS)
    : track.clips.find((c) => c.id !== clip.id && Math.abs(c.start - clipEnd(clip)) < ADJACENT_EPS);
}

/**
 * Normaliza dónde se guarda una transición: la salida de un clip con otro pegado después
 * es, en realidad, la entrada (cruzada) del siguiente.
 */
export function transitionTarget(project: Project, clipId: Id, edge: ClipEdge): { clipId: Id; edge: ClipEdge } | null {
  const ref = findClip(project, clipId);
  if (!ref) return null;
  if (edge === 'out') {
    const next = adjacentClip(ref.track, ref.clip, 'next');
    if (next) return { clipId: next.id, edge: 'in' };
  }
  return { clipId, edge };
}

/** Duración máxima razonable para una transición en ese borde. */
export function maxTransitionDuration(project: Project, clipId: Id, edge: ClipEdge): number {
  const ref = findClip(project, clipId);
  if (!ref) return 0;
  const d = clipDuration(ref.clip);
  if (edge === 'in') {
    const prev = adjacentClip(ref.track, ref.clip, 'prev');
    return prev ? Math.min(d, clipDuration(prev)) : d;
  }
  return d;
}

export function setTransition(project: Project, clipId: Id, edge: ClipEdge, transition: Transition | null): Project {
  const ref = findClip(project, clipId);
  if (!ref) return project;
  const key = edge === 'in' ? 'transitionIn' : 'transitionOut';
  const updated: Clip = transition
    ? { ...ref.clip, [key]: { type: transition.type, duration: transition.duration } }
    : withoutTransition(ref.clip, edge);
  return updateTrack(project, ref.track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? updated : c)),
  }));
}

// ---------------------------------------------------------------------------- audio y velocidad

export type ClipAudioPatch = Partial<Pick<Clip, 'volume' | 'audioFadeIn' | 'audioFadeOut' | 'audioMuted'>>;

export function setClipFields(project: Project, clipId: Id, patch: ClipAudioPatch): Project {
  const ref = findClip(project, clipId);
  if (!ref) return project;
  return updateTrack(project, ref.track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
  }));
}

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 16;

/**
 * Cambia la velocidad manteniendo el inicio y el material del clip. Si al hacerse más lento
 * chocaría con el clip siguiente, se recorta el final. Los keyframes se escalan con la duración.
 */
export function setClipSpeed(project: Project, clipId: Id, speed: number): Project {
  const ref = findClip(project, clipId);
  if (!ref) return project;
  const { clip, track } = ref;
  const sp = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  const oldSp = clipSpeed(clip);
  if (Math.abs(sp - oldSp) < 1e-9) return project;
  let outPoint = clip.outPoint;
  const next = track.clips
    .filter((c) => c.id !== clip.id && c.start >= clipEnd(clip) - EPS)
    .reduce((min, c) => Math.min(min, c.start), Infinity);
  if (clip.start + (outPoint - clip.inPoint) / sp > next + EPS) outPoint = clip.inPoint + (next - clip.start) * sp;
  const ratio = oldSp / sp;
  const keyframes = clip.keyframes
    ? Object.fromEntries(Object.entries(clip.keyframes).map(([p, keys]) => [p, keys!.map((k) => ({ ...k, time: k.time * ratio }))]))
    : undefined;
  const updated: Clip = { ...clip, speed: sp === 1 ? undefined : sp, outPoint, keyframes };
  return updateTrack(project, track.id, (t) => ({ ...t, clips: t.clips.map((c) => (c.id === clipId ? updated : c)) }));
}

/**
 * "Separar audio": copia el audio de un clip de video a una pista de audio libre (o nueva)
 * y silencia el audio del clip original.
 */
export function detachAudio(project: Project, clipId: Id): { project: Project; audioClipId: Id | null } {
  const ref = findClip(project, clipId);
  const media = ref ? findMedia(project, ref.clip.sourceId) : undefined;
  if (!ref || ref.track.kind !== 'video' || !media?.hasAudio || ref.clip.audioMuted) return { project, audioClipId: null };
  const c = ref.clip;
  const audio: Clip = {
    id: newId('clip'),
    sourceId: c.sourceId,
    start: c.start,
    inPoint: c.inPoint,
    outPoint: c.outPoint,
    speed: c.speed,
    volume: c.volume,
    audioFadeIn: c.audioFadeIn,
    audioFadeOut: c.audioFadeOut,
    keyframes: c.keyframes?.volume ? { volume: c.keyframes.volume } : undefined,
  };
  let p = setClipFields(project, clipId, { audioMuted: true });
  const s = audio.start;
  const e = clipEnd(audio);
  let target = p.tracks.find((t) => t.kind === 'audio' && !t.locked && !t.clips.some((x) => x.start < e - EPS && clipEnd(x) > s + EPS));
  if (!target) {
    const added = addTrack(p, 'audio');
    p = added.project;
    target = added.track;
  }
  return { project: insertClip(p, target.id, audio), audioClipId: audio.id };
}

// ---------------------------------------------------------------------------- texto

export const DEFAULT_TEXT_DURATION = 5;

/**
 * Agrega un clip de texto en `start`: en la pista de video más alta que tenga libre el tramo,
 * o en una pista nueva "Texto" arriba de todo.
 */
export function addTextClip(project: Project, text: TextContent, start: number, transform?: Partial<Clip['transform']>): { project: Project; clip: Clip } {
  const clip: Clip = {
    id: newId('clip'),
    sourceId: '',
    start,
    inPoint: 0,
    outPoint: DEFAULT_TEXT_DURATION,
    text,
    transform: transform && Object.keys(transform).length ? { ...transform } : undefined,
  };
  const end = start + DEFAULT_TEXT_DURATION;
  const free = project.tracks.find(
    (t) => t.kind === 'video' && !t.locked && !t.clips.some((c) => c.start < end - EPS && clipEnd(c) > start + EPS),
  );
  if (free) return { project: insertClip(project, free.id, clip), clip };
  const added = addTrack(project, 'video', nextTextTrackName(project));
  return { project: insertClip(added.project, added.track.id, clip), clip };
}

function nextTextTrackName(project: Project): string {
  const used = new Set(project.tracks.map((t) => t.name));
  if (!used.has('Texto')) return 'Texto';
  let n = 2;
  while (used.has(`Texto ${n}`)) n++;
  return `Texto ${n}`;
}

/** Agrega un efecto animado en `start` (misma ubicación que los textos: pista libre más alta o una nueva). */
export function addOverlayClip(project: Project, overlay: OverlayEffect, start: number): { project: Project; clip: Clip } {
  const clip: Clip = { id: newId('clip'), sourceId: '', start, inPoint: 0, outPoint: DEFAULT_OVERLAY_DURATION, overlay };
  const end = start + DEFAULT_OVERLAY_DURATION;
  const free = project.tracks.find(
    (t) => t.kind === 'video' && !t.locked && !t.clips.some((c) => c.start < end - EPS && clipEnd(c) > start + EPS),
  );
  if (free) return { project: insertClip(project, free.id, clip), clip };
  const added = addTrack(project, 'video', nextNamed(project, 'Efectos'));
  return { project: insertClip(added.project, added.track.id, clip), clip };
}

function nextNamed(project: Project, base: string): string {
  const used = new Set(project.tracks.map((t) => t.name));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/**
 * Crea una pista "Subtítulos" (arriba de todo) con un clip de texto por frase.
 * Las frases no se superponen: si una termina después de que empieza la siguiente, se recorta.
 */
export function addSubtitleTrack(
  project: Project,
  segments: { start: number; end: number; text: string }[],
  style: SubtitleStyle,
): { project: Project; trackId: Id } {
  const added = addTrack(project, 'video', nextNamed(project, 'Subtítulos'));
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const clips: Clip[] = [];
  sorted.forEach((seg, i) => {
    const next = sorted[i + 1];
    const end = Math.min(seg.end, next ? next.start : seg.end);
    const dur = Math.max(0.3, end - seg.start);
    const { text, y } = subtitleText(style, seg.text);
    clips.push({ id: newId('clip'), sourceId: '', start: seg.start, inPoint: 0, outPoint: dur, text, transform: { y } });
  });
  const p = added.project;
  return {
    project: { ...p, tracks: p.tracks.map((t) => (t.id === added.track.id ? { ...t, clips: sortClips(clips) } : t)) },
    trackId: added.track.id,
  };
}

export function setClipOverlay(project: Project, clipId: Id, patch: Partial<OverlayEffect>): Project {
  const ref = findClip(project, clipId);
  if (!ref?.clip.overlay) return project;
  const overlay: OverlayEffect = { ...ref.clip.overlay, ...patch };
  return updateTrack(project, ref.track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? { ...c, overlay } : c)),
  }));
}

export function setClipText(project: Project, clipId: Id, patch: Partial<TextContent>): Project {
  const ref = findClip(project, clipId);
  if (!ref?.clip.text) return project;
  const text: TextContent = { ...ref.clip.text, ...patch };
  return updateTrack(project, ref.track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? { ...c, text } : c)),
  }));
}

/** Crea un clip a partir de un medio completo. */
export function clipFromMedia(media: MediaSource, start: number): Clip {
  return { id: newId('clip'), sourceId: media.id, start, inPoint: 0, outPoint: initialClipDuration(media) };
}

export { clipDuration, clipEnd };
