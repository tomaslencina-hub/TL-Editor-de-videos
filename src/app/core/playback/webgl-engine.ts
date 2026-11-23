import { inject, Injectable } from '@angular/core';
import type { MediaSource, Project, Track } from '../../../../shared/model';
import { TL_API } from '../ipc/tl-api';
import { MediaLibraryService } from '../media/media-library.service';
import { Compositor } from '../render/compositor';
import { planFrame, toTrackDraws, TransitionCache, type PlannedTrack } from '../render/scene';
import { findMedia } from '../timeline/timeline-ops';
import { composeTrack, type Layer } from './compose';
import type { PlaybackEngine, PlaybackSurface } from './playback-engine';

/** Tolerancia de desfase antes de forzar un seek mientras se reproduce. */
const DRIFT_TOLERANCE = 0.25;
/** Margen para no pedir el último instante exacto (algunos navegadores muestran negro). */
const END_MARGIN = 0.04;
/** Resolución máxima del canvas de vista previa (el resultado se escala con CSS). */
const MAX_PREVIEW_WIDTH = 1920;

interface Slot {
  el: HTMLMediaElement;
  clipId: string | null;
  /** Clip cuyo cuadro está en la textura de este slot. */
  textureClipId: string | null;
}

interface TrackOutput {
  kind: Track['kind'];
  slots: [Slot, Slot];
}

/**
 * Motor de vista previa: los <video>/<audio> (ocultos) son la fuente de cuadros y de sonido;
 * la imagen se compone con el mismo Compositor WebGL que usa la exportación, así lo que se ve
 * es lo que se exporta (transiciones, transformaciones, color, texto).
 */
@Injectable()
export class WebGLEngine implements PlaybackEngine {
  private readonly api = inject(TL_API);
  private readonly library = inject(MediaLibraryService);

  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private holder: HTMLDivElement | null = null;
  private compositor: Compositor | null = null;
  private readonly outputs = new Map<string, TrackOutput>();
  private readonly transitions = new TransitionCache();

  private last: { project: Project; time: number } | null = null;
  private redrawQueued = false;

  attach(surface: PlaybackSurface): void {
    this.container = surface.container;
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
    this.holder = document.createElement('div');
    // Los elementos multimedia quedan en el DOM pero invisibles (fuente de cuadros y audio).
    Object.assign(this.holder.style, { position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', opacity: '0', pointerEvents: 'none' });
    this.container.append(this.canvas, this.holder);
    this.compositor = new Compositor(this.canvas);
  }

  detach(): void {
    this.halt();
    for (const out of this.outputs.values()) out.slots.forEach((s) => this.destroy(s.el));
    this.outputs.clear();
    this.compositor?.dispose();
    this.canvas?.remove();
    this.holder?.remove();
    this.compositor = null;
    this.canvas = this.holder = this.container = null;
  }

  halt(): void {
    for (const out of this.outputs.values()) out.slots.forEach((s) => s.el.pause());
  }

  sync(project: Project, time: number, playing: boolean): void {
    if (!this.compositor) return;
    this.last = { project, time };
    this.reconcileOutputs(project);
    for (const track of project.tracks) {
      const out = this.outputs.get(track.id)!;
      const frame = composeTrack(track, this.transitions.get(track), time);
      this.syncTrack(project, track, out, frame.layers, frame.transition?.progress, frame.transition?.kind, time, playing);
    }
    this.draw(project, time);
  }

  // ------------------------------------------------------------------ dibujo

  private draw(project: Project, time: number): void {
    const comp = this.compositor!;
    const { width, height, backgroundColor } = project.settings;
    const scale = Math.min(1, MAX_PREVIEW_WIDTH / width);
    comp.setSize(Math.round(width * scale), Math.round(height * scale));
    const plan: PlannedTrack[] = planFrame(project, time, this.transitions);
    const draws = toTrackDraws(plan, time, (track, layer) => this.resolveLayer(track, layer));
    comp.render(backgroundColor, draws);
  }

  private resolveLayer(track: Track, layer: Layer): { texture: string; width: number; height: number } | null {
    const out = this.outputs.get(track.id);
    if (!out) return null;
    const index = out.slots.findIndex((s) => s.clipId === layer.clip.id);
    if (index < 0) return null;
    const slot = out.slots[index];
    const el = slot.el as HTMLVideoElement;
    const key = `${track.id}:${index}`;
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && el.videoWidth > 0) {
      this.compositor!.upload(key, el, el.videoWidth, el.videoHeight);
      slot.textureClipId = layer.clip.id;
    }
    // Mientras carga el cuadro nuevo se mantiene el anterior del mismo clip (evita parpadeos).
    if (slot.textureClipId !== layer.clip.id || !this.compositor!.hasTexture(key)) return null;
    return { texture: key, width: el.videoWidth || 16, height: el.videoHeight || 9 };
  }

  /** Redibuja cuando un <video> termina un seek o carga datos (scrubbing en pausa). */
  private queueRedraw = (): void => {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      if (this.last && this.compositor) this.draw(this.last.project, this.last.time);
    });
  };

  // ------------------------------------------------------------------ elementos multimedia

  private reconcileOutputs(project: Project): void {
    const ids = new Set(project.tracks.map((t) => t.id));
    for (const [id, out] of this.outputs) {
      if (!ids.has(id)) {
        out.slots.forEach((s) => this.destroy(s.el));
        this.outputs.delete(id);
      }
    }
    for (const track of project.tracks) {
      if (this.outputs.has(track.id)) continue;
      const make = (): Slot => ({ el: this.createElement(track.kind), clipId: null, textureClipId: null });
      this.outputs.set(track.id, { kind: track.kind, slots: [make(), make()] });
    }
  }

  private createElement(kind: Track['kind']): HTMLMediaElement {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    // Necesario para poder subir sus cuadros a WebGL (el protocolo media:// responde con CORS).
    el.crossOrigin = 'anonymous';
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.disablePictureInPicture = true;
      el.addEventListener('seeked', this.queueRedraw);
      el.addEventListener('loadeddata', this.queueRedraw);
    }
    this.holder!.appendChild(el);
    return el;
  }

  private destroy(el: HTMLMediaElement): void {
    el.pause();
    el.removeAttribute('src');
    el.load();
    el.remove();
  }

  private syncTrack(
    project: Project,
    track: Track,
    out: TrackOutput,
    layers: Layer[],
    progress: number | undefined,
    kind: 'cross' | 'in' | 'out' | undefined,
    time: number,
    playing: boolean,
  ): void {
    // Asigna capas a slots, reutilizando el slot que ya tiene ese clip cargado.
    const assignment = new Map<Slot, Layer>();
    const pending: Layer[] = [];
    for (const layer of layers) {
      const slot = out.slots.find((s) => s.clipId === layer.clip.id && !assignment.has(s));
      if (slot) assignment.set(slot, layer);
      else pending.push(layer);
    }
    for (const layer of pending) {
      const slot = out.slots.find((s) => !assignment.has(s));
      if (slot) assignment.set(slot, layer);
    }

    for (const slot of out.slots) {
      const layer = assignment.get(slot);
      const media = layer ? findMedia(project, layer.clip.sourceId) : undefined;
      if (!layer || !media) {
        if (!slot.el.paused) slot.el.pause();
        slot.clipId = null;
        continue;
      }
      // Fundido de volumen durante transiciones.
      let volume = 1;
      if (progress !== undefined && layer.role !== 'main') volume = layer.role === 'to' ? progress : 1 - progress;
      if (kind === undefined) volume = 1;
      this.syncSlot(slot, layer, media, time, playing, project.settings.fps);
      slot.el.muted = track.muted;
      slot.el.volume = Math.min(1, Math.max(0, volume));
    }
  }

  private syncSlot(slot: Slot, layer: Layer, media: MediaSource, time: number, playing: boolean, fps: number): void {
    const el = slot.el;
    const url = this.api.mediaUrl(this.library.playbackPath(media));
    if (el.dataset['src'] !== url) {
      el.dataset['src'] = url;
      el.src = url;
    }
    const clipChanged = slot.clipId !== layer.clip.id;
    slot.clipId = layer.clip.id;

    // Fuera del material disponible (extensión de una transición): se congela el primer/último cuadro.
    const maxLocal = Math.max(0, media.duration - END_MARGIN);
    const hold = layer.local < 0 || layer.local > maxLocal;
    const target = Math.min(maxLocal, Math.max(0, layer.local));
    const drift = Math.abs(el.currentTime - target);
    const precise = !playing || hold;
    const needsSeek = clipChanged || (precise ? drift > 1 / (fps * 2) : drift > DRIFT_TOLERANCE);
    if (needsSeek) el.currentTime = target;

    if (playing && !hold && el.paused) {
      el.play().catch(() => {
        /* interrumpido por un cambio de src o pausa: se reintenta en el próximo frame */
      });
    } else if ((!playing || hold) && !el.paused) {
      el.pause();
    }
  }
}
