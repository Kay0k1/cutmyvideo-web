import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAudioNormalize, readAudioReplace, readOutputCanvas } from './mediaOptions';
import { readOutputSettings, readPreferences, savePreferences } from './preferences';
import { exportCuttingPlan, importCuttingPlan } from './cuttingProjects';
import { jobRequestBody } from './api';
import { recoverExportRequest } from './exportRetry';
import type { ClipRange, OutputSettings } from './types';

const cuts: ClipRange[] = [{ id: 'clip1', label: 'First', start_ms: 0, end_ms: 1500 }];
const output: OutputSettings = { format: 'mp4', quality: 'best', cut_mode: 'accurate', output_mode: 'joined',
  audio_normalize: { integrated_lufs: -16, true_peak_dbtp: -1, loudness_range_lu: 11 },
  canvas: { width: 180, height: 320, fit: 'contain', background: '#123456' },
  audio_replace: { source_id: 'src_recording', offset_ms: 250, audio_track: 1 } };
afterEach(() => vi.unstubAllGlobals());

describe('media enhancements persistence and transport', () => {
  it('restores a full source-scoped draft and reconstructs canonical job bytes regardless of property order', () => {
    const restored = readOutputSettings({ ...output, audio_replace: { audio_track: 1, offset_ms: 250, source_id: 'src_recording' }, canvas: { background: '#123456', fit: 'contain', height: 320, width: 180 } });
    expect(restored).toEqual(output);
    expect(jobRequestBody('src_primary', cuts, restored!)).toBe(jobRequestBody('src_primary', cuts, output));
    const body = JSON.parse(jobRequestBody('src_primary', cuts, output));
    expect(body.audio_normalize).toEqual(output.audio_normalize); expect(body.canvas).toEqual(output.canvas); expect(body.audio_replace).toEqual(output.audio_replace);
  });
  it('retains a known request for recovery and changes retry identity when any enhancement changes', () => {
    const attempt = { fingerprint: jobRequestBody('src_primary', cuts, output), key: 'same_key' };
    expect(recoverExportRequest('src_primary', cuts, readOutputSettings(output)!, attempt)?.output).toEqual(output);
    for (const changed of [
      { ...output, audio_normalize: { ...output.audio_normalize!, integrated_lufs: -18 } },
      { ...output, canvas: { ...output.canvas!, background: '#000000' } },
      { ...output, audio_replace: { ...output.audio_replace!, offset_ms: -250 } },
      { ...output, audio_replace: { ...output.audio_replace!, source_id: 'src_another' } },
    ]) expect(recoverExportRequest('src_primary', cuts, changed, attempt)).toBeNull();
  });
  it('keeps replacement references out of new-source preferences', () => {
    const defaults = { ...output }; delete defaults.audio_replace;
    const setItem = vi.fn(); vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ output, timeline_span: 60000 }), setItem });
    expect(readPreferences().output).toEqual(defaults);
    savePreferences({ output, timeline_span: 60000 });
    expect(JSON.parse(setItem.mock.calls[0][1]).output).toEqual(defaults);
  });
  it('exports portable normalization and canvas settings without server-only references or cleanup policy', () => {
    const plan = exportCuttingPlan('video.mp4', cuts, { ...output, cleanup_source: true });
    expect(plan.options.audio_normalize).toEqual(output.audio_normalize); expect(plan.options.canvas).toEqual(output.canvas);
    expect(JSON.stringify(plan)).not.toContain('src_recording'); expect(plan.options).not.toHaveProperty('cleanup_source');
    const imported = importCuttingPlan(JSON.stringify(plan), 5000, () => 'restored');
    expect(imported.output.canvas).toEqual(output.canvas); expect(imported.output.audio_normalize).toEqual(output.audio_normalize); expect(imported.output.audio_replace).toBeUndefined();
    for (const replacement of [{ source_id: 'src_foreign' }, { input: '/private/recording.wav' }]) {
      expect(() => importCuttingPlan(JSON.stringify({ ...plan, options: { ...plan.options, audio_replace: replacement } }), 5000, () => 'restored')).toThrow('Подключите внешний звук');
    }
  });
  it('rejects nonfinite targets, malformed or oversized canvases and untrusted replacement shapes', () => {
    for (const value of [NaN, Infinity, -Infinity, -71, -4]) expect(readAudioNormalize({ ...output.audio_normalize, integrated_lufs: value })).toBeNull();
    expect(readAudioNormalize({ integrated_lufs: -16, true_peak_dbtp: 0, loudness_range_lu: 1 })).not.toBeNull();
    for (const width of [NaN, 1, 3, 180.5, 4098]) expect(readOutputCanvas({ ...output.canvas, width })).toBeNull();
    for (const replacement of [{ source_id: 'https://example.com/a.wav' }, { source_id: 'src_valid', input: '/private/a.wav' }, { source_id: 'src_valid', offset_ms: 1.5 }, { source_id: 'src_valid', offset_ms: 86400001 }, { source_id: 'src_valid', audio_track: 1000 }]) expect(readAudioReplace(replacement)).toBeNull();
    expect(readAudioReplace({ source_id: 'src_valid', offset_ms: -86400000, audio_track: 0 })).toEqual({ source_id: 'src_valid', offset_ms: -86400000, audio_track: 0 });
  });
  it('rejects invalid saved enhancement objects as a whole rather than silently dropping requested effects', () => {
    expect(readOutputSettings({ ...output, canvas: { ...output.canvas, width: 181 } })).toBeNull();
    expect(readOutputSettings({ ...output, audio_normalize: { ...output.audio_normalize, true_peak_dbtp: null } })).toBeNull();
    // An incompatible but well-formed draft remains editable; the UI explains
    // the conflict and offers a deliberate compatible-settings action.
    expect(readOutputSettings({ ...output, format: 'mkv', cut_mode: 'copy' })?.audio_normalize).toEqual(output.audio_normalize);
  });
});
