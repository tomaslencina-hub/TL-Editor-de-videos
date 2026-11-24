import { clipEnd, type Id, type Project } from '../../../../shared/model';

/** Puntos de imantado: 0, playhead y bordes de todos los clips (excepto los excluidos). */
export function collectSnapPoints(project: Project, playhead: number, excludeClipIds: Id[] = []): number[] {
  const exclude = new Set(excludeClipIds);
  const points = [0, playhead, ...(project.markers ?? []).map((m) => m.time)];
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (exclude.has(c.id)) continue;
      points.push(c.start, clipEnd(c));
    }
  }
  return points;
}

export interface SnapResult {
  /** Desplazamiento a aplicar (s); 0 si no hubo imantado. */
  delta: number;
  /** Punto al que se imantó, para dibujar la guía. */
  point: number | null;
}

/**
 * Busca el punto de snap más cercano para cualquiera de los `edges` (posiciones candidatas).
 * `threshold` en segundos (normalmente píxeles / pps).
 */
export function snap(edges: number[], points: number[], threshold: number): SnapResult {
  let best: SnapResult = { delta: 0, point: null };
  let bestDist = threshold;
  for (const e of edges) {
    for (const p of points) {
      const d = Math.abs(p - e);
      if (d <= bestDist) {
        bestDist = d;
        best = { delta: p - e, point: p };
      }
    }
  }
  return best;
}
