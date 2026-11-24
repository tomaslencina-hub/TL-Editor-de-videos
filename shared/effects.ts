/**
 * Efectos animados superpuestos (corazones, fuegos artificiales, confeti...).
 * Un clip de efecto vive en una pista de video, tiene `overlay` y `sourceId` vacío.
 * Se dibujan proceduralmente a partir del tiempo (con aleatorios fijos por partícula):
 * el mismo cuadro sale idéntico en la vista previa y en la exportación.
 */

export const OVERLAY_TYPES = ['hearts', 'fireworks', 'confetti', 'snow', 'sparkles', 'bubbles'] as const;
export type OverlayType = (typeof OVERLAY_TYPES)[number];

export const OVERLAY_LABELS: Record<OverlayType, string> = {
  hearts: 'Corazones',
  fireworks: 'Fuegos artificiales',
  confetti: 'Confeti',
  snow: 'Nieve',
  sparkles: 'Brillos',
  bubbles: 'Burbujas',
};

export const OVERLAY_ICONS: Record<OverlayType, string> = {
  hearts: '❤',
  fireworks: '🎆',
  confetti: '🎉',
  snow: '❄',
  sparkles: '✨',
  bubbles: '🫧',
};

export interface OverlayEffect {
  type: OverlayType;
  /** Cantidad de partículas (0.1 – 3, 1 = normal). */
  intensity: number;
  /** Tamaño relativo (0.3 – 3). */
  size: number;
  /** Velocidad relativa (0.2 – 3). */
  speed: number;
  /** Color principal (#rrggbb). Confeti y fuegos usan además una paleta. */
  color: string;
  /** Usar varios colores (paleta festiva) en vez de solo el principal. */
  multicolor: boolean;
  /** Semilla: cambia la distribución de partículas sin cambiar el estilo. */
  seed: number;
}

export const OVERLAY_DEFAULTS: Record<OverlayType, Omit<OverlayEffect, 'type' | 'seed'>> = {
  hearts: { intensity: 1, size: 1, speed: 1, color: '#ff4d6d', multicolor: false },
  fireworks: { intensity: 1, size: 1, speed: 1, color: '#ffd84d', multicolor: true },
  confetti: { intensity: 1, size: 1, speed: 1, color: '#19c3b0', multicolor: true },
  snow: { intensity: 1, size: 1, speed: 1, color: '#ffffff', multicolor: false },
  sparkles: { intensity: 1, size: 1, speed: 1, color: '#fff3b0', multicolor: false },
  bubbles: { intensity: 1, size: 1, speed: 1, color: '#9fe7ff', multicolor: false },
};

export const DEFAULT_OVERLAY_DURATION = 5;

export function makeOverlay(type: OverlayType, seed = Math.floor(Math.random() * 1e6)): OverlayEffect {
  return { type, seed, ...OVERLAY_DEFAULTS[type] };
}

export function isOverlayType(v: unknown): v is OverlayType {
  return typeof v === 'string' && (OVERLAY_TYPES as readonly string[]).includes(v);
}
