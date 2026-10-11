import type { MediaTrack, OutputSettings } from './types';

export function defaultAudioTrack(tracks: MediaTrack[]): MediaTrack | undefined {
  const audio = tracks.filter(track => track.type === 'audio').sort((a, b) => a.index - b.index);
  return audio.find(track => track.default) ?? audio[0];
}

export function audioSelection(output: OutputSettings): string {
  return output.no_audio ? 'none' : output.audio_track !== undefined ? String(output.audio_track) : 'default';
}

export function withAudioSelection(output: OutputSettings, selection: string): OutputSettings {
  const { audio_track: _track, no_audio: _silent, ...rest } = output;
  return selection === 'none' ? { ...rest, no_audio: true } : selection === 'default' ? rest : { ...rest, audio_track: Number(selection) };
}

export function supportedSubtitles(tracks: MediaTrack[]): boolean {
  const subtitles = tracks.filter(track => track.type === 'subtitle');
  return subtitles.length > 0 && subtitles.every(track => ['subrip', 'mov_text', 'webvtt', 'text'].includes(track.codec));
}

export function includedTrackIndices(tracks: MediaTrack[], output: OutputSettings): Set<number> {
  const result = new Set<number>();
  const video = tracks.filter(track => track.type === 'video' && !track.attached_picture).sort((a, b) => a.index - b.index)[0];
  if (video && output.format !== 'mp3') result.add(video.index);
  if (!output.no_audio) {
    const audio = output.audio_track === undefined ? defaultAudioTrack(tracks) : tracks.find(track => track.type === 'audio' && track.index === output.audio_track);
    if (audio) result.add(audio.index);
  }
  if (output.subtitle_mode === 'preserve') for (const track of tracks) if (track.type === 'subtitle') result.add(track.index);
  return result;
}

export function trackLabel(track: MediaTrack, t: (text: string, values?: Record<string, string | number>) => string): string {
  const kinds: Record<MediaTrack['type'], string> = { video: 'Видео', audio: 'Аудио', subtitle: 'Субтитры', data: 'Данные', attachment: 'Вложение' };
  return `${t(kinds[track.type] ?? 'Дорожка')} #${track.index} · ${[track.language, track.title, track.codec,
    track.channels ? track.channels === 1 ? t('1 канал') : t('{count} каналов', { count: track.channels }) : '',
    track.sample_rate ? `${track.sample_rate} Hz` : ''].filter(Boolean).join(' · ')}`;
}
