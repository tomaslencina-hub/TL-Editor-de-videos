import { clipDuration, type Clip } from '../../../../shared/model';
import { textAnimation, type TextContent } from '../../../../shared/text';
import type { Compositor } from './compositor';
import type { ResolvedSource } from './scene';

export interface RenderedText {
  canvas: OffscreenCanvas;
  /** Tamaño en píxeles del cuadro del proyecto. */
  width: number;
  height: number;
}

const CACHE_SIZE = 48;

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rr);
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Rasteriza texto con canvas 2D a la resolución del proyecto. Lo usan la vista previa y la
 * exportación (mismo resultado). Cachea por estilo + texto visible + alto del cuadro.
 */
export class TextRasterizer {
  private readonly cache = new Map<string, RenderedText>();

  render(text: TextContent, frameHeight: number, reveal = 1): RenderedText {
    const chars = [...text.text];
    const visibleCount = Math.round(chars.length * Math.min(1, Math.max(0, reveal)));
    const key = `${frameHeight}|${visibleCount}|${JSON.stringify(text)}`;
    const hit = this.cache.get(key);
    if (hit) {
      // LRU: lo vuelve a poner al final.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    const u = frameHeight / 1080;
    const fontPx = Math.max(1, text.fontSize * u);
    const font = `${text.italic ? 'italic ' : ''}${text.bold ? '700' : '400'} ${fontPx}px "${text.fontFamily}", "Segoe UI", sans-serif`;
    const measureCtx = new OffscreenCanvas(1, 1).getContext('2d')!;
    measureCtx.font = font;
    measureCtx.letterSpacing = `${text.letterSpacing * u}px`;

    // El tamaño se calcula con el texto completo: la máquina de escribir no hace "saltar" la caja.
    const lines = text.text.split('\n');
    const lineH = fontPx * text.lineHeight;
    const textW = Math.max(1, ...lines.map((l) => measureCtx.measureText(l || ' ').width));
    const textH = Math.max(lineH, lines.length * lineH);

    const strokePx = text.stroke.enabled ? text.stroke.width * u : 0;
    const shadowPx = text.shadow.enabled ? text.shadow.blur * u + Math.max(Math.abs(text.shadow.offsetX), Math.abs(text.shadow.offsetY)) * u : 0;
    const bgPad = text.background.enabled ? text.background.padding * u : 0;
    const pad = Math.ceil(Math.max(strokePx, shadowPx) + bgPad + 2);

    const width = Math.ceil(textW + pad * 2);
    const height = Math.ceil(textH + pad * 2);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;

    if (text.background.enabled) {
      ctx.fillStyle = hexToRgba(text.background.color, text.background.opacity);
      roundRect(ctx, pad - bgPad, pad - bgPad, textW + bgPad * 2, textH + bgPad * 2, text.background.radius * u);
      ctx.fill();
    }

    ctx.font = font;
    ctx.letterSpacing = `${text.letterSpacing * u}px`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = text.align;
    ctx.lineJoin = 'round';
    const x = text.align === 'left' ? pad : text.align === 'right' ? pad + textW : pad + textW / 2;

    // Texto visible (máquina de escribir), respetando saltos de línea.
    let remaining = visibleCount;
    const visibleLines = lines.map((l) => {
      const c = [...l];
      const take = Math.max(0, Math.min(c.length, remaining));
      remaining -= c.length + 1; // +1 por el salto de línea
      return c.slice(0, take).join('');
    });

    visibleLines.forEach((line, i) => {
      if (!line) return;
      const y = pad + lineH * (i + 0.5);
      if (text.shadow.enabled) {
        ctx.shadowColor = text.shadow.color;
        ctx.shadowBlur = text.shadow.blur * u;
        ctx.shadowOffsetX = text.shadow.offsetX * u;
        ctx.shadowOffsetY = text.shadow.offsetY * u;
      }
      if (strokePx > 0) {
        ctx.strokeStyle = text.stroke.color;
        ctx.lineWidth = strokePx * 2;
        ctx.strokeText(line, x, y);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = text.color;
      ctx.fillText(line, x, y);
      ctx.shadowColor = 'transparent';
    });

    const rendered = { canvas, width, height };
    this.cache.set(key, rendered);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return rendered;
  }
}

/**
 * Sube (si cambió) la textura de un clip de texto en el instante t y devuelve la fuente para la escena.
 * `uploaded` recuerda qué imagen tiene cada textura para no re-subirla en cada cuadro.
 */
export function resolveTextLayer(
  compositor: Compositor,
  rasterizer: TextRasterizer,
  uploaded: Map<string, RenderedText>,
  textureKey: string,
  clip: Clip,
  t: number,
  frameHeight: number,
): ResolvedSource | null {
  if (!clip.text) return null;
  const anim = textAnimation(clip.text, t - clip.start, clipDuration(clip));
  const r = rasterizer.render(clip.text, frameHeight, anim.reveal);
  if (uploaded.get(textureKey) !== r) {
    compositor.upload(textureKey, r.canvas, r.width, r.height);
    uploaded.set(textureKey, r);
  }
  return { texture: textureKey, width: r.width, height: r.height, fit: 'none' };
}
