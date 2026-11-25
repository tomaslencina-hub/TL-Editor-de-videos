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
import { DEFAULT_TEXT } from '../../shared/text';
import { ZipReader } from './zip';

/**
 * Importa un proyecto de Wondershare Filmora (.wfp, probado con Filmora 14).
 * El .wfp es un ZIP; la timeline está en ProjectFolder/Medias/<id>/timeline.wesproj (JSON).
 * Tiempos en unidades de 100 ns. Se importan videos, audios, imágenes, recortes, volumen, fundidos,
 * posición/escala y los textos de los títulos; lo propio de Filmora (stickers, filtros) se reporta.
 */

const TU = 1e7; // unidades por segundo
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);

export interface FilmoraImportResult {
  project: Project;
  /** Cosas que no se pudieron traer igual (se muestran al usuario). */
  warnings: string[];
  /** Medios cuyo archivo no existe en esta computadora (rutas originales). */
  missing: string[];
  stats: { clips: number; texts: number; media: number };
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

/** Texto de un título: Filmora usa \r como salto y rellena con espacios. */
function cleanTitle(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
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
    return clip;
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
            text: { ...DEFAULT_TEXT, text, fontSize: 80 },
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
  main.trackInfos.forEach((ftr, i) => {
    const isVideo = ftr.trackType === 1;
    const clips: Clip[] = [];
    const texts: Clip[] = [];
    for (const c of ftr.clipList) {
      if (c.type === 7) {
        const r = expandCompound(c);
        clips.push(...r.clips);
        texts.push(...r.texts);
      } else if (c.type === 8) {
        note(`Elemento de la biblioteca de Filmora: ${libraryName(c) ?? 'sin nombre'}`);
      } else {
        const clip = toClip(c);
        if (clip) clips.push(clip);
        else if (!c.filename) note('Elementos propios de Filmora sin archivo');
      }
    }
    textCount += texts.length;
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
    } else if (clips.length) {
      audioTracks.push(make('audio', `Audio ${audioTracks.length + 1}`, clips));
    }
  });
  // Nombres prolijos: se numeran de abajo hacia arriba, como en Filmora.
  let vn = 0;
  let tn = 0;
  for (const t of [...videoTracks].reverse()) t.name = t.clips.some((c) => c.text) ? `Títulos ${++tn}` : `Video ${++vn}`;
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

  for (const [what, n] of unsupported) warnings.push(n > 1 ? `${what} (×${n})` : what);
  warnings.push('Las transiciones, filtros, máscaras y animaciones de Filmora no se importan.');
  const missing = project.media.map((m) => m.path).filter((p) => !fs.existsSync(p));
  const clipsTotal = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  return { project, warnings, missing, stats: { clips: clipsTotal - textCount, texts: textCount, media: project.media.length } };
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
