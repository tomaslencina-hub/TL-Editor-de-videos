import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { propValue } from '../../../../shared/animation';
import { clipDuration, type AnimatableProp } from '../../../../shared/model';
import { Commands } from '../../core/commands/command';
import { PlaybackService } from '../../core/playback/playback.service';
import { ProjectStore } from '../../core/state/project-store';
import { SelectedClipService } from '../../core/state/selected-clip.service';
import { hasKeyframeAt, keyframeTimes, KEYFRAME_EPS } from '../../core/timeline/clip-props';
import type { ClipAudioPatch } from '../../core/timeline/timeline-ops';
import { formatTimecode } from '../../core/timeline/time';
import { FONT_FAMILIES, TEXT_ANIMATION_LABELS, TEXT_ANIMATIONS, type TextContent } from '../../../../shared/text';

interface PropRow {
  prop: AnimatableProp;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Valor del modelo → valor mostrado. */
  toView: (v: number) => number;
  toModel: (v: number) => number;
}

const pct = { toView: (v: number) => v * 100, toModel: (v: number) => v / 100 };
const same = { toView: (v: number) => v, toModel: (v: number) => v };

const TRANSFORM_ROWS: PropRow[] = [
  { prop: 'x', label: 'Posición X', min: -100, max: 100, step: 0.1, unit: '%', ...pct },
  { prop: 'y', label: 'Posición Y', min: -100, max: 100, step: 0.1, unit: '%', ...pct },
  { prop: 'scale', label: 'Escala', min: 1, max: 400, step: 1, unit: '%', ...pct },
  { prop: 'rotation', label: 'Rotación', min: -180, max: 180, step: 0.5, unit: '°', ...same },
  { prop: 'opacity', label: 'Opacidad', min: 0, max: 100, step: 1, unit: '%', ...pct },
];

const COLOR_ROWS: PropRow[] = [
  { prop: 'brightness', label: 'Brillo', min: -100, max: 100, step: 1, unit: '', ...pct },
  { prop: 'contrast', label: 'Contraste', min: 0, max: 200, step: 1, unit: '%', ...pct },
  { prop: 'saturation', label: 'Saturación', min: 0, max: 200, step: 1, unit: '%', ...pct },
  { prop: 'temperature', label: 'Temperatura', min: -100, max: 100, step: 1, unit: '', ...pct },
];

@Component({
  selector: 'app-properties-panel',
  imports: [NgTemplateOutlet],
  templateUrl: './properties-panel.html',
  styleUrl: './properties-panel.scss',
})
export class PropertiesPanel {
  protected readonly sel = inject(SelectedClipService);
  private readonly store = inject(ProjectStore);
  private readonly playback = inject(PlaybackService);

  protected readonly fonts = FONT_FAMILIES;
  protected readonly animations = TEXT_ANIMATIONS;
  protected readonly animationLabels = TEXT_ANIMATION_LABELS;
  protected readonly text = computed(() => this.sel.clip()?.text ?? null);

  /** Cambia el texto/estilo; los cambios continuos (tipeo, deslizadores) se agrupan en el historial. */
  protected setText(patch: Partial<TextContent>, mergeKey = 'text'): void {
    const clip = this.sel.clip();
    if (!clip?.text || this.sel.track()?.locked) return;
    this.store.dispatch(Commands.updateText(clip.id, patch), { mergeKey: `${mergeKey}:${clip.id}` });
  }

  protected setNested<K extends 'stroke' | 'shadow' | 'background'>(key: K, patch: Partial<TextContent[K]>, mergeKey: string): void {
    const text = this.text();
    if (text) this.setText({ [key]: { ...text[key], ...patch } } as Partial<TextContent>, mergeKey);
  }

  protected readonly transformRows = TRANSFORM_ROWS;
  protected readonly volumeRow: PropRow = { prop: 'volume', label: 'Volumen', min: 0, max: 200, step: 1, unit: '%', ...pct };
  protected readonly speedPresets = [0.25, 0.5, 1, 1.5, 2, 4];

  protected readonly isMedia = computed(() => !!this.sel.media() && !this.sel.clip()?.text);
  protected readonly hasAudio = computed(() => this.isMedia() && !!this.sel.media()?.hasAudio);
  protected readonly canDetach = computed(
    () => this.hasAudio() && this.sel.track()?.kind === 'video' && !this.sel.clip()?.audioMuted,
  );
  protected readonly speed = computed(() => this.sel.clip()?.speed ?? 1);

  protected setSpeed(speed: number): void {
    const clip = this.sel.clip();
    if (!clip || !Number.isFinite(speed) || speed <= 0 || this.sel.track()?.locked) return;
    this.store.dispatch(Commands.setSpeed(clip.id, speed));
  }

  protected setAudio(patch: ClipAudioPatch, mergeKey?: string): void {
    const clip = this.sel.clip();
    if (!clip || this.sel.track()?.locked) return;
    this.store.dispatch(Commands.setClipAudio(clip.id, patch), mergeKey ? { mergeKey: `${mergeKey}:${clip.id}` } : undefined);
  }

  protected detachAudio(): void {
    const clip = this.sel.clip();
    if (clip) this.store.dispatch(Commands.detachAudio(clip.id));
  }
  protected readonly colorRows = COLOR_ROWS;

  protected readonly info = computed(() => {
    const clip = this.sel.clip();
    if (!clip) return null;
    const fps = this.store.settings().fps;
    const name = clip.text ? 'Texto' : (this.sel.media()?.name ?? 'Clip');
    return { name, start: formatTimecode(clip.start, fps), duration: formatTimecode(clipDuration(clip), fps) };
  });

  /** Keyframes de todo el clip (para navegar). */
  private readonly times = computed(() => {
    const clip = this.sel.clip();
    return clip ? keyframeTimes(clip) : [];
  });
  protected readonly prevKey = computed(() => [...this.times()].reverse().find((t) => t < this.sel.clipTime() - KEYFRAME_EPS) ?? null);
  protected readonly nextKey = computed(() => this.times().find((t) => t > this.sel.clipTime() + KEYFRAME_EPS) ?? null);

  protected value(row: PropRow): number {
    const clip = this.sel.clip();
    if (!clip) return 0;
    return Math.round(row.toView(propValue(clip, row.prop, this.sel.clipTime())) * 100) / 100;
  }

  protected keyState(row: PropRow): 'none' | 'animated' | 'here' {
    const clip = this.sel.clip();
    if (!clip?.keyframes?.[row.prop]?.length) return 'none';
    return hasKeyframeAt(clip, row.prop, this.sel.clipTime()) ? 'here' : 'animated';
  }

  protected onInput(row: PropRow, raw: string): void {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(row.max, Math.max(row.min, v));
    this.sel.set({ [row.prop]: row.toModel(clamped) }, `prop:${row.prop}`);
  }

  protected toggleKey(row: PropRow): void {
    const clip = this.sel.clip();
    if (!clip || !this.sel.playheadInside()) return;
    this.store.dispatch(Commands.toggleKeyframe(clip.id, row.prop, this.sel.clipTime()));
  }

  protected reset(group: 'transform' | 'adjust'): void {
    const clip = this.sel.clip();
    if (clip) this.store.dispatch(Commands.resetClipProps(clip.id, group));
  }

  protected goToKey(time: number | null): void {
    const clip = this.sel.clip();
    if (clip && time !== null) {
      this.playback.pause();
      this.playback.seek(clip.start + time);
    }
  }
}
