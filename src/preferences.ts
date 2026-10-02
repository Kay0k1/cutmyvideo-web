import type { OutputSettings } from './types';

export interface Preferences { output: OutputSettings; timeline_span: number; }
export const defaultPreferences: Preferences = { output: { format: 'mp4', quality: '1080p', cut_mode: 'accurate' }, timeline_span: 60000 };

export function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem('cutmyvideo.preferences') ?? 'null') as Preferences | null;
    if (!saved || !['mp4', 'mp3'].includes(saved.output?.format) || !['1080p', '720p', 'best'].includes(saved.output?.quality) || !['accurate', 'copy'].includes(saved.output?.cut_mode) || ![10000, 60000, 300000].includes(saved.timeline_span)) return defaultPreferences;
    return { ...saved, output: { ...saved.output, cut_mode: saved.output.format === 'mp3' ? 'accurate' : saved.output.cut_mode } };
  } catch { return defaultPreferences; }
}

export function savePreferences(value: Preferences) {
  try { localStorage.setItem('cutmyvideo.preferences', JSON.stringify(value)); } catch { /* Current settings remain functional without storage. */ }
}
