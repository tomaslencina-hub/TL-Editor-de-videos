import { Injectable, signal } from '@angular/core';

export interface ImportReport {
  title: string;
  summary: string[];
  warnings: string[];
  missing: number;
}

/** Resumen que se muestra después de importar un proyecto de otro editor. */
@Injectable({ providedIn: 'root' })
export class ImportReportService {
  readonly report = signal<ImportReport | null>(null);

  show(r: ImportReport): void {
    this.report.set(r);
  }

  close(): void {
    this.report.set(null);
  }
}
