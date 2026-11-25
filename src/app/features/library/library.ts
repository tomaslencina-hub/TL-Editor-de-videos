import { Component, effect, inject, untracked } from '@angular/core';
import { ProjectStore } from '../../core/state/project-store';
import { Icon } from '../../core/ui/icon';
import { MediaPanel } from '../media-panel/media-panel';
import { PropertiesPanel } from '../properties/properties-panel';
import { TextPanel } from '../text-panel/text-panel';
import { EffectsPanel } from '../effects-panel/effects-panel';
import { TransitionsPanel } from '../transitions-panel/transitions-panel';
import { AssistantPanel } from '../assistant-panel/assistant-panel';

import { LibraryTabService } from '../../core/ui/library-tab.service';

/** Panel izquierdo con pestañas: medios importados, transiciones y propiedades del clip seleccionado. */
@Component({
  selector: 'app-library',
  imports: [Icon, MediaPanel, TextPanel, EffectsPanel, TransitionsPanel, PropertiesPanel, AssistantPanel],
  template: `
    <nav class="tabs" role="tablist">
      <button role="tab" [class.active]="tab() === 'media'" (click)="tab.set('media')"><app-icon name="images" [size]="15" /> Medios</button>
      <button role="tab" [class.active]="tab() === 'text'" (click)="tab.set('text')"><app-icon name="type" [size]="15" /> Texto</button>
      <button role="tab" [class.active]="tab() === 'effects'" (click)="tab.set('effects')"><app-icon name="sparkles" [size]="15" /> Efectos</button>
      <button role="tab" [class.active]="tab() === 'transitions'" (click)="tab.set('transitions')"><app-icon name="transition" [size]="15" /> Transiciones</button>
      <button role="tab" [class.active]="tab() === 'props'" (click)="tab.set('props')"><app-icon name="sliders" [size]="15" /> Propiedades</button>
      <button role="tab" [class.active]="tab() === 'assistant'" (click)="tab.set('assistant')"><app-icon name="bot" [size]="15" /> Asistente</button>
    </nav>
    @switch (tab()) {
      @case ('media') {
        <app-media-panel class="content" />
      }
      @case ('text') {
        <app-text-panel class="content" />
      }
      @case ('effects') {
        <app-effects-panel class="content" />
      }
      @case ('transitions') {
        <app-transitions-panel class="content" />
      }
      @case ('props') {
        <app-properties-panel class="content" />
      }
      @case ('assistant') {
        <app-assistant-panel class="content" />
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      background: var(--bg-1);
    }
    .tabs {
      display: flex;
      gap: 2px;
      padding: 6px 6px 0;
      overflow-x: auto;
      scrollbar-width: none;
      border-bottom: 1px solid var(--border);
      button {
        border: none;
        border-bottom: 2px solid transparent;
        border-radius: var(--radius) var(--radius) 0 0;
        background: transparent;
        color: var(--text-2);
        padding: 6px 8px;
        white-space: nowrap;
        flex: none;
        &.active {
          color: var(--text-0);
          border-bottom-color: var(--accent);
          background: var(--bg-2);
        }
      }
    }
    .content {
      flex: 1;
      min-height: 0;
    }
  `,
})
export class Library {
  protected readonly tab = inject(LibraryTabService).tab;

  constructor() {
    const store = inject(ProjectStore);
    // Al seleccionar un clip se muestran sus propiedades (como en los editores modernos).
    effect(() => {
      // (no mientras se usa el asistente: el chat no se tiene que cerrar)
      if (store.selectedClipId()) untracked(() => this.tab() !== 'assistant' && this.tab.set('props'));
    });
  }
}
