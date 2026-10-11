import { describe, expect, it } from 'vitest';
import { audioSelection, defaultAudioTrack, includedTrackIndices, supportedSubtitles, withAudioSelection } from './mediaTracks';
import type { MediaTrack, OutputSettings } from './types';

const output: OutputSettings = { format: 'mp4', quality: 'best', cut_mode: 'copy', output_mode: 'joined' };
const audio: MediaTrack[] = [{ index: 7, type: 'audio', codec: 'aac' }, { index: 2, type: 'audio', codec: 'aac', default: true }];

describe('source track selection', () => {
  it('uses the disposition default and otherwise the lowest absolute stream index', () => {
    expect(defaultAudioTrack(audio)?.index).toBe(2);
    expect(defaultAudioTrack(audio.map(track => ({ ...track, default: false })))?.index).toBe(2);
    expect(defaultAudioTrack([])).toBeUndefined();
  });
  it('keeps preview/export selection exclusive and resets to the documented default', () => {
    const selected = withAudioSelection(output, '7');
    expect(selected).toEqual({ ...output, audio_track: 7 });
    const silent = withAudioSelection(selected, 'none');
    expect(silent).toEqual({ ...output, no_audio: true });
    expect(audioSelection(silent)).toBe('none');
    expect(withAudioSelection(silent, 'default')).toEqual(output);
  });
  it('offers text preservation only when all source subtitles are supported', () => {
    const text: MediaTrack = { index: 9, type: 'subtitle', codec: 'subrip' };
    expect(supportedSubtitles([...audio, text])).toBe(true);
    expect(supportedSubtitles([...audio, text, { ...text, index: 10, codec: 'ass' }])).toBe(false);
    expect(supportedSubtitles(audio)).toBe(false);
  });
  it('shows the selected source streams while excluding cover images and extra streams', () => {
    const tracks: MediaTrack[] = [{ index: 0, type: 'video', codec: 'mjpeg', attached_picture: true },
      { index: 3, type: 'video', codec: 'h264' }, { index: 5, type: 'video', codec: 'h264' }, ...audio,
      { index: 9, type: 'subtitle', codec: 'subrip' }, { index: 10, type: 'attachment', codec: 'ttf' }];
    expect([...includedTrackIndices(tracks, { ...output, audio_track: 7, subtitle_mode: 'preserve' })]).toEqual([3, 7, 9]);
    expect([...includedTrackIndices(tracks, { ...output, no_audio: true })]).toEqual([3]);
    expect([...includedTrackIndices(tracks, { ...output, format: 'mp3' })]).toEqual([2]);
  });
});
