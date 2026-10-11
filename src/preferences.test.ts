import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPreferences, readOutputSettings, readPreferences, savePreferences } from './preferences';

afterEach(() => vi.unstubAllGlobals());

describe('persisted export settings', () => {
  it('normalizes MP3 and strips fields from older settings before using them in the API', () => {
    expect(readOutputSettings({ format: 'mp3', quality: 'best', cut_mode: 'copy', legacy: true })).toEqual({ format: 'mp3', quality: 'best', cut_mode: 'accurate' });
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ output: { format: 'mp4', quality: '720p', cut_mode: 'copy', legacy: true }, timeline_span: 10000, obsolete: true }) });
    expect(readPreferences()).toEqual({ output: { format: 'mp4', quality: '720p', cut_mode: 'copy' }, timeline_span: 10000 });
  });
  it('rejects invalid and unavailable browser storage', () => {
    for (const value of [null, 42, {}, { format: 'mp3', quality: 'unknown', cut_mode: 'copy' }]) expect(readOutputSettings(value)).toBeNull();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('storage unavailable'); } });
    expect(readPreferences()).toEqual(defaultPreferences);
  });
  it('restores a source-specific selection only in the draft, keeping new-source defaults clean', () => {
    const output = { format: 'mkv', quality: 'best', cut_mode: 'copy', output_mode: 'joined', audio_track: 2, subtitle_mode: 'preserve' };
    expect(readOutputSettings(output)).toEqual(output);
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ output, timeline_span: 60000 }), setItem });
    const { audio_track: _audio, ...defaults } = output;
    expect(readPreferences().output).toEqual(defaults);
    savePreferences({ output: readOutputSettings(output)!, timeline_span: 60000 });
    expect(JSON.parse(setItem.mock.calls[0][1]).output).toEqual(defaults);
  });
  it.each([
    { format: 'mkv', cut_mode: 'accurate' }, { audio_track: -1 }, { audio_track: 1.5 },
    { audio_track: 2, no_audio: true }, { format: 'mp3', no_audio: true },
    { output_mode: 'unknown' }, { subtitle_mode: 'preserve', cut_mode: 'accurate' },
  ])('does not restore incompatible output combinations %o', invalid => {
    expect(readOutputSettings({ format: 'mp4', quality: 'best', cut_mode: 'copy', ...invalid })).toBeNull();
  });
});
