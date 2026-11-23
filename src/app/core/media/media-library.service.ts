import { inject, Injectable, signal } from '@angular/core';
import type { WaveformData } from '../../../../shared/ipc-contract';
import type { Id, MediaSource, ProjectSettings } from '../../../../shared/model';
import { Commands } from '../commands/command';
import { TL_API } from '../ipc/tl-api';
import { ProjectStore } from '../state/project-store';
import { newId } from '../timeline/timeline-ops';

/** Datos derivados de un medio, generados en runtime (no se guardan en el .vproj). */
export interface MediaAssets {
  thumbnail?: string;
  waveform?: WaveformData;
  missing?: boolean;
}

export interface ImportReport {
  imported: number;
  skipped: number;
  errors: { path: string; message: string }[];
}

const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

@Injectable({ providedIn: 'root' })
export class MediaLibraryService {
  private readonly api = inject(TL_API);
  private readonly store = inject(ProjectStore);

  readonly assets = signal<ReadonlyMap<Id, MediaAssets>>(new Map());
  readonly importing = signal(0);

  async importPaths(paths: string[]): Promise<ImportReport> {
    const report: ImportReport = { imported: 0, skipped: 0, errors: [] };
    const existing = new Set(this.store.project().media.map((m) => m.path.toLowerCase()));
    const unique = [...new Set(paths)].filter((p) => {
      if (existing.has(p.toLowerCase())) {
        report.skipped++;
        return false;
      }
      return true;
    });
    if (unique.length === 0) return report;

    this.importing.update((n) => n + unique.length);
    const results = await Promise.allSettled(unique.map((p) => this.api.probe(p)));
    this.importing.update((n) => n - unique.length);

    const media: MediaSource[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        media.push({ id: newId('media'), ...r.value });
      } else {
        report.errors.push({ path: unique[i], message: errorMessage(r.reason) });
      }
    });
    if (media.length === 0) return report;

    // Con un proyecto vacío, la configuración se adapta al primer video importado.
    let settings: Partial<ProjectSettings> | undefined;
    const p = this.store.project();
    const firstVideo = media.find((m) => m.hasVideo && m.width && m.height);
    if (p.media.length === 0 && firstVideo) {
      settings = {
        width: even(firstVideo.width!),
        height: even(firstVideo.height!),
        fps: nearestFps(firstVideo.fps ?? p.settings.fps),
      };
    }

    this.store.dispatch(Commands.addMedia(media, settings));
    report.imported = media.length;
    media.forEach((m) => void this.loadAssets(m));
    return report;
  }

  /** Recalcula assets de todos los medios del proyecto (al abrir un .vproj). */
  async refreshAll(): Promise<void> {
    this.assets.set(new Map());
    await Promise.all(this.store.project().media.map((m) => this.loadAssets(m)));
  }

  private async loadAssets(media: MediaSource): Promise<void> {
    const exists = await this.api.fileExists(media.path);
    if (!exists) {
      this.patch(media.id, { missing: true });
      return;
    }
    const tasks: Promise<void>[] = [];
    if (media.hasVideo) {
      tasks.push(
        this.api
          .thumbnail(media.path, Math.min(1, media.duration * 0.1))
          .then((thumbnail) => this.patch(media.id, { thumbnail }))
          .catch((e: unknown) => console.warn('Miniatura', media.path, e)),
      );
    }
    if (media.hasAudio) {
      tasks.push(
        this.api
          .waveform(media.path)
          .then((waveform) => this.patch(media.id, { waveform }))
          .catch((e: unknown) => console.warn('Onda de audio', media.path, e)),
      );
    }
    await Promise.all(tasks);
  }

  private patch(id: Id, patch: MediaAssets): void {
    this.assets.update((map) => {
      const next = new Map(map);
      next.set(id, { ...next.get(id), ...patch });
      return next;
    });
  }
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

function nearestFps(fps: number): number {
  return COMMON_FPS.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best), 30);
}

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Los errores de ipcRenderer.invoke vienen con un prefijo técnico.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
