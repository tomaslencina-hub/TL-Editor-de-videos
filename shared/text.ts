/**
 * Clips de texto: contenido, estilo y animaciones de entrada/salida.
 * Un clip de texto vive en una pista de video, tiene `text` y `sourceId` vacío.
 * Las medidas (tamaño de fuente, contorno, etc.) están en píxeles de un cuadro de 1080 px de alto
 * y se escalan a la resolución del proyecto, así el texto se ve igual en 720p o 4K.
 */

export const TEXT_ANIMATIONS = ['none', 'fade', 'slide-up', 'slide-down', 'pop', 'typewriter'] as const;
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];

export const TEXT_ANIMATION_LABELS: Record<TextAnimation, string> = {
  none: 'Ninguna',
  fade: 'Fundido',
  'slide-up': 'Deslizar hacia arriba',
  'slide-down': 'Deslizar hacia abajo',
  pop: 'Pop',
  typewriter: 'Máquina de escribir',
};

export const FONT_FAMILIES = [
  'Segoe UI',
  'Arial',
  'Bahnschrift',
  'Impact',
  'Georgia',
  'Times New Roman',
  'Verdana',
  'Trebuchet MS',
  'Courier New',
  'Comic Sans MS',
  'Segoe Script',
] as const;

export interface TextContent {
  text: string;
  fontFamily: string;
  /** Px de alto de fuente en un cuadro de 1080 px. */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  /** Interlineado (múltiplo del tamaño). */
  lineHeight: number;
  /** Espaciado entre letras (px a 1080). */
  letterSpacing: number;
  stroke: { enabled: boolean; color: string; width: number };
  shadow: { enabled: boolean; color: string; blur: number; offsetX: number; offsetY: number };
  background: { enabled: boolean; color: string; opacity: number; padding: number; radius: number };
  animIn: TextAnimation;
  animOut: TextAnimation;
  /** Duración de cada animación (s). */
  animDuration: number;
}

export const DEFAULT_TEXT: TextContent = {
  text: 'Tu texto acá',
  fontFamily: 'Segoe UI',
  fontSize: 96,
  bold: true,
  italic: false,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.15,
  letterSpacing: 0,
  stroke: { enabled: false, color: '#000000', width: 6 },
  shadow: { enabled: true, color: '#000000', blur: 12, offsetX: 0, offsetY: 4 },
  background: { enabled: false, color: '#000000', opacity: 0.6, padding: 24, radius: 12 },
  animIn: 'fade',
  animOut: 'fade',
  animDuration: 0.5,
};

export interface TextPreset {
  id: string;
  label: string;
  text: Partial<TextContent> & { text: string };
  /** Posición inicial (fracción del cuadro, 0 = centro). */
  y?: number;
  x?: number;
}

export const TEXT_PRESETS: TextPreset[] = [
  { id: 'title', label: 'Título', text: { text: 'Título', fontSize: 140, bold: true, animIn: 'pop', animOut: 'fade' } },
  { id: 'subtitle', label: 'Subtítulo', text: { text: 'Subtítulo del video', fontSize: 64, bold: false }, y: 0.12 },
  {
    id: 'lower-third',
    label: 'Tercio inferior',
    text: {
      text: 'Nombre Apellido\nCargo o descripción',
      fontSize: 56,
      align: 'left',
      shadow: { ...DEFAULT_TEXT.shadow, enabled: false },
      background: { enabled: true, color: '#19c3b0', opacity: 0.9, padding: 28, radius: 8 },
      animIn: 'slide-up',
      animOut: 'fade',
    },
    x: -0.27,
    y: 0.32,
  },
  {
    id: 'caption',
    label: 'Subtítulo social',
    text: {
      text: 'ESTO ES IMPORTANTE',
      fontFamily: 'Impact',
      fontSize: 92,
      bold: false,
      stroke: { enabled: true, color: '#000000', width: 10 },
      shadow: { ...DEFAULT_TEXT.shadow, enabled: false },
      color: '#ffe14d',
      animIn: 'pop',
      animOut: 'none',
    },
    y: 0.3,
  },
  {
    id: 'typewriter',
    label: 'Máquina de escribir',
    text: { text: 'Había una vez…', fontFamily: 'Courier New', fontSize: 72, bold: false, animIn: 'typewriter', animOut: 'fade', animDuration: 1.5 },
  },
  {
    id: 'neon',
    label: 'Neón',
    text: {
      text: 'NEÓN',
      fontFamily: 'Bahnschrift',
      fontSize: 160,
      color: '#ff4dd2',
      shadow: { enabled: true, color: '#ff4dd2', blur: 40, offsetX: 0, offsetY: 0 },
      animIn: 'fade',
    },
  },
];

export function makeText(preset?: TextPreset): TextContent {
  const p = preset?.text ?? { text: DEFAULT_TEXT.text };
  return {
    ...DEFAULT_TEXT,
    ...p,
    stroke: { ...DEFAULT_TEXT.stroke, ...p.stroke },
    shadow: { ...DEFAULT_TEXT.shadow, ...p.shadow },
    background: { ...DEFAULT_TEXT.background, ...p.background },
  };
}

/** Efecto de las animaciones de entrada/salida en un instante del clip. */
export interface TextAnimState {
  opacity: number;
  /** Desplazamiento (fracción del alto del cuadro). */
  dy: number;
  scale: number;
  /** Fracción de caracteres visibles (máquina de escribir). */
  reveal: number;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

function apply(state: TextAnimState, anim: TextAnimation, p: number): void {
  const k = Math.min(1, Math.max(0, p));
  switch (anim) {
    case 'fade':
      state.opacity *= k;
      break;
    case 'slide-up':
      state.opacity *= k;
      state.dy += (1 - easeOut(k)) * 0.06;
      break;
    case 'slide-down':
      state.opacity *= k;
      state.dy -= (1 - easeOut(k)) * 0.06;
      break;
    case 'pop':
      state.opacity *= Math.min(1, k * 3);
      state.scale *= 0.5 + 0.5 * easeOutBack(k);
      break;
    case 'typewriter':
      state.reveal = Math.min(state.reveal, k);
      break;
  }
}

export function textAnimation(text: TextContent, clipTime: number, clipDuration: number): TextAnimState {
  const state: TextAnimState = { opacity: 1, dy: 0, scale: 1, reveal: 1 };
  const d = Math.max(0.01, Math.min(text.animDuration, clipDuration / 2));
  if (text.animIn !== 'none') apply(state, text.animIn, clipTime / d);
  if (text.animOut !== 'none') apply(state, text.animOut, (clipDuration - clipTime) / d);
  return state;
}
