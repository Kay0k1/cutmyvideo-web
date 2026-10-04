import { describe, expect, it } from 'vitest';
import { duplicateRanges, markBounds, rangeSelection, removeRanges, restoreRanges, restoredStep } from './clipCollection';
import type { ClipRange } from './types';

const ranges: ClipRange[] = [
  { id: 'one', label: 'Opening', start_ms: 1250, end_ms: 3750 },
  { id: 'two', label: 'Later', start_ms: 6000, end_ms: 8000 },
];

describe('clip selection and workflow restoration', () => {
  it('recovers valid clips from malformed storage without duplicate IDs or invalid API bounds', () => {
    expect(restoreRanges([null, 42, {}, ranges[0], ranges[0], { ...ranges[1], start_ms: 6000.5 }, { ...ranges[1], end_ms: 50000 }, { ...ranges[1], label: 'я'.repeat(101) }, ranges[1]], 12000)).toEqual(ranges);
    expect(restoreRanges({}, 12000)).toEqual([]);
    expect(restoreRanges([], 12000)).toEqual([]);
  });
  it('migrates the old export step without changing the new clip-list step', () => {
    expect(restoredStep(3, undefined)).toBe(4);
    expect(restoredStep(3, 2)).toBe(3);
    expect(restoredStep(2, undefined)).toBe(2);
    expect(restoredStep(99, 2)).toBeUndefined();
  });
  it('defaults old drafts to all clips while preserving an intentionally empty or partial selection', () => {
    expect(rangeSelection(ranges, undefined)).toEqual(['one', 'two']);
    expect(rangeSelection(ranges, [])).toEqual([]);
    expect(rangeSelection(ranges, ['two', 'missing', 'two', 7])).toEqual(['two']);
  });
  it('duplicates only included clips in source order with exact bounds and independent IDs', () => {
    let next = 0;
    const result = duplicateRanges(ranges, ['two', 'one'], () => `copy-${++next}`)!;
    expect(result.ranges.slice(2)).toEqual([{ ...ranges[0], id: 'copy-1' }, { ...ranges[1], id: 'copy-2' }]);
    expect(result.addedIds).toEqual(['copy-1', 'copy-2']);
    expect(ranges).toHaveLength(2);
    expect(duplicateRanges(Array.from({ length: 12 }, (_, index) => ({ ...ranges[0], id: String(index) })), ['0'], () => 'extra')).toBeNull();
  });
  it('allows explicit removal of every clip and ignores selections from another source', () => {
    expect(removeRanges(ranges, ['one', 'two'])).toEqual([]);
    expect(removeRanges(ranges, ['missing', 'one'])).toEqual([ranges[1]]);
  });
  it('starts a distant moment without trapping the user behind the old end marker', () => {
    const defaultMoment = { ...ranges[0], start_ms: 0, end_ms: 30000 };
    expect(markBounds(defaultMoment, 5_400_000, 'start', 10_800_000)).toEqual([5_400_000, 5_430_000]);
    expect(markBounds(defaultMoment, 10_790_000, 'start', 10_800_000)).toEqual([10_790_000, 10_800_000]);
    expect(markBounds({ ...defaultMoment, start_ms: 60000, end_ms: 90000 }, 45000, 'end', 10_800_000)).toEqual([15000, 45000]);
  });
});
