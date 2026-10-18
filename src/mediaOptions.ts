import type { AudioNormalize, AudioReplace, OutputCanvas } from './types';
import { storedResourceId } from './browserStorage';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

export function readAudioNormalize(value: unknown): AudioNormalize | null {
  if (!object(value) || !keys(value, ['integrated_lufs', 'true_peak_dbtp', 'loudness_range_lu'])) return null;
  const { integrated_lufs, true_peak_dbtp, loudness_range_lu } = value;
  return finite(integrated_lufs, -70, -5) && finite(true_peak_dbtp, -9, 0) && finite(loudness_range_lu, 1, 50)
    ? { integrated_lufs, true_peak_dbtp, loudness_range_lu } : null;
}

export function readOutputCanvas(value: unknown): OutputCanvas | null {
  if (!object(value) || !keys(value, ['width', 'height', 'fit', 'background'])) return null;
  const { width, height, fit, background } = value;
  return finite(width, 2, 4096) && width % 2 === 0 && finite(height, 2, 4096) && height % 2 === 0 && fit === 'contain' && typeof background === 'string' && /^#[\da-fA-F]{6}$/.test(background)
    ? { width, height, fit, background } : null;
}

/** A browser draft can refer only to a staged source, never a local path or URL. */
export function readAudioReplace(value: unknown): AudioReplace | null {
  if (!object(value) || !keys(value, ['source_id', 'audio_track', 'offset_ms'])) return null;
  const { source_id, audio_track, offset_ms } = value;
  if (!storedResourceId(source_id) || !source_id.startsWith('src_')) return null;
  if (audio_track !== undefined && (!finite(audio_track, 0, 999) || !Number.isSafeInteger(audio_track))) return null;
  if (offset_ms !== undefined && (!finite(offset_ms, -86400000, 86400000) || !Number.isSafeInteger(offset_ms))) return null;
  return { source_id, ...(audio_track !== undefined ? { audio_track } : {}), ...(offset_ms !== undefined ? { offset_ms } : {}) };
}
