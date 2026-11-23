import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { ProjectStore } from '../state/project-store';
import { PLAYBACK_ENGINE, type PlaybackSurface } from './playback-engine';

/**
 * Reloj de reproducción (fuente del tiempo del playhead) y controlador del motor.
 * El tiempo avanza con performance.now(), así funciona igual sobre huecos sin clips.
 */
@Injectable({ providedIn: 'root' })
export class PlaybackService {
  private readonly store = inject(ProjectStore);
  private readonly engine = inject(PLAYBACK_ENGINE);

  readonly currentTime = signal(0);
  readonly playing = signal(false);

  private rafId: number | null = null;
  private anchorTime = 0;
  private anchorNow = 0;

  constructor() {
    // Cualquier cambio en el proyecto (editar, deshacer) se refleja en la vista previa.
    effect(() => {
      const project = this.store.project();
      const t = this.currentTime();
      untracked(() => {
        if (!this.playing()) this.engine.sync(project, t, false);
      });
    });
  }

  attach(surface: PlaybackSurface): void {
    this.engine.attach(surface);
    this.engine.sync(this.store.project(), this.currentTime(), false);
  }

  detach(): void {
    this.pause();
    this.engine.detach();
  }

  toggle(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    if (this.playing()) return;
    const duration = this.store.duration();
    if (duration <= 0) return;
    if (this.currentTime() >= duration - 1e-3) this.currentTime.set(0);
    this.anchorTime = this.currentTime();
    this.anchorNow = performance.now();
    this.playing.set(true);
    this.tick();
  }

  pause(): void {
    if (!this.playing()) return;
    this.playing.set(false);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.engine.halt();
    this.engine.sync(this.store.project(), this.currentTime(), false);
  }

  seek(t: number): void {
    const clamped = Math.max(0, t);
    this.currentTime.set(clamped);
    if (this.playing()) {
      this.anchorTime = clamped;
      this.anchorNow = performance.now();
    }
  }

  /** Avanza/retrocede N frames (en pausa). */
  step(frames: number): void {
    this.pause();
    const fps = this.store.settings().fps;
    const frame = Math.round(this.currentTime() * fps) + frames;
    this.seek(Math.max(0, frame / fps));
  }

  private readonly tick = (): void => {
    if (!this.playing()) return;
    const duration = this.store.duration();
    const t = this.anchorTime + (performance.now() - this.anchorNow) / 1000;
    if (t >= duration) {
      this.currentTime.set(duration);
      this.pause();
      return;
    }
    this.currentTime.set(t);
    this.engine.sync(this.store.project(), t, true);
    this.rafId = requestAnimationFrame(this.tick);
  };
}
