import { Component, inject, OnDestroy, signal } from '@angular/core';
import { TRANSITION_LABELS, TRANSITION_TYPES, type TransitionType } from '../../../../shared/transitions';
import { transitionStyles, type LayerStyle } from '../../core/playback/transition-styles';
import { MediaDragService, TRANSITION_DRAG_TYPE } from '../../core/ui/media-drag.service';

const PREVIEW_MS = 1400;

@Component({
  selector: 'app-transitions-panel',
  templateUrl: './transitions-panel.html',
  styleUrl: './transitions-panel.scss',
})
export class TransitionsPanel implements OnDestroy {
  private readonly drag = inject(MediaDragService);

  protected readonly types = TRANSITION_TYPES;
  protected readonly labels = TRANSITION_LABELS;

  /** Tarjeta animada (hover) y su progreso; el resto se muestra a mitad de transición. */
  protected readonly hovered = signal<TransitionType | null>(null);
  protected readonly progress = signal(0.5);
  private raf: number | null = null;

  protected styleFor(type: TransitionType, role: 'from' | 'to'): Record<string, string> {
    const p = this.hovered() === type ? this.progress() : 0.5;
    const s: LayerStyle = transitionStyles(type, p)[role];
    return {
      opacity: String(s.opacity),
      transform: s.transform,
      'clip-path': s.clipPath,
      filter: s.filter,
      'z-index': String(s.order),
    };
  }

  protected onEnter(type: TransitionType): void {
    this.hovered.set(type);
    const start = performance.now();
    const loop = (now: number) => {
      // Ida y vuelta para que se vea completa.
      const phase = ((now - start) % (PREVIEW_MS * 2)) / PREVIEW_MS;
      this.progress.set(phase <= 1 ? phase : 2 - phase);
      this.raf = requestAnimationFrame(loop);
    };
    this.stop();
    this.raf = requestAnimationFrame(loop);
  }

  protected onLeave(): void {
    this.stop();
    this.hovered.set(null);
  }

  protected onDragStart(e: DragEvent, type: TransitionType): void {
    e.dataTransfer?.setData(TRANSITION_DRAG_TYPE, type);
    e.dataTransfer!.effectAllowed = 'copy';
    this.drag.transition.set(type);
  }

  protected onDragEnd(): void {
    this.drag.transition.set(null);
  }

  ngOnDestroy(): void {
    this.stop();
  }

  private stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }
}
