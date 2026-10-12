import { describe, expect, it } from 'vitest';
import { parseWaveform, waveformPath } from './waveform';

const valid = { start_ms: 30000, end_ms: 30250, step_ms: 100, has_audio: true, audio_track: 2, peaks: [0, .5, 1] };
describe('source waveform', () => {
  it('validates original-source positions, selected index and partial final bins', () => {
    expect(parseWaveform(valid, 30000, 30250)).toEqual(valid);
    for (const change of [{ start_ms: 0 }, { end_ms: 30300 }, { step_ms: 200 }, { peaks: [0] }, { peaks: [0, NaN, 1] }, { peaks: [0, 2, 1] }, { has_audio: false }, { audio_track: -1 }]) {
      expect(parseWaveform({ ...valid, ...change }, 30000, 30250)).toBeNull();
    }
  });
  it('keeps unknown overview areas blank and scales only original positions', () => {
    const path = waveformPath([valid], [29900, 30300], 4, 10);
    expect(path).not.toContain('M0,');
    expect(path).toContain('M1,4.50V5.50');
    expect(path).toContain('M2,2.50V7.50');
    expect(path).toContain('M3,0.00V10.00');
  });
});
