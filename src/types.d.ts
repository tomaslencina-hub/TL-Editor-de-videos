import type { TlApi } from '../shared/ipc-contract';

declare global {
  interface Window {
    /** API expuesta por el preload de Electron (ver electron/preload.ts). */
    tl: TlApi;
  }
}
