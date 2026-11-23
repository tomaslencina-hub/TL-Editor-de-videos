import {
  clipDuration,
  projectDuration,
  type Clip,
  type MediaSource,
  type Project,
  type Track,
} from '../../shared/model';

/**
 * Traduce el modelo del proyecto a argumentos de FFmpeg + un filtergraph.
 * Función pura: no toca disco ni procesos, así se puede testear aislada.
 *
 * Estrategia v0.1:
 *  - Cada clip es un input propio con `-ss inPoint -t duración` (seek rápido y preciso al re-codificar).
 *  - Cada pista se arma como una secuencia (concat) de segmentos: clips + huecos (negro / silencio),
 *    todos normalizados a la resolución, fps y formato del proyecto.
 *  - Video: primera pista de video (con varias pistas, acá irá un `overlay` por capa).
 *  - Audio: audio de los clips de video + pistas de audio, mezclados con `amix`.
 */

export interface ExportPlan {
  /** Argumentos de entrada (`-ss … -t … -i …` por clip). */
  inputArgs: string[];
  /** Contenido del filtergraph (se pasa por archivo para evitar el límite de línea de comandos de Windows). */
  filterGraph: string;
  /** Argumentos de salida (map, códecs) sin la ruta de salida. */
  outputArgs: string[];
  duration: number;
}

const EPS = 1e-4;

function ffColor(css: string): string {
  return /^#[0-9a-f]{6}$/i.test(css) ? `0x${css.slice(1)}` : 'black';
}

function num(n: number): string {
  // Evita notación exponencial y ruido de coma flotante.
  return (Math.round(n * 1e6) / 1e6).toFixed(6);
}

type Segment = { kind: 'gap'; duration: number } | { kind: 'clip'; clip: Clip; duration: number };

function segmentsOf(track: Track, total: number): Segment[] {
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  const segs: Segment[] = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.start > cursor + EPS) segs.push({ kind: 'gap', duration: clip.start - cursor });
    const d = clipDuration(clip);
    if (d > EPS) segs.push({ kind: 'clip', clip, duration: d });
    cursor = Math.max(cursor, clip.start + d);
  }
  if (total > cursor + EPS) segs.push({ kind: 'gap', duration: total - cursor });
  return segs;
}

export function buildExportPlan(project: Project): ExportPlan {
  const { width: W, height: H, fps, sampleRate: SR } = project.settings;
  const bg = ffColor(project.settings.backgroundColor);
  const total = projectDuration(project);
  if (total <= EPS) throw new Error('La timeline está vacía: no hay nada para exportar.');

  const mediaById = new Map<string, MediaSource>(project.media.map((m) => [m.id, m]));
  const inputArgs: string[] = [];
  const inputIndex = new Map<string, number>(); // clipId -> índice de input
  const filters: string[] = [];

  const inputFor = (clip: Clip): { idx: number; media: MediaSource } => {
    const media = mediaById.get(clip.sourceId);
    if (!media) throw new Error(`El clip ${clip.id} referencia un medio inexistente (${clip.sourceId}).`);
    let idx = inputIndex.get(clip.id);
    if (idx === undefined) {
      idx = inputIndex.size;
      inputIndex.set(clip.id, idx);
      inputArgs.push('-ss', num(clip.inPoint), '-t', num(clipDuration(clip)), '-i', media.path);
    }
    return { idx, media };
  };

  // ---------------- Video ----------------
  const videoTrack = project.tracks.find((t) => t.kind === 'video');
  const vLabels: string[] = [];
  const vSegs = videoTrack ? segmentsOf(videoTrack, total) : [{ kind: 'gap' as const, duration: total }];
  vSegs.forEach((seg, n) => {
    const label = `v${n}`;
    if (seg.kind === 'gap') {
      filters.push(
        `color=c=${bg}:s=${W}x${H}:r=${fps}:d=${num(seg.duration)},format=yuv420p,setsar=1,settb=AVTB[${label}]`,
      );
    } else {
      const { idx, media } = inputFor(seg.clip);
      if (media.hasVideo) {
        filters.push(
          `[${idx}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
            `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1,fps=${fps},format=yuv420p,` +
            `trim=duration=${num(seg.duration)},setpts=PTS-STARTPTS,settb=AVTB[${label}]`,
        );
      } else {
        filters.push(
          `color=c=${bg}:s=${W}x${H}:r=${fps}:d=${num(seg.duration)},format=yuv420p,setsar=1,settb=AVTB[${label}]`,
        );
      }
    }
    vLabels.push(`[${label}]`);
  });
  filters.push(`${vLabels.join('')}concat=n=${vLabels.length}:v=1:a=0[vout]`);

  // ---------------- Audio ----------------
  const aFormat = `aresample=${SR},aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`;
  const silence = (d: number, label: string) =>
    `anullsrc=r=${SR}:cl=stereo,atrim=duration=${num(d)},asetpts=PTS-STARTPTS[${label}]`;

  const trackMixLabels: string[] = [];
  const audioTracks = project.tracks.filter((t) => !t.muted && (t.kind === 'audio' || t === videoTrack));
  audioTracks.forEach((track, ti) => {
    const segs = segmentsOf(track, total);
    const labels: string[] = [];
    segs.forEach((seg, n) => {
      const label = `a${ti}_${n}`;
      if (seg.kind === 'gap') {
        filters.push(silence(seg.duration, label));
      } else {
        const { idx, media } = inputFor(seg.clip);
        if (media.hasAudio) {
          // apad + atrim garantizan la duración exacta aunque el audio fuente sea más corto que el video.
          filters.push(
            `[${idx}:a:0]${aFormat},asetpts=PTS-STARTPTS,apad,atrim=duration=${num(seg.duration)}[${label}]`,
          );
        } else {
          filters.push(silence(seg.duration, label));
        }
      }
      labels.push(`[${label}]`);
    });
    const out = `at${ti}`;
    filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[${out}]`);
    trackMixLabels.push(`[${out}]`);
  });

  if (trackMixLabels.length === 0) {
    filters.push(silence(total, 'aout'));
  } else if (trackMixLabels.length === 1) {
    filters.push(`${trackMixLabels[0]}anull[aout]`);
  } else {
    filters.push(
      `${trackMixLabels.join('')}amix=inputs=${trackMixLabels.length}:duration=longest:normalize=0[aout]`,
    );
  }

  const outputArgs = [
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', String(SR),
    '-movflags', '+faststart',
    '-t', num(total),
  ];

  return { inputArgs, filterGraph: filters.join(';\n'), outputArgs, duration: total };
}
