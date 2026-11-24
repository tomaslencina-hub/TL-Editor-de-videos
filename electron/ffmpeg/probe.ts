import path from 'node:path';
import type { ProbeResult } from '../../shared/ipc-contract';
import { FFPROBE_BIN, lastLines, runProcess } from './process';

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
}

function parseRate(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den) return undefined;
  return Math.round((num / den) * 1000) / 1000;
}

export async function probe(filePath: string): Promise<ProbeResult> {
  const { stdout, stderr, code } = await runProcess(FFPROBE_BIN, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  if (code !== 0) throw new Error(`ffprobe falló: ${lastLines(stderr)}`);

  const data = JSON.parse(stdout.toString()) as FfprobeOutput;
  const streams = data.streams ?? [];
  // Las carátulas de MP3/M4A aparecen como stream de video "attached_pic": se ignoran.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video && !audio) throw new Error('El archivo no tiene pistas de video ni de audio.');

  // Imágenes fijas (png, jpg, webp, bmp, gif): un solo cuadro, sin duración propia.
  const format = data.format?.format_name ?? '';
  if (video && !audio && /image2|_pipe|^gif$|^webp/.test(format)) {
    return {
      path: filePath,
      name: path.basename(filePath),
      kind: 'image',
      duration: 0,
      hasVideo: true,
      hasAudio: false,
      width: video.width,
      height: video.height,
    };
  }

  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('No se pudo determinar la duración (¿imagen fija? no soportada en v0.1).');
  }

  // Videos de celular: la rotación va en metadatos; las dimensiones visibles son las rotadas.
  const rotation = Math.abs(video?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? 0);
  const swap = rotation % 180 === 90;

  return {
    path: filePath,
    name: path.basename(filePath),
    kind: video ? 'video' : 'audio',
    duration,
    hasVideo: !!video,
    hasAudio: !!audio,
    width: swap ? video?.height : video?.width,
    height: swap ? video?.width : video?.height,
    fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
  };
}
