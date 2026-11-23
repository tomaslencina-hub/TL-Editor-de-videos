/** Redondea un tiempo a la grilla de frames del proyecto. */
export function roundToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

/** Timecode HH:MM:SS:FF */
export function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(t * fps));
  const f = Math.round(fps);
  const frames = totalFrames % f;
  const totalSeconds = Math.floor(totalFrames / f);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

/** Duración legible: 1:05, 12:30, 1:02:03 */
export function formatDuration(t: number): string {
  const total = Math.max(0, Math.round(t));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Etiqueta de la regla según el paso elegido. */
export function formatRulerLabel(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const sec = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0');
  return `${m}:${sec}`;
}
