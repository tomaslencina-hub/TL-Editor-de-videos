import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SubtitleModelInfo, SubtitleRequest, SubtitleSegment, WhisperModelId } from '../../shared/ipc-contract';
import type { Project } from '../../shared/model';
import { buildAudioPlan, num } from './export-graph';
import { FFMPEG_BIN, lastLines, runProcess } from './process';

/** Modelos de whisper.cpp (formato ggml) publicados en Hugging Face. Se bajan una vez a userData/models. */
const MODELS: Record<WhisperModelId, { file: string; label: string; sizeMB: number }> = {
  base: { file: 'ggml-base.bin', label: 'Rápido (base)', sizeMB: 148 },
  small: { file: 'ggml-small.bin', label: 'Equilibrado (small)', sizeMB: 488 },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', label: 'Máxima calidad (large-v3-turbo)', sizeMB: 1624 },
};
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

export interface TranscribeProgress {
  phase: 'download' | 'transcribe';
  /** 0..1 */
  ratio: number;
}

/** Valor de opción de filtro: ':' escapado y entre comillas (protege del parser del filtergraph). */
function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
}

/**
 * Subtítulos automáticos con el filtro `whisper` de FFmpeg (whisper.cpp), sin internet salvo para
 * bajar el modelo la primera vez. Transcribe la mezcla de audio de la timeline (lo que se escucha).
 */
export class SubtitleTranscriber {
  private proc: ChildProcess | null = null;
  private abort: AbortController | null = null;
  private cancelled = false;

  constructor(private readonly modelsDir: string) {}

  listModels(): SubtitleModelInfo[] {
    return (Object.keys(MODELS) as WhisperModelId[]).map((id) => ({
      id,
      label: MODELS[id].label,
      sizeMB: MODELS[id].sizeMB,
      downloaded: fs.existsSync(path.join(this.modelsDir, MODELS[id].file)),
    }));
  }

  cancel(): void {
    this.cancelled = true;
    this.abort?.abort();
    const p = this.proc;
    if (p) {
      try {
        p.stdin?.write('q');
      } catch {
        /* cerrado */
      }
      setTimeout(() => p.kill(), 1000);
    }
  }

  async run(project: Project, req: SubtitleRequest, onProgress: (p: TranscribeProgress) => void): Promise<SubtitleSegment[]> {
    this.cancelled = false;
    const model = await this.ensureModel(req.model, (r) => onProgress({ phase: 'download', ratio: r }));
    if (this.cancelled) throw new Error('Cancelado');

    const plan = buildAudioPlan(project, 0);
    const start = Math.max(0, req.start ?? 0);
    const end = Math.min(plan.duration, req.end ?? plan.duration);
    if (end - start < 0.2) throw new Error('El tramo elegido es demasiado corto.');

    const tmp = path.join(os.tmpdir(), `shoton-subs-${process.pid}-${Date.now()}`);
    const out = `${tmp}.json`;
    const script = `${tmp}.txt`;
    const pcm = `${tmp}.pcm`;
    const lang = req.language === 'auto' ? 'auto' : req.language;
    // Mezcla de la timeline → tramo pedido → 16 kHz → whisper (escribe un JSON por línea).
    // La misma señal sale también en PCM para ajustar el inicio/fin de cada frase a la voz real.
    const graph =
      `${plan.filterGraph};\n` +
      `[aout]atrim=start=${num(start)}:end=${num(end)},asetpts=PTS-STARTPTS,aresample=16000,asplit=2[a1][a2];\n` +
      `[a1]whisper=model=${filterPath(model)}:language=${lang}:format=json:destination=${filterPath(out)}` +
      `:queue=10:max_len=${Math.max(10, Math.round(req.maxChars))}[w]`;
    await fs.promises.writeFile(script, graph, 'utf8');

    try {
      let pending = '';
      const duration = end - start;
      const res = await runProcess(
        FFMPEG_BIN,
        [
          '-hide_banner', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-y',
          ...plan.inputArgs,
          '-/filter_complex', script,
          '-map', '[w]', '-f', 'null', '-',
          '-map', '[a2]', '-ac', '1', '-f', 's16le', pcm,
        ],
        {
          onSpawn: (p) => (this.proc = p),
          onStdout: (chunk) => {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() ?? '';
            for (const line of lines) {
              const m = /^out_time_us=(\d+)/.exec(line);
              if (m) onProgress({ phase: 'transcribe', ratio: Math.min(1, Number(m[1]) / 1e6 / duration) });
            }
          },
        },
      );
      if (this.cancelled) throw new Error('Cancelado');
      if (res.code !== 0) {
        const err = lastLines(res.stderr, 8);
        if (/No such filter: 'whisper'|Filter not found/i.test(err)) {
          throw new Error('Esta versión de FFmpeg no incluye Whisper (hace falta un build "full").');
        }
        throw new Error(`No se pudo transcribir:\n${err}`);
      }
      const raw = fs.existsSync(out) ? await fs.promises.readFile(out, 'utf8') : '';
      const energy = fs.existsSync(pcm) ? speechEnergy(await fs.promises.readFile(pcm)) : null;
      const segments = raw
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { start: number; end: number; text: string })
        .map((s) => ({ start: s.start / 1000, end: s.end / 1000, text: s.text.trim() }))
        // Etiquetas de whisper como "[Música]" o "(aplausos)" no son diálogo.
        .filter((s) => s.text && !/^[[(].*[\])]$/.test(s.text));
      const timed = energy ? refineToSpeech(segments, energy) : segments;
      return resegment(timed, Math.max(10, Math.round(req.maxChars)))
        .filter((s) => s.end - s.start > 0.05)
        .map((s) => ({ ...s, start: start + s.start, end: start + s.end }));
    } finally {
      this.proc = null;
      await fs.promises.rm(out, { force: true }).catch(() => undefined);
      await fs.promises.rm(script, { force: true }).catch(() => undefined);
      await fs.promises.rm(pcm, { force: true }).catch(() => undefined);
    }
  }

  /** Devuelve la ruta del modelo, bajándolo si hace falta (con progreso y cancelación). */
  private async ensureModel(id: WhisperModelId, onProgress: (ratio: number) => void): Promise<string> {
    const info = MODELS[id];
    if (!info) throw new Error(`Modelo desconocido: ${id}`);
    const file = path.join(this.modelsDir, info.file);
    if (fs.existsSync(file)) return file;
    await fs.promises.mkdir(this.modelsDir, { recursive: true });
    const part = `${file}.part`;
    this.abort = new AbortController();
    try {
      const res = await fetch(MODEL_BASE_URL + info.file, { signal: this.abort.signal });
      if (!res.ok || !res.body) throw new Error(`No se pudo bajar el modelo (HTTP ${res.status}).`);
      const total = Number(res.headers.get('content-length')) || info.sizeMB * 1024 * 1024;
      let received = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        onProgress(Math.min(1, received / total));
      });
      await pipeline(body, fs.createWriteStream(part));
      await fs.promises.rename(part, file);
      return file;
    } catch (e) {
      await fs.promises.rm(part, { force: true }).catch(() => undefined);
      throw this.cancelled ? new Error('Cancelado') : e;
    } finally {
      this.abort = null;
    }
  }
}

/** Formato SubRip (.srt). */
export function toSrt(segments: SubtitleSegment[]): string {
  const ts = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
  };
  return segments.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.text}\n`).join('\n');
}

// ---------------------------------------------------------------------------- ajuste de tiempos

const WINDOW_S = 0.02;

/** Energía RMS (dBFS) por ventanas de 20 ms de un PCM s16le mono a 16 kHz. */
function speechEnergy(buf: Buffer): Float32Array {
  const per = Math.round(16000 * WINDOW_S);
  const n = Math.floor(buf.length / 2 / per);
  const out = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (let i = 0; i < per; i++) {
      const v = buf.readInt16LE((w * per + i) * 2) / 32768;
      sum += v * v;
    }
    out[w] = 10 * Math.log10(sum / per + 1e-12);
  }
  return out;
}

/**
 * Whisper suele incluir el silencio previo dentro de la primera frase. Se corre el inicio de cada
 * frase al primer momento con voz y el final al último, dentro de su propio tramo (con un margen).
 */
function refineToSpeech(segments: SubtitleSegment[], energy: Float32Array): SubtitleSegment[] {
  // Umbral relativo al nivel de voz del material (percentil 90), con un piso absoluto.
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? -20;
  const threshold = Math.max(-50, loud - 30);
  const idx = (t: number) => Math.max(0, Math.min(energy.length - 1, Math.floor(t / WINDOW_S)));
  const pad = 0.12;
  return segments.map((s) => {
    let a = idx(s.start);
    let b = idx(s.end);
    while (a < b && energy[a] < threshold) a++;
    while (b > a && energy[b] < threshold) b--;
    if (a >= b) return s; // sin voz detectable: se deja como vino
    return { ...s, start: Math.max(s.start, a * WINDOW_S - pad), end: Math.min(s.end, (b + 1) * WINDOW_S + pad) };
  });
}

/**
 * Whisper corta por cantidad de caracteres sin mirar la puntuación ("Este es un | editor de video").
 * Se unen los tramos continuos y se vuelven a cortar priorizando fin de oración, después comas, y
 * por último espacios, sin pasar `maxChars`. El tiempo de cada parte se reparte por caracteres.
 */
function resegment(segments: SubtitleSegment[], maxChars: number): SubtitleSegment[] {
  const out: SubtitleSegment[] = [];
  let run: SubtitleSegment[] = [];
  const flush = () => {
    if (!run.length) return;
    // Texto continuo con el tiempo de cada carácter interpolado dentro de su tramo original.
    const chars: { c: string; t0: number; t1: number }[] = [];
    run.forEach((seg, i) => {
      const text = (i > 0 ? ' ' : '') + seg.text;
      const d = (seg.end - seg.start) / Math.max(1, text.length);
      [...text].forEach((c, k) => chars.push({ c, t0: seg.start + k * d, t1: seg.start + (k + 1) * d }));
    });
    let i = 0;
    while (i < chars.length) {
      while (i < chars.length && chars[i].c === ' ') i++;
      if (i >= chars.length) break;
      const limit = Math.min(chars.length, i + maxChars);
      let cut = limit;
      if (limit < chars.length) {
        const slice = chars.slice(i, limit).map((x) => x.c).join('');
        const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
        const comma = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '), slice.lastIndexOf(': '));
        const space = slice.lastIndexOf(' ');
        // Cortes muy al principio dejan subtítulos de una palabra: se exige un mínimo.
        const min = Math.floor(maxChars * 0.35);
        if (sentence >= min) cut = i + sentence + 1;
        else if (comma >= min) cut = i + comma + 1;
        else if (space > 0) cut = i + space;
      } else {
        // Último tramo: si cabe una oración anterior, se separa igual.
        const slice = chars.slice(i).map((x) => x.c).join('');
        const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
        if (sentence >= Math.floor(maxChars * 0.35) && sentence < slice.length - 2) cut = i + sentence + 1;
      }
      const part = chars.slice(i, cut);
      const text = part.map((x) => x.c).join('').trim();
      if (text) out.push({ text, start: part[0].t0, end: part[part.length - 1].t1 });
      i = cut;
    }
    run = [];
  };
  for (const s of segments) {
    const prev = run[run.length - 1];
    if (prev && s.start - prev.end > 0.6) flush();
    run.push(s);
  }
  flush();
  return out;
}
