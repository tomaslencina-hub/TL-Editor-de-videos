import { ChangeDetectionStrategy, Component, effect, ElementRef, inject, input, Renderer2 } from '@angular/core';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AudioLines,
  Bold,
  Captions,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clapperboard,
  Diamond,
  Download,
  FilePlus,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Images,
  Italic,
  Lock,
  LockOpen,
  Magnet,
  Maximize2,
  Minus,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  Scissors,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  StepBack,
  StepForward,
  Trash2,
  Type,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  Blend,
  Bot,
  SendHorizontal,
  X,
  type IconNode,
} from 'lucide';

/**
 * Íconos de Lucide (licencia ISC) usados en la app. Solo se incluyen los importados acá,
 * así el bundle no carga el set completo.
 */
const ICONS = {
  'align-center': AlignCenter,
  'align-left': AlignLeft,
  'align-right': AlignRight,
  'audio-lines': AudioLines,
  bold: Bold,
  captions: Captions,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  clapperboard: Clapperboard,
  diamond: Diamond,
  download: Download,
  'file-plus': FilePlus,
  film: Film,
  // En esta versión de Lucide los nombres están cruzados respecto del dibujo.
  'flip-h': FlipVertical2,
  'flip-v': FlipHorizontal2,
  'folder-open': FolderOpen,
  images: Images,
  italic: Italic,
  lock: Lock,
  'lock-open': LockOpen,
  magnet: Magnet,
  maximize: Maximize2,
  minus: Minus,
  music: Music,
  pause: Pause,
  pencil: Pencil,
  play: Play,
  plus: Plus,
  redo: Redo2,
  refresh: RefreshCw,
  save: Save,
  scissors: Scissors,
  shuffle: Shuffle,
  'skip-back': SkipBack,
  'skip-forward': SkipForward,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  bot: Bot,
  send: SendHorizontal,
  'step-back': StepBack,
  'step-forward': StepForward,
  trash: Trash2,
  type: Type,
  undo: Undo2,
  upload: Upload,
  volume: Volume2,
  'volume-off': VolumeX,
  transition: Blend,
  x: X,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** `<app-icon name="save" />`: ícono SVG de trazo, hereda el color del texto (currentColor). */
@Component({
  selector: 'app-icon',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      line-height: 0;
    }
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(16);
  readonly strokeWidth = input(2);
  /** Relleno con el color del texto (p. ej. el rombo de keyframe activo). */
  readonly filled = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly r = inject(Renderer2);

  constructor() {
    effect(() => {
      const host = this.host.nativeElement;
      host.replaceChildren();
      const svg = this.r.createElement('svg', SVG_NS) as SVGSVGElement;
      const attrs: Record<string, string> = {
        width: String(this.size()),
        height: String(this.size()),
        viewBox: '0 0 24 24',
        fill: this.filled() ? 'currentColor' : 'none',
        stroke: 'currentColor',
        'stroke-width': String(this.strokeWidth()),
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      };
      for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
      for (const [tag, nodeAttrs] of ICONS[this.name()]) {
        const el = this.r.createElement(tag, SVG_NS) as SVGElement;
        for (const [k, v] of Object.entries(nodeAttrs)) el.setAttribute(k, String(v));
        svg.appendChild(el);
      }
      host.appendChild(svg);
    });
  }
}
