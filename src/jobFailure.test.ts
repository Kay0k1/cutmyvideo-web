import { describe, expect, it } from 'vitest';
import { exportFailureMessages, exportFailureReason, repeatsFailedExport } from './jobFailure';
import { translate } from './locales';
import type { ClipRange, Job } from './types';

describe('export recovery', () => {
  it('explains a missing audio track without recommending boundaries that are already exact', () => {
    const message = exportFailureReason({ error_code: 'audio_missing' });
    expect(message).toBe('В видео нет аудиодорожки. Выберите MP4, чтобы сохранить видео.');
    expect(translate(message, 'en')).toBe('This video has no audio track. Choose MP4 to save the video.');
    expect(message).not.toContain('границы');
  });

  it('reads safe legacy diagnostics and never displays arbitrary server messages', () => {
    expect(exportFailureReason({ message: 'No supported seekable streams match these settings; upload the source instead' })).toBe(exportFailureMessages.unsupported_stream);
    expect(exportFailureReason({}, 'Source is unavailable or has expired')).toBe(exportFailureMessages.source_expired);
    const unknown = exportFailureReason({ error_code: 'future_code', message: 'https://cdn.example/private?token=secret stderr=codec' });
    expect(unknown).not.toMatch(/https|secret|stderr|future_code/);
    expect(unknown).not.toContain('точные границы');
    expect(exportFailureReason({ error_code: 'constructor' })).toBe(unknown);
    expect(exportFailureReason({ message: '__proto__' })).toBe(unknown);
    expect(exportFailureReason({ message: 'The source has changed; open it again before exporting', error_code: 'media_network_timeout' })).toBe(exportFailureMessages.media_network_timeout);
  });

  it('has complete English recovery copy for current and unknown failure codes', () => {
    for (const message of [...Object.values(exportFailureMessages), exportFailureReason({})]) {
      const english = translate(message, 'en');
      expect(english).not.toBe(message);
      expect(english).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('offers repeat export only for the same selected moments, preserving the stored job snapshot', () => {
    const ranges: ClipRange[] = [{ id: 'local-1', label: '', start_ms: 25600, end_ms: 44100 }, { id: 'local-3', label: 'Second', start_ms: 60000, end_ms: 63000 }];
    const job: Job = { id: 'job-1', status: 'failed', stage: 'finished', message: '', items: ranges.map(range => ({ ...range, id: `item-${range.id}`, status: 'failed', artifact: null })) };
    expect(repeatsFailedExport(job, ranges)).toBe(true);
    expect(repeatsFailedExport(job, ranges.slice(0, 1))).toBe(false);
    expect(repeatsFailedExport(job, [...ranges].reverse())).toBe(false);
    expect(repeatsFailedExport(job, [{ ...ranges[0], start_ms: 25000 }, ranges[1]])).toBe(false);
    expect(repeatsFailedExport(job, [{ ...ranges[0], label: 'Edited' }, ranges[1]])).toBe(false);
    expect(repeatsFailedExport({ ...job, status: 'succeeded' }, ranges)).toBe(false);
    expect(repeatsFailedExport(null, ranges)).toBe(false);
    expect(job.items[0].start_ms).toBe(25600);
  });
});
