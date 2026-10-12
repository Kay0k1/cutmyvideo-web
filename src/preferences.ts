import type { OutputSettings } from './types';
import { readStoredRecord } from './browserStorage';

export interface Preferences { output: OutputSettings; timeline_span: number; }
export const defaultPreferences: Preferences = { output: { format: 'mp4', quality: '1080p', cut_mode: 'accurate' }, timeline_span: 60000 };

export function readOutputSettings(value: unknown): OutputSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const { format, quality, cut_mode, output_mode, audio_track, no_audio, subtitle_mode } = value as Record<string, unknown>;
  if ((format !== 'mp4' && format !== 'mp3' && format !== 'mkv') || (quality !== 'best' && quality !== '1080p' && quality !== '720p') || (cut_mode !== 'accurate' && cut_mode !== 'copy')) return null;
  if (format === 'mkv' && cut_mode !== 'copy') return null;
  if (audio_track !== undefined && (typeof audio_track !== 'number' || !Number.isSafeInteger(audio_track) || audio_track < 0 || audio_track > 999)) return null;
  if (no_audio !== undefined && typeof no_audio !== 'boolean') return null;
  if (no_audio && (audio_track !== undefined || format === 'mp3')) return null;
  if (output_mode !== undefined && output_mode !== 'separate' && output_mode !== 'joined') return null;
  if (subtitle_mode !== undefined && subtitle_mode !== 'omit' && subtitle_mode !== 'preserve') return null;
  if (subtitle_mode === 'preserve' && (format === 'mp3' || cut_mode !== 'copy')) return null;
  return { format, quality, cut_mode: format === 'mp3' ? 'accurate' : cut_mode,
    ...(output_mode !== undefined ? { output_mode } : {}), ...(audio_track !== undefined ? { audio_track } : {}),
    ...(no_audio !== undefined ? { no_audio } : {}), ...(subtitle_mode !== undefined ? { subtitle_mode } : {}) };
}

// Stream indices belong to one source and must never become defaults for another.
export function withoutSourceAudio({ audio_track: _audio, no_audio: _silent, ...output }: OutputSettings): OutputSettings { return output; }

export function readPreferences(): Preferences {
  try {
    const saved = readStoredRecord('cutmyvideo.preferences', 4096);
    const output = readOutputSettings(saved?.output);
    if (!output || typeof saved.timeline_span !== 'number' || ![10000, 60000, 300000].includes(saved.timeline_span)) return defaultPreferences;
    return { output: withoutSourceAudio(output), timeline_span: saved.timeline_span };
  } catch { return defaultPreferences; }
}

export function savePreferences(value: Preferences) {
  try { localStorage.setItem('cutmyvideo.preferences', JSON.stringify({ ...value, output: withoutSourceAudio(value.output) })); } catch { /* Current settings remain functional without storage. */ }
}
