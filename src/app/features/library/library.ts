import { Component, signal } from '@angular/core';
import { MediaPanel } from '../media-panel/media-panel';
import { TransitionsPanel } from '../transitions-panel/transitions-panel';

type Tab = 'media' | 'transitions';

/** Panel izquierdo con pestañas: medios importados y transiciones. */
@Component({
  selector: 'app-library',
  imports: [MediaPanel, TransitionsPanel],
  template: `
    <nav class="tabs" role="tablist">
      <button role="tab" [class.active]="tab() === 'media'" (click)="tab.set('media')">🎞 Medios</button>
      <button role="tab" [class.active]="tab() === 'transitions'" (click)="tab.set('transitions')">✦ Transiciones</button>
    </nav>
    @if (tab() === 'media') {
      <app-media-panel class="content" />
    } @else {
      <app-transitions-panel class="content" />
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
      padding: 6px 8px 0;
      border-bottom: 1px solid var(--border);
      button {
        border: none;
        border-bottom: 2px solid transparent;
        border-radius: var(--radius) var(--radius) 0 0;
        background: transparent;
        color: var(--text-2);
        padding: 6px 12px;
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
}
