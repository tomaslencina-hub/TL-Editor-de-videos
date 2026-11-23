import { computed, inject, Injectable } from '@angular/core';
import { visualParams } from '../../../../shared/animation';
import { clipDuration, type AnimatableProp } from '../../../../shared/model';
import { Commands } from '../commands/command';
import { PlaybackService } from '../playback/playback.service';
import { findClip, findMedia } from '../timeline/timeline-ops';
import { ProjectStore } from './project-store';

/** Contexto del clip seleccionado: lo usan el panel de propiedades y las manijas de la vista previa. */
@Injectable({ providedIn: 'root' })
export class SelectedClipService {
  private readonly store = inject(ProjectStore);
  private readonly playback = inject(PlaybackService);

  readonly ref = computed(() => {
    const id = this.store.selectedClipId();
    return id ? findClip(this.store.project(), id) : null;
  });
  readonly clip = computed(() => this.ref()?.clip ?? null);
  readonly track = computed(() => this.ref()?.track ?? null);
  readonly media = computed(() => {
    const clip = this.clip();
    return clip ? (findMedia(this.store.project(), clip.sourceId) ?? null) : null;
  });
  readonly isVisual = computed(() => !!this.track() && this.track()!.kind !== 'audio' && !!this.media()?.hasVideo);

  /** Tiempo del playhead relativo al inicio del clip, limitado a su duración. */
  readonly clipTime = computed(() => {
    const clip = this.clip();
    if (!clip) return 0;
    return Math.min(clipDuration(clip), Math.max(0, this.playback.currentTime() - clip.start));
  });
  /** ¿El playhead está sobre el clip? (los keyframes se agregan en el playhead). */
  readonly playheadInside = computed(() => {
    const clip = this.clip();
    if (!clip) return false;
    const t = this.playback.currentTime();
    return t >= clip.start - 1e-6 && t <= clip.start + clipDuration(clip) + 1e-6;
  });
  readonly params = computed(() => {
    const clip = this.clip();
    return clip ? visualParams(clip, this.clipTime()) : null;
  });

  /** Cambia propiedades en el instante actual (con agrupado de historial por clave). */
  set(values: Partial<Record<AnimatableProp, number>>, mergeKey: string): void {
    const clip = this.clip();
    if (!clip || this.track()?.locked) return;
    this.store.dispatch(Commands.setClipProps(clip.id, values, this.clipTime()), { mergeKey: `${mergeKey}:${clip.id}` });
  }
}
