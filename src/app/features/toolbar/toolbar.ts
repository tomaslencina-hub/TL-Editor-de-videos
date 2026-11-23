import { Component, computed, inject } from '@angular/core';
import { Commands } from '../../core/commands/command';
import { EditorActionsService } from '../../core/editor-actions.service';
import { ExportService } from '../../core/export/export.service';
import { ProjectStore } from '../../core/state/project-store';

interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

const RESOLUTIONS: ResolutionPreset[] = [
  { label: '4K UHD (3840×2160)', width: 3840, height: 2160 },
  { label: '1440p (2560×1440)', width: 2560, height: 1440 },
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: 'Vertical 1080×1920', width: 1080, height: 1920 },
  { label: 'Cuadrado 1080×1080', width: 1080, height: 1080 },
];
const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

@Component({
  selector: 'app-toolbar',
  templateUrl: './toolbar.html',
  styleUrl: './toolbar.scss',
})
export class Toolbar {
  protected readonly store = inject(ProjectStore);
  protected readonly actions = inject(EditorActionsService);
  protected readonly exporter = inject(ExportService);

  protected readonly fpsOptions = FPS_OPTIONS;
  protected readonly resolutionKey = computed(() => {
    const s = this.store.settings();
    return `${s.width}x${s.height}`;
  });
  /** Incluye la resolución actual aunque no sea un preset (p. ej. adoptada de un video). */
  protected readonly resolutions = computed(() => {
    const s = this.store.settings();
    const list = RESOLUTIONS.map((r) => ({ key: `${r.width}x${r.height}`, label: r.label }));
    const key = `${s.width}x${s.height}`;
    if (!list.some((r) => r.key === key)) list.unshift({ key, label: `Personalizada (${s.width}×${s.height})` });
    return list;
  });
  protected readonly fpsList = computed(() => {
    const fps = this.store.settings().fps;
    return FPS_OPTIONS.includes(fps) ? FPS_OPTIONS : [fps, ...FPS_OPTIONS];
  });

  protected rename(value: string): void {
    const name = value.trim();
    if (name && name !== this.store.project().name) this.store.dispatch(Commands.renameProject(name));
  }

  protected setResolution(key: string): void {
    const [width, height] = key.split('x').map(Number);
    this.store.dispatch(Commands.updateSettings({ width, height }));
  }

  protected setFps(value: string): void {
    this.store.dispatch(Commands.updateSettings({ fps: Number(value) }));
  }
}
