import type { TransitionType } from '../../../../shared/transitions';

/** Estilo CSS aplicable a una capa de video durante una transición. */
export interface LayerStyle {
  opacity: number;
  transform: string;
  clipPath: string;
  filter: string;
  maskImage: string;
  /** Orden dentro de la pista: la capa con mayor valor va arriba. */
  order: number;
}

export const BASE_LAYER_STYLE: LayerStyle = { opacity: 1, transform: '', clipPath: '', filter: '', maskImage: '', order: 0 };
const BASE = BASE_LAYER_STYLE;

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

/**
 * Máscara circular con el mismo borde difuso que xfade: opaco donde r/semidiagonal ≤ -k,
 * transparente donde ≥ 1 - k (farthest-corner = semidiagonal). `invert` deja el agujero al centro.
 */
function softCircle(k: number, invert: boolean): string {
  const [a, b] = invert ? ['transparent', 'black'] : ['black', 'transparent'];
  return `radial-gradient(circle farthest-corner at 50% 50%, ${a} ${pct(-k)}, ${b} ${pct(1 - k)})`;
}

/**
 * Emulación en CSS de las transiciones de `xfade` (FFmpeg), con la misma dirección y progreso.
 * `p` = 0 al inicio de la transición (todo "from") → 1 al final (todo "to").
 * "from"/"to" pueden faltar (entradas/salidas sobre lo que haya debajo).
 */
export function transitionStyles(type: TransitionType, p: number): { from: LayerStyle; to: LayerStyle } {
  const from = { ...BASE, order: 0 };
  const to = { ...BASE, order: 1 };
  const q = 1 - p;
  switch (type) {
    case 'fade':
      // "to" encima con opacidad p equivale a la mezcla lineal de xfade; "from" queda opaco
      // para no dejar ver las pistas de abajo durante un cruce.
      to.opacity = p;
      break;
    case 'fadeblack': {
      // Primera mitad: from se oscurece; segunda mitad: to aparece desde negro.
      const a = Math.max(0, 1 - 2 * p);
      const b = Math.max(0, 2 * p - 1);
      from.filter = `brightness(${a.toFixed(3)})`;
      to.filter = `brightness(${b.toFixed(3)})`;
      to.opacity = p < 0.5 ? 0 : 1;
      break;
    }
    case 'wipeleft':
      to.clipPath = `inset(0 0 0 ${pct(q)})`;
      break;
    case 'wiperight':
      to.clipPath = `inset(0 ${pct(q)} 0 0)`;
      break;
    case 'wipeup':
      to.clipPath = `inset(${pct(q)} 0 0 0)`;
      break;
    case 'wipedown':
      to.clipPath = `inset(0 0 ${pct(q)} 0)`;
      break;
    case 'slideleft':
      from.transform = `translateX(${pct(-p)})`;
      to.transform = `translateX(${pct(q)})`;
      break;
    case 'slideright':
      from.transform = `translateX(${pct(p)})`;
      to.transform = `translateX(${pct(-q)})`;
      break;
    case 'slideup':
      from.transform = `translateY(${pct(-p)})`;
      to.transform = `translateY(${pct(q)})`;
      break;
    case 'slidedown':
      from.transform = `translateY(${pct(p)})`;
      to.transform = `translateY(${pct(-q)})`;
      break;
    case 'circleopen':
      // xfade: B visible donde dist/semidiagonal + k < 1, con k = 1.5 - 3p y borde suave de 1 semidiagonal.
      to.maskImage = softCircle(1.5 - 3 * p, false);
      break;
    case 'circleclose':
      // xfade: A queda en el centro, k = 3p - 1.5.
      from.maskImage = softCircle(3 * p - 1.5, false);
      from.order = 1;
      to.order = 0;
      break;
    case 'zoomin':
      from.transform = `scale(${(1 + p).toFixed(3)})`;
      from.opacity = q;
      from.order = 1;
      to.order = 0;
      break;
  }
  return { from, to };
}

/** Variante para entradas/salidas sin clip del otro lado: la capa se desvanece contra lo de abajo. */
export function edgeStyles(type: TransitionType, p: number, role: 'from' | 'to'): LayerStyle {
  const s = transitionStyles(type, p);
  if (type === 'fade' || type === 'zoomin') {
    // La exportación usa un fade de alpha para estos dos (ver export-graph.ts).
    return { ...BASE, opacity: role === 'to' ? p : 1 - p };
  }
  // Del otro lado no hay clip (transparente en xfade): la capa debe ocultar la región que ocuparía.
  const hole = (k: number): LayerStyle => ({ ...BASE, maskImage: softCircle(k, true) });
  if (role === 'from') {
    switch (type) {
      case 'wipeleft':
        return { ...BASE, clipPath: `inset(0 ${pct(p)} 0 0)` };
      case 'wiperight':
        return { ...BASE, clipPath: `inset(0 0 0 ${pct(p)})` };
      case 'wipeup':
        return { ...BASE, clipPath: `inset(0 0 ${pct(p)} 0)` };
      case 'wipedown':
        return { ...BASE, clipPath: `inset(${pct(p)} 0 0 0)` };
      case 'circleopen':
        return hole(1.5 - 3 * p);
    }
  } else if (type === 'circleclose') {
    return hole(3 * p - 1.5);
  }
  if (type === 'fadeblack') {
    // xfade contra transparente: pasa por negro y luego revela lo de abajo (o al revés en la entrada).
    if (role === 'from') {
      return p < 0.5
        ? { ...BASE, filter: `brightness(${(1 - 2 * p).toFixed(3)})` }
        : { ...BASE, filter: 'brightness(0)', opacity: 2 - 2 * p };
    }
    return p < 0.5
      ? { ...BASE, filter: 'brightness(0)', opacity: 2 * p }
      : { ...BASE, filter: `brightness(${(2 * p - 1).toFixed(3)})` };
  }
  return s[role];
}
