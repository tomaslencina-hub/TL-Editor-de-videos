import type { Clip } from './model';

/**
 * Filtros de imagen (estilo Filmora). Se dibujan en el shader de capa del compositor WebGL
 * (src/app/core/render/shaders.ts), el mismo para la vista previa y la exportación.
 *
 * Un filtro puede ir:
 *  - en un clip con imagen (video, foto, texto, efecto): afecta solo a ese clip;
 *  - en un "clip de filtro" (sin archivo, sin texto ni efecto): una capa de ajuste que
 *    afecta a todo lo que está debajo mientras dure.
 */
export const FILTER_TYPES = [
  'bw',
  'sepia',
  'vintage',
  'cinema',
  'dramatic',
  'vivid',
  'noir',
  'cold',
  'warm',
  'invert',
  'posterize',
  'duotone',
  'thermal',
  'horror',
  'vignette',
  'blur',
  'dream',
  'sharpen',
  'pixelate',
  'rgbsplit',
  'glitch',
  'vhs',
  'grain',
  'oldfilm',
  'sketch',
  'mirror',
  'fisheye',
] as const;

export type FilterType = (typeof FILTER_TYPES)[number];

export const FILTER_LABELS: Record<FilterType, string> = {
  bw: 'Blanco y negro',
  sepia: 'Sepia',
  vintage: 'Vintage',
  cinema: 'Cine',
  dramatic: 'Dramático',
  vivid: 'Vívido',
  noir: 'Noir',
  cold: 'Frío',
  warm: 'Cálido',
  invert: 'Negativo',
  posterize: 'Póster',
  duotone: 'Duotono',
  thermal: 'Térmico',
  horror: 'Terror',
  vignette: 'Viñeta',
  blur: 'Desenfoque',
  dream: 'Sueño',
  sharpen: 'Nitidez',
  pixelate: 'Pixelado',
  rgbsplit: 'Separación RGB',
  glitch: 'Glitch',
  vhs: 'VHS',
  grain: 'Grano de película',
  oldfilm: 'Película vieja',
  sketch: 'Boceto',
  mirror: 'Reflejo',
  fisheye: 'Ojo de pez',
};

export interface ClipFilter {
  type: FilterType;
  /** Intensidad 0..1. */
  amount: number;
}

/** Intensidad con la que se agrega cada filtro (1 si no figura). */
const DEFAULT_AMOUNT: Partial<Record<FilterType, number>> = {
  blur: 0.5,
  pixelate: 0.5,
  rgbsplit: 0.5,
  grain: 0.6,
  vignette: 0.7,
  sharpen: 0.6,
  fisheye: 0.6,
};

export const DEFAULT_FILTER_DURATION = 5;

export function makeFilter(type: FilterType): ClipFilter {
  return { type, amount: DEFAULT_AMOUNT[type] ?? 1 };
}

export function isFilterType(v: unknown): v is FilterType {
  return typeof v === 'string' && (FILTER_TYPES as readonly string[]).includes(v);
}

/** Clip de filtro (capa de ajuste): afecta a lo que está debajo. */
export function isFilterClip(clip: Clip): boolean {
  return !!clip.filter && !clip.sourceId && !clip.text && !clip.overlay;
}
