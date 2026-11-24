import {
  ALL_FORMATS,
  CanvasSource,
  canEncodeVideo,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  UrlSource,
  VideoSampleSink,
  type StreamTargetChunk,
  type VideoCodec,
  type VideoSample,
} from 'mediabunny';
import { projectDuration, type Clip, type MediaSource, type Project } from '../../../../shared/model';
import { Compositor } from '../render/compositor';
import { planFrame, toTrackDraws, TransitionCache } from '../render/scene';
import { ImageCache } from '../render/image-cache';
import { resolveTextLayer, TextRasterizer, type RenderedText } from '../render/text-renderer';

export class ExportCancelled extends Error {
  constructor() {
    super('Exportación cancelada');
  }
}

export interface VideoRenderOptions {
  project: Project;
  /** URL reproducible (media://) del archivo del que se decodifica cada medio. */
  sourceUrl: (media: MediaSource) => string;
  /** Escribe un fragmento del MP4 en la posición dada (lo recibe el proceso main). */
  write: (position: number, data: Uint8Array) => Promise<void>;
  onProgress: (ratio: number, time: number) => void;
  isCancelled: () => boolean;
}

/** Cuadros que necesita cada clip, en orden (para decodificación secuencial eficiente). */
interface ClipPlan {
  clip: Clip;
  media: MediaSource;
  /** Tiempos locales (en el archivo) por cuadro de salida donde el clip es visible. */
  times: number[];
  firstFrame: number;
  lastFrame: number;
}

interface ClipReader {
  input: Input;
  iterator: AsyncGenerator<VideoSample | null, void, unknown>;
  width: number;
  height: number;
  rotation: number;
  hasTexture: boolean;
}

/**
 * Compone y codifica el video del proyecto cuadro por cuadro con el mismo Compositor que la vista previa.
 * Decodifica con WebCodecs (Mediabunny), dibuja con WebGL en un OffscreenCanvas y codifica a H.264.
 */
export async function renderVideo(opts: VideoRenderOptions): Promise<void> {
  const { project } = opts;
  const { width: W, height: H, fps, backgroundColor } = project.settings;
  const duration = projectDuration(project);
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const transitions = new TransitionCache();
  const mediaById = new Map(project.media.map((m) => [m.id, m]));

  // 1) Plan: qué clip se necesita en qué cuadro y a qué tiempo local.
  const plans = new Map<string, ClipPlan>();
  const frames: ReturnType<typeof planFrame>[] = [];
  for (let n = 0; n < totalFrames; n++) {
    const plan = planFrame(project, n / fps, transitions);
    frames.push(plan);
    for (const track of plan) {
      for (const layer of track.layers) {
        const media = mediaById.get(layer.clip.sourceId);
        if (!media?.hasVideo || media.kind === 'image') continue;
        let p = plans.get(layer.clip.id);
        if (!p) plans.set(layer.clip.id, (p = { clip: layer.clip, media, times: [], firstFrame: n, lastFrame: n }));
        // Fuera del material disponible se congela el primer/último cuadro.
        p.times.push(Math.min(Math.max(0, layer.local), Math.max(0, media.duration - 1 / fps / 2)));
        p.lastFrame = n;
      }
    }
  }

  // 2) Salida: MP4 solo-video, escrito por partes hacia el proceso main.
  const codec = await pickCodec(W, H);
  const canvas = new OffscreenCanvas(W, H);
  const compositor = new Compositor(canvas);
  compositor.setSize(W, H);
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => opts.write(chunk.position, chunk.data),
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  });
  const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const readers = new Map<string, ClipReader>();
  const rasterizer = new TextRasterizer();
  const uploadedText = new Map<string, RenderedText>();
  // Imágenes: se precargan todas antes de empezar a componer.
  const images = new ImageCache();
  const uploadedImages = new Set<string>();
  const imageUrl = new Map<string, string>();
  for (const m of project.media) if (m.kind === 'image') imageUrl.set(m.id, opts.sourceUrl(m));
  await Promise.all([...imageUrl.values()].map((u) => images.load(u)));
  const openReader = async (p: ClipPlan): Promise<ClipReader> => {
    const input = new Input({ source: new UrlSource(opts.sourceUrl(p.media)), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      throw new Error(`No se puede decodificar el video de "${p.media.name}".`);
    }
    const offset = await track.getFirstTimestamp();
    const sink = new VideoSampleSink(track);
    const reader: ClipReader = {
      input,
      iterator: sink.samplesAtTimestamps(p.times.map((t) => t + offset)),
      width: track.squarePixelWidth ?? track.displayWidth,
      height: track.squarePixelHeight ?? track.displayHeight,
      rotation: track.rotation ?? 0,
      hasTexture: false,
    };
    readers.set(p.clip.id, reader);
    return reader;
  };
  const closeReader = async (clipId: string) => {
    const r = readers.get(clipId);
    if (!r) return;
    readers.delete(clipId);
    await r.iterator.return(undefined).catch(() => undefined);
    r.input.dispose();
    compositor.releaseTexture(clipId);
  };

  try {
    for (let n = 0; n < totalFrames; n++) {
      if (opts.isCancelled()) throw new ExportCancelled();
      const t = n / fps;
      const plan = frames[n];

      // 3) Decodifica el cuadro de cada clip visible y lo sube como textura.
      for (const track of plan) {
        for (const layer of track.layers) {
          const p = plans.get(layer.clip.id);
          if (!p) continue;
          const reader = readers.get(p.clip.id) ?? (await openReader(p));
          const { value: sample } = await reader.iterator.next();
          if (sample) {
            const frame = sample.toVideoFrame();
            compositor.upload(p.clip.id, frame, frame.displayWidth, frame.displayHeight);
            reader.width = frame.displayWidth;
            reader.height = frame.displayHeight;
            reader.rotation = sample.rotation ?? reader.rotation;
            reader.hasTexture = true;
            frame.close();
            sample.close();
          }
        }
      }

      // 4) Compone y codifica.
      const draws = toTrackDraws(plan, t, (_track, layer) => {
        if (layer.clip.text) return resolveTextLayer(compositor, rasterizer, uploadedText, `text:${layer.clip.id}`, layer.clip, t, H);
        const img = imageUrl.get(layer.clip.sourceId);
        if (img) return images.resolve(compositor, uploadedImages, `img:${layer.clip.id}`, img);
        const r = readers.get(layer.clip.id);
        return r?.hasTexture ? { texture: layer.clip.id, width: r.width, height: r.height, sourceRotation: r.rotation } : null;
      });
      compositor.render(backgroundColor, draws);
      await source.add(t, 1 / fps);

      // 5) Libera los decodificadores de clips que ya no se usan.
      for (const [clipId, p] of plans) {
        if (p.lastFrame === n) await closeReader(clipId);
      }
      opts.onProgress((n + 1) / totalFrames, t);
    }
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => undefined);
    throw e;
  } finally {
    for (const id of [...readers.keys()]) await closeReader(id);
    compositor.dispose();
    images.dispose();
  }
}

/** H.264 si el equipo lo puede codificar a esa resolución; si no, VP9 (también va en MP4). */
async function pickCodec(width: number, height: number): Promise<VideoCodec> {
  for (const codec of ['avc', 'vp9', 'av1'] as VideoCodec[]) {
    if (await canEncodeVideo(codec, { width, height })) return codec;
  }
  throw new Error('Este equipo no puede codificar video con WebCodecs (H.264/VP9/AV1).');
}
