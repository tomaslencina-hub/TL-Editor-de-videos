import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AiStatus } from '../../shared/ipc-contract';

/**
 * Acceso a la API de Gemini (Google AI Studio). La clave se guarda cifrada con `safeStorage`
 * en la carpeta de datos de la app y nunca llega al renderer: el renderer arma el pedido
 * (contenidos + herramientas) y acá se agrega la clave y el modelo.
 */
const API = 'https://generativelanguage.googleapis.com/v1beta';
/** Si no se puede listar los modelos, se usa este. */
const FALLBACK_MODEL = 'gemini-2.5-flash';

let cachedKey: string | null | undefined;
let model: string | null = null;

const keyFile = () => path.join(app.getPath('userData'), 'ai-key.bin');

async function readKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  try {
    const buf = await fs.readFile(keyFile());
    cachedKey = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

async function writeKey(key: string | null): Promise<void> {
  cachedKey = key;
  model = null;
  if (!key) {
    await fs.rm(keyFile(), { force: true });
    return;
  }
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
  await fs.writeFile(keyFile(), data);
}

function headers(key: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': key };
}

/** Traduce los errores de la API a mensajes entendibles. */
async function apiError(res: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } };
    detail = body.error?.message ?? '';
  } catch {
    /* sin cuerpo */
  }
  if (res.status === 429) {
    return new Error('Se alcanzó el límite gratuito de Gemini (pedidos por minuto o por día). Esperá un momento y probá de nuevo.');
  }
  if (res.status === 400 && /api key/i.test(detail)) return new Error('La clave de Gemini no es válida.');
  if (res.status === 401 || res.status === 403) return new Error('La clave de Gemini no es válida o no tiene permiso para este modelo.');
  return new Error(`Gemini respondió ${res.status}${detail ? `: ${detail}` : ''}`);
}

/**
 * Elige el modelo "flash" estable más nuevo que admita generateContent (son los del nivel gratuito).
 * Los nombres cambian con el tiempo, por eso se consulta la lista en vez de fijarlo.
 */
async function pickModel(key: string): Promise<string> {
  if (model) return model;
  try {
    const res = await fetch(`${API}/models?pageSize=200`, { headers: headers(key) });
    if (!res.ok) throw await apiError(res);
    const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const names = (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /^gemini-[\d.]+-flash$/.test(n));
    const version = (n: string) => parseFloat(/^gemini-([\d.]+)/.exec(n)?.[1] ?? '0');
    names.sort((a, b) => version(b) - version(a));
    model = names[0] ?? FALLBACK_MODEL;
  } catch (e) {
    if (e instanceof Error && /clave/.test(e.message)) throw e;
    model = FALLBACK_MODEL;
  }
  return model;
}

export async function aiStatus(): Promise<AiStatus> {
  const key = await readKey();
  return { hasKey: !!key, model };
}

/** Guarda la clave después de comprobar que funciona (null la borra). */
export async function aiSetKey(key: string | null): Promise<AiStatus> {
  const k = key?.trim() || null;
  if (!k) {
    await writeKey(null);
    return { hasKey: false, model: null };
  }
  model = null;
  const m = await pickModel(k);
  await writeKey(k);
  model = m;
  return { hasKey: true, model: m };
}

/** Un turno de generateContent. `request` es el cuerpo de la API (contents, tools, systemInstruction…). */
export async function aiGenerate(request: unknown): Promise<unknown> {
  const key = await readKey();
  if (!key) throw new Error('Falta la clave de Gemini.');
  const m = await pickModel(key);
  const res = await fetch(`${API}/models/${m}:generateContent`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify(request),
  });
  if (!res.ok) throw await apiError(res);
  return res.json();
}
