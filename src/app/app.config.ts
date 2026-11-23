import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { HtmlMediaEngine } from './core/playback/html-media-engine';
import { PLAYBACK_ENGINE } from './core/playback/playback-engine';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Para migrar a WebCodecs + WebGL alcanza con cambiar esta implementación.
    { provide: PLAYBACK_ENGINE, useClass: HtmlMediaEngine },
  ],
};
