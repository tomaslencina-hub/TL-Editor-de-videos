import { Component, ElementRef, inject, OnDestroy, viewChildren, type AfterViewInit } from '@angular/core';
import { DEFAULT_ADJUST, DEFAULT_TRANSFORM } from '../../../../shared/model';
import { TRANSITION_LABELS, TRANSITION_TYPES, type TransitionType } from '../../../../shared/transitions';
import { Compositor, type LayerDraw } from '../../core/render/compositor';
import { MediaDragService, TRANSITION_DRAG_TYPE } from '../../core/ui/media-drag.service';

const PREVIEW_MS = 1400;
const THUMB_W = 192;
const THUMB_H = 108;

/** Imagen de ejemplo para las miniaturas (A = sale, B = entra). */
function sampleImage(label: string, from: string, to: string): OffscreenCanvas {
  const c = new OffscreenCanvas(THUMB_W, THUMB_H);
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, THUMB_W, THUMB_H);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = 'bold 44px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, THUMB_W / 2, THUMB_H / 2 + 2);
  return c;
}

@Component({
  selector: 'app-transitions-panel',
  templateUrl: './transitions-panel.html',
  styleUrl: './transitions-panel.scss',
})
export class TransitionsPanel implements AfterViewInit, OnDestroy {
  private readonly drag = inject(MediaDragService);

  protected readonly types = TRANSITION_TYPES;
  protected readonly labels = TRANSITION_LABELS;

  private readonly canvases = viewChildren<ElementRef<HTMLCanvasElement>>('thumb');
  /** Las miniaturas se dibujan con el mismo compositor que la vista previa y la exportación. */
  private compositor: Compositor | null = null;
  private raf: number | null = null;

  ngAfterViewInit(): void {
    try {
      this.compositor = new Compositor(new OffscreenCanvas(THUMB_W, THUMB_H));
      this.compositor.setSize(THUMB_W, THUMB_H);
      this.compositor.upload('A', sampleImage('A', '#2f6fb3', '#19c3b0'), THUMB_W, THUMB_H);
      this.compositor.upload('B', sampleImage('B', '#b23ad6', '#ff6b8b'), THUMB_W, THUMB_H);
      TRANSITION_TYPES.forEach((t, i) => this.paint(i, t, 0.5));
    } catch (e) {
      console.warn('Miniaturas de transiciones', e);
    }
  }

  private paint(index: number, type: TransitionType, progress: number): void {
    const comp = this.compositor;
    const canvas = this.canvases()[index]?.nativeElement;
    if (!comp || !canvas) return;
    const layer = (texture: string): LayerDraw => ({
      texture,
      width: THUMB_W,
      height: THUMB_H,
      transform: DEFAULT_TRANSFORM,
      adjust: DEFAULT_ADJUST,
    });
    comp.render('#000000', [{ from: layer('A'), to: layer('B'), transition: { type, progress } }]);
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(comp.canvas as OffscreenCanvas, 0, 0, canvas.width, canvas.height);
  }

  protected onEnter(index: number, type: TransitionType): void {
    this.stop();
    const start = performance.now();
    const loop = (now: number) => {
      // Ida y vuelta para que se vea completa.
      const phase = ((now - start) % (PREVIEW_MS * 2)) / PREVIEW_MS;
      this.paint(index, type, phase <= 1 ? phase : 2 - phase);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  protected onLeave(index: number, type: TransitionType): void {
    this.stop();
    this.paint(index, type, 0.5);
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
    this.compositor?.dispose();
  }

  private stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }
}
