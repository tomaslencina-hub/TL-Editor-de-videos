import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  OnDestroy,
  signal,
  untracked,
  viewChild,
  type AfterViewInit,
} from '@angular/core';
import { clipDuration, clipEnd, type Clip, type Id, type MediaSource, type Track } from '../../../../shared/model';
import { Commands } from '../../core/commands/command';
import { EditorActionsService } from '../../core/editor-actions.service';
import { MediaLibraryService } from '../../core/media/media-library.service';
import { PlaybackService } from '../../core/playback/playback.service';
import { ProjectStore } from '../../core/state/project-store';
import { collectSnapPoints, snap } from '../../core/timeline/snap';
import { roundToFrame } from '../../core/timeline/time';
import { clipFromMedia, findClip, findMedia, isCompatible, trimLimits, type TrimEdge, type TrimLimits } from '../../core/timeline/timeline-ops';
import { MEDIA_DRAG_TYPE, MediaDragService } from '../../core/ui/media-drag.service';
import { TimelineRuler } from './ruler';
import { MAX_PPS, MIN_PPS, TimelineViewService } from './timeline-view.service';
import { Waveform } from './waveform';

const SNAP_PX = 8;
const DRAG_THRESHOLD_PX = 3;
const RULER_HEIGHT = 28;
const TRACK_HEIGHT = { video: 72, audio: 56 } as const;

/** Versión "en vivo" de un clip mientras se arrastra/recorta (no se confirma hasta soltar). */
interface ClipPreview {
  clipId: Id;
  trackId: Id;
  start: number;
  inPoint: number;
  outPoint: number;
}

type Interaction =
  | { kind: 'move'; clip: Clip; trackId: Id; trackKind: Track['kind']; grabOffset: number; startX: number; moved: boolean }
  | { kind: 'trim'; clip: Clip; trackId: Id; edge: TrimEdge; limits: TrimLimits }
  | { kind: 'scrub' };

interface DropGhost {
  trackId: Id;
  start: number;
  duration: number;
}

@Component({
  selector: 'app-timeline',
  imports: [TimelineRuler, Waveform],
  templateUrl: './timeline.html',
  styleUrl: './timeline.scss',
})
export class Timeline implements AfterViewInit, OnDestroy {
  protected readonly store = inject(ProjectStore);
  protected readonly view = inject(TimelineViewService);
  protected readonly playback = inject(PlaybackService);
  protected readonly library = inject(MediaLibraryService);
  protected readonly actions = inject(EditorActionsService);
  private readonly mediaDrag = inject(MediaDragService);
  private readonly injector = inject(Injector);

  private readonly scroll = viewChild.required<ElementRef<HTMLDivElement>>('scroll');

  protected readonly RULER_HEIGHT = RULER_HEIGHT;
  protected readonly TRACK_HEIGHT = TRACK_HEIGHT;
  protected readonly MIN_PPS = MIN_PPS;
  protected readonly MAX_PPS = MAX_PPS;

  protected readonly scrollLeft = signal(0);
  protected readonly scrollTop = signal(0);
  protected readonly viewportWidth = signal(800);
  protected readonly preview = signal<ClipPreview | null>(null);
  protected readonly snapLine = signal<number | null>(null);
  protected readonly dropGhost = signal<DropGhost | null>(null);

  private interaction: Interaction | null = null;
  private resizeObserver?: ResizeObserver;

  protected readonly mediaById = computed(() => new Map(this.store.project().media.map((m) => [m.id, m])));

  protected readonly contentWidth = computed(() => {
    const pps = this.view.pps();
    return Math.max(this.viewportWidth(), (this.store.duration() + 30) * pps);
  });

  protected readonly playheadX = computed(() => this.playback.currentTime() * this.view.pps());

  /** Pistas con sus clips, aplicando la previsualización del arrastre en curso. */
  protected readonly rows = computed(() => {
    const p = this.preview();
    return this.store.project().tracks.map((track) => {
      let clips = track.clips;
      if (p) {
        clips = clips.filter((c) => c.id !== p.clipId);
        if (p.trackId === track.id) {
          const original = findClip(this.store.project(), p.clipId)?.clip;
          if (original) clips = [...clips, { ...original, start: p.start, inPoint: p.inPoint, outPoint: p.outPoint }];
        }
      }
      return { track, clips };
    });
  });

  protected readonly hasSelection = computed(() => this.store.selectedClipId() !== null);

  constructor() {
    // Durante la reproducción, la vista sigue al playhead.
    effect(() => {
      const x = this.playheadX();
      if (!this.playback.playing()) return;
      untracked(() => {
        const el = this.scroll().nativeElement;
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) {
          el.scrollLeft = Math.max(0, x - 40);
        }
      });
    });
  }

  ngAfterViewInit(): void {
    const el = this.scroll().nativeElement;
    this.resizeObserver = new ResizeObserver(() => this.viewportWidth.set(el.clientWidth));
    this.resizeObserver.observe(el);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  // ------------------------------------------------------------------ helpers

  protected clipStyleWidth(clip: Clip): number {
    return Math.max(2, clipDuration(clip) * this.view.pps());
  }

  protected clipName(clip: Clip): string {
    return this.mediaById().get(clip.sourceId)?.name ?? '¿medio desconocido?';
  }

  protected media(clip: Clip): MediaSource | undefined {
    return this.mediaById().get(clip.sourceId);
  }

  /** Tiempo de timeline bajo una coordenada X de pantalla. */
  private timeAt(clientX: number): number {
    const el = this.scroll().nativeElement;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft) / this.view.pps());
  }

  private snapEnabled(e: { altKey: boolean }): boolean {
    // Alt desactiva temporalmente el imantado.
    return this.view.snapEnabled() && !e.altKey;
  }

  private trackUnderPointer(e: PointerEvent): Track | undefined {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-track-id]');
    const id = el?.dataset['trackId'];
    return id ? this.store.project().tracks.find((t) => t.id === id) : undefined;
  }

  // ------------------------------------------------------------------ scroll / zoom

  protected onScroll(): void {
    const el = this.scroll().nativeElement;
    this.scrollLeft.set(el.scrollLeft);
    this.scrollTop.set(el.scrollTop);
  }

  protected onWheel(e: WheelEvent): void {
    const el = this.scroll().nativeElement;
    if (e.ctrlKey) {
      e.preventDefault();
      this.zoomAround(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX);
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }

  /** Zoom manteniendo fijo el instante bajo el cursor (o el playhead si no hay cursor). */
  protected zoomAround(factor: number, clientX?: number): void {
    const el = this.scroll().nativeElement;
    const rect = el.getBoundingClientRect();
    const anchorX = clientX ?? rect.left + Math.min(el.clientWidth / 2, this.playheadX() - el.scrollLeft);
    const t = this.timeAt(anchorX);
    this.view.zoomBy(factor);
    this.applyScrollAfterRender(t * this.view.pps() - (anchorX - rect.left));
  }

  protected setZoom(value: number): void {
    const el = this.scroll().nativeElement;
    const t = this.playback.currentTime();
    const offset = t * this.view.pps() - el.scrollLeft;
    this.view.setPps(value);
    this.applyScrollAfterRender(t * this.view.pps() - offset);
  }

  protected zoomToFit(): void {
    const duration = this.store.duration();
    if (duration <= 0) return;
    this.view.setPps((this.viewportWidth() - 40) / duration);
    this.applyScrollAfterRender(0);
  }

  private applyScrollAfterRender(scrollLeft: number): void {
    afterNextRender(
      { write: () => (this.scroll().nativeElement.scrollLeft = Math.max(0, scrollLeft)) },
      { injector: this.injector },
    );
  }

  // ------------------------------------------------------------------ pointer: scrub

  protected onRulerPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.beginCapture(e);
    this.interaction = { kind: 'scrub' };
    this.playback.seek(this.scrubTime(e));
  }

  protected onTrackPointerDown(e: PointerEvent): void {
    // Clic en zona vacía de una pista: deselecciona y mueve el playhead.
    if (e.button !== 0) return;
    this.store.selectedClipId.set(null);
    this.beginCapture(e);
    this.interaction = { kind: 'scrub' };
    this.playback.seek(this.scrubTime(e));
  }

  private scrubTime(e: PointerEvent): number {
    let t = this.timeAt(e.clientX);
    if (this.snapEnabled(e)) {
      const points = collectSnapPoints(this.store.project(), -1);
      const s = snap([t], points, SNAP_PX / this.view.pps());
      t += s.delta;
    }
    return roundToFrame(t, this.store.settings().fps);
  }

  // ------------------------------------------------------------------ pointer: clips

  protected onClipPointerDown(e: PointerEvent, clip: Clip, track: Track, mode: 'move' | TrimEdge): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.store.selectedClipId.set(clip.id);
    if (track.locked) return;
    this.beginCapture(e);

    if (mode === 'move') {
      this.interaction = {
        kind: 'move',
        clip,
        trackId: track.id,
        trackKind: track.kind,
        grabOffset: this.timeAt(e.clientX) - clip.start,
        startX: e.clientX,
        moved: false,
      };
    } else {
      const limits = trimLimits(this.store.project(), clip.id, mode);
      if (!limits) return;
      this.interaction = { kind: 'trim', clip, trackId: track.id, edge: mode, limits };
    }
  }

  protected onPointerMove(e: PointerEvent): void {
    const it = this.interaction;
    if (!it) return;
    const fps = this.store.settings().fps;
    const pps = this.view.pps();
    const project = this.store.project();
    const playhead = this.playback.currentTime();

    if (it.kind === 'scrub') {
      this.playback.seek(this.scrubTime(e));
      return;
    }

    if (it.kind === 'move') {
      if (!it.moved && Math.abs(e.clientX - it.startX) < DRAG_THRESHOLD_PX) return;
      it.moved = true;
      const dur = clipDuration(it.clip);
      let start = Math.max(0, this.timeAt(e.clientX) - it.grabOffset);
      let snapPoint: number | null = null;
      if (this.snapEnabled(e)) {
        const s = snap([start, start + dur], collectSnapPoints(project, playhead, [it.clip.id]), SNAP_PX / pps);
        start += s.delta;
        snapPoint = s.point;
      }
      if (snapPoint === null) start = roundToFrame(start, fps);
      start = Math.max(0, start);

      const over = this.trackUnderPointer(e);
      const trackId = over && over.kind === it.trackKind && !over.locked ? over.id : it.trackId;
      this.snapLine.set(snapPoint);
      this.preview.set({ clipId: it.clip.id, trackId, start, inPoint: it.clip.inPoint, outPoint: it.clip.outPoint });
      return;
    }

    // trim
    let edge = this.timeAt(e.clientX);
    let snapPoint: number | null = null;
    if (this.snapEnabled(e)) {
      const s = snap([edge], collectSnapPoints(project, playhead, [it.clip.id]), SNAP_PX / pps);
      edge += s.delta;
      snapPoint = s.point;
    }
    if (snapPoint === null) edge = roundToFrame(edge, fps);
    edge = Math.min(it.limits.max, Math.max(it.limits.min, edge));
    const c = it.clip;
    const p: ClipPreview =
      it.edge === 'start'
        ? { clipId: c.id, trackId: it.trackId, start: edge, inPoint: c.inPoint + (edge - c.start), outPoint: c.outPoint }
        : { clipId: c.id, trackId: it.trackId, start: c.start, inPoint: c.inPoint, outPoint: c.inPoint + (edge - c.start) };
    this.snapLine.set(snapPoint !== null && Math.abs(snapPoint - edge) < 1e-6 ? snapPoint : null);
    this.preview.set(p);
  }

  protected onPointerUp(e: PointerEvent): void {
    const it = this.interaction;
    const p = this.preview();
    this.interaction = null;
    this.preview.set(null);
    this.snapLine.set(null);
    this.scroll().nativeElement.releasePointerCapture?.(e.pointerId);
    if (!it || !p) return;

    if (it.kind === 'move' && it.moved) {
      if (p.start !== it.clip.start || p.trackId !== it.trackId) {
        this.store.dispatch(Commands.moveClip(it.clip.id, p.trackId, p.start));
      }
    } else if (it.kind === 'trim') {
      const edgeTime = it.edge === 'start' ? p.start : p.start + (p.outPoint - p.inPoint);
      const original = it.edge === 'start' ? it.clip.start : clipEnd(it.clip);
      if (Math.abs(edgeTime - original) > 1e-9) {
        this.store.dispatch(Commands.trimClip(it.clip.id, it.edge, edgeTime));
      }
    }
  }

  private beginCapture(e: PointerEvent): void {
    this.scroll().nativeElement.setPointerCapture(e.pointerId);
  }

  // ------------------------------------------------------------------ drop desde el panel de medios

  protected onTrackDragOver(e: DragEvent, track: Track): void {
    const media = this.mediaDrag.current();
    if (!media || !e.dataTransfer?.types.includes(MEDIA_DRAG_TYPE)) return;
    if (track.locked || !isCompatible(media, track)) {
      this.dropGhost.set(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    let start = this.timeAt(e.clientX);
    let snapped = false;
    if (this.snapEnabled(e)) {
      const points = collectSnapPoints(this.store.project(), this.playback.currentTime());
      const s = snap([start, start + media.duration], points, SNAP_PX / this.view.pps());
      start += s.delta;
      snapped = s.point !== null;
      this.snapLine.set(s.point);
    }
    if (!snapped) start = roundToFrame(start, this.store.settings().fps);
    this.dropGhost.set({ trackId: track.id, start: Math.max(0, start), duration: media.duration });
  }

  protected onTrackDragLeave(e: DragEvent): void {
    const related = e.relatedTarget as Node | null;
    if (related && (e.currentTarget as HTMLElement).contains(related)) return;
    this.dropGhost.set(null);
    this.snapLine.set(null);
  }

  protected onTrackDrop(e: DragEvent, track: Track): void {
    const ghost = this.dropGhost();
    this.dropGhost.set(null);
    this.snapLine.set(null);
    const id = e.dataTransfer?.getData(MEDIA_DRAG_TYPE);
    if (!id || !ghost || ghost.trackId !== track.id) return;
    e.preventDefault();
    const media = findMedia(this.store.project(), id);
    if (!media) return;
    const clip = clipFromMedia(media, ghost.start);
    this.store.dispatch(Commands.insertClip(track.id, clip));
    this.store.selectedClipId.set(clip.id);
  }

  // ------------------------------------------------------------------ pistas

  protected toggleMute(track: Track): void {
    this.store.dispatch(Commands.updateTrack(track.id, { muted: !track.muted }));
  }

  protected toggleLock(track: Track): void {
    this.store.dispatch(Commands.updateTrack(track.id, { locked: !track.locked }));
  }
}
