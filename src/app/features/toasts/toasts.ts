import { Component, inject } from '@angular/core';
import { NotificationsService } from '../../core/ui/notifications.service';

@Component({
  selector: 'app-toasts',
  template: `
    @for (t of notify.toasts(); track t.id) {
      <div class="toast" [class]="t.kind" (click)="notify.dismiss(t.id)">{{ t.text }}</div>
    }
  `,
  styles: `
    :host {
      position: fixed;
      right: 16px;
      bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 200;
      max-width: 420px;
    }
    .toast {
      padding: 10px 14px;
      border-radius: var(--radius);
      background: var(--bg-3);
      border-left: 4px solid var(--accent);
      box-shadow: 0 6px 20px rgb(0 0 0 / 40%);
      cursor: pointer;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      &.error { border-left-color: var(--danger); }
      &.success { border-left-color: var(--success); }
    }
  `,
})
export class Toasts {
  protected readonly notify = inject(NotificationsService);
}
