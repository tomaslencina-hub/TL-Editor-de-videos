import type { WaveformData } from '../../shared/ipc-contract';
import { FFMPEG_BIN, lastLines, runProcess } from './process';

const SAMPLE_RATE = 8000;
const PEAKS_PER_SECOND = 50;
const SAMPLES_PER_PEAK = SAMPLE_RATE / PEAKS_PER_SECOND;

const cache = new Map<string, Promise<WaveformData>>();

/** Decodifica el audio a PCM mono 8 kHz y calcula picos por bucket en streaming. */
export function waveform(filePath: string): Promise<WaveformData> {
  let p = cache.get(filePath);
  if (!p) {
    p = computeWaveform(filePath);
    cache.set(filePath, p);
    p.catch(() => cache.delete(filePath));
  }
  return p;
}

async function computeWaveform(filePath: string): Promise<WaveformData> {
  const peaks: number[] = [];
  let bucketMax = 0;
  let bucketCount = 0;
  let leftover: Buffer | null = null;

  const res = await runProcess(
    FFMPEG_BIN,
    ['-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1'],
    {
      onStdout: (chunk) => {
        const buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
        const usable = buf.length - (buf.length % 2);
        leftover = usable < buf.length ? buf.subarray(usable) : null;
        for (let i = 0; i < usable; i += 2) {
          const v = Math.abs(buf.readInt16LE(i));
          if (v > bucketMax) bucketMax = v;
          if (++bucketCount === SAMPLES_PER_PEAK) {
            peaks.push(bucketMax / 32768);
            bucketMax = 0;
            bucketCount = 0;
          }
        }
      },
    },
  );
  if (bucketCount > 0) peaks.push(bucketMax / 32768);
  if (res.code !== 0) throw new Error(`No se pudo calcular la onda de audio: ${lastLines(res.stderr)}`);

  return { peaks: Float32Array.from(peaks), peaksPerSecond: PEAKS_PER_SECOND };
}
