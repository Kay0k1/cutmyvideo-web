import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPreferences, readOutputSettings, readPreferences } from './preferences';

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
});
