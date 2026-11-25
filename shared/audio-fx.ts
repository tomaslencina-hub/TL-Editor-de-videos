/**
 * Limpieza y ecualización del audio de un clip.
 * La exportación lo aplica con filtros de FFmpeg (audioFxFilters); la vista previa usa una cadena
 * equivalente de Web Audio (src/app/core/playback/audio-fx-chain.ts), salvo la reducción de ruido,
 * que solo se escucha al exportar.
 */

/** Bandas del ecualizador (Hz), las mismas que usa Filmora. */
export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_LABELS = ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
export const EQ_MAX_DB = 12;

export interface AudioFx {
  /** Reducción de ruido de fondo, 0..1 (0 = apagada). */
  denoise?: number;
  /** Quita el ruido de viento (corta graves por debajo de ~120 Hz). */
  dewind?: boolean;
  /** Quita el zumbido eléctrico de 50/60 Hz y sus armónicos. */
  dehum?: boolean;
  /** Reduce el siseo (ruido agudo constante). */
  dehiss?: boolean;
  /** Ganancia por banda en dB (ver EQ_BANDS); ausente = plano. */
  eq?: number[];
  /** Balance estéreo: -1 = izquierda, 0 = centro, 1 = derecha. */
  pan?: number;
}

export const EQ_PRESETS: { id: string; label: string; gains: number[] }[] = [
  { id: 'flat', label: 'Plano', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'voice', label: 'Voz clara', gains: [-6, -4, -2, 0, 1, 3, 4, 3, 1, 0] },
  { id: 'bass', label: 'Más graves', gains: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
  { id: 'treble', label: 'Más agudos', gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 5] },
  { id: 'warm', label: 'Cálido', gains: [2, 3, 3, 2, 1, 0, -1, -2, -2, -3] },
  { id: 'phone', label: 'Teléfono', gains: [-12, -12, -8, -2, 2, 4, 4, -4, -12, -12] },
];

export const DEHUM_FREQS = [50, 60, 100, 120];
export const DEWIND_HZ = 120;
export const DEHISS_HZ = 7000;

/** true si no cambia nada el sonido. */
export function isNeutralAudioFx(fx: AudioFx | undefined): boolean {
  return (
    !fx ||
    (!(fx.denoise && fx.denoise > 0) &&
      !fx.dewind &&
      !fx.dehum &&
      !fx.dehiss &&
      !(fx.eq ?? []).some((g) => Math.abs(g) > 0.01) &&
      !(fx.pan && Math.abs(fx.pan) > 0.01))
  );
}

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Filtros de FFmpeg (para una cadena estéreo) que aplican la limpieza. */
export function audioFxFilters(fx: AudioFx | undefined): string[] {
  if (isNeutralAudioFx(fx)) return [];
  const f: string[] = [];
  if (fx!.dewind) f.push(`highpass=f=${DEWIND_HZ}:poles=2`);
  if (fx!.dehum) for (const hz of DEHUM_FREQS) f.push(`bandreject=f=${hz}:width_type=q:w=10`);
  if (fx!.denoise && fx!.denoise > 0) {
    // nr: reducción en dB (6..30); nf: piso de ruido estimado.
    f.push(`afftdn=nr=${n(6 + 24 * Math.min(1, fx!.denoise))}:nf=-35:tn=1`);
  }
  if (fx!.dehiss) f.push(`highshelf=f=${DEHISS_HZ}:g=-9`);
  (fx!.eq ?? []).forEach((g, i) => {
    if (Math.abs(g) > 0.01 && EQ_BANDS[i]) f.push(`equalizer=f=${EQ_BANDS[i]}:t=o:w=1:g=${n(g)}`);
  });
  const pan = Math.max(-1, Math.min(1, fx!.pan ?? 0));
  if (Math.abs(pan) > 0.01) {
    const l = Math.min(1, 1 - pan);
    const r = Math.min(1, 1 + pan);
    f.push(`pan=stereo|c0=${n(l)}*c0|c1=${n(r)}*c1`);
  }
  return f;
}
