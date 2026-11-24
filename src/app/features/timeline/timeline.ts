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
import { clipDuration, clipEnd, clipSpeed, initialClipDuration, sourceTime, type Clip, type Id, type MediaSource, type Track, type TrackKind } from '../../../../shared/model';
import {
  DEFAULT_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  resolveTransitions,
  TRANSITION_LABELS,
  TRANSITION_TYPES,
  type ResolvedTransition,
  type TransitionType,
} from '../../../../shared/transitions';
import { Commands } from '../../core/commands/command';
import { EditorActionsService } from '../../core/editor-actions.service';
import { MediaLibraryService } from '../../core/media/media-library.service';
import { PlaybackService } from '../../core/playback/playback.service';
import { ProjectStore } from '../../core/state/project-store';
import { collectSnapPoints, snap } from '../../core/timeline/snap';
import { roundToFrame } from '../../core/timeline/time';
import {
  adjacentClip,
  canRemoveTrack,
  clipFromMedia,
  findClip,
  findMedia,
  isCompatible,
  maxTransitionDuration,
  transitionTarget,
  trimLimits,
  type ClipEdge,
  type TrimEdge,
  type TrimLimits,
} from '../../core/timeline/timeline-ops';
import { AutofocusDirective } from '../../core/ui/autofocus.directive';
import { keyframeTimes } from '../../core/timeline/clip-props';
import { MEDIA_DRAG_TYPE, MediaDragService, TRANSITION_DRAG_TYPE } from '../../core/ui/media-drag.service';
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
  kind: 'media' | 'transition';
}

/** Marca visual de una transición en la timeline. */
interface TransitionBadge {
  key: string;
  start: number;
  end: number;
  kind: ResolvedTransition['kind'];
  type: TransitionType;
  target: { clipId: Id; edge: ClipEdge };
}

function badgeOf(t: ResolvedTransition): TransitionBadge {
  const target = t.kind === 'out' ? { clipId: t.from.id, edge: 'out' as const } : { clipId: t.to.id, edge: 'in' as const };
  return { key: `${target.clipId}:${target.edge}`, start: t.start, end: t.end, kind: t.kind, type: t.type, target };
}

@Component({
  selector: 'app-timeline',
  imports: [TimelineRuler, Waveform, AutofocusDirective],
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

  /** Pistas con sus clips (aplicando la previsualización del arrastre en curso) y sus transiciones. */
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
      // Durante un arrastre las transiciones se recalculan sobre la posición provisional.
      const badges = resolveTransitions(p ? { ...track, clips } : track).map(badgeOf);
      return { track, clips, badges, removable: canRemoveTrack(this.store.project(), track.id) };
    });
  });

  protected readonly hasSelection = computed(
    () => this.store.selectedClipId() !== null || this.store.selectedTransition() !== null,
  );

  // ---- Edición de nombre de pista ----
  protected readonly editingTrackId = signal<Id | null>(null);

  // ---- Transición seleccionada (inspector) ----
  protected readonly keyframeTimes = keyframeTimes;
  protected readonly transitionTypes = TRANSITION_TYPES;
  protected readonly transitionLabels = TRANSITION_LABELS;
  protected readonly selectedTransitionInfo = computed(() => {
    const sel = this.store.selectedTransition();
    if (!sel) return null;
    const project = this.store.project();
    const ref = findClip(project, sel.clipId);
    const transition = sel.edge === 'in' ? ref?.clip.transitionIn : ref?.clip.transitionOut;
    if (!ref || !transition) return null;
    const cross = sel.edge === 'in' && !!adjacentClip(ref.track, ref.clip, 'prev');
    return {
      ...sel,
      transition,
      max: maxTransitionDuration(project, sel.clipId, sel.edge),
      label: cross ? 'Transición (cruce)' : sel.edge === 'in' ? 'Transición (entrada)' : 'Transición (salida)',
    };
  });

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
    if (clip.text) return `T  ${clip.text.text.split('\n')[0] || 'Texto'}`;
    const name = this.mediaById().get(clip.sourceId)?.name ?? '¿medio desconocido?';
    const sp = clipSpeed(clip);
    return sp !== 1 ? `${name} · ${Math.round(sp * 100) / 100}×` : name;
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
    this.store.selectClip(null);
    this.store.selectTransition(null);
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
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      this.store.selectClip(clip.id, true);
      return;
    }
    this.store.selectClip(clip.id);
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
        ? { clipId: c.id, trackId: it.trackId, start: edge, inPoint: sourceTime(c, edge), outPoint: c.outPoint }
        : { clipId: c.id, trackId: it.trackId, start: c.start, inPoint: c.inPoint, outPoint: sourceTime(c, edge) };
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
      const edgeTime = it.edge === 'start' ? p.start : p.start + (p.outPoint - p.inPoint) / clipSpeed(it.clip);
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
    if (this.mediaDrag.transition() && e.dataTransfer?.types.includes(TRANSITION_DRAG_TYPE)) {
      this.onTransitionDragOver(e, track);
      return;
    }
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
      const s = snap([start, start + initialClipDuration(media)], points, SNAP_PX / this.view.pps());
      start += s.delta;
      snapped = s.point !== null;
      this.snapLine.set(s.point);
    }
    if (!snapped) start = roundToFrame(start, this.store.settings().fps);
    this.dropGhost.set({ trackId: track.id, start: Math.max(0, start), duration: initialClipDuration(media), kind: 'media' });
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
    const transitionType = e.dataTransfer?.getData(TRANSITION_DRAG_TYPE);
    if (transitionType) {
      e.preventDefault();
      const drop = this.transitionDrop(e, track);
      if (!drop) return;
      this.store.dispatch(
        Commands.setTransition(drop.target.clipId, drop.target.edge, {
          type: transitionType as TransitionType,
          duration: drop.duration,
        }),
      );
      this.store.selectTransition(drop.target);
      return;
    }
    const id = e.dataTransfer?.getData(MEDIA_DRAG_TYPE);
    if (!id || !ghost || ghost.trackId !== track.id) return;
    e.preventDefault();
    const media = findMedia(this.store.project(), id);
    if (!media) return;
    const clip = clipFromMedia(media, ghost.start);
    this.store.dispatch(Commands.insertClip(track.id, clip));
    this.store.selectClip(clip.id);
  }

  // ------------------------------------------------------------------ transiciones

  /** Borde de clip bajo el puntero: mitad izquierda = inicio, mitad derecha = final. */
  private transitionDrop(e: DragEvent, track: Track): { target: { clipId: Id; edge: ClipEdge }; duration: number; start: number; end: number } | null {
    if (track.locked) return null;
    const clipEl = (e.target as Element | null)?.closest<HTMLElement>('[data-clip-id]');
    const clipId = clipEl?.dataset['clipId'];
    if (!clipEl || !clipId) return null;
    const rect = clipEl.getBoundingClientRect();
    const edge: ClipEdge = e.clientX < rect.left + rect.width / 2 ? 'in' : 'out';
    const project = this.store.project();
    const target = transitionTarget(project, clipId, edge);
    if (!target) return null;
    const max = maxTransitionDuration(project, target.clipId, target.edge);
    const duration = Math.min(DEFAULT_TRANSITION_DURATION, max);
    if (duration < MIN_TRANSITION_DURATION) return null;
    const ref = findClip(project, target.clipId)!;
    const cross = target.edge === 'in' && !!adjacentClip(ref.track, ref.clip, 'prev');
    const [start, end] = cross
      ? [ref.clip.start - duration / 2, ref.clip.start + duration / 2]
      : target.edge === 'in'
        ? [ref.clip.start, ref.clip.start + duration]
        : [clipEnd(ref.clip) - duration, clipEnd(ref.clip)];
    return { target, duration, start, end };
  }

  private onTransitionDragOver(e: DragEvent, track: Track): void {
    const drop = this.transitionDrop(e, track);
    if (!drop) {
      this.dropGhost.set(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    this.dropGhost.set({ trackId: track.id, start: drop.start, duration: drop.end - drop.start, kind: 'transition' });
  }

  protected onBadgePointerDown(e: PointerEvent, badge: TransitionBadge): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.store.selectTransition(badge.target);
  }

  protected isBadgeSelected(badge: TransitionBadge): boolean {
    const sel = this.store.selectedTransition();
    return !!sel && sel.clipId === badge.target.clipId && sel.edge === badge.target.edge;
  }

  protected updateSelectedTransition(patch: { type?: string; duration?: number }): void {
    const info = this.selectedTransitionInfo();
    if (!info) return;
    const duration = patch.duration ?? info.transition.duration;
    if (!Number.isFinite(duration) || duration < MIN_TRANSITION_DURATION) return;
    this.store.dispatch(
      Commands.setTransition(info.clipId, info.edge, {
        type: (patch.type as TransitionType) ?? info.transition.type,
        duration: Math.min(duration, info.max),
      }),
    );
  }

  protected removeSelectedTransition(): void {
    const info = this.selectedTransitionInfo();
    if (info) this.store.dispatch(Commands.setTransition(info.clipId, info.edge, null));
  }

  // ------------------------------------------------------------------ pistas

  protected addTrack(kind: TrackKind): void {
    const before = new Set(this.store.project().tracks.map((t) => t.id));
    this.store.dispatch(Commands.addTrack(kind));
    // La pista nueva queda lista para renombrar.
    const created = this.store.project().tracks.find((t) => !before.has(t.id));
    if (created) this.editingTrackId.set(created.id);
  }

  protected removeTrack(track: Track): void {
    if (!canRemoveTrack(this.store.project(), track.id)) return;
    if (track.clips.length && !confirm(`La pista "${track.name}" tiene ${track.clips.length} clip(s). ¿Quitarla igual?`)) return;
    this.store.dispatch(Commands.removeTrack(track.id));
  }

  protected commitRename(track: Track, value: string): void {
    if (this.editingTrackId() !== track.id) return;
    this.editingTrackId.set(null);
    const name = value.trim();
    if (name && name !== track.name) this.store.dispatch(Commands.renameTrack(track.id, name));
  }

  protected isSelected(clipId: Id): boolean {
    return this.store.selectedClipIds().includes(clipId);
  }

  protected moveTrack(track: Track, direction: -1 | 1): void {
    this.store.dispatch(Commands.moveTrack(track.id, direction));
  }

  /** Puede subir/bajar sin cruzarse con pistas del otro tipo. */
  protected canMove(track: Track, direction: -1 | 1): boolean {
    const tracks = this.store.project().tracks;
    const j = tracks.findIndex((t) => t.id === track.id) + direction;
    return j >= 0 && j < tracks.length && tracks[j].kind === track.kind;
  }

  protected readonly markers = computed(() => this.store.project().markers ?? []);

  protected onMarkerPointerDown(e: PointerEvent, time: number): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.playback.pause();
    this.playback.seek(time);
  }

  protected removeMarker(e: MouseEvent, id: Id): void {
    e.preventDefault();
    e.stopPropagation();
    this.store.dispatch(Commands.removeMarker(id));
  }

  protected toggleMute(track: Track): void {
    this.store.dispatch(Commands.updateTrack(track.id, { muted: !track.muted }));
  }

  protected toggleLock(track: Track): void {
    this.store.dispatch(Commands.updateTrack(track.id, { locked: !track.locked }));
  }
}
