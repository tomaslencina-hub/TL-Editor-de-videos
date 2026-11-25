import { Component, effect, ElementRef, inject, signal, viewChild, type OnInit } from '@angular/core';
import { AssistantService, type ChatMessage } from '../../core/ai/assistant.service';
import { TL_API } from '../../core/ipc/tl-api';
import { Icon } from '../../core/ui/icon';

const KEY_URL = 'https://aistudio.google.com/app/apikey';

const SUGGESTIONS = [
  'Poné un fundido cruzado entre todos los clips',
  'Aplicale un look de cine a todo el video',
  'Agregá un título "Mi viaje" al principio',
  'Bajá la música al 40% y limpiá el ruido de las voces',
  'Poné confeti en los últimos 5 segundos',
];

/** Pestaña "Asistente": chat con Gemini que edita el proyecto. */
@Component({
  selector: 'app-assistant-panel',
  imports: [Icon],
  template: `
    @if (status(); as st) {
      @if (!st.hasKey || editingKey()) {
        <div class="setup">
          <h3><app-icon name="bot" [size]="16" /> Asistente con IA (Gemini)</h3>
          <p>
            Para probarlo gratis necesitás una clave de Google AI Studio (sin tarjeta). Entrá con tu cuenta de Google,
            tocá <b>Create API key</b> y pegala acá.
          </p>
          <button class="link" (click)="openKeyPage()">Abrir Google AI Studio →</button>
          <div class="key-row">
            <input type="password" placeholder="Pegá la clave (AIza…)" [value]="keyInput()" (input)="keyInput.set($any($event.target).value)" (keydown.enter)="saveKey()" />
            <button class="primary" [disabled]="!keyInput().trim() || savingKey()" (click)="saveKey()">{{ savingKey() ? 'Probando…' : 'Guardar' }}</button>
          </div>
          @if (keyError()) {
            <p class="err">{{ keyError() }}</p>
          }
          <p class="note">
            La clave se guarda cifrada en esta PC. Al asistente se le manda la estructura del proyecto (nombres de archivos, clips y
            tiempos) y tus pedidos, nunca los videos. En el nivel gratuito Google puede usar esos datos para mejorar sus productos
            y hay un límite de pedidos por minuto y por día.
          </p>
          @if (st.hasKey) {
            <button class="link" (click)="editingKey.set(false)">Cancelar</button>
          }
        </div>
      } @else {
        <div class="chat" #scroller>
          @if (!ai.messages().length) {
            <div class="intro">
              <p>Pedile cambios al proyecto con tus palabras. Lo que haga se aplica de una vez y se deshace con un clic (o Ctrl+Z).</p>
              @for (s of suggestions; track s) {
                <button class="chip" (click)="send(s)">{{ s }}</button>
              }
            </div>
          }
          @for (m of ai.messages(); track $index) {
            <div class="msg" [class.user]="m.role === 'user'" [class.error]="m.role === 'error'">
              <div class="text">{{ m.text }}</div>
              @if (m.actions?.length) {
                <ul class="actions">
                  @for (a of m.actions; track $index) {
                    <li>{{ a }}</li>
                  }
                </ul>
              }
              @if (ai.canUndo(m)) {
                <button class="link undo" (click)="ai.undo(m)"><app-icon name="undo" [size]="12" /> Deshacer estos cambios</button>
              }
            </div>
          }
          @if (ai.busy()) {
            <div class="msg working">{{ ai.progress() }}</div>
          }
        </div>
        <div class="composer">
          <textarea
            rows="2"
            placeholder="¿Qué querés hacer? (Enter para enviar)"
            [value]="draft()"
            (input)="draft.set($any($event.target).value)"
            (keydown.enter)="onEnter($event)"
            [disabled]="ai.busy()"
          ></textarea>
          <button class="icon primary" [disabled]="ai.busy() || !draft().trim()" (click)="send(draft())" title="Enviar"><app-icon name="send" [size]="16" /></button>
        </div>
        <div class="foot">
          <span>{{ st.model ?? 'Gemini' }}</span>
          <button class="link" (click)="ai.clear()" [disabled]="ai.busy()">Nueva conversación</button>
          <button class="link" (click)="editingKey.set(true)">Clave</button>
        </div>
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; }
    .setup { padding: 12px; overflow-y: auto; font-size: 12px; color: var(--text-1); }
    .setup h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; font-size: 13px; color: var(--text-0); }
    .setup p { margin: 0 0 8px; line-height: 1.45; }
    .key-row { display: flex; gap: 6px; margin: 10px 0 6px; }
    .key-row input { flex: 1; min-width: 0; }
    .err { color: var(--danger, #ff6b6b); }
    .note { color: var(--text-2); font-size: 11px; }
    .chat { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    .intro { color: var(--text-2); font-size: 12px; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .intro p { margin: 0 0 4px; line-height: 1.45; }
    .chip { font-size: 12px; text-align: left; padding: 5px 9px; border-radius: 12px; background: var(--bg-2); }
    .chip:hover { border-color: var(--accent); }
    .msg { max-width: 92%; padding: 7px 10px; border-radius: 10px; background: var(--bg-2); font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; align-self: flex-start; }
    .msg.user { align-self: flex-end; background: color-mix(in srgb, var(--accent) 28%, var(--bg-2)); }
    .msg.error { color: #ffb3b3; background: color-mix(in srgb, #ff4d4d 18%, var(--bg-2)); }
    .msg.working { color: var(--text-2); font-style: italic; }
    .actions { margin: 6px 0 0; padding-left: 16px; color: var(--text-2); font-size: 11.5px; white-space: normal; }
    .undo { margin-top: 6px; display: inline-flex; align-items: center; gap: 4px; }
    .composer { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border); align-items: flex-end; }
    .composer textarea { flex: 1; resize: none; font: inherit; font-size: 12.5px; min-width: 0; }
    .foot { display: flex; gap: 10px; align-items: center; padding: 0 10px 8px; font-size: 11px; color: var(--text-2); }
    .foot span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
})
export class AssistantPanel implements OnInit {
  protected readonly ai = inject(AssistantService);
  private readonly api = inject(TL_API);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly status = this.ai.status;
  protected readonly suggestions = SUGGESTIONS;
  protected readonly draft = signal('');
  protected readonly keyInput = signal('');
  protected readonly keyError = signal('');
  protected readonly savingKey = signal(false);
  protected readonly editingKey = signal(false);

  constructor() {
    // Baja al último mensaje.
    effect(() => {
      this.ai.messages();
      this.ai.busy();
      const el = this.scroller()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  ngOnInit(): void {
    if (!this.status()) void this.ai.refreshStatus();
  }

  protected openKeyPage(): void {
    void this.api.openHelpUrl(KEY_URL);
  }

  protected async saveKey(): Promise<void> {
    const key = this.keyInput().trim();
    if (!key) return;
    this.savingKey.set(true);
    this.keyError.set('');
    try {
      await this.ai.setKey(key);
      this.keyInput.set('');
      this.editingKey.set(false);
    } catch (e) {
      this.keyError.set(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      this.savingKey.set(false);
    }
  }

  protected onEnter(e: Event): void {
    if ((e as KeyboardEvent).shiftKey) return;
    e.preventDefault();
    this.send(this.draft());
  }

  protected send(text: string): void {
    if (!text.trim()) return;
    this.draft.set('');
    void this.ai.send(text);
  }

  protected isUser(m: ChatMessage): boolean {
    return m.role === 'user';
  }
}
