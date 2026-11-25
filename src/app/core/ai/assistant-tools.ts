import { EQ_PRESETS, type AudioFx } from '../../../../shared/audio-fx';
import { makeOverlay, OVERLAY_LABELS, OVERLAY_TYPES, isOverlayType } from '../../../../shared/effects';
import { FILTER_LABELS, FILTER_TYPES, isFilterClip, isFilterType, makeFilter } from '../../../../shared/filters';
import { clipEnd, clipSpeed, projectDuration, type Clip, type Id, type Project } from '../../../../shared/model';
import { makeText, TEXT_ANIMATIONS, TEXT_PRESETS, type TextAnimation } from '../../../../shared/text';
import { isTransitionType, TRANSITION_LABELS, TRANSITION_TYPES } from '../../../../shared/transitions';
import { setClipProps } from '../timeline/clip-props';
import * as ops from '../timeline/timeline-ops';

/**
 * Herramientas del asistente de IA. Cada una es una función pura Project → Project que usa las
 * mismas operaciones que la interfaz; el servicio las aplica sobre un borrador y al final lo
 * confirma como un único paso del historial (Ctrl+Z lo deshace entero).
 *
 * Los IDs internos son largos: al modelo se le muestran alias cortos (c1, t2, m3).
 */

// ------------------------------------------------------------------ alias

export class Aliases {
  private readonly toShort = new Map<Id, string>();
  private readonly toLong = new Map<string, Id>();
  private n = 0;

  alias(id: Id, prefix: 'c' | 't' | 'm'): string {
    let a = this.toShort.get(id);
    if (!a) {
      a = `${prefix}${++this.n}`;
      this.toShort.set(id, a);
      this.toLong.set(a, id);
    }
    return a;
  }

  id(alias: unknown): Id | null {
    return typeof alias === 'string' ? (this.toLong.get(alias.trim()) ?? null) : null;
  }
}

const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

/** Estado del proyecto en texto compacto para el modelo. */
export function describeProject(p: Project, a: Aliases, playhead: number, selected: Id[]): string {
  const lines: string[] = [];
  const s = p.settings;
  lines.push(`Proyecto "${p.name}": ${s.width}x${s.height}, ${s.fps} fps, duración ${f2(projectDuration(p))} s. Cursor (playhead) en ${f2(playhead)} s.`);
  if (selected.length) lines.push(`Clips seleccionados: ${selected.map((id) => a.alias(id, 'c')).join(', ')}`);
  lines.push('Medios importados:');
  if (!p.media.length) lines.push('  (ninguno)');
  for (const m of p.media) {
    const kind = m.kind === 'image' ? 'imagen' : m.kind === 'audio' ? 'audio' : `video${m.hasAudio ? ' con audio' : ''}`;
    lines.push(`  [${a.alias(m.id, 'm')}] "${m.name}" (${kind}${m.kind === 'image' ? '' : `, ${f2(m.duration)} s`})`);
  }
  lines.push('Pistas (de arriba hacia abajo; lo de arriba tapa a lo de abajo):');
  for (const t of p.tracks) {
    const flags = [t.muted && 'silenciada', t.locked && 'bloqueada'].filter(Boolean).join(', ');
    lines.push(`  [${a.alias(t.id, 't')}] "${t.name}" (${t.kind === 'audio' ? 'audio' : 'video'}${flags ? `, ${flags}` : ''})`);
    for (const c of t.clips) lines.push(`    ${describeClip(p, c, a)}`);
    if (!t.clips.length) lines.push('    (vacía)');
  }
  if (p.markers?.length) lines.push(`Marcadores: ${p.markers.map((m) => f2(m.time)).join(', ')} s`);
  return lines.join('\n');
}

function describeClip(p: Project, c: Clip, a: Aliases): string {
  let what: string;
  if (c.text) what = `texto "${c.text.text.replace(/\n/g, ' / ').slice(0, 80)}"`;
  else if (c.overlay) what = `efecto ${OVERLAY_LABELS[c.overlay.type]} (${c.overlay.type})`;
  else if (isFilterClip(c)) what = `capa de filtro ${c.filter!.type}`;
  else {
    const m = p.media.find((x) => x.id === c.sourceId);
    what = `"${m?.name ?? '¿medio faltante?'}" (archivo ${f2(c.inPoint)}–${f2(c.outPoint)} s)`;
  }
  const extra: string[] = [];
  const sp = clipSpeed(c);
  if (sp !== 1) extra.push(`velocidad ${sp}x`);
  if (c.volume !== undefined && c.volume !== 1) extra.push(`volumen ${Math.round(c.volume * 100)}%`);
  if (c.audioMuted) extra.push('audio silenciado');
  if (c.filter && !isFilterClip(c)) extra.push(`filtro ${c.filter.type}`);
  if (c.transitionIn) extra.push(`transición de entrada ${c.transitionIn.type} ${c.transitionIn.duration}s`);
  if (c.transitionOut) extra.push(`transición de salida ${c.transitionOut.type} ${c.transitionOut.duration}s`);
  if (c.audioFx) extra.push('audio con limpieza/ecualizador');
  return `[${a.alias(c.id, 'c')}] ${f2(c.start)}–${f2(clipEnd(c))} s: ${what}${extra.length ? ` · ${extra.join(', ')}` : ''}`;
}

// ------------------------------------------------------------------ declaraciones (esquema de Gemini)

const str = (description: string) => ({ type: 'STRING', description });
const num = (description: string) => ({ type: 'NUMBER', description });
const bool = (description: string) => ({ type: 'BOOLEAN', description });
const oneOf = (values: readonly string[], description: string) => ({ type: 'STRING', format: 'enum', enum: [...values], description });
const ids = { type: 'ARRAY', items: { type: 'STRING' }, description: 'Alias de los clips, por ejemplo ["c3", "c4"].' };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'OBJECT', properties, required });

const PRESET_IDS = TEXT_PRESETS.map((p) => p.id);

export const TOOL_DECLARATIONS = [
  {
    name: 'ver_proyecto',
    description: 'Devuelve el estado actual del proyecto (pistas, clips con sus alias y tiempos). Usalo después de cambios grandes para ver los alias nuevos.',
    // Sin parámetros: Gemini rechaza un objeto vacío.
  },
  {
    name: 'dividir_clip',
    description: 'Corta un clip en dos en un instante de la timeline. Devuelve los alias de las dos partes.',
    parameters: obj({ clip_id: str('Alias del clip.'), tiempo: num('Instante de la timeline (s) donde cortar.') }, ['clip_id', 'tiempo']),
  },
  {
    name: 'borrar_clips',
    description: 'Borra clips. Con cerrar_huecos=true corre hacia la izquierda lo que viene después en esa pista.',
    parameters: obj({ clip_ids: ids, cerrar_huecos: bool('Cerrar el hueco que queda (por defecto false).') }, ['clip_ids']),
  },
  {
    name: 'mover_clip',
    description: 'Mueve un clip a otro instante y opcionalmente a otra pista del mismo tipo. Pisa lo que haya en el destino.',
    parameters: obj({ clip_id: str('Alias del clip.'), inicio: num('Nuevo inicio en la timeline (s).'), pista_id: str('Alias de la pista destino (opcional).') }, ['clip_id', 'inicio']),
  },
  {
    name: 'recortar_clip',
    description: 'Cambia dónde empieza y/o termina un clip en la timeline (recorta o estira sus bordes; no lo mueve).',
    parameters: obj({ clip_id: str('Alias del clip.'), inicio: num('Nuevo inicio (s), opcional.'), fin: num('Nuevo final (s), opcional.') }, ['clip_id']),
  },
  {
    name: 'poner_transicion',
    description:
      'Pone o quita una transición. En el lado "entrada" de un clip pegado a otro anterior hace un cruce entre ambos; si no hay clip pegado, es una entrada desde lo de abajo. "salida" solo sirve si no hay clip pegado después.',
    parameters: obj(
      {
        clip_ids: ids,
        tipo: oneOf([...TRANSITION_TYPES, 'ninguna'], `Tipo de transición o "ninguna" para quitarla. Nombres: ${TRANSITION_TYPES.map((t) => `${t}=${TRANSITION_LABELS[t]}`).join(', ')}.`),
        duracion: num('Duración en segundos (por defecto 1).'),
        lado: oneOf(['entrada', 'salida'], 'Borde del clip (por defecto entrada).'),
      },
      ['clip_ids', 'tipo'],
    ),
  },
  {
    name: 'poner_filtro',
    description: 'Aplica, cambia o quita el filtro de imagen de clips de video, imagen, texto o efecto.',
    parameters: obj(
      {
        clip_ids: ids,
        tipo: oneOf([...FILTER_TYPES, 'ninguno'], `Filtro o "ninguno". Nombres: ${FILTER_TYPES.map((t) => `${t}=${FILTER_LABELS[t]}`).join(', ')}.`),
        intensidad: num('0 a 1 (opcional).'),
      },
      ['clip_ids', 'tipo'],
    ),
  },
  {
    name: 'agregar_capa_filtro',
    description: 'Agrega una capa de filtro que afecta a todo lo que está debajo entre inicio e inicio+duracion (ideal para aplicar un look a todo el video).',
    parameters: obj(
      { tipo: oneOf(FILTER_TYPES, 'Filtro.'), inicio: num('Inicio (s).'), duracion: num('Duración (s).'), intensidad: num('0 a 1 (opcional).') },
      ['tipo', 'inicio', 'duracion'],
    ),
  },
  {
    name: 'agregar_efecto',
    description: `Agrega un efecto animado superpuesto. Tipos: ${OVERLAY_TYPES.map((t) => `${t}=${OVERLAY_LABELS[t]}`).join(', ')}.`,
    parameters: obj({ tipo: oneOf(OVERLAY_TYPES, 'Efecto.'), inicio: num('Inicio (s).'), duracion: num('Duración (s).') }, ['tipo', 'inicio', 'duracion']),
  },
  {
    name: 'agregar_texto',
    description: `Agrega un texto (título, subtítulo, etc.). Estilos: ${TEXT_PRESETS.map((p) => `${p.id}=${p.label}`).join(', ')}.`,
    parameters: obj(
      {
        texto: str('Texto (usar \\n para varias líneas).'),
        inicio: num('Inicio (s).'),
        duracion: num('Duración (s).'),
        estilo: oneOf(PRESET_IDS, 'Estilo (por defecto title).'),
        posicion: oneOf(['arriba', 'centro', 'abajo'], 'Posición vertical (opcional; si no, la del estilo).'),
        color: str('Color #rrggbb (opcional).'),
      },
      ['texto', 'inicio', 'duracion'],
    ),
  },
  {
    name: 'editar_texto',
    description: 'Cambia un clip de texto existente.',
    parameters: obj(
      {
        clip_id: str('Alias del clip de texto.'),
        texto: str('Nuevo texto (opcional).'),
        color: str('Color #rrggbb (opcional).'),
        tamano: num('Tamaño de letra en px para un cuadro de 1080 de alto (opcional, normal 60-160).'),
        animacion_entrada: oneOf(TEXT_ANIMATIONS, 'Animación de entrada (opcional).'),
        animacion_salida: oneOf(TEXT_ANIMATIONS, 'Animación de salida (opcional).'),
      },
      ['clip_id'],
    ),
  },
  {
    name: 'ajustar_audio',
    description: 'Volumen, fundidos y silencio del audio de clips.',
    parameters: obj(
      {
        clip_ids: ids,
        volumen: num('Volumen en % (100 = original, 0 a 200).'),
        fundido_entrada: num('Fundido de entrada (s).'),
        fundido_salida: num('Fundido de salida (s).'),
        silenciar: bool('Silenciar o no el audio del clip.'),
      },
      ['clip_ids'],
    ),
  },
  {
    name: 'limpiar_audio',
    description: 'Limpieza y ecualización del audio de clips (la reducción de ruido se escucha al exportar).',
    parameters: obj(
      {
        clip_ids: ids,
        reducir_ruido: num('0 a 1 (0 = apagado).'),
        viento: bool('Quitar viento.'),
        zumbido: bool('Quitar zumbido eléctrico.'),
        siseo: bool('Quitar siseo.'),
        ecualizador: oneOf(EQ_PRESETS.map((p) => p.id), `Estilo de ecualizador: ${EQ_PRESETS.map((p) => `${p.id}=${p.label}`).join(', ')}.`),
        balance: num('-1 (izquierda) a 1 (derecha), 0 = centro.'),
      },
      ['clip_ids'],
    ),
  },
  {
    name: 'cambiar_velocidad',
    description: 'Cambia la velocidad de clips de video/audio (0.25 a 4; 2 = el doble de rápido).',
    parameters: obj({ clip_ids: ids, velocidad: num('Velocidad.') }, ['clip_ids', 'velocidad']),
  },
  {
    name: 'ajustar_color',
    description: 'Ajustes de color de clips (o de una capa de filtro).',
    parameters: obj(
      {
        clip_ids: ids,
        brillo: num('-100 a 100 (0 = sin cambio).'),
        contraste: num('0 a 200 (100 = sin cambio).'),
        saturacion: num('0 a 200 (100 = sin cambio).'),
        temperatura: num('-100 (frío) a 100 (cálido).'),
      },
      ['clip_ids'],
    ),
  },
  {
    name: 'transformar',
    description: 'Posición, escala, rotación, opacidad y espejado de clips visuales.',
    parameters: obj(
      {
        clip_ids: ids,
        x: num('Desplazamiento horizontal en % del ancho (0 = centro).'),
        y: num('Desplazamiento vertical en % del alto (0 = centro, + = abajo).'),
        escala: num('Escala en % (100 = ocupa el cuadro).'),
        rotacion: num('Grados.'),
        opacidad: num('0 a 100.'),
        espejar_horizontal: bool('Espejado horizontal.'),
        espejar_vertical: bool('Espejado vertical.'),
      },
      ['clip_ids'],
    ),
  },
  {
    name: 'agregar_marcador',
    description: 'Agrega un marcador en la timeline.',
    parameters: obj({ tiempo: num('Instante (s).') }, ['tiempo']),
  },
  {
    name: 'mover_cursor',
    description: 'Mueve el cursor de reproducción (playhead) para mostrarle algo al usuario.',
    parameters: obj({ tiempo: num('Instante (s).') }, ['tiempo']),
  },
];

// ------------------------------------------------------------------ ejecución

type Args = Record<string, unknown>;

export interface ToolContext {
  aliases: Aliases;
  playhead: number;
  selected: Id[];
  seek: (t: number) => void;
}

export interface ToolOutcome {
  project: Project;
  /** Lo que se le devuelve al modelo. */
  result: Record<string, unknown>;
  /** Línea para mostrarle al usuario (vacía si no hubo cambio). */
  action?: string;
}

const numArg = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class ToolError extends Error {}

function clipRef(p: Project, ctx: ToolContext, alias: unknown) {
  const id = ctx.aliases.id(alias);
  const ref = id ? ops.findClip(p, id) : null;
  if (!ref) throw new ToolError(`No existe el clip "${String(alias)}". Usá ver_proyecto para ver los alias.`);
  if (ref.track.locked) throw new ToolError(`El clip ${String(alias)} está en una pista bloqueada.`);
  return ref;
}

function clipRefs(p: Project, ctx: ToolContext, list: unknown) {
  if (!Array.isArray(list) || !list.length) throw new ToolError('Falta la lista clip_ids.');
  return list.map((a) => clipRef(p, ctx, a));
}

/** Ejecuta una herramienta. Nunca lanza: los errores vuelven como resultado para que el modelo corrija. */
export function runTool(project: Project, name: string, args: Args, ctx: ToolContext): ToolOutcome {
  try {
    return run(project, name, args ?? {}, ctx);
  } catch (e) {
    return { project, result: { error: e instanceof Error ? e.message : String(e) } };
  }
}

function run(p: Project, name: string, args: Args, ctx: ToolContext): ToolOutcome {
  const a = ctx.aliases;
  switch (name) {
    case 'ver_proyecto':
      return { project: p, result: { estado: describeProject(p, a, ctx.playhead, ctx.selected) } };

    case 'dividir_clip': {
      const ref = clipRef(p, ctx, args['clip_id']);
      const t = numArg(args['tiempo']);
      if (t === undefined) throw new ToolError('Falta el tiempo.');
      const next = ops.splitClip(p, ref.clip.id, t);
      if (next === p) throw new ToolError(`El instante ${t} s no cae dentro del clip ${String(args['clip_id'])}.`);
      const track = next.tracks.find((tr) => tr.id === ref.track.id)!;
      const left = track.clips.find((c) => c.id === ref.clip.id)!;
      const right = track.clips.find((c) => Math.abs(c.start - clipEnd(left)) < 1e-6 && c.id !== left.id)!;
      return {
        project: next,
        result: { ok: true, parte_1: a.alias(left.id, 'c'), parte_2: a.alias(right.id, 'c') },
        action: `Cortó ${String(args['clip_id'])} en ${f2(t)} s`,
      };
    }

    case 'borrar_clips': {
      const refs = clipRefs(p, ctx, args['clip_ids']);
      const list = refs.map((r) => r.clip.id);
      const next = args['cerrar_huecos'] === true ? ops.rippleDelete(p, list) : ops.deleteClips(p, list);
      return { project: next, result: { ok: true, borrados: refs.length }, action: `Borró ${refs.length} clip(s)` };
    }

    case 'mover_clip': {
      const ref = clipRef(p, ctx, args['clip_id']);
      const start = numArg(args['inicio']);
      if (start === undefined) throw new ToolError('Falta el inicio.');
      const trackId = args['pista_id'] !== undefined ? a.id(args['pista_id']) : ref.track.id;
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track) throw new ToolError(`No existe la pista "${String(args['pista_id'])}".`);
      if ((track.kind === 'audio') !== (ref.track.kind === 'audio')) throw new ToolError('No se puede mover entre pistas de audio y de video.');
      return { project: ops.moveClip(p, ref.clip.id, track.id, start), result: { ok: true }, action: `Movió ${String(args['clip_id'])} a ${f2(start)} s` };
    }

    case 'recortar_clip': {
      const ref = clipRef(p, ctx, args['clip_id']);
      let next = p;
      const start = numArg(args['inicio']);
      const end = numArg(args['fin']);
      if (start === undefined && end === undefined) throw new ToolError('Indicá inicio y/o fin.');
      if (start !== undefined) next = ops.trimClip(next, ref.clip.id, 'start', start);
      if (end !== undefined) next = ops.trimClip(next, ref.clip.id, 'end', end);
      const c = ops.findClip(next, ref.clip.id)!.clip;
      return { project: next, result: { ok: true, inicio: f2(c.start), fin: f2(clipEnd(c)) }, action: `Recortó ${String(args['clip_id'])}` };
    }

    case 'poner_transicion': {
      const refs = clipRefs(p, ctx, args['clip_ids']);
      const tipo = args['tipo'];
      const edge = args['lado'] === 'salida' ? 'out' : 'in';
      const dur = clamp(numArg(args['duracion']) ?? 1, 0.1, 5);
      if (tipo !== 'ninguna' && !isTransitionType(tipo)) throw new ToolError(`Transición desconocida: ${String(tipo)}`);
      let next = p;
      for (const r of refs) {
        if (r.track.kind === 'audio' && tipo !== 'ninguna' && tipo !== 'fade') {
          next = ops.setTransition(next, r.clip.id, edge, { type: 'fade', duration: dur });
        } else {
          next = ops.setTransition(next, r.clip.id, edge, tipo === 'ninguna' ? null : { type: tipo, duration: dur });
        }
      }
      const label = tipo === 'ninguna' ? 'Quitó transiciones' : `Transición ${TRANSITION_LABELS[tipo]}`;
      return { project: next, result: { ok: true, clips: refs.length }, action: `${label} en ${refs.length} clip(s)` };
    }

    case 'poner_filtro': {
      const refs = clipRefs(p, ctx, args['clip_ids']);
      const tipo = args['tipo'];
      if (tipo !== 'ninguno' && !isFilterType(tipo)) throw new ToolError(`Filtro desconocido: ${String(tipo)}`);
      const amount = numArg(args['intensidad']);
      let next = p;
      for (const r of refs) {
        if (r.track.kind === 'audio') continue;
        const filter = tipo === 'ninguno' ? null : { ...makeFilter(tipo), ...(amount !== undefined ? { amount: clamp(amount, 0, 1) } : {}) };
        next = ops.setClipFilter(next, r.clip.id, filter);
      }
      const label = tipo === 'ninguno' ? 'Quitó filtros' : `Filtro ${FILTER_LABELS[tipo]}`;
      return { project: next, result: { ok: true }, action: `${label} en ${refs.length} clip(s)` };
    }

    case 'agregar_capa_filtro': {
      const tipo = args['tipo'];
      if (!isFilterType(tipo)) throw new ToolError(`Filtro desconocido: ${String(tipo)}`);
      const start = Math.max(0, numArg(args['inicio']) ?? ctx.playhead);
      const dur = Math.max(0.1, numArg(args['duracion']) ?? 5);
      const amount = numArg(args['intensidad']);
      const filter = { ...makeFilter(tipo), ...(amount !== undefined ? { amount: clamp(amount, 0, 1) } : {}) };
      const res = ops.addFilterClip(p, filter, start);
      const next = ops.trimClip(res.project, res.clip.id, 'end', start + dur);
      return {
        project: next,
        result: { ok: true, clip_id: a.alias(res.clip.id, 'c') },
        action: `Capa de filtro ${FILTER_LABELS[tipo]} (${f2(start)}–${f2(start + dur)} s)`,
      };
    }

    case 'agregar_efecto': {
      const tipo = args['tipo'];
      if (!isOverlayType(tipo)) throw new ToolError(`Efecto desconocido: ${String(tipo)}`);
      const start = Math.max(0, numArg(args['inicio']) ?? ctx.playhead);
      const dur = Math.max(0.1, numArg(args['duracion']) ?? 5);
      const res = ops.addOverlayClip(p, makeOverlay(tipo), start);
      const next = ops.trimClip(res.project, res.clip.id, 'end', start + dur);
      return { project: next, result: { ok: true, clip_id: a.alias(res.clip.id, 'c') }, action: `Efecto ${OVERLAY_LABELS[tipo]} en ${f2(start)} s` };
    }

    case 'agregar_texto': {
      const text = typeof args['texto'] === 'string' ? args['texto'].replace(/\\n/g, '\n') : '';
      if (!text.trim()) throw new ToolError('Falta el texto.');
      const preset = TEXT_PRESETS.find((x) => x.id === args['estilo']) ?? TEXT_PRESETS[0];
      const start = Math.max(0, numArg(args['inicio']) ?? ctx.playhead);
      const dur = Math.max(0.2, numArg(args['duracion']) ?? 4);
      const content = { ...makeText(preset), text };
      if (typeof args['color'] === 'string' && /^#[0-9a-f]{6}$/i.test(args['color'])) content.color = args['color'];
      const pos = args['posicion'];
      const y = pos === 'arriba' ? -0.35 : pos === 'abajo' ? 0.35 : pos === 'centro' ? 0 : (preset.y ?? 0);
      const res = ops.addTextClip(p, content, start, { x: preset.x ?? 0, y });
      const next = ops.trimClip(res.project, res.clip.id, 'end', start + dur);
      return { project: next, result: { ok: true, clip_id: a.alias(res.clip.id, 'c') }, action: `Texto "${text.slice(0, 30)}" en ${f2(start)} s` };
    }

    case 'editar_texto': {
      const ref = clipRef(p, ctx, args['clip_id']);
      if (!ref.clip.text) throw new ToolError('Ese clip no es de texto.');
      const patch: Record<string, unknown> = {};
      if (typeof args['texto'] === 'string') patch['text'] = args['texto'].replace(/\\n/g, '\n');
      if (typeof args['color'] === 'string' && /^#[0-9a-f]{6}$/i.test(args['color'])) patch['color'] = args['color'];
      const size = numArg(args['tamano']);
      if (size !== undefined) patch['fontSize'] = clamp(size, 10, 400);
      const isAnim = (v: unknown): v is TextAnimation => typeof v === 'string' && (TEXT_ANIMATIONS as readonly string[]).includes(v);
      if (isAnim(args['animacion_entrada'])) patch['animIn'] = args['animacion_entrada'];
      if (isAnim(args['animacion_salida'])) patch['animOut'] = args['animacion_salida'];
      return { project: ops.setClipText(p, ref.clip.id, patch), result: { ok: true }, action: `Editó el texto ${String(args['clip_id'])}` };
    }

    case 'ajustar_audio': {
      const refs = clipRefs(p, ctx, args['clip_ids']);
      const patch: ops.ClipAudioPatch = {};
      const vol = numArg(args['volumen']);
      if (vol !== undefined) patch.volume = clamp(vol, 0, 200) / 100;
      const fi = numArg(args['fundido_entrada']);
      if (fi !== undefined) patch.audioFadeIn = Math.max(0, fi);
      const fo = numArg(args['fundido_salida']);
      if (fo !== undefined) patch.audioFadeOut = Math.max(0, fo);
      if (typeof args['silenciar'] === 'boolean') patch.audioMuted = args['silenciar'] || undefined;
      let next = p;
      for (const r of refs) next = ops.setClipFields(next, r.clip.id, patch);
      return { project: next, result: { ok: true }, action: `Ajustó el audio de ${refs.length} clip(s)` };
    }

    case 'limpiar_audio': {
      const refs = clipRefs(p, ctx, args['clip_ids']);
      let next = p;
      for (const r of refs) {
        const fx: AudioFx = { ...r.clip.audioFx };
        const nr = numArg(args['reducir_ruido']);
        if (nr !== undefined) fx.denoise = clamp(nr, 0, 1) || undefined;
        for (const [arg, key] of [['viento', 'dewind'], ['zumbido', 'dehum'], ['siseo', 'dehiss']] as const) {
          if (typeof args[arg] === 'boolean') fx[key] = args[arg] || undefined;
        }
        const eq = EQ_PRESETS.find((x) => x.id === args['ecualizador']);
        if (eq) fx.eq = eq.id === 'flat' ? undefined : [...eq.gains];
        const pan = numArg(args['balance']);
        if (pan !== undefined) fx.pan = clamp(pan, -1, 1) || undefined;
        const clean = Object.fromEntries(Object.entries(fx).filter(([, v]) => v !== undefined)) as AudioFx;
        next = ops.setClipFields(next, r.clip.id, { audioFx: Object.keys(clean).length ? clean : undefined });
      }
      return { project: next, result: { ok: true }, action: `Limpieza de audio en ${refs.length} clip(s)` };
    }

    case 'cambiar_velocidad': {
      const refs = clipRefs(p, ctx, args['clip_ids']);
      const sp = clamp(numArg(args['velocidad']) ?? 1, 0.1, 16);
      let next = p;
      for (const r of refs) next = ops.setClipSpeed(next, r.clip.id, sp);
      return { project: next, result: { ok: true }, action: `Velocidad ${sp}x en ${refs.length} clip(s)` };
    }

    case 'ajustar_color': {
      const refs = clipRefs(p, ctx, args['clip_ids']);
      const v: Record<string, number> = {};
      const b = numArg(args['brillo']);
      if (b !== undefined) v['brightness'] = clamp(b, -100, 100) / 100;
      const c = numArg(args['contraste']);
      if (c !== undefined) v['contrast'] = clamp(c, 0, 200) / 100;
      const s = numArg(args['saturacion']);
      if (s !== undefined) v['saturation'] = clamp(s, 0, 200) / 100;
      const t = numArg(args['temperatura']);
      if (t !== undefined) v['temperature'] = clamp(t, -100, 100) / 100;
      let next = p;
      for (const r of refs) next = setClipProps(next, r.clip.id, v, 0);
      return { project: next, result: { ok: true }, action: `Ajustó el color de ${refs.length} clip(s)` };
    }

    case 'transformar': {
      const refs = clipRefs(p, ctx, args['clip_ids']);
      const v: Record<string, number> = {};
      const x = numArg(args['x']);
      if (x !== undefined) v['x'] = clamp(x, -100, 100) / 100;
      const y = numArg(args['y']);
      if (y !== undefined) v['y'] = clamp(y, -100, 100) / 100;
      const sc = numArg(args['escala']);
      if (sc !== undefined) v['scale'] = clamp(sc, 1, 400) / 100;
      const rot = numArg(args['rotacion']);
      if (rot !== undefined) v['rotation'] = clamp(rot, -180, 180);
      const op = numArg(args['opacidad']);
      if (op !== undefined) v['opacity'] = clamp(op, 0, 100) / 100;
      let next = p;
      for (const r of refs) {
        if (r.track.kind === 'audio') continue;
        next = setClipProps(next, r.clip.id, v, 0);
        const flips: ops.ClipAudioPatch = {};
        if (typeof args['espejar_horizontal'] === 'boolean') flips.flipH = args['espejar_horizontal'] || undefined;
        if (typeof args['espejar_vertical'] === 'boolean') flips.flipV = args['espejar_vertical'] || undefined;
        if (Object.keys(flips).length) next = ops.setClipFields(next, r.clip.id, flips);
      }
      return { project: next, result: { ok: true }, action: `Transformó ${refs.length} clip(s)` };
    }

    case 'agregar_marcador': {
      const t = numArg(args['tiempo']);
      if (t === undefined) throw new ToolError('Falta el tiempo.');
      return { project: ops.addMarker(p, Math.max(0, t)).project, result: { ok: true }, action: `Marcador en ${f2(t)} s` };
    }

    case 'mover_cursor': {
      const t = numArg(args['tiempo']);
      if (t === undefined) throw new ToolError('Falta el tiempo.');
      ctx.seek(Math.max(0, t));
      return { project: p, result: { ok: true } };
    }
  }
  throw new ToolError(`Herramienta desconocida: ${name}`);
}

