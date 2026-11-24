import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ProjectStore } from '../../core/state/project-store';
import { MediaPanel } from '../media-panel/media-panel';
import { PropertiesPanel } from '../properties/properties-panel';
import { TextPanel } from '../text-panel/text-panel';
import { EffectsPanel } from '../effects-panel/effects-panel';
import { TransitionsPanel } from '../transitions-panel/transitions-panel';

type Tab = 'media' | 'text' | 'effects' | 'transitions' | 'props';

/** Panel izquierdo con pestañas: medios importados, transiciones y propiedades del clip seleccionado. */
@Component({
  selector: 'app-library',
  imports: [MediaPanel, TextPanel, EffectsPanel, TransitionsPanel, PropertiesPanel],
  template: `
    <nav class="tabs" role="tablist">
      <button role="tab" [class.active]="tab() === 'media'" (click)="tab.set('media')">🎞 Medios</button>
      <button role="tab" [class.active]="tab() === 'text'" (click)="tab.set('text')">T Texto</button>
      <button role="tab" [class.active]="tab() === 'effects'" (click)="tab.set('effects')">✨ Efectos</button>
      <button role="tab" [class.active]="tab() === 'transitions'" (click)="tab.set('transitions')">✦ Transiciones</button>
      <button role="tab" [class.active]="tab() === 'props'" (click)="tab.set('props')">⚙ Propiedades</button>
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
  protected readonly tab = signal<Tab>('media');

  constructor() {
    const store = inject(ProjectStore);
    // Al seleccionar un clip se muestran sus propiedades (como en los editores modernos).
    effect(() => {
      if (store.selectedClipId()) untracked(() => this.tab.set('props'));
    });
  }
}
