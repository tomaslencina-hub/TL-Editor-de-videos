import { Component, effect, ElementRef, input, viewChild } from '@angular/core';
import type { WaveformData } from '../../../../shared/ipc-contract';

/** Canvas máximo para no exceder límites del navegador en clips muy largos con mucho zoom. */
const MAX_CANVAS_WIDTH = 8192;

@Component({
  selector: 'app-waveform',
  template: `<canvas #canvas></canvas>`,
  styles: `
    :host { display: block; pointer-events: none; }
    canvas { display: block; width: 100%; height: 100%; }
  `,
})
export class Waveform {
  readonly data = input.required<WaveformData>();
  readonly inPoint = input.required<number>();
  readonly outPoint = input.required<number>();
  /** Ancho en px CSS del clip. */
  readonly width = input.required<number>();
  readonly height = input.required<number>();
  readonly color = input('rgba(255,255,255,0.75)');

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => {
      this.draw(this.data(), this.inPoint(), this.outPoint(), this.width(), this.height(), this.color());
    });
  }

  private draw(data: WaveformData, inPoint: number, outPoint: number, width: number, height: number, color: string): void {
    const canvas = this.canvas().nativeElement;
    const w = Math.max(1, Math.min(MAX_CANVAS_WIDTH, Math.floor(width)));
    const h = Math.max(1, Math.floor(height));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;

    const { peaks, peaksPerSecond } = data;
    const dur = outPoint - inPoint;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const t0 = inPoint + (x / w) * dur;
      const t1 = inPoint + ((x + 1) / w) * dur;
      const i0 = Math.floor(t0 * peaksPerSecond);
      const i1 = Math.max(i0 + 1, Math.ceil(t1 * peaksPerSecond));
      let max = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
      // Escala raíz: realza niveles bajos para que la forma sea legible.
      const amp = Math.sqrt(max) * mid * 0.95;
      if (amp > 0.3) ctx.fillRect(x, mid - amp, 1, amp * 2);
    }
  }
}
