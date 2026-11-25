import { clipDuration, clipSpeed, projectDuration, type Clip, type MediaSource, type Project, type Track } from '../../shared/model';
import { audioFxFilters } from '../../shared/audio-fx';
import { ADJACENT_EPS, crossExtensions, resolveTransitions, type ResolvedTransition } from '../../shared/transitions';

/**
 * Mezcla de AUDIO de la exportación (el video lo compone el renderer con WebGL).
 * Traduce el modelo a inputs + filtergraph de FFmpeg. Función pura.
 *
 *  - Cada clip con audio es un input propio con `-ss/-t`, extendido por sus transiciones cruzadas.
 *  - Cada pista es una secuencia de segmentos (clips + silencios) unidos con `concat`, o con
 *    `acrossfade` donde hay transición; entradas/salidas usan `afade`.
 *  - Todas las pistas (incluido el audio de los clips de video) se mezclan con `amix`.
 */
export interface AudioPlan {
  /** Argumentos de entrada (`-ss … -t … -i …` por clip). */
  inputArgs: string[];
  /** Filtergraph; su salida es [aout]. */
  filterGraph: string;
  duration: number;
}

const EPS = 1e-4;

export function num(n: number): string {
  // Evita notación exponencial y ruido de coma flotante.
  return (Math.round(n * 1e6) / 1e6).toFixed(6);
}

type Segment = { kind: 'gap'; duration: number } | { kind: 'clip'; clip: Clip };

function segmentsOf(track: Track, total: number): Segment[] {
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  const segs: Segment[] = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.start > cursor + ADJACENT_EPS) segs.push({ kind: 'gap', duration: clip.start - cursor });
    if (clipDuration(clip) > EPS) segs.push({ kind: 'clip', clip });
    cursor = Math.max(cursor, clip.start + clipDuration(clip));
  }
  if (total > cursor + ADJACENT_EPS) segs.push({ kind: 'gap', duration: total - cursor });
  return segs;
}

/**
 * @param inputOffset índice del primer input de audio (los anteriores los usa el llamador, p. ej. el video).
 */
export function buildAudioPlan(project: Project, inputOffset = 0): AudioPlan {
  const SR = project.settings.sampleRate;
  const total = projectDuration(project);
  if (total <= EPS) throw new Error('La timeline está vacía: no hay nada para exportar.');

  const mediaById = new Map<string, MediaSource>(project.media.map((m) => [m.id, m]));
  const inputArgs: string[] = [];
  let inputCount = 0;
  const filters: string[] = [];
  let seq = 0;
  const label = (prefix: string) => `${prefix}${seq++}`;

  const transitionsByTrack = new Map(project.tracks.map((t) => [t.id, resolveTransitions(t)]));
  const extensions = crossExtensions([...transitionsByTrack.values()].flat());

  const aFormat = `aresample=${SR},aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`;
  const silence = (d: number) => {
    const l = label('s');
    filters.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${num(d)},asetpts=PTS-STARTPTS[${l}]`);
    return l;
  };

  const edge = (transitions: ResolvedTransition[], kind: 'in' | 'out', clip: Clip) =>
    transitions.find((t) => (kind === 'in' ? t.kind === 'in' && t.to.id === clip.id : t.kind === 'out' && t.from.id === clip.id));
  const crossBetween = (transitions: ResolvedTransition[], from: Clip, to: Clip) =>
    transitions.find((t) => t.kind === 'cross' && t.from.id === from.id && t.to.id === to.id);

  const audioClip = (clip: Clip, transitions: ResolvedTransition[]): { l: string; len: number } => {
    const media = mediaById.get(clip.sourceId);
    if (!media && !clip.text && !clip.overlay) throw new Error(`El clip ${clip.id} referencia un medio inexistente (${clip.sourceId}).`);
    const ext = extensions.get(clip.id) ?? { head: 0, tail: 0 };
    const len = ext.head + clipDuration(clip) + ext.tail;
    let l: string;
    if (media?.hasAudio && !clip.audioMuted) {
      const sp = clipSpeed(clip);
      // Las extensiones de transición están en segundos de timeline; en el archivo valen × velocidad.
      let srcStart = clip.inPoint - ext.head * sp;
      const preHold = Math.max(0, -srcStart) / sp;
      srcStart = Math.max(0, srcStart);
      const srcEnd = Math.max(srcStart + 0.001, Math.min(clip.outPoint + ext.tail * sp, media.duration));
      const idx = inputOffset + inputCount++;
      inputArgs.push('-ss', num(srcStart), '-t', num(srcEnd - srcStart), '-i', media.path);
      l = label('ac');
      const delayMs = Math.round(preHold * 1000);
      const clipDur = clipDuration(clip);
      const parts = [
        `[${idx}:a:0]${aFormat}`,
        'asetpts=PTS-STARTPTS',
        ...atempoChain(sp),
        // Limpieza/ecualizador/balance antes de rellenar con silencio.
        ...audioFxFilters(clip.audioFx),
        delayMs > 0 ? `adelay=${delayMs}:all=1` : null,
        // apad + atrim garantizan la duración exacta aunque el audio fuente sea más corto.
        'apad',
        `atrim=duration=${num(len)}`,
        'asetpts=PTS-STARTPTS',
        volumeFilter(clip, ext.head),
        (clip.audioFadeIn ?? 0) > 0 ? `afade=t=in:st=${num(ext.head)}:d=${num(clip.audioFadeIn!)}` : null,
        (clip.audioFadeOut ?? 0) > 0 ? `afade=t=out:st=${num(ext.head + clipDur - clip.audioFadeOut!)}:d=${num(clip.audioFadeOut!)}` : null,
      ].filter(Boolean);
      filters.push(`${parts[0]},${parts.slice(1).join(',')}[${l}]`);
    } else {
      l = silence(len);
    }
    const tin = edge(transitions, 'in', clip);
    const tout = edge(transitions, 'out', clip);
    if (tin || tout) {
      const o = label('af');
      const fades = [
        tin ? `afade=t=in:st=0:d=${num(tin.duration)}` : null,
        tout ? `afade=t=out:st=${num(len - tout.duration)}:d=${num(tout.duration)}` : null,
      ].filter(Boolean);
      filters.push(`[${l}]${fades.join(',')}[${o}]`);
      l = o;
    }
    return { l, len };
  };

  const audioTrack = (track: Track): string => {
    const transitions = transitionsByTrack.get(track.id) ?? [];
    let cur: string | null = null;
    let prevClip: Clip | null = null;
    for (const seg of segmentsOf(track, total)) {
      const s = seg.kind === 'gap' ? { l: silence(seg.duration) } : audioClip(seg.clip, transitions);
      if (cur === null) {
        cur = s.l;
      } else {
        const cross = seg.kind === 'clip' && prevClip ? crossBetween(transitions, prevClip, seg.clip) : undefined;
        const o = label('aj');
        filters.push(
          cross
            ? `[${cur}][${s.l}]acrossfade=d=${num(cross.duration)}:c1=tri:c2=tri[${o}]`
            : `[${cur}][${s.l}]concat=n=2:v=0:a=1[${o}]`,
        );
        cur = o;
      }
      prevClip = seg.kind === 'clip' ? seg.clip : null;
    }
    return cur ?? silence(total);
  };

  const trackLabels: string[] = [];
  for (const track of project.tracks) {
    if (track.muted) continue;
    if (!track.clips.some((c) => mediaById.get(c.sourceId)?.hasAudio)) continue;
    trackLabels.push(`[${audioTrack(track)}]`);
  }

  if (trackLabels.length === 0) {
    filters.push(`anullsrc=r=${SR}:cl=stereo,atrim=duration=${num(total)}[aout]`);
  } else if (trackLabels.length === 1) {
    filters.push(`${trackLabels[0]}anull[aout]`);
  } else {
    filters.push(`${trackLabels.join('')}amix=inputs=${trackLabels.length}:duration=longest:normalize=0[aout]`);
  }

  return { inputArgs, filterGraph: filters.join(';\n'), duration: total };
}

/** atempo admite 0.5–100 por instancia: velocidades extremas se encadenan. Conserva el tono. */
function atempoChain(speed: number): string[] {
  if (Math.abs(speed - 1) < 1e-6) return [];
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  out.push(`atempo=${num(s)}`);
  return out;
}

/**
 * Volumen del clip: constante, o una expresión lineal por tramos si tiene keyframes de volumen.
 * `offset` = segundos de extensión antes del inicio del clip (t=0 del segmento).
 */
function volumeFilter(clip: Clip, offset: number): string | null {
  const keys = clip.keyframes?.volume;
  if (keys && keys.length > 1) {
    const k = keys.map((key) => ({ t: key.time + offset, v: key.value }));
    let expr = num(k[k.length - 1].v);
    for (let i = k.length - 2; i >= 0; i--) {
      const a = k[i];
      const b = k[i + 1];
      const span = Math.max(1e-6, b.t - a.t);
      expr = `if(lt(t,${num(b.t)}),${num(a.v)}+(${num(b.v - a.v)})*(t-${num(a.t)})/${num(span)},${expr})`;
    }
    expr = `if(lt(t,${num(k[0].t)}),${num(k[0].v)},${expr})`;
    // Entre comillas simples: las comas de la expresión no separan filtros del filtergraph.
    return `volume='${expr}':eval=frame`;
  }
  const v = keys?.length === 1 ? keys[0].value : (clip.volume ?? 1);
  return Math.abs(v - 1) > 1e-6 ? `volume=${num(v)}` : null;
}
