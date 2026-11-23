import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG_BIN, lastLines, runProcess } from './process';

const pending = new Map<string, Promise<string>>();

/**
 * Copia intermedia H.264 (solo video) para formatos que el renderer no puede decodificar.
 * GOP corto para que el scrubbing sea ágil. Se cachea por ruta + tamaño + fecha.
 */
export async function makeIntermediate(cacheDir: string, filePath: string): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  const key = createHash('sha1').update(`${filePath}|${stat.size}|${stat.mtimeMs}`).digest('hex');
  const out = path.join(cacheDir, `${key}.mp4`);
  if (fs.existsSync(out)) return out;

  let job = pending.get(out);
  if (!job) {
    job = (async () => {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const tmp = `${out}.part.mp4`;
      const res = await runProcess(FFMPEG_BIN, [
        '-v', 'error', '-y',
        '-i', filePath,
        '-map', '0:v:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
        '-pix_fmt', 'yuv420p', '-g', '15',
        '-an', '-movflags', '+faststart',
        tmp,
      ]);
      if (res.code !== 0) {
        await fs.promises.rm(tmp, { force: true });
        throw new Error(`No se pudo preparar el archivo para edición: ${lastLines(res.stderr)}`);
      }
      await fs.promises.rename(tmp, out);
      return out;
    })().finally(() => pending.delete(out));
    pending.set(out, job);
  }
  return job;
}
