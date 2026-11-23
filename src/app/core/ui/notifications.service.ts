import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;

  show(text: string, kind: Toast['kind'] = 'info', ms = 4000): void {
    const id = this.nextId++;
    this.toasts.update((t) => [...t, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? ms * 2 : ms);
  }

  error(text: string): void {
    this.show(text, 'error');
  }

  dismiss(id: number): void {
    this.toasts.update((t) => t.filter((x) => x.id !== id));
  }
}
