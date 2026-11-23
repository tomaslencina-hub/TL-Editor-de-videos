import type { ClipTransform } from '../../../../shared/model';

/** Caja de una capa en píxeles del cuadro del proyecto (misma lógica que Compositor.layerMatrix). */
export interface LayerBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Grados (horario). */
  rotation: number;
}

/**
 * @param srcW / srcH tamaño visible de la fuente (ya rotado si el archivo trae rotación)
 */
export function layerBox(frameW: number, frameH: number, srcW: number, srcH: number, t: ClipTransform): LayerBox {
  const fit = Math.min(frameW / srcW, frameH / srcH);
  return {
    cx: frameW / 2 + t.x * frameW,
    cy: frameH / 2 + t.y * frameH,
    w: srcW * fit * t.scale,
    h: srcH * fit * t.scale,
    rotation: t.rotation,
  };
}

/** ¿El punto (píxeles del cuadro) cae dentro de la caja rotada? */
export function boxContains(box: LayerBox, px: number, py: number): boolean {
  const rad = (-box.rotation * Math.PI) / 180;
  const dx = px - box.cx;
  const dy = py - box.cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= box.w / 2 && Math.abs(ly) <= box.h / 2;
}
