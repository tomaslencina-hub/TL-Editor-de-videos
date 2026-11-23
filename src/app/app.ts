import { Component, DestroyRef, effect, HostListener, inject, signal } from '@angular/core';
import { EditorActionsService } from './core/editor-actions.service';
import { TL_API } from './core/ipc/tl-api';
import { PlaybackService } from './core/playback/playback.service';
import { ProjectStore } from './core/state/project-store';
import { TimelineViewService } from './features/timeline/timeline-view.service';
import { ExportDialog } from './features/export-dialog/export-dialog';
import { MediaPanel } from './features/media-panel/media-panel';
import { Preview } from './features/preview/preview';
import { Timeline } from './features/timeline/timeline';
import { Toasts } from './features/toasts/toasts';
import { Toolbar } from './features/toolbar/toolbar';

@Component({
  selector: 'app-root',
  imports: [Toolbar, MediaPanel, Preview, Timeline, ExportDialog, Toasts],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly api = inject(TL_API);
  private readonly store = inject(ProjectStore);
  private readonly actions = inject(EditorActionsService);
  private readonly playback = inject(PlaybackService);
  private readonly view = inject(TimelineViewService);

  /** Se muestra la capa de "soltar archivos" al arrastrar desde el explorador. */
  protected readonly fileDragOver = signal(false);
  private dragDepth = 0;

  constructor() {
    const off = this.api.onMenuAction((a) => this.actions.handleMenu(a));
    inject(DestroyRef).onDestroy(off);

    // Título de la ventana con indicador de cambios sin guardar.
    effect(() => {
      const name = this.store.project().name;
      document.title = `${this.store.dirty() ? '● ' : ''}${name} — TL Editor`;
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  protected onBeforeUnload(e: BeforeUnloadEvent): void {
    // Electron muestra el diálogo de confirmación desde main (will-prevent-unload).
    if (this.store.dirty()) e.preventDefault();
  }

  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (ctrl && !e.shiftKey && key === 'z') {
      this.store.undo();
    } else if (ctrl && (key === 'y' || (e.shiftKey && key === 'z'))) {
      this.store.redo();
    } else if (key === ' ' && !ctrl) {
      this.playback.toggle();
    } else if ((ctrl && key === 'b') || (!ctrl && key === 's')) {
      this.actions.splitAtPlayhead();
    } else if (key === 'delete' || key === 'backspace') {
      this.actions.deleteSelected();
    } else if (key === 'arrowleft') {
      this.playback.step(e.shiftKey ? -10 : -1);
    } else if (key === 'arrowright') {
      this.playback.step(e.shiftKey ? 10 : 1);
    } else if (key === 'home') {
      this.playback.seek(0);
    } else if (key === 'end') {
      this.playback.seek(this.store.duration());
    } else if (key === '+' || key === '=') {
      this.view.zoomBy(1.25);
    } else if (key === '-') {
      this.view.zoomBy(0.8);
    } else if (key === 'escape') {
      this.store.selectedClipId.set(null);
    } else {
      return;
    }
    e.preventDefault();
  }

  // ---- Drag & drop de archivos desde el sistema ----
  private isFileDrag(e: DragEvent): boolean {
    return !!e.dataTransfer?.types.includes('Files');
  }

  @HostListener('dragenter', ['$event'])
  protected onDragEnter(e: DragEvent): void {
    if (!this.isFileDrag(e)) return;
    this.dragDepth++;
    this.fileDragOver.set(true);
  }

  @HostListener('dragleave', ['$event'])
  protected onDragLeave(e: DragEvent): void {
    if (!this.isFileDrag(e)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.fileDragOver.set(false);
  }

  @HostListener('dragover', ['$event'])
  protected onDragOver(e: DragEvent): void {
    if (!this.isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }

  @HostListener('drop', ['$event'])
  protected onDrop(e: DragEvent): void {
    if (!this.isFileDrag(e)) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.fileDragOver.set(false);
    const paths = Array.from(e.dataTransfer?.files ?? [])
      .map((f) => this.api.getPathForFile(f))
      .filter((p) => !!p);
    if (paths.length) void this.actions.importPaths(paths);
  }
}
