import type { Clip, Id, MediaSource, Project, ProjectSettings, Track } from '../../../../shared/model';
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
};
