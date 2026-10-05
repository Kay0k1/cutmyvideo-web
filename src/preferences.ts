import type { OutputSettings } from './types';
import { readStoredRecord } from './browserStorage';

export interface Preferences { output: OutputSettings; timeline_span: number; }
export const defaultPreferences: Preferences = { output: { format: 'mp4', quality: '1080p', cut_mode: 'accurate' }, timeline_span: 60000 };

export function readOutputSettings(value: unknown): OutputSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const { format, quality, cut_mode } = value as Record<string, unknown>;
  if ((format !== 'mp4' && format !== 'mp3') || (quality !== 'best' && quality !== '1080p' && quality !== '720p') || (cut_mode !== 'accurate' && cut_mode !== 'copy')) return null;
  return { format, quality, cut_mode: format === 'mp3' ? 'accurate' : cut_mode };
}

export function readPreferences(): Preferences {
  try {
    const saved = readStoredRecord('cutmyvideo.preferences', 4096);
    const output = readOutputSettings(saved?.output);
    if (!output || typeof saved.timeline_span !== 'number' || ![10000, 60000, 300000].includes(saved.timeline_span)) return defaultPreferences;
    return { output, timeline_span: saved.timeline_span };
  } catch { return defaultPreferences; }
}

export function savePreferences(value: Preferences) {
  try { localStorage.setItem('cutmyvideo.preferences', JSON.stringify(value)); } catch { /* Current settings remain functional without storage. */ }
}
