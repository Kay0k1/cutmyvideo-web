import { describe, expect, it } from 'vitest';
import { countLabel, english, translate } from './locales';
import { durationLabel, formatBytes } from './timecode';

describe('interface language', () => {
  it('uses Russian as the source language and interpolates status parameters', () => {
    expect(translate('Готово: {count} из {total}', 'ru', { count: 1, total: 3 })).toBe('Готово: 1 из 3');
    expect(translate('Готово: {count} из {total}', 'en', { count: 1, total: 3 })).toBe('Ready: 1 of 3');
  });
  it('provides English copy without Cyrillic fragments for every catalog entry', () => {
    for (const message of Object.values(english)) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/[А-Яа-яЁё]/);
    }
  });
  it('uses correct clip and file counts', () => {
    expect(countLabel(1, 'clip', 'ru')).toBe('1 фрагмент');
    expect(countLabel(4, 'clip', 'ru')).toBe('4 фрагмента');
    expect(countLabel(12, 'file', 'ru')).toBe('12 файлов');
    expect(countLabel(1, 'file', 'en')).toBe('1 file');
    expect(countLabel(2, 'clip', 'en')).toBe('2 clips');
  });
  it('localizes duration and size units', () => {
    expect(durationLabel(1250, 'en')).toBe('1.25 s');
    expect(durationLabel(61000, 'en')).toBe('1 min 1 s');
    expect(formatBytes(1024 * 1024, 'en')).toBe('1.0 MB');
    expect(formatBytes(0, 'en')).toBe('0 KB');
  });
});
