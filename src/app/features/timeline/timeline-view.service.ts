import { Injectable, signal } from '@angular/core';

export const MIN_PPS = 2;
export const MAX_PPS = 600;

/** Estado de vista de la timeline (no forma parte del proyecto ni del historial). */
@Injectable({ providedIn: 'root' })
export class TimelineViewService {
  /** Píxeles por segundo (zoom). */
  readonly pps = signal(60);
  readonly snapEnabled = signal(true);

  setPps(value: number): void {
    this.pps.set(Math.min(MAX_PPS, Math.max(MIN_PPS, value)));
  }

  zoomBy(factor: number): void {
    this.setPps(this.pps() * factor);
  }
}
