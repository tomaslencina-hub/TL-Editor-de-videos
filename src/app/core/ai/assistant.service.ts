import { inject, Injectable, signal } from '@angular/core';
import type { AiStatus } from '../../../../shared/ipc-contract';
import { TL_API } from '../ipc/tl-api';
import { PlaybackService } from '../playback/playback.service';
import { ProjectStore } from '../state/project-store';
import { Aliases, describeProject, runTool, TOOL_DECLARATIONS } from './assistant-tools';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
  /** Cambios que hizo en este turno (para mostrar). */
  actions?: string[];
  /** Etiqueta del paso del historial que creó (para "Deshacer"). */
  undoLabel?: string;
}

/** Partes de un mensaje de la API de Gemini (se reenvían tal cual, con sus firmas de pensamiento). */
interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  [k: string]: unknown;
}
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

const MAX_STEPS = 16;
/** Turnos de usuario que se conservan en la conversación enviada (los viejos se descartan). */
const MAX_TURNS = 8;

const SYSTEM = `Sos el asistente de SHOTON, un editor de video de escritorio. Respondés en español rioplatense, breve y claro.
Podés editar el proyecto del usuario con las herramientas. Reglas:
- Los tiempos son segundos en la timeline. Los clips, pistas y medios se identifican con alias (c1, t2, m3) que aparecen en el estado del proyecto. Usá solo alias que existan.
- "Entre todos los clips" = transición de entrada en cada clip que tenga otro clip pegado antes en la misma pista.
- Para aplicar un look a todo el video, preferí agregar_capa_filtro desde 0 hasta el final; para un clip puntual, poner_filtro.
- Después de cortar, mover o borrar, los alias de los clips nuevos los devuelve la herramienta; si dudás, llamá a ver_proyecto.
- Hacé todo lo que pide en este turno (podés llamar varias herramientas) y al final contá en una o dos frases qué hiciste.
- Todos tus cambios se aplican juntos y el usuario los puede deshacer con un botón o Ctrl+Z.
- No podés importar archivos, transcribir audio, exportar ni ver las imágenes del video: si te lo piden, explicá cómo hacerlo en la app (Medios → Importar, botón Subtítulos de la timeline, botón Exportar).
- Si el pedido es ambiguo, preguntá antes de hacer cambios grandes.`;

/**
 * Asistente de IA (Gemini). Mantiene la conversación, ejecuta las herramientas sobre un borrador
 * del proyecto y al terminar el turno lo confirma como un único paso del historial.
 */
@Injectable({ providedIn: 'root' })
export class AssistantService {
  private readonly api = inject(TL_API);
  private readonly store = inject(ProjectStore);
  private readonly playback = inject(PlaybackService);

  readonly status = signal<AiStatus | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly busy = signal(false);
  /** Paso actual mientras trabaja ("Pensando…", "Poniendo transiciones…"). */
  readonly progress = signal('');

  private history: Content[] = [];
  private aliases = new Aliases();
  private loadCount = -1;

  async refreshStatus(): Promise<void> {
    try {
      this.status.set(await this.api.aiStatus());
    } catch {
      this.status.set({ hasKey: false, model: null });
    }
  }

  async setKey(key: string | null): Promise<void> {
    this.status.set(await this.api.aiSetKey(key));
  }

  clear(): void {
    this.history = [];
    this.aliases = new Aliases();
    this.messages.set([]);
  }

  async send(text: string): Promise<void> {
    const pedido = text.trim();
    if (!pedido || this.busy()) return;
    // Un proyecto nuevo o abierto empieza una conversación nueva (los alias no sirven más).
    const base = this.store.project();
    if (this.loadCount !== -1 && this.loadCount !== this.store.loadCount()) this.clear();
    this.loadCount = this.store.loadCount();

    this.messages.update((m) => [...m, { role: 'user', text: pedido }]);
    this.busy.set(true);
    this.progress.set('Pensando…');

    let draft = base;
    const actions: string[] = [];
    const playhead = this.playback.currentTime();
    const selected = this.store.selectedClipIds();
    const ctx = {
      aliases: this.aliases,
      playhead,
      selected,
      seek: (t: number) => {
        this.playback.pause();
        this.playback.seek(t);
      },
    };

    this.history.push({ role: 'user', parts: [{ text: pedido }] });
    this.trimHistory();
    // El estado del proyecto va solo en el último mensaje del usuario (no se acumula en el historial).
    const state = describeProject(base, this.aliases, playhead, selected);

    try {
      let reply = '';
      for (let step = 0; step < MAX_STEPS; step++) {
        const contents = this.history.map((c, i) =>
          i === this.lastUserIndex() ? { role: c.role, parts: [{ text: `Estado actual del proyecto:\n${state}\n\nPedido: ${pedido}` }] } : c,
        );
        const res = (await this.api.aiGenerate({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          generationConfig: { temperature: 0.3 },
        })) as { candidates?: { content?: Content; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };

        const content = res.candidates?.[0]?.content;
        if (!content?.parts?.length) {
          const why = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason ?? 'sin respuesta';
          throw new Error(`Gemini no respondió (${why}).`);
        }
        this.history.push({ role: 'model', parts: content.parts });

        const calls = content.parts.filter((p) => p.functionCall);
        reply = content.parts
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join('')
          .trim();
        if (!calls.length) break;

        const responses: Part[] = [];
        for (const part of calls) {
          const call = part.functionCall!;
          this.progress.set(`Ejecutando ${call.name.replace(/_/g, ' ')}…`);
          const out = runTool(draft, call.name, call.args ?? {}, ctx);
          draft = out.project;
          if (out.action) actions.push(out.action);
          responses.push({ functionResponse: { name: call.name, response: out.result } });
        }
        this.history.push({ role: 'user', parts: responses });
        this.progress.set('Pensando…');
      }

      let undoLabel: string | undefined;
      if (draft !== base) {
        undoLabel = `Asistente: ${pedido.length > 40 ? `${pedido.slice(0, 40)}…` : pedido}`;
        const result = draft;
        this.store.dispatch({ label: undoLabel, apply: () => result });
      }
      this.messages.update((m) => [
        ...m,
        { role: 'assistant', text: reply || (actions.length ? 'Listo.' : 'No hice cambios.'), actions, undoLabel },
      ]);
    } catch (e) {
      // El turno fallido se saca del historial para que el próximo pedido empiece limpio.
      this.history.splice(this.lastUserTextIndex());
      this.messages.update((m) => [...m, { role: 'error', text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) }]);
    } finally {
      this.busy.set(false);
      this.progress.set('');
    }
  }

  /** Deshace el paso del asistente si sigue siendo el último del historial. */
  undo(msg: ChatMessage): boolean {
    if (!msg.undoLabel || this.store.undoLabel() !== msg.undoLabel) return false;
    this.store.undo();
    this.messages.update((m) => m.map((x) => (x === msg ? { ...x, undoLabel: undefined, actions: [...(x.actions ?? []), '(deshecho)'] } : x)));
    return true;
  }

  canUndo(msg: ChatMessage): boolean {
    return !!msg.undoLabel && this.store.undoLabel() === msg.undoLabel;
  }

  /** Índice del último mensaje de texto del usuario (el pedido actual). */
  private lastUserTextIndex(): number {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const c = this.history[i];
      if (c.role === 'user' && c.parts.some((p) => typeof p.text === 'string')) return i;
    }
    return 0;
  }

  private lastUserIndex(): number {
    return this.lastUserTextIndex();
  }

  /** Conserva los últimos turnos completos (cortando siempre en un mensaje de texto del usuario). */
  private trimHistory(): void {
    const starts = this.history.map((c, i) => (c.role === 'user' && c.parts.some((p) => typeof p.text === 'string') ? i : -1)).filter((i) => i >= 0);
    if (starts.length > MAX_TURNS) this.history = this.history.slice(starts[starts.length - MAX_TURNS]);
  }
}
