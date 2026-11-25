import { effect, inject, Injectable, untracked } from '@angular/core';
import type { SessionData } from '../../../../shared/ipc-contract';
import { validateProject } from '../../../../shared/model';
import { TimelineViewService } from '../../features/timeline/timeline-view.service';
import { TL_API } from '../ipc/tl-api';
import { MediaLibraryService } from '../media/media-library.service';
import { PlaybackService } from '../playback/playback.service';
import { NotificationsService } from '../ui/notifications.service';
import { ProjectStore } from './project-store';

const SAVE_DELAY_MS = 800;

/**
 * Sesión de trabajo: guarda sola el estado de edición y lo recupera al abrir la app, así el usuario
 * sigue exactamente donde estaba (aunque no haya guardado el .vproj o la app se haya cerrado de golpe).
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly api = inject(TL_API);
  private readonly store = inject(ProjectStore);
  private readonly library = inject(MediaLibraryService);
  private readonly playback = inject(PlaybackService);
  private readonly view = inject(TimelineViewService);
  private readonly notify = inject(NotificationsService);

  /** No se guarda nada hasta terminar de recuperar (si no, se pisaría la sesión anterior). */
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Guardado automático ante cualquier cambio relevante (con un pequeño retardo).
    effect(() => {
      this.store.project();
      this.store.filePath();
      this.store.dirty();
      this.view.pps();
      // El playhead cambia en cada cuadro al reproducir: se guarda solo en pausa.
      if (!this.playback.playing()) this.playback.currentTime();
      untracked(() => this.schedule());
    });
    window.addEventListener('beforeunload', () => this.flushSync());
  }

  /** Recupera la sesión anterior (se llama una vez al iniciar). */
  async restore(): Promise<void> {
    try {
      const data = await this.api.loadSession();
      if (!data || validateProject(data.project)) return;
      const p = data.project;
      const hasContent = p.media.length > 0 || p.tracks.some((t) => t.clips.length > 0);
      if (!hasContent && !data.filePath) return;
      this.store.restore(p, data.filePath, data.dirty);
      this.view.setPps(data.pps);
      this.playback.seek(data.playhead);
      void this.library.refreshAll();
      this.notify.show('Se recuperó tu sesión anterior: seguí donde estabas.', 'success', 3500);
    } catch (e) {
      console.warn('No se pudo recuperar la sesión', e);
    } finally {
      this.ready = true;
      this.schedule();
    }
  }

  private snapshot(): SessionData {
    return {
      version: 1,
      project: this.store.project(),
      filePath: this.store.filePath(),
      dirty: this.store.dirty(),
      playhead: this.playback.currentTime(),
      pps: this.view.pps(),
      savedAt: new Date().toISOString(),
    };
  }

  private schedule(): void {
    if (!this.ready) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.api.saveSession(this.snapshot());
    }, SAVE_DELAY_MS);
  }

  /** Al cerrar la ventana: guardado sincrónico del último estado. */
  private flushSync(): void {
    if (!this.ready) return;
    if (this.timer) clearTimeout(this.timer);
    this.api.saveSessionSync(this.snapshot());
  }
}
