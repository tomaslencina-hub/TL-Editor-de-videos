import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportProgress, ExportResult } from '../../shared/ipc-contract';
import type { Project } from '../../shared/model';
import { buildExportPlan } from './export-graph';
import { FFMPEG_BIN, lastLines, runProcess } from './process';

/** Maneja una exportación a la vez, con progreso y cancelación. */
export class ExportJob {
  private proc: ChildProcess | null = null;
  private cancelled = false;

  get running(): boolean {
    return this.proc !== null;
  }

  async run(project: Project, outputPath: string, onProgress: (p: ExportProgress) => void): Promise<ExportResult> {
    if (this.proc) return { status: 'error', message: 'Ya hay una exportación en curso.' };
    this.cancelled = false;

    let plan;
    try {
      plan = buildExportPlan(project);
    } catch (e) {
      return { status: 'error', message: (e as Error).message };
    }

    const scriptPath = path.join(os.tmpdir(), `tl-export-${process.pid}-${Date.now()}.txt`);
    await fs.promises.writeFile(scriptPath, plan.filterGraph, 'utf8');

    const args = [
      '-hide_banner',
      '-v', 'error',
      '-nostats',
      '-progress', 'pipe:1',
      '-stats_period', '0.25',
      '-y',
      ...plan.inputArgs,
      // Sintaxis de FFmpeg ≥7 para leer el valor de una opción desde archivo.
      '-/filter_complex', scriptPath,
      ...plan.outputArgs,
      outputPath,
    ];

    let pending = '';
    const progress: Record<string, string> = {};
    try {
      const res = await runProcess(FFMPEG_BIN, args, {
        onSpawn: (p) => (this.proc = p),
        onStdout: (chunk) => {
          pending += chunk.toString();
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? '';
          for (const line of lines) {
            const eq = line.indexOf('=');
            if (eq < 0) continue;
            const key = line.slice(0, eq).trim();
            progress[key] = line.slice(eq + 1).trim();
            if (key === 'progress') {
              const us = Number(progress['out_time_us'] ?? progress['out_time_ms']);
              const time = Number.isFinite(us) && us > 0 ? us / 1e6 : 0;
              onProgress({
                ratio: progress['progress'] === 'end' ? 1 : Math.min(1, time / plan.duration),
                time,
                speed: progress['speed'],
              });
            }
          }
        },
      });

      if (this.cancelled) {
        await fs.promises.rm(outputPath, { force: true }).catch(() => undefined);
        return { status: 'cancelled' };
      }
      if (res.code !== 0) {
        return { status: 'error', message: `FFmpeg terminó con código ${res.code}:\n${lastLines(res.stderr, 12)}` };
      }
      return { status: 'done', outputPath };
    } catch (e) {
      return { status: 'error', message: (e as Error).message };
    } finally {
      this.proc = null;
      await fs.promises.rm(scriptPath, { force: true }).catch(() => undefined);
    }
  }

  cancel(): void {
    const proc = this.proc;
    if (!proc) return;
    this.cancelled = true;
    // 'q' le pide a FFmpeg que corte prolijamente; si no responde, se mata el proceso.
    try {
      proc.stdin?.write('q');
    } catch {
      /* stdin cerrado */
    }
    setTimeout(() => {
      if (this.proc === proc) proc.kill();
    }, 1500);
  }
}
