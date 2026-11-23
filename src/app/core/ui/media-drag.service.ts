import { Injectable, signal } from '@angular/core';
import type { MediaSource } from '../../../../shared/model';

/** MIME interno para arrastrar medios del panel a la timeline. */
export const MEDIA_DRAG_TYPE = 'application/x-tl-media';

/**
 * Durante `dragover` el navegador no deja leer los datos del drag;
 * este servicio guarda qué medio se arrastra para dibujar la previsualización en la timeline.
 */
@Injectable({ providedIn: 'root' })
export class MediaDragService {
  readonly current = signal<MediaSource | null>(null);
}
