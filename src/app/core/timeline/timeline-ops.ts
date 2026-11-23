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
  type Clip,
  type Id,
  type MediaSource,
  type Project,
  type ProjectSettings,
  type Track,
} from '../../../../shared/model';

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
    // Parte izquierda que queda antes del rango.
    if (cs < start - EPS) {
      out.push({ ...c, outPoint: c.inPoint + (start - cs) });
    }
    // Parte derecha que queda después del rango.
    if (ce > end + EPS) {
      const right: Clip = { ...c, start: end, inPoint: c.inPoint + (end - cs) };
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
  const sourceDuration = media?.duration ?? clip.outPoint;
  const minDur = 1 / project.settings.fps;
  const others = track.clips.filter((c) => c.id !== clipId);

  if (edge === 'start') {
    const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= clip.start + EPS).map(clipEnd));
    const min = Math.max(prevEnd, clip.start - clip.inPoint);
    const max = clipEnd(clip) - minDur;
    return { min, max };
  }
  const nextStart = Math.min(Infinity, ...others.filter((c) => c.start >= clipEnd(clip) - EPS).map((c) => c.start));
  const min = clip.start + minDur;
  const max = Math.min(nextStart, clip.start + (sourceDuration - clip.inPoint));
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
      ? { ...clip, start: t, inPoint: clip.inPoint + (t - clip.start) }
      : { ...clip, outPoint: clip.inPoint + (t - clip.start) };
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
  const cut = clip.inPoint + (t - clip.start);
  const left: Clip = { ...clip, outPoint: cut };
  const right: Clip = { ...clip, id: newId('clip'), start: t, inPoint: cut };
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

/** Crea un clip a partir de un medio completo. */
export function clipFromMedia(media: MediaSource, start: number): Clip {
  return { id: newId('clip'), sourceId: media.id, start, inPoint: 0, outPoint: media.duration };
}

export { clipDuration, clipEnd };
