import { inject, Injectable } from '@angular/core';
import type { MediaSource, Project, Track } from '../../../../shared/model';
import { resolveTransitions, type ResolvedTransition } from '../../../../shared/transitions';
import { TL_API } from '../ipc/tl-api';
import { findMedia } from '../timeline/timeline-ops';
import { composeTrack, type Layer, type TrackFrame } from './compose';
import type { PlaybackEngine, PlaybackSurface } from './playback-engine';
import { BASE_LAYER_STYLE, edgeStyles, transitionStyles, type LayerStyle } from './transition-styles';

/** Tolerancia de desfase antes de forzar un seek mientras se reproduce. */
const DRIFT_TOLERANCE = 0.25;
/** Margen para no pedir el último instante exacto (algunos navegadores muestran negro). */
const END_MARGIN = 0.04;

interface Slot {
  el: HTMLMediaElement;
  clipId: string | null;
}

interface TrackOutput {
  kind: Track['kind'];
  slots: [Slot, Slot];
}

/**
 * Motor HTML: por cada pista, dos elementos <video>/<audio> (clip saliente y entrante durante una
 * transición cruzada). Los videos se apilan dentro del contenedor según el orden de las pistas
 * y las transiciones se emulan con CSS (ver transition-styles.ts). El audio de todas las pistas
 * se reproduce en paralelo, con fundidos de volumen durante las transiciones.
 *
 * Limitaciones: pequeños cortes al cambiar de archivo (sin precarga), sincronía aproximada (±250 ms)
 * y algunas transiciones (fundido a negro, zoom) son aproximaciones de las de FFmpeg.
 */
@Injectable()
export class HtmlMediaEngine implements PlaybackEngine {
  private readonly api = inject(TL_API);
  private container: HTMLElement | null = null;
  private readonly outputs = new Map<string, TrackOutput>();
  /** Las pistas son inmutables: se cachean sus transiciones resueltas por referencia. */
  private readonly transitionCache = new WeakMap<Track, ResolvedTransition[]>();

  attach(surface: PlaybackSurface): void {
    this.container = surface.container;
  }

  detach(): void {
    this.halt();
    for (const out of this.outputs.values()) out.slots.forEach((s) => this.destroy(s.el));
    this.outputs.clear();
    this.container = null;
  }

  halt(): void {
    for (const out of this.outputs.values()) out.slots.forEach((s) => s.el.pause());
  }

  sync(project: Project, time: number, playing: boolean): void {
    if (!this.container) return;
    this.reconcileOutputs(project);

    const videoTracks = project.tracks.filter((t) => t.kind === 'video');
    for (const track of project.tracks) {
      const out = this.outputs.get(track.id)!;
      let transitions = this.transitionCache.get(track);
      if (!transitions) {
        transitions = resolveTransitions(track);
        this.transitionCache.set(track, transitions);
      }
      const frame = composeTrack(track, transitions, time);
      // Pistas de arriba con z-index mayor.
      const zBase = (videoTracks.length - videoTracks.indexOf(track)) * 10;
      this.renderTrack(project, track, out, frame, time, playing, zBase);
    }
  }

  // ------------------------------------------------------------------ internos

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
      const make = (): Slot => ({ el: this.createElement(track.kind), clipId: null });
      this.outputs.set(track.id, { kind: track.kind, slots: [make(), make()] });
    }
  }

  private createElement(kind: Track['kind']): HTMLMediaElement {
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'auto';
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.disablePictureInPicture = true;
      Object.assign(el.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        visibility: 'hidden',
        transformOrigin: '50% 50%',
      });
      this.container!.appendChild(el);
    }
    return el;
  }

  private destroy(el: HTMLMediaElement): void {
    el.pause();
    el.removeAttribute('src');
    el.load();
    el.remove();
  }

  private renderTrack(
    project: Project,
    track: Track,
    out: TrackOutput,
    frame: TrackFrame,
    time: number,
    playing: boolean,
    zBase: number,
  ): void {
    // Asigna capas a slots, reutilizando el slot que ya tiene ese clip cargado.
    const assignment = new Map<Slot, Layer>();
    const pending: Layer[] = [];
    for (const layer of frame.layers) {
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
        if (slot.el instanceof HTMLVideoElement) slot.el.style.visibility = 'hidden';
        continue;
      }
      const { style, volume } = this.layerLook(frame, layer);
      this.syncSlot(slot, layer, media, time, playing, project.settings.fps);
      slot.el.muted = track.muted;
      slot.el.volume = Math.min(1, Math.max(0, volume));
      if (slot.el instanceof HTMLVideoElement) {
        const s = slot.el.style;
        s.visibility = media.hasVideo ? 'visible' : 'hidden';
        // Letterbox opaco con el color de fondo, igual que en la exportación.
        s.backgroundColor = project.settings.backgroundColor;
        s.zIndex = String(zBase + style.order);
        s.opacity = String(style.opacity);
        s.transform = style.transform;
        s.clipPath = style.clipPath;
        s.filter = style.filter;
        s.maskImage = style.maskImage;
      }
    }
  }

  private layerLook(frame: TrackFrame, layer: Layer): { style: LayerStyle; volume: number } {
    const tr = frame.transition;
    if (!tr || layer.role === 'main') return { style: BASE_LAYER_STYLE, volume: 1 };
    const p = tr.progress;
    const volume = layer.role === 'to' ? p : 1 - p;
    const style =
      tr.kind === 'cross' ? transitionStyles(tr.type, p)[layer.role] : edgeStyles(tr.type, p, layer.role);
    return { style, volume };
  }

  private syncSlot(slot: Slot, layer: Layer, media: MediaSource, time: number, playing: boolean, fps: number): void {
    const el = slot.el;
    const url = this.api.mediaUrl(media.path);
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
