import type { AudioNormalize, MediaTrack, OutputCanvas, OutputSettings, Source } from './types';
import { defaultAudioTrack } from './mediaTracks';
import { readAudioNormalize, readOutputCanvas } from './mediaOptions';

export const DEFAULT_NORMALIZATION: AudioNormalize = { integrated_lufs: -16, true_peak_dbtp: -1, loudness_range_lu: 11 };
export const DEFAULT_CANVAS: OutputCanvas = { width: 1080, height: 1920, fit: 'contain', background: '#000000' };
export const MAX_AUDIO_OFFSET_MS = 86400000;
export const MAX_ANALYSIS_WINDOW_MS = 30 * 60 * 1000;

export function activeEnhancementLabels(output: OutputSettings): string[] {
  return [output.audio_normalize ? 'Выровненная громкость' : '', output.canvas ? 'Размер кадра и фон' : '', output.audio_replace ? 'Замена звука' : ''].filter(Boolean);
}

export function validNormalization(value: unknown): value is AudioNormalize {
  return readAudioNormalize(value) !== null;
}

export function validCanvas(value: unknown): value is OutputCanvas {
  return readOutputCanvas(value) !== null;
}

/** Parsing never changes a fraction, exponent, blank or out-of-range offset into a different time. */
export function audioOffsetFromText(value: string): number | null {
  if (!/^[+-]?\d+$/.test(value.trim())) return null;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && Math.abs(offset) <= MAX_AUDIO_OFFSET_MS ? offset : null;
}

export function enhancementConflict(output: OutputSettings): string {
  if (!output.audio_normalize && !output.canvas && !output.audio_replace) return '';
  if (output.cut_mode !== 'accurate' || output.format === 'mkv' || output.subtitle_mode === 'preserve')
    return 'Дополнительная обработка требует точного MP4 или MP3 без субтитров.';
  if (output.canvas && (output.format !== 'mp4' || output.quality !== 'best'))
    return 'Размер кадра и фон требуют точного MP4 и качества «Лучшее доступное».';
  if ((output.audio_normalize || output.audio_replace) && output.no_audio)
    return 'Обработка звука несовместима с режимом «Без звука».';
  if (output.audio_replace && output.audio_track !== undefined)
    return 'Для замены звука выберите дорожку в аудиофайле замены.';
  if (output.audio_normalize && !validNormalization(output.audio_normalize))
    return 'Проверьте целевую громкость, пик и диапазон громкости.';
  if (output.canvas && !validCanvas(output.canvas))
    return 'Размеры должны быть чётными числами от 2 до 4096, а фон — цветом #RRGGBB.';
  if (output.audio_replace && (!output.audio_replace.source_id || (output.audio_replace.audio_track !== undefined
    && (!Number.isSafeInteger(output.audio_replace.audio_track) || output.audio_replace.audio_track < 0))
    || audioOffsetFromText(String(output.audio_replace.offset_ms ?? 0)) === null))
    return 'Проверьте аудиофайл замены, дорожку и сдвиг звука.';
  return '';
}

/** Only the explicit compatibility action calls this; changing another control never discards an effect. */
export function compatibleEnhancementSettings(output: OutputSettings): OutputSettings {
  if (!output.audio_normalize && !output.canvas && !output.audio_replace) return output;
  const next: OutputSettings = { ...output, format: output.canvas || output.format === 'mkv' ? 'mp4' : output.format,
    cut_mode: 'accurate', subtitle_mode: 'omit', ...(output.canvas ? { quality: 'best' } : {}) };
  if (output.audio_normalize || output.audio_replace) delete next.no_audio;
  if (output.audio_replace) delete next.audio_track;
  return next;
}

export function replacementTracks(tracks: MediaTrack[]): MediaTrack[] {
  return tracks.filter(track => track.type === 'audio' && Number.isSafeInteger(track.index) && track.index >= 0
    && Number.isInteger(track.channels) && track.channels! >= 1 && track.channels! <= 8).sort((a, b) => a.index - b.index);
}

export function replacementTrackState(inspected: MediaTrack[]): { tracks: MediaTrack[]; defaultIndex?: number } {
  // Preserve the exporter's default before filtering unsupported channel layouts.
  // Otherwise a supported second track could be displayed while the server uses a different first/default track.
  return { tracks: replacementTracks(inspected), defaultIndex: defaultAudioTrack(inspected)?.index };
}

export function replacementSourceAvailable(source: Source, primaryID: string): boolean {
  return source.id !== primaryID && source.kind === 'upload' && !source.media_removed;
}

/** MIME is a picker hint; the owned upload's inspected streams are the authoritative check. */
export function replacementFileError(file: Pick<File, 'name' | 'size' | 'type'>, maximumBytes: number): string {
  if (!file.size) return 'Файл пустой. Выберите другую аудиозапись.';
  if (file.size > maximumBytes) return 'Файл превышает лимит сервиса. Выберите файл меньшего размера.';
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  return file.type.startsWith('audio/') || ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'mkv', 'webm'].includes(extension ?? '')
    ? '' : 'Выберите аудиозапись WAV, MP3, M4A, AAC, FLAC, Ogg или видео со звуком.';
}

/** Refuse an overlong selected window instead of silently measuring only its beginning. */
export function loudnessWindow(source: Source, range?: { start_ms: number; end_ms: number }): { start_ms: number; end_ms: number } | null {
  const start_ms = range?.start_ms ?? 0;
  const end_ms = range?.end_ms ?? source.duration_ms;
  return Number.isSafeInteger(start_ms) && Number.isSafeInteger(end_ms) && start_ms >= 0 && end_ms > start_ms
    && end_ms <= source.duration_ms && end_ms - start_ms <= MAX_ANALYSIS_WINDOW_MS ? { start_ms, end_ms } : null;
}

export function canvasPicturePercent(source: Pick<Source, 'width' | 'height'>, canvas: OutputCanvas, crop?: OutputSettings['crop']): { width: number; height: number } | null {
  if (!source.width || !source.height || !Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0 || !validCanvas(canvas)) return null;
  const ratio = source.width * (crop?.width ?? 1) / (source.height * (crop?.height ?? 1));
  const outer = canvas.width / canvas.height;
  return ratio > outer ? { width: 100, height: outer / ratio * 100 } : { width: ratio / outer * 100, height: 100 };
}
