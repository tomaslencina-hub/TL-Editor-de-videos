import { Component, ElementRef, inject, OnDestroy, viewChildren, type AfterViewInit } from '@angular/core';
import { makeOverlay, OVERLAY_ICONS, OVERLAY_LABELS, OVERLAY_TYPES, type OverlayType } from '../../../../shared/effects';
import { EditorActionsService } from '../../core/editor-actions.service';
import { drawOverlay } from '../../core/render/overlay-renderer';

/** Pestaña "Efectos": corazones, fuegos artificiales, confeti... con vista previa animada. */
@Component({
  selector: 'app-effects-panel',
  template: `
    <p class="hint">Hacé clic en un efecto para agregarlo en el playhead, encima del video. Después ajustalo en <b>Propiedades</b>.</p>
    <div class="grid">
      @for (t of types; track t) {
        <button class="card" (click)="add(t)" [title]="'Agregar ' + labels[t]">
          <canvas #thumb width="320" height="180"></canvas>
          <span class="name">{{ labels[t] }}</span>
        </button>
      }
    </div>
  `,
  styles: `
    :host { display: block; overflow-y: auto; padding: 10px; }
    .hint { margin: 0 0 10px; color: var(--text-2); font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
    .card {
      display: flex; flex-direction: column; align-items: stretch; gap: 5px;
      padding: 6px; background: var(--bg-2);
      &:hover { border-color: var(--accent); background: var(--bg-3); }
    }
    canvas { width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; background: linear-gradient(135deg, #2b3245, #161922); }
    .name { font-size: 11px; color: var(--text-1); text-align: center; }
  `,
})
export class EffectsPanel implements AfterViewInit, OnDestroy {
  private readonly actions = inject(EditorActionsService);
  private readonly canvases = viewChildren<ElementRef<HTMLCanvasElement>>('thumb');

  protected readonly types = OVERLAY_TYPES;
  protected readonly labels = OVERLAY_LABELS;
  protected readonly icons = OVERLAY_ICONS;

  private raf: number | null = null;

  ngAfterViewInit(): void {
    // Las miniaturas usan el mismo dibujo que el render final.
    // En la miniatura (180 px de alto) las partículas se agrandan para que se aprecien.
    const effects = this.types.map((t) => ({ ...makeOverlay(t, 7), size: 2.4, intensity: 0.8 }));
    const scratch = new OffscreenCanvas(320, 180);
    const start = performance.now();
    const loop = (now: number) => {
      const t = (now - start) / 1000;
      this.canvases().forEach((ref, i) => {
        const ctx = ref.nativeElement.getContext('2d');
        if (!ctx) return;
        drawOverlay(scratch, effects[i], t);
        ctx.clearRect(0, 0, 320, 180);
        ctx.drawImage(scratch, 0, 0);
      });
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  ngOnDestroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
  }

  protected add(type: OverlayType): void {
    this.actions.addOverlay(type);
  }
}
