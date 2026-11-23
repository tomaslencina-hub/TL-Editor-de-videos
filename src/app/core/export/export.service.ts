import { inject, Injectable, signal } from '@angular/core';
import type { ExportProgress } from '../../../../shared/ipc-contract';
import { TL_API } from '../ipc/tl-api';
import { errorMessage, MediaLibraryService } from '../media/media-library.service';
import { ProjectStore } from '../state/project-store';

export type ExportStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly api = inject(TL_API);
  private readonly store = inject(ProjectStore);
  private readonly library = inject(MediaLibraryService);

  readonly open = signal(false);
  readonly status = signal<ExportStatus>('idle');
  readonly progress = signal<ExportProgress>({ ratio: 0, time: 0 });
  readonly outputPath = signal<string | null>(null);
  readonly message = signal<string | null>(null);

  /** Muestra el diálogo de exportación (aún no inicia). */
  show(): void {
    if (this.status() !== 'running') {
      this.status.set('idle');
      this.message.set(null);
      this.progress.set({ ratio: 0, time: 0 });
    }
    this.open.set(true);
  }

  close(): void {
    if (this.status() === 'running') return;
    this.open.set(false);
  }

  /** Problemas que impiden exportar (se muestran en el diálogo). */
  validate(): string | null {
    const project = this.store.project();
    if (this.store.duration() <= 0) return 'La timeline está vacía.';
    const assets = this.library.assets();
    const used = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.sourceId)));
    const missing = project.media.filter((m) => used.has(m.id) && assets.get(m.id)?.missing);
    if (missing.length) return `Faltan archivos fuente: ${missing.map((m) => m.name).join(', ')}`;
    return null;
  }

  async start(): Promise<void> {
    if (this.status() === 'running') return;
    const problem = this.validate();
    if (problem) {
      this.status.set('error');
      this.message.set(problem);
      return;
    }
    const project = this.store.project();
    const outputPath = await this.api.pickExportPath(project.name);
    if (!outputPath) return;

    this.outputPath.set(outputPath);
    this.status.set('running');
    this.message.set(null);
    this.progress.set({ ratio: 0, time: 0 });
    const unsubscribe = this.api.onExportProgress((p) => this.progress.set(p));
    try {
      const res = await this.api.startExport({ project, outputPath });
      if (res.status === 'done') {
        this.progress.update((p) => ({ ...p, ratio: 1 }));
        this.status.set('done');
      } else if (res.status === 'cancelled') {
        this.status.set('cancelled');
      } else {
        this.status.set('error');
        this.message.set(res.message);
      }
    } catch (e) {
      this.status.set('error');
      this.message.set(errorMessage(e));
    } finally {
      unsubscribe();
    }
  }

  cancel(): void {
    if (this.status() === 'running') void this.api.cancelExport();
  }

  reveal(): void {
    const p = this.outputPath();
    if (p) void this.api.showItemInFolder(p);
  }
}
