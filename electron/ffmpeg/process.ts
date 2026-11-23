import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolución de binarios: variable de entorno → copia incluida en el instalador
 * (resources/ffmpeg) → PATH del sistema (desarrollo).
 */
function resolveBin(name: 'ffmpeg' | 'ffprobe', envVar: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const bundled = path.join(resources, 'ffmpeg', process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(bundled)) return bundled;
  }
  return name;
}

export const FFMPEG_BIN = resolveBin('ffmpeg', 'FFMPEG_PATH');
export const FFPROBE_BIN = resolveBin('ffprobe', 'FFPROBE_PATH');

/** Verifica que ffmpeg y ffprobe estén disponibles. Devuelve un mensaje de error o null. */
export function checkFfmpegAvailable(): string | null {
  for (const bin of [FFMPEG_BIN, FFPROBE_BIN]) {
    const r = spawnSync(bin, ['-version'], { windowsHide: true });
    if (r.error || r.status !== 0) {
      return `No se pudo ejecutar "${bin}". Instalá FFmpeg y agregalo al PATH (o definí FFMPEG_PATH/FFPROBE_PATH).`;
    }
  }
  return null;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

export interface RunOptions {
  /** Si se provee, recibe stdout en streaming y no se acumula en el resultado. */
  onStdout?: (chunk: Buffer) => void;
  onSpawn?: (proc: ChildProcess) => void;
}

/** Ejecuta un binario y resuelve al terminar (no rechaza por código != 0; lo deja al llamador). */
export function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    opts.onSpawn?.(proc);
    const out: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      if (opts.onStdout) opts.onStdout(chunk);
      else out.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
      // Evita crecer sin límite en procesos largos.
      if (err.length > 64_000) err = err.slice(-32_000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout: Buffer.concat(out), stderr: err, code }));
  });
}

export function lastLines(text: string, n = 8): string {
  return text.trim().split(/\r?\n/).slice(-n).join('\n');
}
