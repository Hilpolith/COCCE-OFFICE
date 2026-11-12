/** Build a compact, normalized peak waveform from decoded audio samples. */
export function buildAudioWaveform(samples: Float32Array, barCount = 40): number[] {
  if (!Number.isInteger(barCount) || barCount < 1 || barCount > 256) throw new RangeError('barCount must be between 1 and 256');
  if (!samples.length) return Array(barCount).fill(8);
  return Array.from({ length: barCount }, (_, index) => {
    const start = Math.floor(index * samples.length / barCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * samples.length / barCount));
    let peak = 0;
    for (let cursor = start; cursor < Math.min(end, samples.length); cursor += 1) peak = Math.max(peak, Math.abs(samples[cursor]));
    return Math.max(8, Math.min(100, Math.round(peak * 100)));
  });
}

/** Convert Web Audio analyser bins into stable visual bars while recording. */
export function buildLiveAudioWaveform(bins: Uint8Array, barCount = 40): number[] {
  if (!Number.isInteger(barCount) || barCount < 1 || barCount > 256) throw new RangeError('barCount must be between 1 and 256');
  if (!bins.length) return Array(barCount).fill(8);
  return Array.from({ length: barCount }, (_, index) => {
    const start = Math.floor(index * bins.length / barCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * bins.length / barCount));
    let peak = 0;
    for (let bin = start; bin < end; bin += 1) peak = Math.max(peak, bins[bin]);
    return Math.max(8, Math.min(100, Math.round(peak * 1.45)));
  });
}
