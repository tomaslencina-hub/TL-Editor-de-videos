import {
  clipDuration,
  projectDuration,
  type Clip,
  type MediaSource,
  type Project,
  type Track,
} from '../../shared/model';
import {
  ADJACENT_EPS,
  crossExtensions,
  resolveTransitions,
  type ResolvedTransition,
} from '../../shared/transitions';

/**
 * Traduce el modelo del proyecto a argumentos de FFmpeg + un filtergraph.
 * Función pura: no toca disco ni procesos, así se puede testear aislada.
 *
 * Estrategia:
 *  - Cada clip es un input propio con `-ss/-t`, extendido lo necesario para sus transiciones cruzadas
 *    (si el archivo no tiene material extra, se congela el primer/último cuadro con `tpad`).
 *  - Cada pista se arma como una secuencia de segmentos (clips + huecos). Los huecos de video son
 *    transparentes; los cortes se unen con `concat` o, si hay transición, con `xfade` / `acrossfade`.
 *  - Video: se superponen las pistas de abajo hacia arriba sobre un fondo del color del proyecto.
 *  - Audio: se mezclan todas las pistas (incluido el audio de los clips de video) con `amix`.
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

type Segment = { kind: 'gap'; duration: number } | { kind: 'clip'; clip: Clip };

function segmentsOf(track: Track, total: number): Segment[] {
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  const segs: Segment[] = [];
  let cursor = 0;
  for (const clip of clips) {
    // Huecos menores a ADJACENT_EPS se consideran clips pegados (misma regla que las transiciones).
    if (clip.start > cursor + ADJACENT_EPS) segs.push({ kind: 'gap', duration: clip.start - cursor });
    if (clipDuration(clip) > EPS) segs.push({ kind: 'clip', clip });
    cursor = Math.max(cursor, clip.start + clipDuration(clip));
  }
  if (total > cursor + ADJACENT_EPS) segs.push({ kind: 'gap', duration: total - cursor });
  return segs;
}

interface ClipInput {
  idx: number;
  media: MediaSource;
  /** Segundos a congelar antes del primer cuadro disponible. */
  preHold: number;
  /** Segundos a congelar después del último cuadro disponible. */
  postHold: number;
  /** Duración del segmento extendido (head + clip + tail). */
  length: number;
}

export function buildExportPlan(project: Project): ExportPlan {
  const { width: W, height: H, fps, sampleRate: SR } = project.settings;
  const bg = ffColor(project.settings.backgroundColor);
  const total = projectDuration(project);
  if (total <= EPS) throw new Error('La timeline está vacía: no hay nada para exportar.');

  const mediaById = new Map<string, MediaSource>(project.media.map((m) => [m.id, m]));
  const inputArgs: string[] = [];
  const inputs = new Map<string, ClipInput>();
  const filters: string[] = [];
  let labelSeq = 0;
  const label = (prefix: string) => `${prefix}${labelSeq++}`;

  const transitionsByTrack = new Map(project.tracks.map((t) => [t.id, resolveTransitions(t)]));
  const extensions = crossExtensions([...transitionsByTrack.values()].flat());

  const inputFor = (clip: Clip): ClipInput => {
    const cached = inputs.get(clip.id);
    if (cached) return cached;
    const media = mediaById.get(clip.sourceId);
    if (!media) throw new Error(`El clip ${clip.id} referencia un medio inexistente (${clip.sourceId}).`);
    const ext = extensions.get(clip.id) ?? { head: 0, tail: 0 };
    let srcStart = clip.inPoint - ext.head;
    const preHold = Math.max(0, -srcStart);
    srcStart = Math.max(0, srcStart);
    let srcEnd = clip.outPoint + ext.tail;
    const postHold = Math.max(0, srcEnd - media.duration);
    srcEnd = Math.max(srcStart + 0.001, Math.min(srcEnd, media.duration));
    const input: ClipInput = {
      idx: inputs.size,
      media,
      preHold,
      postHold,
      length: ext.head + clipDuration(clip) + ext.tail,
    };
    inputs.set(clip.id, input);
    inputArgs.push('-ss', num(srcStart), '-t', num(srcEnd - srcStart), '-i', media.path);
    return input;
  };

  const crossBetween = (transitions: ResolvedTransition[], from: Clip, to: Clip) =>
    transitions.find((t) => t.kind === 'cross' && t.from.id === from.id && t.to.id === to.id);
  const edgeTransition = (transitions: ResolvedTransition[], kind: 'in' | 'out', clip: Clip) =>
    transitions.find((t) => (t.kind === 'in' && kind === 'in' && t.to.id === clip.id) || (t.kind === 'out' && kind === 'out' && t.from.id === clip.id));

  // ======================= Video =======================
  const transparent = (d: number) => {
    const l = label('g');
    filters.push(`color=c=black@0.0:s=${W}x${H}:r=${fps}:d=${num(d)},format=yuva420p,setsar=1,settb=AVTB[${l}]`);
    return l;
  };

  const videoClip = (clip: Clip, transitions: ResolvedTransition[]): { l: string; len: number } => {
    const inp = inputFor(clip);
    if (!inp.media.hasVideo) return { l: transparent(inp.length), len: inp.length };
    let l = label('vc');
    filters.push(
      // Letterbox opaco con el color de fondo (igual que la vista previa).
      `[${inp.idx}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,format=yuva420p,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1,fps=${fps},` +
        // Congela cuadros si falta material y agrega margen al final por si el stream es más corto que lo informado.
        `tpad=start_duration=${num(inp.preHold)}:start_mode=clone:stop_duration=${num(inp.postHold + 1)}:stop_mode=clone,` +
        `trim=duration=${num(inp.length)},setpts=PTS-STARTPTS,settb=AVTB[${l}]`,
    );
    // Entradas/salidas contra lo de abajo. xfade mezcla el color con el negro del transparente
    // (no usa alpha premultiplicado) y oscurece los fundidos: para fade/zoom se usa un fade de alpha real.
    const alphaFade = (t: ResolvedTransition) => t.type === 'fade' || t.type === 'zoomin';
    const tin = edgeTransition(transitions, 'in', clip);
    if (tin) {
      const o = label('vi');
      if (alphaFade(tin)) {
        filters.push(`[${l}]fade=t=in:st=0:d=${num(tin.duration)}:alpha=1[${o}]`);
      } else {
        const g = transparent(tin.duration);
        filters.push(`[${g}][${l}]xfade=transition=${tin.type}:duration=${num(tin.duration)}:offset=0[${o}]`);
      }
      l = o;
    }
    const tout = edgeTransition(transitions, 'out', clip);
    if (tout) {
      const o = label('vo');
      const offset = num(inp.length - tout.duration);
      if (alphaFade(tout)) {
        filters.push(`[${l}]fade=t=out:st=${offset}:d=${num(tout.duration)}:alpha=1[${o}]`);
      } else {
        const g = transparent(tout.duration);
        filters.push(`[${l}][${g}]xfade=transition=${tout.type}:duration=${num(tout.duration)}:offset=${offset}[${o}]`);
      }
      l = o;
    }
    return { l, len: inp.length };
  };

  const videoTrack = (track: Track): string => {
    const transitions = transitionsByTrack.get(track.id) ?? [];
    const segs = segmentsOf(track, total);
    let cur: string | null = null;
    let curLen = 0;
    let prevClip: Clip | null = null;
    for (const seg of segs) {
      const s = seg.kind === 'gap' ? { l: transparent(seg.duration), len: seg.duration } : videoClip(seg.clip, transitions);
      if (cur === null) {
        cur = s.l;
        curLen = s.len;
      } else {
        const cross = seg.kind === 'clip' && prevClip ? crossBetween(transitions, prevClip, seg.clip) : undefined;
        const o = label('vj');
        if (cross) {
          filters.push(
            `[${cur}][${s.l}]xfade=transition=${cross.type}:duration=${num(cross.duration)}:offset=${num(curLen - cross.duration)}[${o}]`,
          );
          curLen += s.len - cross.duration;
        } else {
          filters.push(`[${cur}][${s.l}]concat=n=2:v=1:a=0[${o}]`);
          curLen += s.len;
        }
        cur = o;
      }
      prevClip = seg.kind === 'clip' ? seg.clip : null;
    }
    return cur ?? transparent(total);
  };

  // Fondo + pistas de video de abajo hacia arriba.
  let composite = label('base');
  filters.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${num(total)},format=yuv420p,setsar=1,settb=AVTB[${composite}]`);
  const videoTracks = project.tracks.filter((t) => t.kind === 'video');
  for (const track of [...videoTracks].reverse()) {
    if (track.clips.length === 0) continue;
    const t = videoTrack(track);
    const o = label('ov');
    filters.push(`[${composite}][${t}]overlay=0:0:format=auto:eof_action=pass[${o}]`);
    composite = o;
  }
  filters.push(`[${composite}]format=yuv420p[vout]`);

  // ======================= Audio =======================
  const aFormat = `aresample=${SR},aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`;
  const silence = (d: number) => {
    const l = label('s');
    filters.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${num(d)},asetpts=PTS-STARTPTS[${l}]`);
    return l;
  };

  const audioClip = (clip: Clip, transitions: ResolvedTransition[]): { l: string; len: number } => {
    const inp = inputFor(clip);
    let l: string;
    if (inp.media.hasAudio) {
      l = label('ac');
      const delayMs = Math.round(inp.preHold * 1000);
      filters.push(
        `[${inp.idx}:a:0]${aFormat},asetpts=PTS-STARTPTS,` +
          (delayMs > 0 ? `adelay=${delayMs}:all=1,` : '') +
          // apad + atrim garantizan la duración exacta aunque el audio fuente sea más corto.
          `apad,atrim=duration=${num(inp.length)},asetpts=PTS-STARTPTS[${l}]`,
      );
    } else {
      l = silence(inp.length);
    }
    const tin = edgeTransition(transitions, 'in', clip);
    const tout = edgeTransition(transitions, 'out', clip);
    if (tin || tout) {
      const o = label('af');
      const fades = [
        tin ? `afade=t=in:st=0:d=${num(tin.duration)}` : null,
        tout ? `afade=t=out:st=${num(inp.length - tout.duration)}:d=${num(tout.duration)}` : null,
      ].filter(Boolean);
      filters.push(`[${l}]${fades.join(',')}[${o}]`);
      l = o;
    }
    return { l, len: inp.length };
  };

  const audioTrack = (track: Track): string => {
    const transitions = transitionsByTrack.get(track.id) ?? [];
    let cur: string | null = null;
    let curLen = 0;
    let prevClip: Clip | null = null;
    for (const seg of segmentsOf(track, total)) {
      const s = seg.kind === 'gap' ? { l: silence(seg.duration), len: seg.duration } : audioClip(seg.clip, transitions);
      if (cur === null) {
        cur = s.l;
        curLen = s.len;
      } else {
        const cross = seg.kind === 'clip' && prevClip ? crossBetween(transitions, prevClip, seg.clip) : undefined;
        const o = label('aj');
        if (cross) {
          filters.push(`[${cur}][${s.l}]acrossfade=d=${num(cross.duration)}:c1=tri:c2=tri[${o}]`);
          curLen += s.len - cross.duration;
        } else {
          filters.push(`[${cur}][${s.l}]concat=n=2:v=0:a=1[${o}]`);
          curLen += s.len;
        }
        cur = o;
      }
      prevClip = seg.kind === 'clip' ? seg.clip : null;
    }
    return cur ?? silence(total);
  };

  const audioLabels: string[] = [];
  for (const track of project.tracks) {
    if (track.muted) continue;
    const hasAudio = track.clips.some((c) => mediaById.get(c.sourceId)?.hasAudio);
    if (!hasAudio) continue;
    audioLabels.push(`[${audioTrack(track)}]`);
  }

  if (audioLabels.length === 0) {
    filters.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${num(total)}[aout]`);
  } else if (audioLabels.length === 1) {
    filters.push(`${audioLabels[0]}anull[aout]`);
  } else {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[aout]`);
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
