import { Component, effect, ElementRef, input, viewChild } from '@angular/core';
import { formatRulerLabel } from '../../core/timeline/time';

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
const MIN_LABEL_SPACING = 70;

/**
 * Regla de tiempo dibujada en canvas. Solo dibuja la porción visible (se posiciona "sticky"),
 * así funciona igual con timelines de horas.
 */
@Component({
  selector: 'app-timeline-ruler',
  template: `<canvas #canvas></canvas>`,
  styles: `
    :host { display: block; }
    canvas { display: block; width: 100%; height: 100%; }
  `,
})
export class TimelineRuler {
  readonly pps = input.required<number>();
  readonly scrollLeft = input.required<number>();
  readonly width = input.required<number>();
  readonly height = input(28);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => this.draw(this.pps(), this.scrollLeft(), this.width(), this.height()));
  }

  private draw(pps: number, scrollLeft: number, width: number, height: number): void {
    const canvas = this.canvas().nativeElement;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    ctx.fillStyle = styles.getPropertyValue('--bg-1').trim() || '#18191e';
    ctx.fillRect(0, 0, width, height);

    const step = STEPS.find((s) => s * pps >= MIN_LABEL_SPACING) ?? STEPS[STEPS.length - 1];
    const minor = step / 5;
    const startT = scrollLeft / pps;
    const endT = (scrollLeft + width) / pps;

    ctx.strokeStyle = styles.getPropertyValue('--text-2').trim() || '#7d818c';
    ctx.fillStyle = styles.getPropertyValue('--text-1').trim() || '#b4b7c0';
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;

    ctx.beginPath();
    const firstMinor = Math.floor(startT / minor);
    for (let i = firstMinor; i * minor <= endT; i++) {
      const t = i * minor;
      const x = Math.round(t * pps - scrollLeft) + 0.5;
      const isMajor = i % 5 === 0;
      const tick = isMajor ? 12 : 5;
      ctx.moveTo(x, height - tick);
      ctx.lineTo(x, height);
      if (isMajor) ctx.fillText(formatRulerLabel(t, step), x + 3, 4);
    }
    ctx.stroke();

    ctx.strokeStyle = styles.getPropertyValue('--border').trim() || '#2e3139';
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();
  }
}
