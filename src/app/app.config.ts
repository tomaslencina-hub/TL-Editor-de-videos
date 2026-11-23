import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { WebGLEngine } from './core/playback/webgl-engine';
import { PLAYBACK_ENGINE } from './core/playback/playback-engine';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Motor de vista previa: compone con el mismo Compositor WebGL que la exportación.
    { provide: PLAYBACK_ENGINE, useClass: WebGLEngine },
  ],
};
