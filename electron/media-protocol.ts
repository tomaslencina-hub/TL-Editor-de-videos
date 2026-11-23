import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * Protocolo `media://local/<ruta-codificada>` para que el renderer reproduzca archivos locales
 * sin habilitar file:// ni desactivar webSecurity. Soporta Range (206), requerido para seek en <video>.
 */
export const MEDIA_SCHEME = 'media';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/** Debe llamarse antes de `app.whenReady()`. */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

function toWeb(stream: fs.ReadStream): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream;
}

export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const mime = MIME[path.extname(filePath).toLowerCase()];
    // Solo se sirven extensiones multimedia conocidas.
    if (!mime) return new Response('Tipo no permitido', { status: 403 });

    let size: number;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('No encontrado', { status: 404 });
      size = stat.size;
    } catch {
      return new Response('No encontrado', { status: 404 });
    }

    const range = request.headers.get('range');
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (match && size > 0) {
      let start: number;
      let end: number;
      if (match[1] === '') {
        // Sufijo: últimos N bytes.
        start = Math.max(0, size - Number(match[2]));
        end = size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      }
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      return new Response(toWeb(fs.createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }

    return new Response(toWeb(fs.createReadStream(filePath)), {
      status: 200,
      headers: { 'Content-Type': mime, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  });
}

export function toMediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(filePath)}`;
}
