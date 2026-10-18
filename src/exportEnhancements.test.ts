import { describe, expect, it } from 'vitest';
import { audioOffsetFromText, canvasPicturePercent, compatibleEnhancementSettings, DEFAULT_CANVAS, DEFAULT_NORMALIZATION, enhancementConflict, loudnessWindow, replacementFileError, replacementSourceAvailable, replacementTracks, replacementTrackState, validCanvas, validNormalization } from './exportEnhancementModel';
import type { MediaTrack, OutputSettings, Source } from './types';

const base: OutputSettings = { format: 'mp4', quality: '1080p', cut_mode: 'accurate' };
const source: Source = { id: 'primary', kind: 'upload', title: 'video.mp4', duration_ms: 4000, width: 1920, height: 1080, preview_url: null, embed_url: null, thumbnail_url: null };

describe('optional export processing', () => {
  it('keeps ordinary exports and copy settings untouched when no tool is enabled', () => {
    const ordinary: OutputSettings = { ...base, cut_mode: 'copy', format: 'mkv', subtitle_mode: 'preserve', no_audio: true };
    expect(enhancementConflict(ordinary)).toBe('');
    expect(compatibleEnhancementSettings(ordinary)).toBe(ordinary);
  });
  it('makes the explicit compatible action retain all effects and unrelated export choices', () => {
    const original: OutputSettings = { ...base, format: 'mkv', cut_mode: 'copy', subtitle_mode: 'preserve', no_audio: true, audio_track: 9,
      output_mode: 'joined', cleanup_source: false, crop: { x: .25, y: 0, width: .5, height: 1 },
      canvas: { ...DEFAULT_CANVAS }, audio_normalize: { ...DEFAULT_NORMALIZATION }, audio_replace: { source_id: 'recorder', audio_track: 3, offset_ms: 500 } };
    const saved = structuredClone(original);
    expect(enhancementConflict(original)).not.toBe('');
    const next = compatibleEnhancementSettings(original);
    expect(next).toMatchObject({ format: 'mp4', cut_mode: 'accurate', quality: 'best', subtitle_mode: 'omit', output_mode: 'joined', cleanup_source: false, audio_replace: original.audio_replace, canvas: original.canvas, audio_normalize: original.audio_normalize, crop: original.crop });
    expect(next.no_audio).toBeUndefined(); expect(next.audio_track).toBeUndefined();
    expect(enhancementConflict(next)).toBe(''); expect(original).toEqual(saved);
  });
  it('retains MP3 and video quality when only sound needs a compatible mode', () => {
    expect(compatibleEnhancementSettings({ ...base, format: 'mp3', audio_normalize: DEFAULT_NORMALIZATION })).toMatchObject({ format: 'mp3', quality: '1080p' });
  });
  it('blocks silent sound effects, incompatible canvas format/quality and primary-track selection', () => {
    for (const output of [
      { ...base, audio_normalize: DEFAULT_NORMALIZATION, no_audio: true },
      { ...base, canvas: DEFAULT_CANVAS },
      { ...base, quality: 'best' as const, format: 'mp3' as const, canvas: DEFAULT_CANVAS },
      { ...base, audio_replace: { source_id: 'recorder' }, audio_track: 1 },
      { ...base, audio_replace: { source_id: 'recorder', offset_ms: .25 } },
      { ...base, audio_replace: { source_id: 'recorder', audio_track: -1 } },
    ]) expect(enhancementConflict(output)).not.toBe('');
  });
  it('validates every normalization target including a real zero peak', () => {
    expect(validNormalization(DEFAULT_NORMALIZATION)).toBe(true);
    expect(validNormalization({ integrated_lufs: -70, true_peak_dbtp: 0, loudness_range_lu: 50 })).toBe(true);
    for (const value of [null, {}, { ...DEFAULT_NORMALIZATION, integrated_lufs: NaN }, { ...DEFAULT_NORMALIZATION, integrated_lufs: -4 }, { ...DEFAULT_NORMALIZATION, true_peak_dbtp: Infinity }, { ...DEFAULT_NORMALIZATION, loudness_range_lu: 0 }]) expect(validNormalization(value)).toBe(false);
  });
  it('validates explicit canvas pixel limits, even sizes and solid colors', () => {
    expect(validCanvas(DEFAULT_CANVAS)).toBe(true);
    expect(validCanvas({ ...DEFAULT_CANVAS, width: 2, height: 4096, background: '#aBcDeF' })).toBe(true);
    for (const value of [null, {}, { ...DEFAULT_CANVAS, width: 1081 }, { ...DEFAULT_CANVAS, height: 0 }, { ...DEFAULT_CANVAS, width: 4098 }, { ...DEFAULT_CANVAS, fit: 'cover' }, { ...DEFAULT_CANVAS, background: 'red' }, { ...DEFAULT_CANVAS, background: '#12345678' }]) expect(validCanvas(value)).toBe(false);
  });
  it('parses a signed source-clock offset without truncating, rounding or accepting exponents', () => {
    for (const [text, offset] of [['+500', 500], ['-250', -250], [' 0 ', 0], ['86400000', 86400000], ['-86400000', -86400000]] as const) expect(audioOffsetFromText(text)).toBe(offset);
    for (const text of ['', ' ', '1.5', '1e3', 'NaN', 'Infinity', '86400001', '-86400001', '1 000', '0x10']) expect(audioOffsetFromText(text)).toBeNull();
  });
  it('uses an exact chosen analysis window and rejects an uncovered or overlong interval', () => {
    expect(loudnessWindow(source)).toEqual({ start_ms: 0, end_ms: 4000 });
    expect(loudnessWindow(source, { start_ms: 1250, end_ms: 3999 })).toEqual({ start_ms: 1250, end_ms: 3999 });
    for (const range of [{ start_ms: -1, end_ms: 1000 }, { start_ms: 0, end_ms: 4001 }, { start_ms: 0, end_ms: 0 }, { start_ms: .5, end_ms: 1000 }]) expect(loudnessWindow(source, range)).toBeNull();
    expect(loudnessWindow({ ...source, duration_ms: 1800001 })).toBeNull();
    expect(loudnessWindow({ ...source, duration_ms: 1800001 }, { start_ms: 1, end_ms: 1800001 })).not.toBeNull();
  });
  it('accepts audio recordings without the primary-video container restrictions', () => {
    for (const name of ['recorder.wav', 'voice.MP3', 'voice.m4a', 'recording.flac', 'voice.ogg', 'camera.mp4']) expect(replacementFileError({ name, size: 20, type: '' }, 100)).toBe('');
    expect(replacementFileError({ name: 'recorder', size: 20, type: 'audio/wav' }, 100)).toBe('');
    expect(replacementFileError({ name: 'voice.wav', size: 0, type: 'audio/wav' }, 100)).not.toBe('');
    expect(replacementFileError({ name: 'voice.wav', size: 101, type: 'audio/wav' }, 100)).not.toBe('');
    expect(replacementFileError({ name: 'notes.txt', size: 20, type: 'text/plain' }, 100)).not.toBe('');
  });
  it('allows only a different ready owned upload and inspected 1–8 channel audio', () => {
    expect(replacementSourceAvailable({ ...source, id: 'other' }, source.id)).toBe(true);
    for (const invalid of [source, { ...source, id: 'other', kind: 'direct' as const }, { ...source, id: 'other', media_removed: true }]) expect(replacementSourceAvailable(invalid, source.id)).toBe(false);
    const tracks: MediaTrack[] = [{ index: 7, type: 'audio', codec: 'aac', channels: 2 }, { index: 3, type: 'audio', codec: 'pcm_s16le', channels: 1 }, { index: 1, type: 'video', codec: 'h264' }, { index: 5, type: 'audio', codec: 'aac', channels: 9 }, { index: 9, type: 'audio', codec: 'aac' }, { index: -1, type: 'audio', codec: 'aac', channels: 2 }];
    expect(replacementTracks(tracks).map(track => track.index)).toEqual([3, 7]);
  });
  it('previews contain padding using the already cropped displayed picture', () => {
    const landscape = canvasPicturePercent(source, DEFAULT_CANVAS)!;
    expect(landscape.width).toBe(100); expect(landscape.height).toBeCloseTo(31.640625);
    expect(canvasPicturePercent(source, { ...DEFAULT_CANVAS, width: 1080, height: 1080 }, { x: .25, y: 0, width: .5, height: 1 })).toEqual({ width: 88.88888888888889, height: 100 });
    expect(canvasPicturePercent({}, DEFAULT_CANVAS)).toBeNull();
  });
  it('does not redefine the server default when its channel layout is unsupported', () => {
    const inspected: MediaTrack[] = [{ index: 1, type: 'audio', codec: 'aac', channels: 9, default: true }, { index: 3, type: 'audio', codec: 'aac', channels: 2 }];
    const actual = replacementTrackState(inspected);
    expect(actual.defaultIndex).toBe(1);
    expect(actual.tracks.map(track => track.index)).toEqual([3]);
    expect(actual.tracks.find(track => track.index === actual.defaultIndex)).toBeUndefined();
  });
});
