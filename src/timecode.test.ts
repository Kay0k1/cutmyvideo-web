import { describe, expect, it } from 'vitest';
import { formatTimecode, parseTimecode, validateRange, zoomWindow } from './timecode';

describe('source timeline values', () => {
  it('accepts multi-hour times, total minutes and decimal seconds', () => {
    expect(parseTimecode('03:12:08.125')).toBe(11528125);
    expect(parseTimecode('83:10')).toBe(4990000);
    expect(parseTimecode('8,025')).toBe(8025);
  });
  it('rejects ambiguous or malformed fields without normalizing them silently', () => {
    for (const text of ['1:60', '00:60:10', '-1', '1:2:3:4', '1.0001', 'abc', '']) {
      expect(parseTimecode(text)).toBeNull();
    }
  });
  it('roundtrips millisecond boundaries', () => {
    for (const ms of [0, 100, 59999, 3600000, 10845293]) {
      expect(parseTimecode(formatTimecode(ms, true))).toBe(ms);
    }
  });
  it('rejects reversed, out-of-source and subminimum selections', () => {
    expect(validateRange(1000, 900, 5000)).not.toBeNull();
    expect(validateRange(1000, 5100, 5000)).not.toBeNull();
    expect(validateRange(1000, 1050, 5000)).not.toBeNull();
    expect(validateRange(1000, 1100, 5000)).toBeNull();
  });
  it('keeps zoom windows inside the source at both edges', () => {
    expect(zoomWindow(10800000, 1000, 60000)).toEqual([0, 60000]);
    expect(zoomWindow(10800000, 10799000, 60000)).toEqual([10740000, 10800000]);
    expect(zoomWindow(12000, 6000, 60000)).toEqual([0, 12000]);
  });
});
