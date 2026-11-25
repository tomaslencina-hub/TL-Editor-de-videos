import { Injectable, signal } from '@angular/core';

export type LibraryTab = 'media' | 'text' | 'effects' | 'transitions' | 'props' | 'assistant';

/** Pestaña activa del panel izquierdo (compartida para poder abrirla desde la barra superior). */
@Injectable({ providedIn: 'root' })
export class LibraryTabService {
  readonly tab = signal<LibraryTab>('media');
}
