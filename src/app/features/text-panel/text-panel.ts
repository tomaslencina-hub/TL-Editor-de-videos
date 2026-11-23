import { Component, ElementRef, inject, viewChildren, type AfterViewInit } from '@angular/core';
import { makeText, TEXT_PRESETS, type TextPreset } from '../../../../shared/text';
import { EditorActionsService } from '../../core/editor-actions.service';
import { TextRasterizer } from '../../core/render/text-renderer';

/** Pestaña "Texto": estilos prearmados que se agregan en el playhead. */
@Component({
  selector: 'app-text-panel',
  template: `
    <p class="hint">Hacé clic en un estilo para agregarlo en el playhead. Después editalo en <b>Propiedades</b>.</p>
    <div class="grid">
      @for (p of presets; track p.id) {
        <button class="card" (click)="add(p)" [title]="'Agregar ' + p.label">
          <canvas #thumb width="320" height="180"></canvas>
          <span class="name">{{ p.label }}</span>
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
    canvas { width: 100%; aspect-ratio: 16 / 9; border-radius: 4px; background: #2a2d35; }
    .name { font-size: 11px; color: var(--text-1); text-align: center; }
  `,
})
export class TextPanel implements AfterViewInit {
  private readonly actions = inject(EditorActionsService);
  private readonly canvases = viewChildren<ElementRef<HTMLCanvasElement>>('thumb');
  protected readonly presets = TEXT_PRESETS;

  ngAfterViewInit(): void {
    const rasterizer = new TextRasterizer();
    this.canvases().forEach((ref, i) => {
      const canvas = ref.nativeElement;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      g.addColorStop(0, '#3a4256');
      g.addColorStop(1, '#22262f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Mismo rasterizador que el render: la miniatura es el texto real, escalado a un cuadro de 180 px.
      const preset = this.presets[i];
      const r = rasterizer.render(makeText(preset), canvas.height);
      const k = Math.min(1, (canvas.width * 0.92) / r.width);
      const w = r.width * k;
      const h = r.height * k;
      const cx = canvas.width / 2 + (preset.x ?? 0) * canvas.width * 0.6;
      const cy = canvas.height / 2 + (preset.y ?? 0) * canvas.height;
      ctx.drawImage(r.canvas, cx - w / 2, cy - h / 2, w, h);
    });
  }

  protected add(preset: TextPreset): void {
    this.actions.addText(preset);
  }
}
