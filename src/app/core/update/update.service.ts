import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { UpdateStatus } from '../../../../shared/ipc-contract';
import { TL_API } from '../ipc/tl-api';
import { NotificationsService } from '../ui/notifications.service';

/** Estado de la actualización automática (la lógica vive en el proceso main: electron/updater.ts). */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly api = inject(TL_API);
  private readonly notify = inject(NotificationsService);

  readonly status = signal<UpdateStatus>({ state: 'idle', currentVersion: '' });

  constructor() {
    void this.api.getUpdateStatus().then((s) => this.status.set(s));
    const off = this.api.onUpdateStatus((s) => {
      const prev = this.status().state;
      this.status.set(s);
      if (s.state === 'ready' && prev !== 'ready') {
        this.notify.show(`SHOTON ${s.version} está lista. Se instala al cerrar la app, o reiniciá ahora desde la barra superior.`, 'success', 8000);
      }
    });
    inject(DestroyRef).onDestroy(off);
  }

  install(): void {
    void this.api.installUpdate();
  }
}
