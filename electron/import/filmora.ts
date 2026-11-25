import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createEmptyProject,
  PROJECT_FORMAT_VERSION,
  type Clip,
  type MediaSource,
  type Project,
  type Track,
} from '../../shared/model';
import { EQ_LABELS, type AudioFx } from '../../shared/audio-fx';
import { makeOverlay, OVERLAY_LABELS, type OverlayType } from '../../shared/effects';
import { FILTER_LABELS, makeFilter, type FilterType } from '../../shared/filters';
import { DEFAULT_TEXT } from '../../shared/text';
import { TRANSITION_LABELS, type TransitionType } from '../../shared/transitions';
import { ZipReader } from './zip';

/**
 * Importa un proyecto de Wondershare Filmora (.wfp, probado con Filmora 14).
 * El .wfp es un ZIP; la timeline está en ProjectFolder/Medias/<id>/timeline.wesproj (JSON).
 * Tiempos en unidades de 100 ns. Se importan videos, audios, imágenes, recortes, volumen, fundidos,
 * posición/escala, espejado, transiciones (con la equivalente más parecida), limpieza y ecualizador
 * de audio, textos y animaciones de títulos. Lo propio de la biblioteca de Filmora (stickers, packs)
 * se reemplaza por un efecto de SHOTON si hay uno parecido; si no, se reporta.
 */

const TU = 1e7; // unidades por segundo
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);

export interface FilmoraImportResult {
  project: Project;
  /** Cosas que no se pudieron traer igual (se muestran al usuario). */
  warnings: string[];
  /** Medios cuyo archivo no existe en esta computadora (rutas originales). */
  missing: string[];
  stats: { clips: number; texts: number; media: number; transitions: number; effects: number };
}

interface FxParam {
  name: string;
  fxParam?: { unValue?: number };
}
interface FxEffect {
  id?: string;
  display?: string;
  enable?: boolean;
  paramList?: FxParam[];
}
interface FClip {
  type: number;
  filename?: string;
  inPoint: number;
  outPoint: number;
  tlBegin: number;
  tlEnd: number;
  timelineId?: number;
  scriptBuf?: string;
  effectChainList?: { effectList?: FxEffect[] }[];
  userData?: { data?: string }[];
  preTransition?: FTransition;
  postTransition?: FTransition;
  inAnimation?: { name?: string };
  enableV3Denoise?: boolean;
  denoiseV3Strength?: number;
}
interface FTransition {
  id?: string;
  display?: string;
  tlBegin: number;
  tlEnd: number;
}
interface FTrack {
  trackType: number;
  clipList: FClip[];
}
interface FTimeline {
  timelineId: number;
  type: number;
  resolutionWidth: number;
  resolutionHeight: number;
  frameRate?: { num: number; den: number };
  trackInfos: FTrack[];
}
interface FResource {
  filename: string;
  mediaLength: number;
  videoStreamCount: number;
  audioStreamCount: number;
  vidStreamInfo?: { width: number; height: number; frameRate?: { num: number; den: number }; rotation?: number }[];
}

const newId = (p: string) => `${p}-${randomUUID()}`;

/** "file:/C:/carpeta/a%20b.mp4" → "C:\carpeta\a b.mp4" */
function filePath(uri: string): string {
  let s = uri.replace(/^file:\/*/i, '');
  try {
    s = decodeURI(s);
  } catch {
    /* rutas con % sueltos: se dejan como están */
  }
  return path.normalize(s);
}

function effect(clip: FClip | undefined, id: string): FxEffect | undefined {
  for (const chain of clip?.effectChainList ?? []) {
    const e = chain.effectList?.find((x) => x.id === id);
    if (e) return e;
  }
  return undefined;
}

function param(e: FxEffect | undefined, name: string): number | undefined {
  const v = e?.paramList?.find((p) => p.name === name)?.fxParam?.unValue;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Nombre legible de un elemento de la biblioteca de Filmora (va en userData en base64). */
function libraryName(clip: FClip): string | null {
  for (const u of clip.userData ?? []) {
    if (!u.data) continue;
    const txt = Buffer.from(u.data, 'base64').toString('utf8');
    const m = /"name":"([^"]+)"/.exec(txt);
    if (m) return m[1].replace(/_/g, ' ');
  }
  return null;
}

/** Nombre de un efecto de biblioteca aplicado al clip (cadena "Effect", identificado por GUID). */
function libraryEffectName(clip: FClip): string | null {
  for (const chain of clip.effectChainList ?? []) {
    const e = chain.effectList?.find((x) => x.display && !/^(video|audio)\//.test(x.id ?? ''));
    if (e?.display) return e.display;
  }
  return null;
}

/** Texto de un título: Filmora usa \r como salto y rellena con espacios. */
function cleanTitle(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Transición de Filmora → la de SHOTON más parecida. `exact` = mismo efecto visual; si no, es una
 * aproximación (packs de Filmora con diseños propios) y se reporta.
 */
const TRANSITION_MAP: { re: RegExp; type: TransitionType; exact: boolean }[] = [
  { re: /black|negro/i, type: 'fadeblack', exact: true },
  { re: /white|blanco/i, type: 'fadewhite', exact: true },
  { re: /gr[ae]y/i, type: 'fadegrays', exact: true },
  { re: /flash|burn|light ?leak|destello/i, type: 'flash', exact: false },
  { re: /dissolve|disolv|^fade|cross ?fade|fundido/i, type: 'fade', exact: true },
  { re: /door/i, type: 'doorway', exact: true },
  { re: /heart|love|valentin|romance/i, type: 'heart', exact: false },
  { re: /zoom ?out|alejar/i, type: 'zoomout', exact: true },
  { re: /zoom/i, type: 'zoomin', exact: true },
  { re: /whip|swish|speed/i, type: 'whipleft', exact: true },
  { re: /blur|desenfo/i, type: 'blur', exact: true },
  { re: /spin|rotat|roll/i, type: 'spin', exact: false },
  { re: /swirl|twist|vortex/i, type: 'swirl', exact: true },
  { re: /ripple|wave|water|liquid/i, type: 'ripple', exact: false },
  { re: /glitch|distort|noise/i, type: 'glitch', exact: true },
  { re: /^push|^slide/i, type: 'slideleft', exact: true },
  { re: /moverect|^wipe|barrido/i, type: 'wipeleft', exact: true },
  { re: /iris/i, type: 'circlecrop', exact: true },
  { re: /circle/i, type: 'circleopen', exact: true },
  { re: /radial|clock/i, type: 'radial', exact: true },
  { re: /blind|shutter|louver|stripe/i, type: 'blinds', exact: true },
  { re: /squeeze|stretch/i, type: 'squeezeh', exact: true },
  { re: /split|open/i, type: 'vertopen', exact: false },
  { re: /mosaic|tile|square|grid/i, type: 'squares', exact: true },
  { re: /pixel/i, type: 'pixelize', exact: true },
  { re: /diagonal/i, type: 'diagtl', exact: true },
  { re: /cube|page ?flip|turn/i, type: 'slideleft', exact: false },
];

function transitionFor(t: FTransition): { type: TransitionType; exact: boolean; name: string } {
  const name = (t.display ?? t.id ?? 'Transición').trim();
  // Los fundidos de audio de Filmora son un fundido cruzado simple.
  if (/^audio\//.test(t.id ?? '')) return { type: 'fade', exact: true, name };
  const hit = TRANSITION_MAP.find((m) => m.re.test(name));
  if (hit) return { type: hit.type, exact: hit.exact, name };
  return { type: 'fade', exact: false, name };
}

/** Elemento de la biblioteca de Filmora → efecto animado de SHOTON parecido (o null). */
function overlayFor(name: string): OverlayType | null {
  if (/firework|festival|celebrat/i.test(name)) return 'fireworks';
  if (/heart|love|valentin/i.test(name)) return 'hearts';
  if (/confetti|party/i.test(name)) return 'confetti';
  if (/snow|winter|christmas/i.test(name)) return 'snow';
  if (/bubble/i.test(name)) return 'bubbles';
  if (/stage|spot ?light|concert|disco/i.test(name)) return 'spotlights';
  if (/light ?leak|flare|sun ?light|sunbeam/i.test(name)) return 'lightleak';
  if (/rain|storm/i.test(name)) return 'rain';
  if (/starry|night sky|galaxy|shooting star/i.test(name)) return 'stars';
  if (/bokeh/i.test(name)) return 'bokeh';
  if (/petal|blossom|sakura|flower/i.test(name)) return 'petals';
  if (/leaf|leaves|autumn|fall/i.test(name)) return 'leaves';
  if (/balloon/i.test(name)) return 'balloons';
  if (/music|note|melod/i.test(name)) return 'notes';
  if (/sparkl|glitter|particle|star|shine/i.test(name)) return 'sparkles';
  return null;
}

/** Filtro de la biblioteca de Filmora → filtro de SHOTON parecido (o null). */
function filterFor(name: string): FilterType | null {
  const table: [RegExp, FilterType][] = [
    [/horror|terror|scary|creepy/i, 'horror'],
    [/old ?film|film ?scratch|silent ?movie|retro ?film/i, 'oldfilm'],
    [/vhs|tape|camcorder|\b90s\b/i, 'vhs'],
    [/glitch/i, 'glitch'],
    [/black ?(&|and) ?white|\bb&w\b|mono(chrome)?|gr[ae]yscale/i, 'bw'],
    [/sepia/i, 'sepia'],
    [/noir/i, 'noir'],
    [/vintage|retro/i, 'vintage'],
    [/cinema|cinematic|movie|hollywood/i, 'cinema'],
    [/dramatic|drama/i, 'dramatic'],
    [/vivid|vibrant/i, 'vivid'],
    [/blur/i, 'blur'],
    [/vignette/i, 'vignette'],
    [/grain/i, 'grain'],
    [/mosaic|pixel/i, 'pixelate'],
    [/dream|glow/i, 'dream'],
    [/chromatic|rgb/i, 'rgbsplit'],
    [/fish ?eye/i, 'fisheye'],
    [/sketch|pencil|drawing/i, 'sketch'],
    [/invert|negative/i, 'invert'],
    [/thermal|heat ?map/i, 'thermal'],
    [/duotone/i, 'duotone'],
    [/warm/i, 'warm'],
    [/cold|cool|frozen/i, 'cold'],
  ];
  return table.find(([re]) => re.test(name))?.[1] ?? null;
}

/** Limpieza de audio, ecualizador y balance de Filmora → AudioFx de SHOTON. */
function audioFxFor(c: FClip): AudioFx | undefined {
  const fx: AudioFx = {};
  const on = (id: string) => {
    const e = effect(c, id);
    return !!e && e.enable !== false;
  };
  if (c.enableV3Denoise) fx.denoise = Math.min(1, Math.max(0.1, (c.denoiseV3Strength ?? 50) / 100));
  if (on('audio/effect/dewind')) fx.dewind = true;
  if (on('audio/effect/dehum')) fx.dehum = true;
  if (on('audio/effect/hiss_denoise')) fx.dehiss = true;
  const eqFx = effect(c, 'audio/effect/equalizer');
  if (eqFx && eqFx.enable !== false) {
    const eq = EQ_LABELS.map((l) => param(eqFx, `${l}Hz`) ?? 0);
    if (eq.some((g) => Math.abs(g) > 0.01)) fx.eq = eq.map((g) => Math.round(Math.max(-12, Math.min(12, g)) * 10) / 10);
  }
  const vol = effect(c, 'audio/effect/volume');
  const bal = param(vol, 'Balance');
  if (bal !== undefined && Math.abs(bal) > 0.01) fx.pan = Math.max(-1, Math.min(1, bal));
  return Object.keys(fx).length ? fx : undefined;
}

export async function importFilmora(wfpPath: string): Promise<FilmoraImportResult> {
  const zip = await ZipReader.open(wfpPath);
  const tlName = zip.names().find((n) => n.endsWith('/timeline.wesproj'));
  if (!tlName) throw new Error('No se encontró la timeline dentro del proyecto de Filmora.');
  const data = JSON.parse(zip.readText(tlName)!) as {
    currentTimelineId: number;
    resources: FResource[];
    timelineInfos: FTimeline[];
  };
  const info = JSON.parse(zip.readText('ProjectFolder/project_info.json') ?? '{}') as { project_file_name?: string };

  const timelines = new Map(data.timelineInfos.map((t) => [t.timelineId, t]));
  const main = timelines.get(data.currentTimelineId) ?? data.timelineInfos.find((t) => t.type === 0);
  if (!main) throw new Error('El proyecto de Filmora no tiene una timeline principal.');

  const warnings: string[] = [];
  const unsupported = new Map<string, number>();
  const note = (what: string) => unsupported.set(what, (unsupported.get(what) ?? 0) + 1);

  // ---------------- medios ----------------
  const resources = new Map(data.resources.map((r) => [filePath(r.filename), r]));
  const media = new Map<string, MediaSource>();
  const mediaFor = (uri: string): MediaSource => {
    const p = filePath(uri);
    let m = media.get(p);
    if (m) return m;
    const r = resources.get(p);
    const v = r?.vidStreamInfo?.[0];
    const isImage = IMAGE_EXT.has(path.extname(p).toLowerCase()) || (!!r && r.videoStreamCount > 0 && r.mediaLength <= 0);
    const hasVideo = isImage || (r?.videoStreamCount ?? 0) > 0;
    const swap = Math.abs(v?.rotation ?? 0) % 180 === 90;
    m = {
      id: newId('media'),
      path: p,
      name: path.basename(p),
      kind: isImage ? 'image' : hasVideo ? 'video' : 'audio',
      duration: isImage ? 0 : (r?.mediaLength ?? 0) / TU,
      hasVideo,
      hasAudio: !isImage && (r?.audioStreamCount ?? 0) > 0,
      width: v ? (swap ? v.height : v.width) : undefined,
      height: v ? (swap ? v.width : v.height) : undefined,
      fps: v?.frameRate?.den ? Math.round((v.frameRate.num / v.frameRate.den) * 1000) / 1000 : undefined,
    };
    media.set(p, m);
    return m;
  };

  // ---------------- clips ----------------
  const toClip = (c: FClip, offset = 0): Clip | null => {
    if (!c.filename) return null;
    const m = mediaFor(c.filename);
    const start = (c.tlBegin + offset) / TU;
    const dur = (c.tlEnd - c.tlBegin) / TU;
    if (dur <= 0) return null;
    let inPoint = c.inPoint / TU;
    let outPoint = c.outPoint / TU;
    if (m.kind === 'image') {
      inPoint = 0;
      outPoint = dur;
    }
    const clip: Clip = { id: newId('clip'), sourceId: m.id, start, inPoint, outPoint };
    const speed = (outPoint - inPoint) / dur;
    if (m.kind !== 'image' && Math.abs(speed - 1) > 0.01) clip.speed = Math.round(speed * 1000) / 1000;

    // Volumen en dB (-100 = silencio) → lineal, hasta 200 %.
    const gain = param(effect(c, 'audio/effect/volume'), 'VolumeGain');
    if (gain !== undefined && Math.abs(gain) > 0.05) clip.volume = gain <= -60 ? 0 : Math.min(2, Math.pow(10, gain / 20));
    const fade = effect(c, 'audio/effect/fade');
    const fin = param(fade, 'FadeInTime');
    const fout = param(fade, 'FadeOutTime');
    if (fin && fin > 0) clip.audioFadeIn = Math.round(fin * 100) / 100;
    if (fout && fout > 0) clip.audioFadeOut = Math.round(fout * 100) / 100;

    // Posición/escala (Filmora: centro en 0..1 y escala en %, 100 = encajado).
    const tf = effect(c, 'video/effect/transform');
    if (m.hasVideo && tf && param(tf, 'EnableTransform') !== 0) {
      const sx = param(tf, 'Scale_x');
      const sy = param(tf, 'Scale_y');
      const px = param(tf, 'Position_x');
      const py = param(tf, 'Position_y');
      const rot = param(tf, 'Rotation') ?? param(tf, 'Rotate');
      const t: NonNullable<Clip['transform']> = {};
      if (sx !== undefined && sy !== undefined && Math.abs(Math.min(sx, sy) - 100) > 0.5) t.scale = Math.min(sx, sy) / 100;
      if (px !== undefined && Math.abs(px - 0.5) > 0.002) t.x = px - 0.5;
      if (py !== undefined && Math.abs(py - 0.5) > 0.002) t.y = py - 0.5;
      if (rot) t.rotation = rot;
      if (Object.keys(t).length) clip.transform = t;
    }
    if (m.hasVideo) {
      const enabled = (id: string) => {
        const e = effect(c, id);
        return !!e && e.enable !== false;
      };
      if (enabled('video/effect/horizontal_filp')) clip.flipH = true;
      if (enabled('video/effect/vertical_filp')) clip.flipV = true;
    }
    if (m.hasAudio) {
      const fx = audioFxFor(c);
      if (fx) clip.audioFx = fx;
    }
    if (c.preTransition || c.postTransition) pendingTransitions.set(clip, { pre: c.preTransition, post: c.postTransition });
    return clip;
  };

  // ---------------- transiciones ----------------
  const pendingTransitions = new Map<Clip, { pre?: FTransition; post?: FTransition }>();
  let transitionCount = 0;
  const approximated = new Map<string, { n: number; type: TransitionType }>();
  const toTransition = (ft: FTransition) => {
    const r = transitionFor(ft);
    if (!r.exact) {
      const a = approximated.get(r.name);
      approximated.set(r.name, { n: (a?.n ?? 0) + 1, type: r.type });
    }
    transitionCount++;
    return { type: r.type, duration: Math.max(0.1, Math.round(((ft.tlEnd - ft.tlBegin) / TU) * 100) / 100) };
  };
  /**
   * Filmora guarda la transición en el clip de la izquierda ("post") o de la derecha ("pre"), centrada
   * en el corte. En SHOTON la cruzada va en `transitionIn` del clip de la derecha; si no hay clip pegado,
   * queda como entrada/salida desde lo de abajo.
   */
  const applyTransitions = (clips: Clip[]) => {
    clips.forEach((clip, i) => {
      const p = pendingTransitions.get(clip);
      if (!p) return;
      if (p.pre && !clip.transitionIn) clip.transitionIn = toTransition(p.pre);
      if (p.post) {
        const next = clips[i + 1];
        const end = clip.start + (clip.outPoint - clip.inPoint) / (clip.speed ?? 1);
        if (next && Math.abs(next.start - end) < 0.02) {
          if (!next.transitionIn) next.transitionIn = toTransition(p.post);
        } else if (!clip.transitionOut) {
          clip.transitionOut = toTransition(p.post);
        }
      }
    });
  };

  /** Animación de entrada de un título de Filmora → la de SHOTON más parecida. */
  const titleAnimation = (c: FClip): Partial<typeof DEFAULT_TEXT> => {
    const name = c.inAnimation?.name;
    if (!name) return {};
    const animIn = /rotat|spin|turn|roll/i.test(name)
      ? 'spin'
      : /typ(e|ing)/i.test(name)
        ? 'typewriter'
        : /pop|bounce|zoom|scale/i.test(name)
          ? 'pop'
          : /down/i.test(name)
            ? 'slide-down'
            : /up|rise|slide/i.test(name)
              ? 'slide-up'
              : 'fade';
    if (animIn === 'fade' && !/fade|appear|dissolve/i.test(name)) note(`Animación de título "${name}" (se usó Fundido)`);
    return { animIn, animDuration: 0.8 };
  };

  /** Clip compuesto (tipo 7): títulos y grupos viven en otra timeline; se "aplanan". */
  const expandCompound = (c: FClip): { clips: Clip[]; texts: Clip[] } => {
    const sub = c.timelineId !== undefined ? timelines.get(c.timelineId) : undefined;
    const out = { clips: [] as Clip[], texts: [] as Clip[] };
    if (!sub) {
      note('Clips compuestos sin contenido');
      return out;
    }
    // Un tiempo interno t se ve en la timeline principal en tlBegin + (t - inPoint).
    const offset = c.tlBegin - c.inPoint;
    for (const tr of sub.trackInfos) {
      for (const inner of tr.clipList) {
        const b = Math.max(inner.tlBegin, c.inPoint);
        const e = Math.min(inner.tlEnd, c.outPoint);
        if (e <= b) continue;
        if (inner.scriptBuf) {
          let text = '';
          try {
            text = cleanTitle((JSON.parse(inner.scriptBuf) as { Text?: string }).Text ?? '');
          } catch {
            /* script dañado */
          }
          if (!text) {
            note('Títulos sin texto legible');
            continue;
          }
          const tf = effect(inner, 'video/effect/transform');
          const px = param(tf, 'Position_x');
          const py = param(tf, 'Position_y');
          out.texts.push({
            id: newId('clip'),
            sourceId: '',
            start: (b + offset) / TU,
            inPoint: 0,
            outPoint: (e - b) / TU,
            text: { ...DEFAULT_TEXT, text, fontSize: 80, ...titleAnimation(inner) },
            transform: { x: px !== undefined ? px - 0.5 : 0, y: py !== undefined ? py - 0.5 : 0 },
          });
        } else if (inner.filename) {
          // Recorte al tramo visible del compuesto (velocidad 1 dentro del compuesto).
          const clip = toClip(
            {
              ...inner,
              tlBegin: b,
              tlEnd: e,
              inPoint: inner.inPoint + (b - inner.tlBegin),
              outPoint: inner.inPoint + (e - inner.tlBegin),
            },
            offset,
          );
          if (clip) out.clips.push(clip);
        } else if (inner.type === 7) {
          note('Clips compuestos anidados (se toma solo el primer nivel)');
        }
      }
    }
    return out;
  };

  // ---------------- pistas ----------------
  // En Filmora el índice más alto es la pista de más arriba; en SHOTON el orden es de arriba hacia abajo.
  const videoTracks: Track[] = [];
  const audioTracks: Track[] = [];
  let textCount = 0;
  let effectCount = 0;
  const substituted: string[] = [];
  main.trackInfos.forEach((ftr, i) => {
    const isVideo = ftr.trackType === 1;
    const clips: Clip[] = [];
    const texts: Clip[] = [];
    const effects: Clip[] = [];
    for (const c of ftr.clipList) {
      if (c.type === 7) {
        const r = expandCompound(c);
        clips.push(...r.clips);
        texts.push(...r.texts);
      } else if (c.type === 8) {
        const name = libraryEffectName(c) ?? libraryName(c) ?? 'sin nombre';
        const filter = filterFor(name);
        const type = filter ? null : overlayFor(name);
        const dur = (c.tlEnd - c.tlBegin) / TU;
        if (filter && dur > 0) {
          // Filtro de Filmora sobre la timeline → capa de filtro (afecta a lo de abajo).
          effects.push({ id: newId('clip'), sourceId: '', start: c.tlBegin / TU, inPoint: 0, outPoint: dur, filter: makeFilter(filter) });
          substituted.push(`${name} → filtro ${FILTER_LABELS[filter]}`);
        } else if (type && dur > 0) {
          effects.push({
            id: newId('clip'),
            sourceId: '',
            start: c.tlBegin / TU,
            inPoint: 0,
            outPoint: dur,
            overlay: makeOverlay(type, (c.tlBegin / 1e4) % 1e6 | 0),
          });
          substituted.push(`${name} → ${OVERLAY_LABELS[type]}`);
        } else {
          note(`Elemento de la biblioteca de Filmora sin equivalente: ${name}`);
        }
      } else {
        const clip = toClip(c);
        if (clip) clips.push(clip);
        else if (!c.filename) note('Elementos propios de Filmora sin archivo');
      }
    }
    textCount += texts.length;
    effectCount += effects.length;
    clips.sort((a, b) => a.start - b.start);
    applyTransitions(clips);
    const make = (kind: Track['kind'], name: string, list: Clip[]): Track => ({
      id: newId('track'),
      kind,
      name,
      muted: false,
      locked: false,
      clips: list.sort((a, b) => a.start - b.start),
    });
    if (isVideo) {
      // Si una pista mezcla títulos y medios, los títulos van en su propia pista encima.
      if (clips.length) videoTracks.unshift(make('video', `Video ${i + 1}`, clips));
      if (texts.length) videoTracks.unshift(make('video', `Títulos ${i + 1}`, texts));
      if (effects.length) videoTracks.unshift(make('video', `Efectos ${i + 1}`, effects));
    } else if (clips.length) {
      audioTracks.push(make('audio', `Audio ${audioTracks.length + 1}`, clips));
    }
  });
  // Nombres prolijos: se numeran de abajo hacia arriba, como en Filmora.
  let vn = 0;
  let tn = 0;
  let en = 0;
  for (const t of [...videoTracks].reverse()) {
    t.name = t.clips.some((c) => c.text) ? `Títulos ${++tn}` : t.clips.every((c) => c.overlay || c.filter) ? `Efectos ${++en}` : `Video ${++vn}`;
  }
  if (!videoTracks.length) videoTracks.push({ id: newId('track'), kind: 'video', name: 'Video 1', muted: false, locked: false, clips: [] });
  if (!audioTracks.length) audioTracks.push({ id: newId('track'), kind: 'audio', name: 'Audio 1', muted: false, locked: false, clips: [] });

  // ---------------- proyecto ----------------
  const base = createEmptyProject(info.project_file_name || path.basename(wfpPath, path.extname(wfpPath)));
  const fr = main.frameRate?.den ? main.frameRate.num / main.frameRate.den : 30;
  const project: Project = {
    ...base,
    formatVersion: PROJECT_FORMAT_VERSION,
    settings: {
      ...base.settings,
      width: Math.round(main.resolutionWidth / 2) * 2 || 1920,
      height: Math.round(main.resolutionHeight / 2) * 2 || 1080,
      fps: Math.round(fr * 1000) / 1000,
    },
    media: [...media.values()],
    tracks: [...videoTracks, ...audioTracks],
  };

  for (const [name, a] of approximated) {
    warnings.push(`Transición "${name}"${a.n > 1 ? ` (×${a.n})` : ''} → se usó "${TRANSITION_LABELS[a.type]}"`);
  }
  for (const s of substituted) warnings.push(`Efecto "${s}" (aproximado)`);
  for (const [what, n] of unsupported) warnings.push(n > 1 ? `${what} (×${n})` : what);
  warnings.push('Las máscaras, los keyframes de animación y los filtros de color de Filmora no se importan.');
  const missing = project.media.map((m) => m.path).filter((p) => !fs.existsSync(p));
  const clipsTotal = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  return { project, warnings, missing, stats: {
      clips: clipsTotal - textCount - effectCount,
      texts: textCount,
      media: project.media.length,
      transitions: transitionCount,
      effects: effectCount,
    },
  };
}

/**
 * Busca, dentro de una carpeta (y subcarpetas), archivos con los nombres pedidos.
 * Devuelve nombre de archivo (en minúsculas) → ruta encontrada.
 */
export async function findFilesByName(folder: string, names: string[], maxDepth = 6): Promise<Record<string, string>> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const found: Record<string, string> = {};
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || Object.keys(found).length === wanted.size) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') await walk(full, depth + 1);
      } else {
        const key = e.name.toLowerCase();
        if (wanted.has(key) && !found[key]) found[key] = full;
      }
    }
  };
  await walk(folder, 0);
  return found;
}
