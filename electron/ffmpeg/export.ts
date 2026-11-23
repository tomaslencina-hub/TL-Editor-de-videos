import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportProgress, ExportResult } from '../../shared/ipc-contract';
import type { Project } from '../../shared/model';
import { buildAudioPlan, num } from './export-graph';
import { FFMPEG_BIN, lastLines, runProcess } from './process';

interface Job {
  outputPath: string;
  /** MP4 solo-video que escribe el renderer (WebCodecs). */
  videoPath: string;
  file: fs.promises.FileHandle;
  proc: ChildProcess | null;
  cancelled: boolean;
}

/**
 * Exportación en dos fases:
 *  1. El renderer compone y codifica el video (WebGL + WebCodecs) y lo escribe por partes (`write`).
 *  2. `finish` mezcla el audio con FFmpeg y lo multiplexa con el video (sin recodificarlo).
 */
export class ExportManager {
  private readonly jobs = new Map<string, Job>();

  async begin(outputPath: string): Promise<string> {
    const id = randomUUID();
    const videoPath = path.join(os.tmpdir(), `lenstom-${id}-video.mp4`);
    const file = await fs.promises.open(videoPath, 'w');
    this.jobs.set(id, { outputPath, videoPath, file, proc: null, cancelled: false });
    return id;
  }

  async write(id: string, position: number, data: Uint8Array): Promise<void> {
    const job = this.job(id);
    await job.file.write(data, 0, data.byteLength, position);
  }

  async finish(id: string, project: Project, onProgress: (p: ExportProgress) => void): Promise<ExportResult> {
    const job = this.job(id);
    await job.file.close();
    const scriptPath = path.join(os.tmpdir(), `lenstom-${id}-audio.txt`);
    try {
      const plan = buildAudioPlan(project, 1);
      await fs.promises.writeFile(scriptPath, plan.filterGraph, 'utf8');
      const args = [
        '-hide_banner', '-v', 'error', '-nostats',
        '-progress', 'pipe:1', '-stats_period', '0.25', '-y',
        '-i', job.videoPath,
        ...plan.inputArgs,
        // Sintaxis de FFmpeg ≥7 para leer el valor de una opción desde archivo.
        '-/filter_complex', scriptPath,
        '-map', '0:v:0', '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', '-ar', String(project.settings.sampleRate),
        '-movflags', '+faststart',
        '-t', num(plan.duration),
        job.outputPath,
      ];
      let pending = '';
      const res = await runProcess(FFMPEG_BIN, args, {
        onSpawn: (p) => (job.proc = p),
        onStdout: (chunk) => {
          pending += chunk.toString();
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? '';
          for (const line of lines) {
            const m = /^out_time_us=(\d+)/.exec(line);
            if (m) {
              const time = Number(m[1]) / 1e6;
              onProgress({ ratio: Math.min(1, time / plan.duration), time, phase: 'audio' });
            }
          }
        },
      });
      if (job.cancelled) {
        await fs.promises.rm(job.outputPath, { force: true }).catch(() => undefined);
        return { status: 'cancelled' };
      }
      if (res.code !== 0) {
        return { status: 'error', message: `FFmpeg terminó con código ${res.code}:\n${lastLines(res.stderr, 12)}` };
      }
      return { status: 'done', outputPath: job.outputPath };
    } catch (e) {
      return { status: 'error', message: (e as Error).message };
    } finally {
      await this.cleanup(id, scriptPath);
    }
  }

  /** Cancela (en cualquier fase) y borra los archivos parciales. */
  async abort(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    const proc = job.proc;
    if (proc) {
      try {
        proc.stdin?.write('q');
      } catch {
        /* stdin cerrado */
      }
      setTimeout(() => proc.kill(), 1500);
      return; // finish() limpia al terminar el proceso
    }
    await job.file.close().catch(() => undefined);
    await this.cleanup(id);
    await fs.promises.rm(job.outputPath, { force: true }).catch(() => undefined);
  }

  private job(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Exportación inexistente o finalizada.');
    return job;
  }

  private async cleanup(id: string, scriptPath?: string): Promise<void> {
    const job = this.jobs.get(id);
    this.jobs.delete(id);
    if (job) await fs.promises.rm(job.videoPath, { force: true }).catch(() => undefined);
    if (scriptPath) await fs.promises.rm(scriptPath, { force: true }).catch(() => undefined);
  }
}
