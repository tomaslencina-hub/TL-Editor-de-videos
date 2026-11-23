import { Component, inject } from '@angular/core';
import type { MediaSource } from '../../../../shared/model';
import { Commands } from '../../core/commands/command';
import { EditorActionsService } from '../../core/editor-actions.service';
import { MediaLibraryService } from '../../core/media/media-library.service';
import { ProjectStore } from '../../core/state/project-store';
import { formatDuration } from '../../core/timeline/time';
import { MEDIA_DRAG_TYPE, MediaDragService } from '../../core/ui/media-drag.service';

@Component({
  selector: 'app-media-panel',
  templateUrl: './media-panel.html',
  styleUrl: './media-panel.scss',
})
export class MediaPanel {
  protected readonly store = inject(ProjectStore);
  protected readonly library = inject(MediaLibraryService);
  protected readonly actions = inject(EditorActionsService);
  private readonly drag = inject(MediaDragService);

  protected readonly formatDuration = formatDuration;

  protected onDragStart(e: DragEvent, media: MediaSource): void {
    if (this.library.assets().get(media.id)?.missing) {
      e.preventDefault();
      return;
    }
    e.dataTransfer?.setData(MEDIA_DRAG_TYPE, media.id);
    e.dataTransfer!.effectAllowed = 'copy';
    this.drag.current.set(media);
  }

  protected onDragEnd(): void {
    this.drag.current.set(null);
  }

  protected remove(media: MediaSource, e: Event): void {
    e.stopPropagation();
    const used = this.store.project().tracks.some((t) => t.clips.some((c) => c.sourceId === media.id));
    if (used && !confirm(`"${media.name}" se usa en la timeline. ¿Quitarlo junto con sus clips?`)) return;
    this.store.dispatch(Commands.removeMedia(media.id));
  }

  protected details(m: MediaSource): string {
    const parts = [formatDuration(m.duration)];
    if (m.width && m.height) parts.push(`${m.width}×${m.height}`);
    if (m.fps) parts.push(`${m.fps} fps`);
    if (!m.hasVideo) parts.push('audio');
    return parts.join(' · ');
  }
}
