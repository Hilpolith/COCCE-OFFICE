import { describe, expect, it } from 'vitest';
import { buildAudioWaveform, buildLiveAudioWaveform } from './officeAudioWaveform';

describe('office audio waveforms', () => {
  it('creates normalized peak bars for decoded audio', () => {
    const bars = buildAudioWaveform(new Float32Array([0, 0.1, -0.4, 0.9, -1]));
    expect(bars).toHaveLength(40);
    expect(Math.max(...bars)).toBe(100);
    expect(bars.every((bar) => bar >= 8 && bar <= 100)).toBe(true);
  });
  it('returns a quiet placeholder for empty decoded audio', () => {
    expect(buildAudioWaveform(new Float32Array(), 5)).toEqual([8, 8, 8, 8, 8]);
  });
  it('maps live analyser bins to bounded bars', () => {
    const bars = buildLiveAudioWaveform(new Uint8Array([0, 30, 90, 180, 255]), 5);
    expect(bars).toHaveLength(5);
    expect(bars[0]).toBe(8);
    expect(bars[4]).toBe(100);
    expect(bars.every((bar) => bar >= 8 && bar <= 100)).toBe(true);
  });
  it('rejects invalid bar counts', () => {
    expect(() => buildAudioWaveform(new Float32Array(), 0)).toThrow(RangeError);
    expect(() => buildLiveAudioWaveform(new Uint8Array(), 257)).toThrow(RangeError);
  });
});
