import { inject, Injectable, signal } from '@angular/core';
import { TL_API } from '../ipc/tl-api';
import { errorMessage, MediaLibraryService } from '../media/media-library.service';
import { ProjectStore } from '../state/project-store';
import { ExportCancelled, renderVideo } from './video-renderer';

export type ExportStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

/** Peso de cada fase en la barra de progreso total. */
const VIDEO_WEIGHT = 0.9;

@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly api = inject(TL_API);
  private readonly store = inject(ProjectStore);
  private readonly library = inject(MediaLibraryService);

  readonly open = signal(false);
  readonly status = signal<ExportStatus>('idle');
  /** Progreso total 0..1. */
  readonly progress = signal(0);
  readonly phase = signal<'video' | 'audio'>('video');
  /** Cuadros por segundo de procesamiento (fase de video). */
  readonly speed = signal<number | null>(null);
  readonly outputPath = signal<string | null>(null);
  readonly message = signal<string | null>(null);

  private jobId: string | null = null;
  private cancelRequested = false;

  /** Muestra el diálogo de exportación (aún no inicia). */
  show(): void {
    if (this.status() !== 'running') {
      this.status.set('idle');
      this.message.set(null);
      this.progress.set(0);
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
    const preparing = project.media.filter((m) => used.has(m.id) && assets.get(m.id)?.preparing);
    if (preparing.length) return `Preparando para edición: ${preparing.map((m) => m.name).join(', ')}. Esperá unos segundos.`;
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
    this.progress.set(0);
    this.phase.set('video');
    this.speed.set(null);
    this.cancelRequested = false;
    const jobId = (this.jobId = await this.api.beginExport(outputPath));

    const started = performance.now();
    let frames = 0;
    try {
      // Fase 1: composición + codificación del video en el renderer.
      await renderVideo({
        project,
        sourceUrl: (m) => this.api.mediaUrl(this.library.playbackPath(m)),
        write: (position, data) => this.api.writeExportChunk(jobId, position, data),
        isCancelled: () => this.cancelRequested,
        onProgress: (ratio) => {
          frames++;
          this.progress.set(ratio * VIDEO_WEIGHT);
          const secs = (performance.now() - started) / 1000;
          if (secs > 0.5) this.speed.set(frames / secs);
        },
      });

      // Fase 2: mezcla de audio + multiplexado con FFmpeg.
      this.phase.set('audio');
      const off = this.api.onExportProgress((p) => this.progress.set(VIDEO_WEIGHT + p.ratio * (1 - VIDEO_WEIGHT)));
      const res = await this.api.finishExport(jobId, project).finally(off);
      if (res.status === 'done') {
        this.progress.set(1);
        this.status.set('done');
      } else if (res.status === 'cancelled') {
        this.status.set('cancelled');
      } else {
        this.status.set('error');
        this.message.set(res.message);
      }
    } catch (e) {
      await this.api.abortExport(jobId).catch(() => undefined);
      if (e instanceof ExportCancelled) {
        this.status.set('cancelled');
      } else {
        console.error(e);
        this.status.set('error');
        this.message.set(errorMessage(e));
      }
    } finally {
      this.jobId = null;
    }
  }

  cancel(): void {
    if (this.status() !== 'running') return;
    this.cancelRequested = true;
    // En la fase de audio el corte lo hace el proceso main.
    if (this.phase() === 'audio' && this.jobId) void this.api.abortExport(this.jobId);
  }

  reveal(): void {
    const p = this.outputPath();
    if (p) void this.api.showItemInFolder(p);
  }
}
