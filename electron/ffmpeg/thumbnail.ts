import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG_BIN, lastLines, runProcess } from './process';

/**
 * Genera (o reutiliza de la caché) una miniatura JPEG del frame en `atSeconds`.
 * Devuelve la ruta absoluta del JPEG.
 */
export async function thumbnail(cacheDir: string, filePath: string, atSeconds: number): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  const key = createHash('sha1')
    .update(`${filePath}|${stat.size}|${stat.mtimeMs}|${atSeconds.toFixed(2)}`)
    .digest('hex');
  const out = path.join(cacheDir, `${key}.jpg`);
  if (fs.existsSync(out)) return out;

  await fs.promises.mkdir(cacheDir, { recursive: true });
  const attempt = (at: number) =>
    runProcess(FFMPEG_BIN, [
      '-v', 'error',
      '-ss', String(at),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '5',
      '-y', out,
    ]);

  let res = await attempt(atSeconds);
  // Si el seek cae fuera del archivo no se genera frame: reintenta desde el inicio.
  if (res.code !== 0 || !fs.existsSync(out)) res = await attempt(0);
  if (res.code !== 0 || !fs.existsSync(out)) {
    throw new Error(`No se pudo generar la miniatura: ${lastLines(res.stderr)}`);
  }
  return out;
}
