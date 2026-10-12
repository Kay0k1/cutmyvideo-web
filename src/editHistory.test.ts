import { describe, expect, it } from 'vitest';
import { beginGesture, emptyHistory, finishGesture, historyLimit, rememberEdit, redoEdit, undoEdit } from './editHistory';

describe('project edit history', () => {
  it('coalesces an entire gesture and keeps independent project histories', () => {
    const a = emptyHistory<{ start: number }>(), b = emptyHistory<{ start: number }>();
    beginGesture(a, { start: 0 });
    for (let start = 1; start < 20; start++) rememberEdit(a, { start });
    finishGesture(a, { start: 20 });
    expect(a.past).toEqual([{ start: 0 }]);
    expect(undoEdit(a, { start: 20 })).toEqual({ start: 0 });
    expect(redoEdit(a, { start: 0 })).toEqual({ start: 20 });
    expect(b.past).toEqual([]);
  });
  it('preserves redo after a no-op focus/blur and discards it after a real edit', () => {
    const h = emptyHistory<number>(); rememberEdit(h, 1);
    expect(undoEdit(h, 2)).toBe(1);
    beginGesture(h, 1); finishGesture(h, 1);
    expect(h.past).toEqual([]); expect(h.future).toEqual([2]);
    beginGesture(h, 1); finishGesture(h, 3);
    expect(h.future).toEqual([]); expect(undoEdit(h, 3)).toBe(1);
  });
  it('bounds stored snapshots and clones nested mutable values', () => {
    const h = emptyHistory<{ values: number[] }>(); const value = { values: [1] };
    rememberEdit(h, value); value.values.push(2);
    expect(h.past[0].values).toEqual([1]);
    for (let index = 0; index < 100; index++) rememberEdit(h, { values: [index] });
    expect(h.past).toHaveLength(historyLimit);
  });
});
