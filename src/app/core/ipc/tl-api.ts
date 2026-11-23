import { InjectionToken } from '@angular/core';
import type { TlApi } from '../../../../shared/ipc-contract';

/** Inyectable para poder mockear la API de Electron en tests. */
export const TL_API = new InjectionToken<TlApi>('TL_API', {
  providedIn: 'root',
  factory: () => {
    if (!window.tl) {
      throw new Error('window.tl no está disponible: la app debe ejecutarse dentro de Electron.');
    }
    return window.tl;
  },
});
