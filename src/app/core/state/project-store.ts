import { computed, Injectable, signal } from '@angular/core';
import { createEmptyProject, projectDuration, type Id, type Project } from '../../../../shared/model';
import type { Command } from '../commands/command';

interface HistoryEntry {
  label: string;
  before: Project;
  after: Project;
  mergeKey?: string;
  at: number;
}

const MAX_HISTORY = 200;
const MERGE_WINDOW_MS = 1500;

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
  /** Clip principal de la selección (el que muestra Propiedades y las manijas). */
  readonly selectedClipId = signal<Id | null>(null);
  /** Todos los clips seleccionados (incluye el principal). */
  readonly selectedClipIds = signal<Id[]>([]);
  readonly selectedTransition = signal<{ clipId: Id; edge: 'in' | 'out' } | null>(null);

  /** @param additive Ctrl/Shift + clic: agrega o quita el clip de la selección. */
  selectClip(id: Id | null, additive = false): void {
    if (!id) {
      this.selectedClipId.set(null);
      this.selectedClipIds.set([]);
      return;
    }
    this.selectedTransition.set(null);
    if (additive) {
      const ids = this.selectedClipIds();
      if (ids.includes(id)) {
        const rest = ids.filter((x) => x !== id);
        this.selectedClipIds.set(rest);
        this.selectedClipId.set(rest.at(-1) ?? null);
        return;
      }
      this.selectedClipIds.set([...ids, id]);
    } else if (!this.selectedClipIds().includes(id) || this.selectedClipIds().length <= 1) {
      this.selectedClipIds.set([id]);
    }
    this.selectedClipId.set(id);
  }

  selectClips(ids: Id[]): void {
    this.selectedTransition.set(null);
    this.selectedClipIds.set(ids);
    this.selectedClipId.set(ids.at(-1) ?? null);
  }

  selectTransition(sel: { clipId: Id; edge: 'in' | 'out' } | null): void {
    this.selectedTransition.set(sel);
    if (sel) {
      this.selectedClipId.set(null);
      this.selectedClipIds.set([]);
    }
  }

  readonly settings = computed(() => this._project().settings);
  readonly duration = computed(() => projectDuration(this._project()));
  readonly canUndo = computed(() => this._undo().length > 0);
  readonly canRedo = computed(() => this._redo().length > 0);
  readonly undoLabel = computed(() => this._undo().at(-1)?.label ?? null);
  readonly redoLabel = computed(() => this._redo().at(-1)?.label ?? null);
  /** Comparación por referencia: gracias a la inmutabilidad, deshacer hasta lo guardado limpia el flag. */
  readonly dirty = computed(() => this._project() !== this._savedProject());

  /**
   * Aplica un comando y lo agrega al historial.
   * `mergeKey`: comandos consecutivos con la misma clave (p. ej. arrastrar un deslizador) se
   * agrupan en una sola entrada de deshacer, si llegan con menos de MERGE_WINDOW_MS de diferencia.
   */
  dispatch(command: Command, options?: { mergeKey?: string }): void {
    const before = this._project();
    const after = command.apply(before);
    if (after === before) return;
    this._project.set(after);
    const now = Date.now();
    const last = this._undo().at(-1);
    if (options?.mergeKey && last && last.mergeKey === options.mergeKey && now - last.at < MERGE_WINDOW_MS) {
      this._undo.update((u) => [...u.slice(0, -1), { ...last, after, at: now }]);
    } else {
      this._undo.update((u) => [
        ...u.slice(-(MAX_HISTORY - 1)),
        { label: command.label, before, after, mergeKey: options?.mergeKey, at: now },
      ]);
    }
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
    this.selectedClipIds.set([]);
    this.selectedTransition.set(null);
  }

  /** Recupera una sesión: como `load`, pero puede quedar marcado con cambios sin guardar. */
  restore(project: Project, filePath: string | null, dirty: boolean): void {
    this.load(project, filePath);
    if (dirty) this._savedProject.set(null);
  }

  markSaved(filePath: string): void {
    this._savedProject.set(this._project());
    this.filePath.set(filePath);
  }

  private pruneSelection(): void {
    const findClip = (id: Id) => this._project().tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    const ids = this.selectedClipIds().filter((x) => !!findClip(x));
    if (ids.length !== this.selectedClipIds().length) this.selectedClipIds.set(ids);
    const id = this.selectedClipId();
    if (id && !findClip(id)) this.selectedClipId.set(ids.at(-1) ?? null);
    const tr = this.selectedTransition();
    if (tr) {
      const clip = findClip(tr.clipId);
      if (!clip || !(tr.edge === 'in' ? clip.transitionIn : clip.transitionOut)) this.selectedTransition.set(null);
    }
  }
}
