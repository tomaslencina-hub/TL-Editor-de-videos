import {
  Component,
  computed,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
  type AfterViewInit,
} from '@angular/core';
import { PlaybackService } from '../../core/playback/playback.service';
import { ProjectStore } from '../../core/state/project-store';
import { formatTimecode } from '../../core/timeline/time';

@Component({
  selector: 'app-preview',
  templateUrl: './preview.html',
  styleUrl: './preview.scss',
})
export class Preview implements AfterViewInit, OnDestroy {
  protected readonly store = inject(ProjectStore);
  protected readonly playback = inject(PlaybackService);

  private readonly stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly audio = viewChild.required<ElementRef<HTMLAudioElement>>('audio');

  private readonly stageSize = signal({ w: 0, h: 0 });
  private resizeObserver?: ResizeObserver;

  /** Tamaño del cuadro del proyecto encajado en el área disponible. */
  protected readonly frameSize = computed(() => {
    const { w, h } = this.stageSize();
    const s = this.store.settings();
    const scale = Math.min(w / s.width, h / s.height);
    return { w: Math.max(0, Math.floor(s.width * scale)), h: Math.max(0, Math.floor(s.height * scale)) };
  });
  protected readonly timecode = computed(() => formatTimecode(this.playback.currentTime(), this.store.settings().fps));
  protected readonly durationCode = computed(() => formatTimecode(this.store.duration(), this.store.settings().fps));

  ngAfterViewInit(): void {
    const stage = this.stage().nativeElement;
    this.resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      this.stageSize.set({ w: width, h: height });
    });
    this.resizeObserver.observe(stage);
    this.playback.attach({ video: this.video().nativeElement, audio: this.audio().nativeElement });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.playback.detach();
  }
}
