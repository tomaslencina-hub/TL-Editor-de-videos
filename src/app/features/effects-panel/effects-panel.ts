import { Component, ElementRef, inject, OnDestroy, viewChildren, type AfterViewInit } from '@angular/core';
import { makeOverlay, OVERLAY_ICONS, OVERLAY_LABELS, OVERLAY_TYPES, type OverlayType } from '../../../../shared/effects';
import { FILTER_LABELS, FILTER_TYPES, makeFilter, type FilterType } from '../../../../shared/filters';
import { DEFAULT_ADJUST, DEFAULT_TRANSFORM } from '../../../../shared/model';
import { EditorActionsService } from '../../core/editor-actions.service';
import { Compositor } from '../../core/render/compositor';
import { drawOverlay } from '../../core/render/overlay-renderer';

const FW = 160;
const FH = 90;

/** Paisaje de ejemplo para las miniaturas de filtros (cielo, sol, montañas, lago). */
function sampleScene(): OffscreenCanvas {
  const c = new OffscreenCanvas(FW, FH);
  const ctx = c.getContext('2d')!;
  const sky = ctx.createLinearGradient(0, 0, 0, FH * 0.62);
  sky.addColorStop(0, '#3a6fd8');
  sky.addColorStop(0.6, '#f59a6b');
  sky.addColorStop(1, '#ffd27a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, FW, FH);
  ctx.fillStyle = '#fff3c4';
  ctx.beginPath();
  ctx.arc(FW * 0.68, FH * 0.5, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#4b3f72';
  ctx.beginPath();
  ctx.moveTo(0, FH * 0.62);
  ctx.lineTo(FW * 0.22, FH * 0.3);
  ctx.lineTo(FW * 0.42, FH * 0.55);
  ctx.lineTo(FW * 0.58, FH * 0.38);
  ctx.lineTo(FW, FH * 0.62);
  ctx.fill();
  ctx.fillStyle = '#2f7a5a';
  ctx.beginPath();
  ctx.moveTo(0, FH * 0.62);
  ctx.quadraticCurveTo(FW * 0.3, FH * 0.5, FW * 0.55, FH * 0.62);
  ctx.fill();
  const lake = ctx.createLinearGradient(0, FH * 0.62, 0, FH);
  lake.addColorStop(0, '#f0a476');
  lake.addColorStop(1, '#1f3f7a');
  ctx.fillStyle = lake;
  ctx.fillRect(0, FH * 0.62, FW, FH * 0.38);
  ctx.fillStyle = 'rgba(255,243,196,0.7)';
  ctx.fillRect(FW * 0.63, FH * 0.68, FW * 0.1, 2);
  ctx.fillRect(FW * 0.6, FH * 0.76, FW * 0.16, 2);
  return c;
}

/** Pestaña "Efectos": efectos animados (corazones, confeti…) y filtros (blanco y negro, VHS…). */
@Component({
  selector: 'app-effects-panel',
  template: `
    <h3>Efectos animados</h3>
    <p class="hint">Hacé clic en un efecto para agregarlo en el playhead, encima del video. Después ajustalo en <b>Propiedades</b>.</p>
    <div class="grid">
      @for (t of types; track t) {
        <button class="card" (click)="add(t)" [title]="'Agregar ' + labels[t]">
          <canvas #thumb width="320" height="180"></canvas>
          <span class="name">{{ labels[t] }}</span>
        </button>
      }
    </div>

    <h3>Filtros</h3>
    <p class="hint">
      Con un clip seleccionado, el filtro se aplica a ese clip. Sin selección, se agrega una <b>capa de filtro</b> en el
      playhead que afecta a todo lo que está debajo (estirala en la timeline para cubrir más tiempo).
    </p>
    <div class="grid">
      @for (f of filters; track f; let i = $index) {
        <button class="card" (click)="applyFilter(f)" (mouseenter)="animate(i, f)" (mouseleave)="stopFilter(i, f)" [title]="filterLabels[f]">
          <canvas #filterThumb width="160" height="90"></canvas>
          <span class="name">{{ filterLabels[f] }}</span>
        </button>
      }
    </div>
  `,
  styles: `
    :host { display: block; overflow-y: auto; padding: 10px; }
    h3 { margin: 4px 0 6px; font-size: 12px; font-weight: 600; color: var(--text-1); text-transform: uppercase; letter-spacing: 0.04em; }
    .grid + h3 { margin-top: 16px; }
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
  private readonly filterCanvases = viewChildren<ElementRef<HTMLCanvasElement>>('filterThumb');

  protected readonly types = OVERLAY_TYPES;
  protected readonly labels = OVERLAY_LABELS;
  protected readonly icons = OVERLAY_ICONS;
  protected readonly filters = FILTER_TYPES;
  protected readonly filterLabels = FILTER_LABELS;

  private raf: number | null = null;
  private filterRaf: number | null = null;
  /** Las miniaturas de filtros usan el mismo compositor que la vista previa y la exportación. */
  private compositor: Compositor | null = null;

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

    try {
      this.compositor = new Compositor(new OffscreenCanvas(FW, FH));
      this.compositor.setSize(FW, FH);
      this.compositor.upload('scene', sampleScene(), FW, FH);
      this.filters.forEach((f, i) => this.paintFilter(i, f, 0.5));
    } catch (e) {
      console.warn('Miniaturas de filtros', e);
    }
  }

  private paintFilter(index: number, type: FilterType, time: number): void {
    const comp = this.compositor;
    const canvas = this.filterCanvases()[index]?.nativeElement;
    if (!comp || !canvas) return;
    const { amount } = makeFilter(type);
    comp.render('#000000', [
      {
        main: {
          texture: 'scene',
          width: FW,
          height: FH,
          transform: DEFAULT_TRANSFORM,
          adjust: DEFAULT_ADJUST,
          filter: { type, amount: Math.max(amount, 0.7), time },
        },
      },
    ]);
    canvas.getContext('2d')?.drawImage(comp.canvas as OffscreenCanvas, 0, 0, canvas.width, canvas.height);
  }

  /** Los filtros animados (grano, glitch, VHS…) se mueven al pasar el mouse. */
  protected animate(index: number, type: FilterType): void {
    this.stopLoop();
    const start = performance.now();
    const loop = (now: number) => {
      this.paintFilter(index, type, 0.5 + (now - start) / 1000);
      this.filterRaf = requestAnimationFrame(loop);
    };
    this.filterRaf = requestAnimationFrame(loop);
  }

  protected stopFilter(index: number, type: FilterType): void {
    this.stopLoop();
    this.paintFilter(index, type, 0.5);
  }

  private stopLoop(): void {
    if (this.filterRaf !== null) cancelAnimationFrame(this.filterRaf);
    this.filterRaf = null;
  }

  ngOnDestroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.stopLoop();
    this.compositor?.dispose();
  }

  protected add(type: OverlayType): void {
    this.actions.addOverlay(type);
  }

  protected applyFilter(type: FilterType): void {
    this.actions.applyFilter(type);
  }
}
