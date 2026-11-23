import { Injectable, signal } from '@angular/core';
import type { MediaSource } from '../../../../shared/model';
import type { TransitionType } from '../../../../shared/transitions';

/** MIME interno para arrastrar medios del panel a la timeline. */
export const MEDIA_DRAG_TYPE = 'application/x-tl-media';
/** MIME interno para arrastrar transiciones a los bordes de los clips. */
export const TRANSITION_DRAG_TYPE = 'application/x-tl-transition';

/**
 * Durante `dragover` el navegador no deja leer los datos del drag;
 * este servicio guarda qué medio se arrastra para dibujar la previsualización en la timeline.
 */
@Injectable({ providedIn: 'root' })
export class MediaDragService {
  readonly current = signal<MediaSource | null>(null);
  readonly transition = signal<TransitionType | null>(null);
}
