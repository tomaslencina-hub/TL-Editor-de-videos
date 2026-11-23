import { ALL_FORMATS, Input, UrlSource } from 'mediabunny';

/**
 * ¿Puede el renderer (WebCodecs) decodificar el video de este archivo?
 * Si no, se usa una copia intermedia H.264 generada con FFmpeg.
 */
export async function canDecodeVideo(url: string): Promise<boolean> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return false;
    const track = await input.getPrimaryVideoTrack();
    return !!track && (await track.canDecode());
  } catch {
    return false;
  } finally {
    input.dispose();
  }
}
