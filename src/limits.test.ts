import { describe, expect, it } from 'vitest';
import { defaultLimits, readPublicLimits } from './limits';
import { restoreRanges, duplicateRanges } from './clipCollection';
import { validateRange } from './timecode';

describe('public resource policy', () => {
  it('uses safe defaults for old or invalid handshakes and rejects fractional/negative/unsafe limits', () => {
    for (const value of [null, undefined, [], 42, { max_source_bytes: NaN, max_ranges: -2, max_range_ms: 1.5, max_job_ms: 90 }, Object.create({ max_ranges: 5 })]) expect(readPublicLimits(value)).toEqual(defaultLimits);
  });
  it('uses lower live settings and clamps impossible client allocations', () => {
    expect(readPublicLimits({ max_source_bytes: 1024, max_ranges: 2, max_range_ms: 1000, max_job_ms: 2000 })).toEqual({ max_source_bytes: 1024, max_ranges: 2, max_range_ms: 1000, max_job_ms: 2000 });
    expect(readPublicLimits({ max_ranges: 100000 }).max_ranges).toBe(128);
  });
  it('applies dynamic count limits to new ranges while preserving existing drafts under the bounded client cap', () => {
    const range = { id: 'one', label: '', start_ms: 0, end_ms: 1000 };
    expect(duplicateRanges([range], ['one'], () => 'two', 1)).toBeNull();
    expect(duplicateRanges([range], ['one'], () => 'two', 2)?.ranges).toHaveLength(2);
    const saved = Array.from({ length: 30 }, (_, index) => ({ ...range, id: `range_${index}` }));
    expect(restoreRanges(saved, 5000, 128)).toHaveLength(30);
    expect(restoreRanges([{ ...range, end_ms: 660000 }], 3600000, 128)).toEqual([{ ...range, end_ms: 660000 }]);
    expect(validateRange(0, 3000, 5000, 2000)).toBe('Фрагмент превышает лимит сервиса. Сократите его.');
  });
});
