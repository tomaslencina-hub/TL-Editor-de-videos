import { Component, computed, inject } from '@angular/core';
import { ExportService } from '../../core/export/export.service';
import { ProjectStore } from '../../core/state/project-store';
import { formatTimecode } from '../../core/timeline/time';

@Component({
  selector: 'app-export-dialog',
  templateUrl: './export-dialog.html',
  styleUrl: './export-dialog.scss',
})
export class ExportDialog {
  protected readonly exporter = inject(ExportService);
  protected readonly store = inject(ProjectStore);

  protected readonly percent = computed(() => Math.round(this.exporter.progress() * 100));
  protected readonly durationCode = computed(() => formatTimecode(this.store.duration(), this.store.settings().fps));
  protected readonly problem = computed(() => {
    // Se recalcula al abrir el diálogo o al cambiar el proyecto.
    this.exporter.open();
    this.store.project();
    return this.exporter.validate();
  });
}
