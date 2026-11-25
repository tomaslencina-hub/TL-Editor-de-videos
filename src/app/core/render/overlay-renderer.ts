import type { OverlayEffect } from '../../../../shared/effects';
import type { Clip } from '../../../../shared/model';
import type { Compositor } from './compositor';
import type { ResolvedSource } from './scene';

/**
 * Dibuja efectos animados (corazones, fuegos artificiales, confeti, nieve, brillos, burbujas).
 * Todo es función del tiempo y de aleatorios fijos por partícula (sin estado entre cuadros):
 * cualquier cuadro se puede calcular directo, así que el scrubbing y la exportación son exactos.
 */

const PALETTE = ['#ff4d6d', '#ffd84d', '#19c3b0', '#4d9bff', '#b23ad6', '#ff8a3d', '#7dff7a', '#ffffff'];

/** Aleatorio determinístico en [0, 1) a partir de una semilla y dos índices. */
function rnd(seed: number, i: number, k: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(k + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

interface DrawContext {
  ctx: OffscreenCanvasRenderingContext2D;
  W: number;
  H: number;
  /** Escala: píxeles por "píxel de 1080p". */
  u: number;
  /** Tiempo desde el inicio del clip (s). */
  t: number;
  fx: OverlayEffect;
}

function colorFor(d: DrawContext, i: number): string {
  return d.fx.multicolor ? PALETTE[Math.floor(rnd(d.fx.seed, i, 99) * PALETTE.length)] : d.fx.color;
}

function heartPath(ctx: OffscreenCanvasRenderingContext2D, s: number): void {
  ctx.beginPath();
  ctx.moveTo(0, s * 0.3);
  ctx.bezierCurveTo(0, 0, -s * 0.5, 0, -s * 0.5, s * 0.3);
  ctx.bezierCurveTo(-s * 0.5, s * 0.6, 0, s * 0.75, 0, s);
  ctx.bezierCurveTo(0, s * 0.75, s * 0.5, s * 0.6, s * 0.5, s * 0.3);
  ctx.bezierCurveTo(s * 0.5, 0, 0, 0, 0, s * 0.3);
  ctx.closePath();
}

function hearts(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(14 * fx.intensity);
  for (let i = 0; i < n; i++) {
    const period = (3.5 + rnd(fx.seed, i, 1) * 2.5) / fx.speed;
    const age = mod(t + rnd(fx.seed, i, 2) * period, period) / period; // 0..1 recorrido
    const s = (36 + rnd(fx.seed, i, 3) * 44) * u * fx.size;
    const x = (0.05 + rnd(fx.seed, i, 4) * 0.9) * W + Math.sin(age * 6 + i) * 30 * u;
    const y = H + s - (H + s * 2) * age;
    const alpha = Math.min(1, age * 8) * Math.min(1, (1 - age) * 4);
    const pulse = 1 + Math.sin(t * 6 + i) * 0.06;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(age * 4 + i) * 0.25);
    ctx.scale(pulse, pulse);
    ctx.translate(0, -s / 2);
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillStyle = colorFor(d, i);
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 8 * u;
    heartPath(ctx, s);
    ctx.fill();
    ctx.restore();
  }
}

function fireworks(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const interval = 0.9 / fx.intensity / fx.speed;
  const rise = 0.7 / fx.speed;
  const life = 1.8 / fx.speed;
  const radius = 260 * u * fx.size;
  const parts = 70;
  ctx.globalCompositeOperation = 'lighter';
  const last = Math.floor(t / interval);
  const first = Math.max(0, last - Math.ceil((rise + life) / interval) - 1);
  for (let j = first; j <= last; j++) {
    const t0 = j * interval + rnd(fx.seed, j, 1) * interval * 0.5;
    const tau = t - t0;
    if (tau < 0 || tau > rise + life) continue;
    const cx = (0.15 + rnd(fx.seed, j, 2) * 0.7) * W;
    const cy = (0.15 + rnd(fx.seed, j, 3) * 0.35) * H;
    const color = fx.multicolor ? PALETTE[Math.floor(rnd(fx.seed, j, 4) * (PALETTE.length - 1))] : fx.color;
    if (tau < rise) {
      // Cohete subiendo con estela.
      const p = tau / rise;
      const ease = 1 - (1 - p) * (1 - p);
      const x = cx;
      const y = H + 20 * u - (H + 20 * u - cy) * ease;
      const g = ctx.createLinearGradient(x, y, x, y + 60 * u);
      g.addColorStop(0, 'rgba(255,240,200,0.9)');
      g.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 2 * u, y, 4 * u, 60 * u);
      continue;
    }
    const e = tau - rise; // tiempo desde la explosión
    const alpha = Math.max(0, 1 - e / life);
    const spread = 1 - Math.exp(-3 * e * fx.speed);
    const gravity = 120 * u * e * e;
    for (let k = 0; k < parts; k++) {
      const a = (k / parts) * Math.PI * 2 + rnd(fx.seed, j * 131 + k, 5) * 0.2;
      const v = radius * (0.55 + rnd(fx.seed, j * 131 + k, 6) * 0.45);
      const x = cx + Math.cos(a) * v * spread;
      const y = cy + Math.sin(a) * v * spread + gravity;
      const r = (2.2 + rnd(fx.seed, j * 131 + k, 7) * 1.8) * u * fx.size;
      const twinkle = 0.6 + 0.4 * Math.sin(e * 25 + k);
      ctx.globalAlpha = alpha * twinkle;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
      ctx.globalAlpha = alpha * twinkle * 0.25;
      ctx.fill();
      ctx.globalAlpha = alpha * twinkle;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Destello inicial.
    if (e < 0.25) {
      ctx.globalAlpha = (1 - e / 0.25) * 0.8;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.5);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function confetti(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(110 * fx.intensity);
  const span = H * 1.2;
  for (let i = 0; i < n; i++) {
    const fall = (160 + rnd(fx.seed, i, 1) * 140) * u * fx.speed;
    const y = mod(t * fall + rnd(fx.seed, i, 2) * span, span) - H * 0.1;
    const x = rnd(fx.seed, i, 3) * W + Math.sin(t * (1 + rnd(fx.seed, i, 4)) * fx.speed + i) * 40 * u;
    const w = (10 + rnd(fx.seed, i, 5) * 8) * u * fx.size;
    const h = w * 0.5;
    const flip = Math.cos(t * (4 + rnd(fx.seed, i, 6) * 6) * fx.speed + i);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * (1 + rnd(fx.seed, i, 7) * 3) * fx.speed + i);
    ctx.scale(1, flip);
    ctx.fillStyle = colorFor(d, i);
    ctx.globalAlpha = 0.95;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
}

function snow(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(160 * fx.intensity);
  const span = H * 1.1;
  ctx.fillStyle = fx.color;
  for (let i = 0; i < n; i++) {
    const depth = rnd(fx.seed, i, 1); // 0 = lejos (chico y lento), 1 = cerca
    const r = (1.5 + depth * 4.5) * u * fx.size;
    const fall = (40 + depth * 90) * u * fx.speed;
    const y = mod(t * fall + rnd(fx.seed, i, 2) * span, span) - H * 0.05;
    const x = mod(rnd(fx.seed, i, 3) * W + Math.sin(t * 0.8 * fx.speed + i) * 25 * u * (0.5 + depth), W);
    ctx.globalAlpha = 0.45 + depth * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function sparkles(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(45 * fx.intensity);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const freq = (0.4 + rnd(fx.seed, i, 1) * 0.8) * fx.speed;
    const cycle = Math.floor(t * freq + rnd(fx.seed, i, 2));
    const phase = mod(t * freq + rnd(fx.seed, i, 2), 1);
    // Cada destello aparece en un lugar distinto en cada ciclo.
    const x = rnd(fx.seed, i * 977 + cycle, 3) * W;
    const y = rnd(fx.seed, i * 977 + cycle, 4) * H;
    const a = Math.pow(Math.sin(phase * Math.PI), 3);
    if (a < 0.02) continue;
    const s = (14 + rnd(fx.seed, i, 5) * 26) * u * fx.size * (0.6 + a * 0.4);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(phase * 0.8);
    ctx.globalAlpha = a;
    ctx.fillStyle = colorFor(d, i);
    // Estrella de 4 puntas.
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const rr = k % 2 === 0 ? s : s * 0.18;
      ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
    }
    ctx.closePath();
    ctx.fill();
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.6);
    g.addColorStop(0, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-s, -s, s * 2, s * 2);
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function bubbles(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(26 * fx.intensity);
  for (let i = 0; i < n; i++) {
    const r = (14 + rnd(fx.seed, i, 1) * 40) * u * fx.size;
    const period = (5 + rnd(fx.seed, i, 2) * 4) / fx.speed;
    const age = mod(t + rnd(fx.seed, i, 3) * period, period) / period;
    const x = (0.05 + rnd(fx.seed, i, 4) * 0.9) * W + Math.sin(age * 9 + i) * 20 * u;
    const y = H + r - (H + r * 2) * age;
    const alpha = Math.min(1, age * 6) * Math.min(1, (1 - age) * 6);
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.35)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.05)');
    g.addColorStop(1, fx.color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = fx.color;
    ctx.lineWidth = 1.5 * u;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.ellipse(x - r * 0.35, y - r * 0.4, r * 0.18, r * 0.1, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Color de una paleta propia del efecto (si es multicolor) o el principal. */
function pick(d: DrawContext, i: number, palette: string[]): string {
  return d.fx.multicolor ? palette[Math.floor(rnd(d.fx.seed, i, 98) * palette.length)] : d.fx.color;
}

function rain(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(220 * fx.intensity);
  const span = H * 1.3;
  ctx.strokeStyle = fx.color;
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const depth = rnd(fx.seed, i, 1);
    const fall = (900 + depth * 900) * u * fx.speed;
    const len = (25 + depth * 45) * u * fx.size;
    const y = mod(t * fall + rnd(fx.seed, i, 2) * span, span) - H * 0.15;
    const x = mod(rnd(fx.seed, i, 3) * W * 1.2 - y * 0.15, W * 1.2) - W * 0.1;
    ctx.globalAlpha = 0.2 + depth * 0.45;
    ctx.lineWidth = (1 + depth * 1.5) * u;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len * 0.15, y - len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function stars(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(160 * fx.intensity);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = fx.color;
  for (let i = 0; i < n; i++) {
    const x = rnd(fx.seed, i, 1) * W;
    const y = rnd(fx.seed, i, 2) * H;
    const r = (0.8 + Math.pow(rnd(fx.seed, i, 3), 3) * 2.8) * u * fx.size;
    const tw = 0.5 + 0.5 * Math.sin(t * (1 + rnd(fx.seed, i, 4) * 3) * fx.speed + rnd(fx.seed, i, 5) * 6.28);
    ctx.globalAlpha = 0.25 + 0.75 * tw;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (r > 2 * u) {
      ctx.globalAlpha = 0.25 * tw;
      ctx.beginPath();
      ctx.arc(x, y, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Estrella fugaz de vez en cuando.
  const period = 3 / fx.speed;
  const k = Math.floor(t / period);
  const ph = (t - k * period) / (0.9 / fx.speed);
  if (ph < 1) {
    const x0 = (0.35 + rnd(fx.seed, k, 10) * 0.6) * W;
    const y0 = rnd(fx.seed, k, 11) * H * 0.35;
    const dx = -0.9, dy = 0.42;
    const hx = x0 + dx * ph * W * 0.45;
    const hy = y0 + dy * ph * W * 0.45;
    const tail = 220 * u * fx.size;
    const g = ctx.createLinearGradient(hx, hy, hx - dx * tail, hy - dy * tail);
    g.addColorStop(0, withAlpha(fx.color, 0.95));
    g.addColorStop(1, withAlpha(fx.color, 0));
    ctx.globalAlpha = Math.sin(ph * Math.PI);
    ctx.strokeStyle = g;
    ctx.lineWidth = 2.5 * u * fx.size;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - dx * tail, hy - dy * tail);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

const BOKEH_PALETTE = ['#ffd08a', '#ff9a6b', '#ffe6b0', '#9fd3ff', '#ff7aa8'];

function bokeh(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(22 * fx.intensity);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const r = (40 + rnd(fx.seed, i, 1) * 90) * u * fx.size;
    const x = mod(rnd(fx.seed, i, 2) * W + t * fx.speed * (rnd(fx.seed, i, 3) - 0.5) * 40 * u, W + 2 * r) - r;
    const y = mod(rnd(fx.seed, i, 4) * H - t * fx.speed * (10 + rnd(fx.seed, i, 5) * 25) * u, H + 2 * r) - r;
    const color = pick(d, i, BOKEH_PALETTE);
    ctx.globalAlpha = (0.15 + 0.2 * rnd(fx.seed, i, 6)) * (0.7 + 0.3 * Math.sin(t * fx.speed + i));
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, withAlpha(color, 0.9));
    g.addColorStop(0.75, withAlpha(color, 0.7));
    g.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

const PETAL_PALETTE = ['#ffb7c9', '#ff8fb1', '#ffd6e0', '#ffffff'];
const LEAF_PALETTE = ['#e0782a', '#c4421a', '#e8b13a', '#a0521d', '#d9622b'];

/** Cosas que caen girando y meciéndose (pétalos, hojas). */
function falling(d: DrawContext, count: number, palette: string[], shape: (s: number) => void): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(count * fx.intensity);
  const span = H * 1.2;
  for (let i = 0; i < n; i++) {
    const fall = (70 + rnd(fx.seed, i, 1) * 80) * u * fx.speed;
    const y = mod(t * fall + rnd(fx.seed, i, 2) * span, span) - H * 0.1;
    const x = mod(rnd(fx.seed, i, 3) * W + Math.sin(t * fx.speed * (0.6 + rnd(fx.seed, i, 4)) + i) * 60 * u + t * 20 * u * fx.speed, W);
    const s = (12 + rnd(fx.seed, i, 5) * 12) * u * fx.size;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * fx.speed * (0.8 + rnd(fx.seed, i, 6) * 1.6) + i);
    ctx.scale(1, 0.35 + 0.65 * Math.abs(Math.cos(t * fx.speed * 1.7 + i)));
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = pick(d, i, palette);
    shape(s);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function petals(d: DrawContext): void {
  const { ctx } = d;
  falling(d, 40, PETAL_PALETTE, (s) => {
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.bezierCurveTo(s * 0.9, -s * 0.6, s * 0.7, s * 0.7, 0, s);
    ctx.bezierCurveTo(-s * 0.7, s * 0.7, -s * 0.9, -s * 0.6, 0, -s);
    ctx.fill();
  });
}

function leaves(d: DrawContext): void {
  const { ctx, u } = d;
  falling(d, 28, LEAF_PALETTE, (s) => {
    const L = s * 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -L);
    ctx.quadraticCurveTo(L * 0.8, 0, 0, L);
    ctx.quadraticCurveTo(-L * 0.8, 0, 0, -L);
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,30,0,0.45)';
    ctx.lineWidth = 1.2 * u;
    ctx.beginPath();
    ctx.moveTo(0, -L);
    ctx.lineTo(0, L * 1.15);
    ctx.stroke();
  });
}

function balloons(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(12 * fx.intensity);
  for (let i = 0; i < n; i++) {
    const period = (6 + rnd(fx.seed, i, 1) * 4) / fx.speed;
    const age = mod(t + rnd(fx.seed, i, 2) * period, period) / period;
    const r = (30 + rnd(fx.seed, i, 3) * 25) * u * fx.size;
    const x = (0.05 + rnd(fx.seed, i, 4) * 0.9) * W + Math.sin(age * 6 + i) * 25 * u;
    const y = H + r * 3.5 - (H + r * 7) * age;
    const color = colorFor(d, i);
    // Hilo.
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.5 * u;
    ctx.beginPath();
    ctx.moveTo(x, y + r * 1.1);
    ctx.quadraticCurveTo(x + Math.sin(t * 3 + i) * r * 0.4, y + r * 2, x, y + r * 3.2);
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    // Nudo.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.95);
    ctx.lineTo(x - r * 0.12, y + r * 1.15);
    ctx.lineTo(x + r * 0.12, y + r * 1.15);
    ctx.closePath();
    ctx.fill();
    // Globo con brillo.
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.05, x, y, r * 1.05);
    g.addColorStop(0, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.25, color);
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.85, r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

const NOTE_GLYPHS = ['♪', '♫', '♬', '♩'];

function notes(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.round(16 * fx.intensity);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const period = (5 + rnd(fx.seed, i, 1) * 3) / fx.speed;
    const age = mod(t + rnd(fx.seed, i, 2) * period, period) / period;
    const s = (40 + rnd(fx.seed, i, 3) * 40) * u * fx.size;
    const x = (0.05 + rnd(fx.seed, i, 4) * 0.9) * W + Math.sin(age * 7 + i) * 40 * u;
    const y = H + s - (H + s * 2) * age;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(age * 5 + i) * 0.3);
    ctx.globalAlpha = Math.min(1, age * 6) * Math.min(1, (1 - age) * 4) * 0.9;
    ctx.fillStyle = colorFor(d, i);
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6 * u;
    ctx.font = `${Math.round(s)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
    ctx.fillText(NOTE_GLYPHS[i % NOTE_GLYPHS.length], 0, 0);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function lightleak(d: DrawContext): void {
  const { ctx, W, H, t, fx } = d;
  ctx.globalCompositeOperation = 'lighter';
  const colors = fx.multicolor ? ['#ff9a3d', '#ff5e7a', '#ffd36b'] : [fx.color, fx.color, fx.color];
  const phase = (fx.seed % 97) / 10;
  for (let k = 0; k < 3; k++) {
    const cx = W * (0.5 + 0.65 * Math.cos(t * 0.25 * fx.speed + k * 2.1 + phase));
    const cy = H * (0.5 + 0.55 * Math.sin(t * 0.19 * fx.speed + k * 1.7 + phase));
    const R = H * (0.55 + 0.2 * Math.sin(t * 0.3 * fx.speed + k)) * fx.size;
    const a = Math.min(1, 0.5 * fx.intensity) * (0.6 + 0.4 * Math.sin(t * 0.7 * fx.speed + k * 2));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, withAlpha(colors[k], a));
    g.addColorStop(0.5, withAlpha(colors[k], a * 0.4));
    g.addColorStop(1, withAlpha(colors[k], 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = 'source-over';
}

const SPOT_PALETTE = ['#fff1c2', '#9fd3ff', '#ff8ad8', '#b0ffb0', '#ffd36b'];

function spotlights(d: DrawContext): void {
  const { ctx, W, H, u, t, fx } = d;
  const n = Math.max(2, Math.round(4 * fx.intensity));
  const len = H * 1.35;
  const half = Math.tan(0.16 * fx.size) * len;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const color = pick(d, i, SPOT_PALETTE);
    const ang = Math.sin(t * fx.speed * (0.6 + rnd(fx.seed, i, 1) * 0.5) + i * 1.3 + rnd(fx.seed, i, 2) * 3) * 0.5;
    ctx.save();
    ctx.translate((W * (i + 0.5)) / n, -10 * u);
    ctx.rotate(ang);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, withAlpha(color, 0.55));
    g.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-6 * u, 0);
    ctx.lineTo(6 * u, 0);
    ctx.lineTo(half, len);
    ctx.lineTo(-half, len);
    ctx.closePath();
    ctx.fill();
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 60 * u);
    glow.addColorStop(0, withAlpha(color, 0.9));
    glow.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-60 * u, -60 * u, 120 * u, 120 * u);
    ctx.restore();
  }
  ctx.globalCompositeOperation = 'source-over';
}

const DRAWERS: Record<OverlayEffect['type'], (d: DrawContext) => void> = {
  hearts,
  fireworks,
  confetti,
  snow,
  sparkles,
  bubbles,
  rain,
  stars,
  bokeh,
  petals,
  leaves,
  balloons,
  notes,
  lightleak,
  spotlights,
};

/** Dibuja un cuadro del efecto sobre un canvas transparente de W×H. */
export function drawOverlay(canvas: OffscreenCanvas, fx: OverlayEffect, t: number): void {
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  DRAWERS[fx.type]({ ctx, W: canvas.width, H: canvas.height, u: canvas.height / 1080, t: Math.max(0, t), fx });
}

/** Canvas por clip (se reutiliza entre cuadros). */
export class OverlayRenderer {
  private readonly canvases = new Map<string, OffscreenCanvas>();

  /**
   * Dibuja el efecto del clip en el instante t (tiempo de timeline) a W×H y lo sube como textura.
   * Ocupa todo el cuadro; la transformación del clip (escala, posición, opacidad) se aplica encima.
   */
  resolve(compositor: Compositor, textureKey: string, clip: Clip, t: number, W: number, H: number): ResolvedSource | null {
    if (!clip.overlay) return null;
    let canvas = this.canvases.get(textureKey);
    if (!canvas || canvas.width !== W || canvas.height !== H) {
      canvas = new OffscreenCanvas(W, H);
      this.canvases.set(textureKey, canvas);
    }
    drawOverlay(canvas, clip.overlay, t - clip.start);
    compositor.upload(textureKey, canvas, W, H);
    return { texture: textureKey, width: W, height: H };
  }
}
