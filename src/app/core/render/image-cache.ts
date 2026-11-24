import type { Compositor } from './compositor';
import type { ResolvedSource } from './scene';

/**
 * Imágenes fijas decodificadas como ImageBitmap (una vez por archivo).
 * La usan la vista previa (carga perezosa + redibujo) y la exportación (precarga antes de renderizar).
 */
export class ImageCache {
  private readonly bitmaps = new Map<string, ImageBitmap>();
  private readonly pending = new Map<string, Promise<ImageBitmap>>();

  get(url: string): ImageBitmap | undefined {
    return this.bitmaps.get(url);
  }

  load(url: string): Promise<ImageBitmap> {
    const hit = this.bitmaps.get(url);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`No se pudo leer la imagen (${r.status})`);
          return r.blob();
        })
        .then((b) => createImageBitmap(b, { premultiplyAlpha: 'none' }))
        .then((bmp) => {
          this.bitmaps.set(url, bmp);
          return bmp;
        })
        .finally(() => this.pending.delete(url));
      this.pending.set(url, p);
    }
    return p;
  }

  /**
   * Fuente de una capa de imagen. Sube la textura la primera vez (por clave) y devuelve null
   * si todavía no está cargada (la vista previa redibuja al terminar la carga con `onLoaded`).
   */
  resolve(compositor: Compositor, uploaded: Set<string>, textureKey: string, url: string, onLoaded?: () => void): ResolvedSource | null {
    const bmp = this.bitmaps.get(url);
    if (!bmp) {
      void this.load(url).then(() => onLoaded?.()).catch((e: unknown) => console.warn('Imagen', url, e));
      return null;
    }
    const key = `${textureKey}|${url}`;
    if (!uploaded.has(key)) {
      compositor.upload(textureKey, bmp, bmp.width, bmp.height);
      uploaded.add(key);
    }
    return { texture: textureKey, width: bmp.width, height: bmp.height };
  }

  dispose(): void {
    for (const b of this.bitmaps.values()) b.close();
    this.bitmaps.clear();
  }
}
