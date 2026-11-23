import { inject, Injectable } from '@angular/core';
import type { MenuAction } from '../../../shared/ipc-contract';
import { createEmptyProject } from '../../../shared/model';
import { Commands } from './commands/command';
import { ExportService } from './export/export.service';
import { TL_API } from './ipc/tl-api';
import { errorMessage, MediaLibraryService } from './media/media-library.service';
import { PlaybackService } from './playback/playback.service';
import { ProjectStore } from './state/project-store';
import { clipAt, findClip } from './timeline/timeline-ops';
import { NotificationsService } from './ui/notifications.service';

/** Acciones de alto nivel del editor (menú, atajos, botones). */
@Injectable({ providedIn: 'root' })
export class EditorActionsService {
  private readonly api = inject(TL_API);
  private readonly store = inject(ProjectStore);
  private readonly library = inject(MediaLibraryService);
  private readonly playback = inject(PlaybackService);
  private readonly exporter = inject(ExportService);
  private readonly notify = inject(NotificationsService);

  handleMenu(action: MenuAction): void {
    switch (action) {
      case 'new': return void this.newProject();
      case 'open': return void this.openProject();
      case 'save': return void this.save(false);
      case 'save-as': return void this.save(true);
      case 'import': return void this.importDialog();
      case 'export': return this.exporter.show();
      case 'undo': return this.store.undo();
      case 'redo': return this.store.redo();
    }
  }

  private confirmDiscard(): boolean {
    return !this.store.dirty() || confirm('Hay cambios sin guardar. ¿Descartarlos?');
  }

  newProject(): void {
    if (!this.confirmDiscard()) return;
    this.playback.pause();
    this.playback.seek(0);
    this.store.load(createEmptyProject(), null);
    void this.library.refreshAll();
  }

  async openProject(): Promise<void> {
    if (!this.confirmDiscard()) return;
    try {
      const res = await this.api.openProject();
      if (!res) return;
      this.playback.pause();
      this.playback.seek(0);
      this.store.load(res.project, res.path);
      await this.library.refreshAll();
      const missing = [...this.library.assets().values()].filter((a) => a.missing).length;
      if (missing) this.notify.error(`${missing} archivo(s) del proyecto no se encontraron en disco.`);
    } catch (e) {
      this.notify.error(`No se pudo abrir el proyecto: ${errorMessage(e)}`);
    }
  }

  async save(saveAs: boolean): Promise<void> {
    try {
      const path = await this.api.saveProject(this.store.project(), saveAs ? null : this.store.filePath());
      if (!path) return;
      this.store.markSaved(path);
      this.notify.show('Proyecto guardado', 'success', 2000);
    } catch (e) {
      this.notify.error(`No se pudo guardar: ${errorMessage(e)}`);
    }
  }

  async importDialog(): Promise<void> {
    const paths = await this.api.pickMediaFiles();
    if (paths.length) await this.importPaths(paths);
  }

  async importPaths(paths: string[]): Promise<void> {
    const report = await this.library.importPaths(paths);
    for (const err of report.errors) {
      this.notify.error(`${err.path.split(/[\\/]/).pop()}: ${err.message}`);
    }
    if (report.skipped) this.notify.show(`${report.skipped} archivo(s) ya estaban importados.`);
  }

  /** Divide el clip seleccionado en el playhead; si no hay selección válida, todos los clips bajo el playhead. */
  splitAtPlayhead(): void {
    const t = this.playback.currentTime();
    const project = this.store.project();
    const selected = this.store.selectedClipId();
    const ref = selected ? findClip(project, selected) : null;
    let ids: string[];
    if (ref && clipAt(ref.track, t)?.id === ref.clip.id) {
      ids = [ref.clip.id];
    } else {
      ids = project.tracks
        .filter((tr) => !tr.locked)
        .map((tr) => clipAt(tr, t)?.id)
        .filter((id): id is string => !!id);
    }
    if (ids.length) this.store.dispatch(Commands.splitClips(ids, t));
  }

  deleteSelected(): void {
    const tr = this.store.selectedTransition();
    if (tr) {
      this.store.dispatch(Commands.setTransition(tr.clipId, tr.edge, null));
      return;
    }
    const id = this.store.selectedClipId();
    if (!id) return;
    const ref = findClip(this.store.project(), id);
    if (ref?.track.locked) return;
    this.store.dispatch(Commands.deleteClips([id]));
  }
}
