import { computed, Injectable, signal } from '@angular/core';
import { createEmptyProject, projectDuration, type Id, type Project } from '../../../../shared/model';
import type { Command } from '../commands/command';

interface HistoryEntry {
  label: string;
  before: Project;
  after: Project;
}

const MAX_HISTORY = 200;

/**
 * Estado del proyecto (fuente de verdad) + historial de comandos.
 * Todo cambio al modelo pasa por `dispatch`, que lo hace deshacible.
 */
@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly _project = signal<Project>(createEmptyProject());
  private readonly _undo = signal<HistoryEntry[]>([]);
  private readonly _redo = signal<HistoryEntry[]>([]);
  private readonly _savedProject = signal<Project | null>(this._project());

  readonly project = this._project.asReadonly();
  readonly filePath = signal<string | null>(null);

  /** Estado de UI (no forma parte del modelo ni del historial). Clip y transición son excluyentes. */
  readonly selectedClipId = signal<Id | null>(null);
  readonly selectedTransition = signal<{ clipId: Id; edge: 'in' | 'out' } | null>(null);

  selectClip(id: Id | null): void {
    this.selectedClipId.set(id);
    if (id) this.selectedTransition.set(null);
  }

  selectTransition(sel: { clipId: Id; edge: 'in' | 'out' } | null): void {
    this.selectedTransition.set(sel);
    if (sel) this.selectedClipId.set(null);
  }

  readonly settings = computed(() => this._project().settings);
  readonly duration = computed(() => projectDuration(this._project()));
  readonly canUndo = computed(() => this._undo().length > 0);
  readonly canRedo = computed(() => this._redo().length > 0);
  readonly undoLabel = computed(() => this._undo().at(-1)?.label ?? null);
  readonly redoLabel = computed(() => this._redo().at(-1)?.label ?? null);
  /** Comparación por referencia: gracias a la inmutabilidad, deshacer hasta lo guardado limpia el flag. */
  readonly dirty = computed(() => this._project() !== this._savedProject());

  dispatch(command: Command): void {
    const before = this._project();
    const after = command.apply(before);
    if (after === before) return;
    this._project.set(after);
    this._undo.update((u) => [...u.slice(-(MAX_HISTORY - 1)), { label: command.label, before, after }]);
    this._redo.set([]);
    this.pruneSelection();
  }

  undo(): void {
    const entry = this._undo().at(-1);
    if (!entry) return;
    this._undo.update((u) => u.slice(0, -1));
    this._redo.update((r) => [...r, entry]);
    this._project.set(entry.before);
    this.pruneSelection();
  }

  redo(): void {
    const entry = this._redo().at(-1);
    if (!entry) return;
    this._redo.update((r) => r.slice(0, -1));
    this._undo.update((u) => [...u, entry]);
    this._project.set(entry.after);
    this.pruneSelection();
  }

  /** Reemplaza el proyecto completo (nuevo / abrir): limpia el historial. */
  load(project: Project, filePath: string | null): void {
    this._project.set(project);
    this._savedProject.set(project);
    this._undo.set([]);
    this._redo.set([]);
    this.filePath.set(filePath);
    this.selectedClipId.set(null);
    this.selectedTransition.set(null);
  }

  markSaved(filePath: string): void {
    this._savedProject.set(this._project());
    this.filePath.set(filePath);
  }

  private pruneSelection(): void {
    const findClip = (id: Id) => this._project().tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    const id = this.selectedClipId();
    if (id && !findClip(id)) this.selectedClipId.set(null);
    const tr = this.selectedTransition();
    if (tr) {
      const clip = findClip(tr.clipId);
      if (!clip || !(tr.edge === 'in' ? clip.transitionIn : clip.transitionOut)) this.selectedTransition.set(null);
    }
  }
}
