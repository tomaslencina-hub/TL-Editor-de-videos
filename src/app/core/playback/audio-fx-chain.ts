import { DEHISS_HZ, DEHUM_FREQS, DEWIND_HZ, EQ_BANDS, type AudioFx } from '../../../../shared/audio-fx';

/**
 * Equivalente en Web Audio de `audioFxFilters` (shared/audio-fx.ts) para la vista previa:
 * paso alto (viento), rechazos de banda (zumbido), estante de agudos (siseo), ecualizador y balance.
 * La reducción de ruido no tiene equivalente en vivo: se aplica solo al exportar.
 * Los filtros quedan siempre conectados; "apagado" = parámetros neutros, así cambiar no corta el audio.
 */
export class AudioFxChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly wind: BiquadFilterNode;
  private readonly hum: BiquadFilterNode[];
  private readonly hiss: BiquadFilterNode;
  private readonly eq: BiquadFilterNode[];
  private readonly pan: StereoPannerNode;
  private key = '';

  constructor(ctx: AudioContext) {
    const biquad = (type: BiquadFilterType, frequency: number, Q = 1, gain = 0) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.Q.value = Q;
      f.gain.value = gain;
      return f;
    };
    this.wind = biquad('highpass', 1, 0.707);
    this.hum = DEHUM_FREQS.map((hz) => biquad('peaking', hz, 10, 0));
    this.hiss = biquad('highshelf', DEHISS_HZ, 1, 0);
    // Q ≈ 1.41: ancho de una octava, como `equalizer=t=o:w=1` de FFmpeg.
    this.eq = EQ_BANDS.map((hz) => biquad('peaking', hz, 1.41, 0));
    this.pan = ctx.createStereoPanner();
    const nodes: AudioNode[] = [this.wind, ...this.hum, this.hiss, ...this.eq, this.pan];
    nodes.reduce((a, b) => a.connect(b));
    this.input = nodes[0];
    this.output = this.pan;
  }

  apply(fx: AudioFx | undefined): void {
    const key = fx ? JSON.stringify(fx) : '';
    if (key === this.key) return;
    this.key = key;
    this.wind.frequency.value = fx?.dewind ? DEWIND_HZ : 1;
    for (const f of this.hum) {
      f.type = fx?.dehum ? 'notch' : 'peaking';
      f.gain.value = 0;
    }
    this.hiss.gain.value = fx?.dehiss ? -9 : 0;
    this.eq.forEach((f, i) => (f.gain.value = fx?.eq?.[i] ?? 0));
    this.pan.pan.value = Math.max(-1, Math.min(1, fx?.pan ?? 0));
  }
}
