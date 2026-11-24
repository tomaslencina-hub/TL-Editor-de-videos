import { Component, computed, inject } from '@angular/core';
import { SUBTITLE_STYLE_LABELS, SUBTITLE_STYLES } from '../../../../shared/text';
import { SubtitlesService } from '../../core/subtitles/subtitles.service';
import { SelectedClipService } from '../../core/state/selected-clip.service';

const LANGUAGES = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'Inglés' },
  { code: 'pt', label: 'Portugués' },
  { code: 'it', label: 'Italiano' },
  { code: 'fr', label: 'Francés' },
  { code: 'auto', label: 'Detectar automáticamente' },
];

@Component({
  selector: 'app-subtitles-dialog',
  templateUrl: './subtitles-dialog.html',
  styleUrl: '../export-dialog/export-dialog.scss',
})
export class SubtitlesDialog {
  protected readonly subs = inject(SubtitlesService);
  protected readonly sel = inject(SelectedClipService);
  protected readonly languages = LANGUAGES;
  protected readonly styles = SUBTITLE_STYLES;
  protected readonly styleLabels = SUBTITLE_STYLE_LABELS;

  protected readonly percent = computed(() => Math.round(this.subs.ratio() * 100));
  protected readonly selectedModel = computed(() => this.subs.models().find((m) => m.id === this.subs.options().model));
}
