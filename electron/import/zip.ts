import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Lector mínimo de ZIP (directorio central + entradas "store" o "deflate").
 * Suficiente para proyectos de Filmora (.wfp), que son ZIP comunes sin cifrar.
 */
export class ZipReader {
  private readonly entries = new Map<string, { offset: number; method: number; compSize: number }>();

  private constructor(private readonly buf: Buffer) {
    // Fin del directorio central: se busca desde el final (puede haber un comentario).
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('El archivo no es un ZIP válido.');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Directorio del ZIP dañado.');
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const offset = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
      this.entries.set(name, { offset, method, compSize });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  static async open(path: string): Promise<ZipReader> {
    return new ZipReader(await fs.promises.readFile(path));
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  read(name: string): Buffer | null {
    const e = this.entries.get(name);
    if (!e) return null;
    const b = this.buf;
    if (b.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`Entrada dañada: ${name}`);
    const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
    const data = b.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Compresión ZIP no soportada (${e.method}) en ${name}`);
  }

  readText(name: string): string | null {
    return this.read(name)?.toString('utf8').replace(/^﻿/, '') ?? null;
  }
}
