import { Component, computed, ElementRef, inject, input, signal } from '@angular/core';
import { visualParams } from '../../../../shared/animation';
import { PlaybackService } from '../../core/playback/playback.service';
import { boxContains, layerBox, type LayerBox } from '../../core/render/geometry';
import { planFrame, TransitionCache } from '../../core/render/scene';
import { ProjectStore } from '../../core/state/project-store';
import { SelectedClipService } from '../../core/state/selected-clip.service';
import { findMedia } from '../../core/timeline/timeline-ops';

type Mode = 'move' | 'scale' | 'rotate';

interface Drag {
  mode: Mode;
  startPx: { x: number; y: number };
  box: LayerBox;
  start: { x: number; y: number; scale: number; rotation: number };
}

/** Distancia (fracción del cuadro) a la que la posición se imanta al centro. */
const CENTER_SNAP = 0.01;

/**
 * Manijas de transformación sobre la vista previa (mover, escalar, rotar) y selección por clic.
 * Trabaja en píxeles del cuadro del proyecto con la misma geometría que el compositor.
 */
@Component({
  selector: 'app-transform-gizmo',
  template: `
    <div class="hit" (pointerdown)="onBackgroundDown($event)"></div>
    @if (box(); as b) {
      <div
        class="box"
        [style.left.px]="b.cx * k()"
        [style.top.px]="b.cy * k()"
        [style.width.px]="b.w * k()"
        [style.height.px]="b.h * k()"
        [style.transform]="'translate(-50%, -50%) rotate(' + b.rotation + 'deg)'"
        (pointerdown)="begin($event, 'move')"
      >
        <span class="h tl" (pointerdown)="begin($event, 'scale')"></span>
        <span class="h tr" (pointerdown)="begin($event, 'scale')"></span>
        <span class="h bl" (pointerdown)="begin($event, 'scale')"></span>
        <span class="h br" (pointerdown)="begin($event, 'scale')"></span>
        <span class="rot" (pointerdown)="begin($event, 'rotate')" title="Rotar (Shift: de a 15°)"></span>
      </div>
    }
    @if (guides().x) {
      <div class="guide v" [style.left.px]="(frameW() / 2) * k()"></div>
    }
    @if (guides().y) {
      <div class="guide h2" [style.top.px]="(frameH() / 2) * k()"></div>
    }
  `,
  styles: `
    :host { position: absolute; inset: 0; z-index: 5; }
    .hit { position: absolute; inset: 0; }
    .box {
      position: absolute;
      border: 1.5px solid var(--accent);
      box-shadow: 0 0 0 1px rgb(0 0 0 / 50%);
      cursor: move;
      touch-action: none;
    }
    .h {
      position: absolute;
      width: 10px; height: 10px;
      background: #fff;
      border: 1.5px solid var(--accent);
      border-radius: 2px;
      &.tl { left: -6px; top: -6px; cursor: nwse-resize; }
      &.tr { right: -6px; top: -6px; cursor: nesw-resize; }
      &.bl { left: -6px; bottom: -6px; cursor: nesw-resize; }
      &.br { right: -6px; bottom: -6px; cursor: nwse-resize; }
    }
    .rot {
      position: absolute;
      left: 50%; top: -28px;
      width: 12px; height: 12px;
      margin-left: -6px;
      border-radius: 50%;
      background: var(--accent);
      cursor: grab;
      &::after {
        content: '';
        position: absolute;
        left: 5px; top: 12px;
        width: 1.5px; height: 16px;
        background: var(--accent);
      }
    }
    .guide { position: absolute; pointer-events: none; }
    .guide.v { top: 0; bottom: 0; border-left: 1px dashed #ff4dd2; }
    .guide.h2 { left: 0; right: 0; border-top: 1px dashed #ff4dd2; }
  `,
  host: {
    '(pointermove)': 'onMove($event)',
    '(pointerup)': 'end($event)',
    '(pointercancel)': 'end($event)',
  },
})
export class TransformGizmo {
  /** Tamaño en CSS del cuadro mostrado. */
  readonly cssWidth = input.required<number>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly store = inject(ProjectStore);
  private readonly playback = inject(PlaybackService);
  private readonly sel = inject(SelectedClipService);
  private readonly transitions = new TransitionCache();

  protected readonly frameW = computed(() => this.store.settings().width);
  protected readonly frameH = computed(() => this.store.settings().height);
  /** CSS px por píxel del cuadro. */
  protected readonly k = computed(() => Math.max(1e-6, this.cssWidth() / this.frameW()));
  protected readonly guides = signal({ x: false, y: false });
  private drag: Drag | null = null;

  /** Caja del clip seleccionado, si es visual y el playhead está sobre él. */
  protected readonly box = computed<LayerBox | null>(() => {
    const media = this.sel.media();
    const params = this.sel.params();
    if (!this.sel.isVisual() || !this.sel.playheadInside() || !media?.width || !media.height || !params) return null;
    return layerBox(this.frameW(), this.frameH(), media.width, media.height, params.transform);
  });

  private toFrame(e: PointerEvent): { x: number; y: number } {
    const rect = this.el.nativeElement.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / this.k(), y: (e.clientY - rect.top) / this.k() };
  }

  /** Clic fuera del clip seleccionado: selecciona la capa visible más alta bajo el puntero. */
  protected onBackgroundDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.toFrame(e);
    const project = this.store.project();
    const t = this.playback.currentTime();
    const plan = planFrame(project, t, this.transitions);
    for (const track of [...plan].reverse()) {
      for (const layer of [...track.layers].reverse()) {
        const media = findMedia(project, layer.clip.sourceId);
        if (!media?.width || !media.height) continue;
        const { transform } = visualParams(layer.clip, t - layer.clip.start);
        if (boxContains(layerBox(this.frameW(), this.frameH(), media.width, media.height, transform), p.x, p.y)) {
          this.store.selectClip(layer.clip.id);
          return;
        }
      }
    }
    this.store.selectClip(null);
  }

  protected begin(e: PointerEvent, mode: Mode): void {
    const box = this.box();
    const params = this.sel.params();
    if (e.button !== 0 || !box || !params || this.sel.track()?.locked || this.cssWidth() <= 0) return;
    e.stopPropagation();
    this.playback.pause();
    this.el.nativeElement.setPointerCapture(e.pointerId);
    const { x, y, scale, rotation } = params.transform;
    this.drag = { mode, startPx: this.toFrame(e), box, start: { x, y, scale, rotation } };
  }

  protected onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const p = this.toFrame(e);
    if (d.mode === 'move') {
      let x = d.start.x + (p.x - d.startPx.x) / this.frameW();
      let y = d.start.y + (p.y - d.startPx.y) / this.frameH();
      const snapX = !e.altKey && Math.abs(x) < CENTER_SNAP;
      const snapY = !e.altKey && Math.abs(y) < CENTER_SNAP;
      if (snapX) x = 0;
      if (snapY) y = 0;
      this.guides.set({ x: snapX, y: snapY });
      this.sel.set({ x, y }, 'gizmo-move');
    } else if (d.mode === 'scale') {
      const dist = (q: { x: number; y: number }) => Math.hypot(q.x - d.box.cx, q.y - d.box.cy);
      const ratio = dist(p) / Math.max(1, dist(d.startPx));
      this.sel.set({ scale: Math.max(0.01, Math.min(4, d.start.scale * ratio)) }, 'gizmo-scale');
    } else {
      const ang = (q: { x: number; y: number }) => (Math.atan2(q.y - d.box.cy, q.x - d.box.cx) * 180) / Math.PI;
      let rotation = d.start.rotation + ang(p) - ang(d.startPx);
      rotation = ((((rotation + 180) % 360) + 360) % 360) - 180;
      if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
      this.sel.set({ rotation }, 'gizmo-rotate');
    }
  }

  protected end(e: PointerEvent): void {
    if (!this.drag) return;
    this.drag = null;
    this.guides.set({ x: false, y: false });
    this.el.nativeElement.releasePointerCapture?.(e.pointerId);
  }
}

