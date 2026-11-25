import type { AnimatableProp, Clip, Id, MediaSource, Project, ProjectSettings, Track, TrackKind, Transition } from '../../../../shared/model';
import type { OverlayEffect } from '../../../../shared/effects';
import type { SubtitleStyle, TextContent } from '../../../../shared/text';
import * as props from '../timeline/clip-props';
import * as ops from '../timeline/timeline-ops';

/**
 * Un comando describe un cambio sobre el proyecto.
 * `apply` es puro (Project -> Project); el historial guarda el estado anterior y el posterior,
 * así deshacer/rehacer es O(1) y robusto aunque las operaciones sean complejas
 * (sobrescritura, splits, etc.). Gracias al structural sharing el costo en memoria es bajo.
 */
export interface Command {
  readonly label: string;
  apply(project: Project): Project;
}

const cmd = (label: string, apply: (p: Project) => Project): Command => ({ label, apply });

export const Commands = {
  addMedia: (media: MediaSource[], settings?: Partial<ProjectSettings>) =>
    cmd(media.length === 1 ? `Importar ${media[0].name}` : `Importar ${media.length} medios`, (p) => {
      const withMedia = ops.addMedia(p, media);
      return settings ? ops.updateSettings(withMedia, settings) : withMedia;
    }),

  relinkMedia: (paths: Record<Id, string>) => cmd('Vincular archivos', (p) => ops.relinkMedia(p, paths)),

  removeMedia: (sourceId: Id) => cmd('Quitar medio', (p) => ops.removeMedia(p, sourceId)),

  insertClip: (trackId: Id, clip: Clip) => cmd('Agregar clip', (p) => ops.insertClip(p, trackId, clip)),

  moveClip: (clipId: Id, toTrackId: Id, start: number) =>
    cmd('Mover clip', (p) => ops.moveClip(p, clipId, toTrackId, start)),

  trimClip: (clipId: Id, edge: ops.TrimEdge, edgeTime: number) =>
    cmd('Recortar clip', (p) => ops.trimClip(p, clipId, edge, edgeTime)),

  splitClips: (clipIds: Id[], t: number) =>
    cmd('Dividir', (p) => clipIds.reduce((acc, id) => ops.splitClip(acc, id, t), p)),

  deleteClips: (clipIds: Id[]) => cmd('Borrar clip', (p) => ops.deleteClips(p, clipIds)),

  updateSettings: (patch: Partial<ProjectSettings>) =>
    cmd('Cambiar configuración', (p) => ops.updateSettings(p, patch)),

  updateTrack: (trackId: Id, patch: Partial<Pick<Track, 'muted' | 'locked' | 'name'>>) =>
    cmd('Cambiar pista', (p) => ops.updateTrackProps(p, trackId, patch)),

  renameProject: (name: string) => cmd('Renombrar proyecto', (p) => ops.renameProject(p, name)),

  addTrack: (kind: TrackKind) =>
    cmd(kind === 'video' ? 'Agregar pista de video' : 'Agregar pista de audio', (p) => ops.addTrack(p, kind).project),

  removeTrack: (trackId: Id) => cmd('Quitar pista', (p) => ops.removeTrack(p, trackId)),

  renameTrack: (trackId: Id, name: string) => cmd('Renombrar pista', (p) => ops.updateTrackProps(p, trackId, { name })),

  setClipProps: (clipId: Id, values: Partial<Record<AnimatableProp, number>>, clipTime: number) =>
    cmd('Cambiar propiedades', (p) => props.setClipProps(p, clipId, values, clipTime)),

  toggleKeyframe: (clipId: Id, prop: AnimatableProp, clipTime: number) =>
    cmd('Keyframe', (p) => props.toggleKeyframe(p, clipId, prop, clipTime)),

  resetClipProps: (clipId: Id, group: 'transform' | 'adjust') =>
    cmd(group === 'transform' ? 'Restablecer transformación' : 'Restablecer color', (p) => props.resetClipProps(p, clipId, group)),

  addText: (text: TextContent, start: number, transform?: Partial<Clip['transform']>, onCreated?: (clip: Clip) => void) =>
    cmd('Agregar texto', (p) => {
      const res = ops.addTextClip(p, text, start, transform);
      onCreated?.(res.clip);
      return res.project;
    }),

  setClipAudio: (clipId: Id, patch: ops.ClipAudioPatch) => cmd('Cambiar audio', (p) => ops.setClipFields(p, clipId, patch)),

  setFlip: (clipId: Id, patch: Pick<ops.ClipAudioPatch, 'flipH' | 'flipV'>) => cmd('Espejar', (p) => ops.setClipFields(p, clipId, patch)),

  setSpeed: (clipId: Id, speed: number) => cmd('Cambiar velocidad', (p) => ops.setClipSpeed(p, clipId, speed)),

  detachAudio: (clipId: Id) => cmd('Separar audio', (p) => ops.detachAudio(p, clipId).project),

  addOverlay: (overlay: OverlayEffect, start: number, onCreated?: (clip: Clip) => void) =>
    cmd('Agregar efecto', (p) => {
      const res = ops.addOverlayClip(p, overlay, start);
      onCreated?.(res.clip);
      return res.project;
    }),

  updateOverlay: (clipId: Id, patch: Partial<OverlayEffect>) =>
    cmd('Editar efecto', (p) => ops.setClipOverlay(p, clipId, patch)),

  addSubtitles: (segments: { start: number; end: number; text: string }[], style: SubtitleStyle) =>
    cmd('Subtítulos automáticos', (p) => ops.addSubtitleTrack(p, segments, style).project),

  updateText: (clipId: Id, patch: Partial<TextContent>) => cmd('Editar texto', (p) => ops.setClipText(p, clipId, patch)),

  rippleDelete: (clipIds: Id[]) => cmd('Borrar y cerrar hueco', (p) => ops.rippleDelete(p, clipIds)),

  pasteClips: (data: ops.ClipboardData, at: number, onPasted?: (ids: Id[]) => void) =>
    cmd('Pegar', (p) => {
      const res = ops.pasteClips(p, data, at);
      onPasted?.(res.ids);
      return res.project;
    }),

  addMarker: (time: number) => cmd('Agregar marcador', (p) => ops.addMarker(p, time).project),
  removeMarker: (id: Id) => cmd('Quitar marcador', (p) => ops.removeMarker(p, id)),
  moveTrack: (trackId: Id, direction: -1 | 1) => cmd('Mover pista', (p) => ops.moveTrack(p, trackId, direction)),

  setTransition: (clipId: Id, edge: ops.ClipEdge, transition: Transition | null) =>
    cmd(transition ? 'Aplicar transición' : 'Quitar transición', (p) => ops.setTransition(p, clipId, edge, transition)),
};
