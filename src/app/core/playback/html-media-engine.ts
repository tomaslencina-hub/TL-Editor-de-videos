import { inject, Injectable } from '@angular/core';
import type { Clip, Project, Track } from '../../../../shared/model';
import { TL_API } from '../ipc/tl-api';
import { clipAt, findMedia } from '../timeline/timeline-ops';
import type { PlaybackEngine, PlaybackSurface } from './playback-engine';

/** Tolerancia de desfase antes de forzar un seek mientras se reproduce. */
const DRIFT_TOLERANCE = 0.25;

interface ElementState {
  clipId: string | null;
}

/**
 * Motor v0.1: un <video> para la pista de video y un <audio> para la de audio.
 * En cada sync busca el clip activo en cada pista y ajusta src/currentTime/play.
 *
 * Limitaciones conocidas: un solo clip visible a la vez, pequeños cortes al cambiar de archivo
 * (no hay precarga del siguiente clip) y sincronía aproximada (tolerancia de 250 ms).
 */
@Injectable()
export class HtmlMediaEngine implements PlaybackEngine {
  private readonly api = inject(TL_API);
  private surface: PlaybackSurface | null = null;
  private readonly videoState: ElementState = { clipId: null };
  private readonly audioState: ElementState = { clipId: null };

  attach(surface: PlaybackSurface): void {
    this.surface = surface;
    surface.video.preload = 'auto';
    surface.audio.preload = 'auto';
  }

  detach(): void {
    this.halt();
    this.surface = null;
  }

  sync(project: Project, time: number, playing: boolean): void {
    if (!this.surface) return;
    const videoTrack = project.tracks.find((t) => t.kind === 'video');
    const audioTrack = project.tracks.find((t) => t.kind === 'audio');
    this.syncElement(this.surface.video, this.videoState, project, videoTrack, time, playing, true);
    this.syncElement(this.surface.audio, this.audioState, project, audioTrack, time, playing, false);
  }

  halt(): void {
    this.surface?.video.pause();
    this.surface?.audio.pause();
  }

  private syncElement(
    el: HTMLMediaElement,
    state: ElementState,
    project: Project,
    track: Track | undefined,
    time: number,
    playing: boolean,
    isVideo: boolean,
  ): void {
    const clip: Clip | undefined = track ? clipAt(track, time) : undefined;
    const media = clip ? findMedia(project, clip.sourceId) : undefined;

    if (!track || !clip || !media) {
      if (!el.paused) el.pause();
      if (isVideo) el.style.visibility = 'hidden';
      state.clipId = null;
      return;
    }

    const url = this.api.mediaUrl(media.path);
    if (el.dataset['src'] !== url) {
      el.dataset['src'] = url;
      el.src = url;
    }
    if (isVideo) el.style.visibility = media.hasVideo ? 'visible' : 'hidden';
    el.muted = track.muted;

    const local = clip.inPoint + (time - clip.start);
    const clipChanged = state.clipId !== clip.id;
    const drift = Math.abs(el.currentTime - local);
    // En pausa (scrubbing) se busca el frame exacto; reproduciendo solo se corrige si hay desfase.
    const needsSeek = clipChanged || (playing ? drift > DRIFT_TOLERANCE : drift > 1 / (project.settings.fps * 2));
    if (needsSeek) el.currentTime = local;
    state.clipId = clip.id;

    if (playing && el.paused) {
      el.play().catch(() => {
        /* interrumpido por un cambio de src o pausa: se reintenta en el próximo frame */
      });
    } else if (!playing && !el.paused) {
      el.pause();
    }
  }
}
