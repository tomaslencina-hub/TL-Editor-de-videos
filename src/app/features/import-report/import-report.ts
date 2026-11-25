import { Component, computed, inject } from '@angular/core';
import { EditorActionsService } from '../../core/editor-actions.service';
import { ImportReportService } from '../../core/import/import-report.service';
import { MediaLibraryService } from '../../core/media/media-library.service';
import { Icon } from '../../core/ui/icon';

@Component({
  selector: 'app-import-report',
  imports: [Icon],
  styleUrl: '../export-dialog/export-dialog.scss',
  template: `
    @if (svc.report(); as r) {
      <div class="backdrop" (click)="svc.close()">
        <div class="dialog" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
          <h2><app-icon name="clapperboard" [size]="20" /> {{ r.title }}</h2>
          <ul class="list">
            @for (s of r.summary; track s) {
              <li>{{ s }}</li>
            }
          </ul>
          @if (missingNow() > 0) {
            <p class="error">
              Faltan {{ missingNow() }} archivo(s) en esta computadora. Si los tenés en una carpeta (copiada de la otra PC,
              un pendrive, OneDrive…), elegila y se vinculan solos por nombre.
            </p>
          } @else if (r.missing > 0) {
            <p class="ok">✔ Se encontraron todos los archivos.</p>
          }
          @if (r.warnings.length) {
            <p class="muted">No se pudo traer igual:</p>
            <ul class="list muted">
              @for (w of r.warnings; track w) {
                <li>{{ w }}</li>
              }
            </ul>
          }
          <div class="actions">
            @if (missingNow() > 0) {
              <button (click)="actions.relinkMissing()"><app-icon name="folder-open" [size]="15" /> Buscar archivos…</button>
            }
            <button class="primary" (click)="svc.close()">Listo</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    .list {
      margin: 0 0 10px;
      padding-left: 18px;
      li { margin: 2px 0; }
    }
    h2 { display: flex; align-items: center; gap: 8px; }
  `,
})
export class ImportReportDialog {
  protected readonly svc = inject(ImportReportService);
  protected readonly actions = inject(EditorActionsService);
  private readonly library = inject(MediaLibraryService);

  /** Se actualiza en vivo al vincular archivos. */
  protected readonly missingNow = computed(() => [...this.library.assets().values()].filter((a) => a.missing).length);
}
