import { app, net, safeStorage } from 'electron';
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

/** Explica un error de red (el "fetch failed" pelado no dice nada). */
function networkError(e: unknown): Error {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const detail = [err.cause?.code, err.cause?.message, err.message].filter(Boolean).join(' – ');
  return new Error(
    `No se pudo conectar con Gemini (${detail || 'error de red'}). Revisá la conexión a internet; si usás antivirus con ` +
      'análisis de HTTPS, VPN o proxy, puede estar bloqueando la conexión.',
  );
}

/**
 * fetch con la pila de red de Chromium (`net.fetch`): usa el proxy, los certificados y el IPv6
 * configurados en Windows, igual que el navegador. Reintenta los cortes de conexión.
 */
async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await net.fetch(url, init);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 800 : 2500));
    }
  }
  throw networkError(last);
}

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

/** Modelos candidatos, del preferido al último recurso (se completa al validar la clave). */
let candidates: string[] = [];

/**
 * Arma la lista de modelos "flash" estables que admiten generateContent (los del nivel gratuito):
 * primero los flash del más nuevo al más viejo y después los flash-lite. Los nombres cambian con el
 * tiempo, por eso se consulta la lista en vez de fijarlos.
 */
async function pickModel(key: string): Promise<string> {
  if (model) return model;
  try {
    const res = await httpFetch(`${API}/models?pageSize=200`, { headers: headers(key) });
    if (!res.ok) throw await apiError(res);
    const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    const names = (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n));
    const version = (n: string) => parseFloat(/^gemini-([\d.]+)/.exec(n)?.[1] ?? '0');
    const lite = (n: string) => (n.endsWith('-lite') ? 1 : 0);
    names.sort((a, b) => lite(a) - lite(b) || version(b) - version(a));
    candidates = names.length ? names : [FALLBACK_MODEL];
  } catch (e) {
    if (e instanceof Error && /clave/.test(e.message)) throw e;
    candidates = [FALLBACK_MODEL];
  }
  model = candidates[0];
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Quita las firmas de pensamiento: son propias del modelo que las generó y otro modelo puede rechazarlas. */
function withoutSignatures(request: unknown): unknown {
  return JSON.parse(JSON.stringify(request), (k, v) => (k === 'thoughtSignature' ? undefined : v));
}

/**
 * Un turno de generateContent. `request` es el cuerpo de la API (contents, tools, systemInstruction…).
 * Si el modelo está saturado (503/500) reintenta con espera; si sigue saturado o se agotó su cupo
 * gratuito (429, que es por modelo), pasa al siguiente modelo de la lista y se queda con el que funcione.
 */
export async function aiGenerate(request: unknown): Promise<unknown> {
  const key = await readKey();
  if (!key) throw new Error('Falta la clave de Gemini.');
  const first = await pickModel(key);
  const order = [first, ...candidates.filter((m) => m !== first)].slice(0, 4);
  let busy = false;
  let quota = false;
  for (const m of order) {
    const body = JSON.stringify(m === first ? request : withoutSignatures(request));
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await httpFetch(`${API}/models/${m}:generateContent`, { method: 'POST', headers: headers(key), body });
      if (res.ok) {
        model = m;
        return res.json();
      }
      if (res.status === 503 || res.status === 500) {
        busy = true;
        if (attempt < 2) await sleep(attempt === 0 ? 1500 : 4000);
        continue;
      }
      if (res.status === 429) {
        quota = true;
        break;
      }
      throw await apiError(res);
    }
  }
  if (busy) throw new Error('Los servidores de Gemini están saturados en este momento (no es un problema de SHOTON ni de tu clave). Probá de nuevo en unos minutos.');
  if (quota) throw new Error('Se alcanzó el límite gratuito de Gemini (pedidos por minuto o por día). Esperá un momento y probá de nuevo.');
  throw new Error('Gemini no respondió.');
}
