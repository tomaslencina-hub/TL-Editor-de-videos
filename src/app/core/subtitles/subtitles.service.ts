import { inject, Injectable, signal } from '@angular/core';
import type { SubtitleModelInfo, SubtitleSegment, WhisperModelId } from '../../../../shared/ipc-contract';
import { clipDuration } from '../../../../shared/model';
import type { SubtitleStyle } from '../../../../shared/text';
import { Commands } from '../commands/command';
import { TL_API } from '../ipc/tl-api';
import { errorMessage } from '../media/media-library.service';
import { SelectedClipService } from '../state/selected-clip.service';
import { ProjectStore } from '../state/project-store';

export type SubtitlesStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface SubtitleOptions {
  range: 'all' | 'selection';
  language: string;
  model: WhisperModelId;
  style: SubtitleStyle;
  maxChars: number;
}

/** Subtítulos automáticos: transcribe lo que se escucha y crea una pista de textos sincronizados. */
@Injectable({ providedIn: 'root' })
export class SubtitlesService {
  private readonly api = inject(TL_API);
  private readonly store = inject(ProjectStore);
  private readonly sel = inject(SelectedClipService);

  readonly open = signal(false);
  readonly status = signal<SubtitlesStatus>('idle');
  readonly phase = signal<'download' | 'transcribe'>('transcribe');
  readonly ratio = signal(0);
  readonly message = signal<string | null>(null);
  readonly models = signal<SubtitleModelInfo[]>([]);
  readonly segments = signal<SubtitleSegment[]>([]);
  readonly options = signal<SubtitleOptions>({ range: 'all', language: 'es', model: 'small', style: 'classic', maxChars: 42 });

  show(): void {
    if (this.status() !== 'running') {
      this.status.set('idle');
      this.message.set(null);
    }
    // Si hay un clip seleccionado, por defecto se transcribe solo ese tramo.
    this.options.update((o) => ({ ...o, range: this.sel.clip() ? 'selection' : 'all' }));
    void this.api.listSubtitleModels().then((m) => this.models.set(m));
    this.open.set(true);
  }

  close(): void {
    if (this.status() !== 'running') this.open.set(false);
  }

  patch(p: Partial<SubtitleOptions>): void {
    this.options.update((o) => ({ ...o, ...p }));
  }

  async start(): Promise<void> {
    if (this.status() === 'running') return;
    if (this.store.duration() <= 0) {
      this.fail('La timeline está vacía.');
      return;
    }
    const o = this.options();
    let range: { start?: number; end?: number } = {};
    if (o.range === 'selection') {
      const clip = this.sel.clip();
      if (!clip) {
        this.fail('Seleccioná un clip o elegí "Toda la timeline".');
        return;
      }
      range = { start: clip.start, end: clip.start + clipDuration(clip) };
    }

    this.status.set('running');
    this.message.set(null);
    this.ratio.set(0);
    this.phase.set('transcribe');
    const off = this.api.onSubtitleProgress((p) => {
      this.phase.set(p.phase);
      this.ratio.set(p.ratio);
    });
    try {
      const segments = await this.api.transcribe(this.store.project(), {
        model: o.model,
        language: o.language,
        maxChars: o.maxChars,
        ...range,
      });
      this.segments.set(segments);
      void this.api.listSubtitleModels().then((m) => this.models.set(m));
      if (!segments.length) {
        this.fail('No se detectó voz en el audio.');
        return;
      }
      this.store.dispatch(Commands.addSubtitles(segments, o.style));
      this.status.set('done');
      this.message.set(`Se crearon ${segments.length} subtítulos en la pista "Subtítulos".`);
    } catch (e) {
      const msg = errorMessage(e);
      if (/Cancelado/.test(msg)) this.status.set('cancelled');
      else this.fail(msg);
    } finally {
      off();
    }
  }

  cancel(): void {
    if (this.status() === 'running') void this.api.cancelTranscription();
  }

  async saveSrt(): Promise<void> {
    const path = await this.api.saveSrt(this.segments(), this.store.project().name);
    if (path) this.message.set(`Guardado: ${path}`);
  }

  private fail(msg: string): void {
    this.status.set('error');
    this.message.set(msg);
  }
}
