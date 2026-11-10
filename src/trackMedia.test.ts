import { describe, expect, it } from 'vitest';
import { frameCells, visibleMediaWindows } from './trackMedia';

describe('track media windows', () => {
  it('requests only windows crossing the visible part, nearest to the playhead first', () => {
    expect(visibleMediaWindows([0, 52000], 52000, 21000)).toEqual([0, 30000]);
    expect(visibleMediaWindows([0, 52000], 52000, 40000)).toEqual([30000, 0]);
    expect(visibleMediaWindows([31000, 59000], 120000, 45000)).toEqual([30000]);
    expect(visibleMediaWindows([29999, 30001], 120000, 0)).toEqual([0, 30000]);
  });
  it('keeps at most four windows of a long view around the playhead', () => {
    expect(visibleMediaWindows([0, 600000], 600000, 300000)).toEqual([300000, 270000, 330000, 240000]);
    expect(visibleMediaWindows([0, 600000], 600000, 0)).toEqual([0, 30000, 60000, 90000]);
  });
  it('ignores empty views and the time after the end of the video', () => {
    expect(visibleMediaWindows([0, 0], 52000, 0)).toEqual([]);
    expect(visibleMediaWindows([0, 120000], 52000, 0)).toEqual([0, 30000]);
    expect(visibleMediaWindows([0, 1000], 0, 0)).toEqual([]);
  });
  it('places every frame cell on its own five seconds of the visible part', () => {
    expect(frameCells([0, 12000], 12000)).toEqual([
      { ms: 0, left: 0, width: 5000 / 12000 * 100 },
      { ms: 5000, left: 5000 / 12000 * 100, width: 5000 / 12000 * 100 },
      { ms: 10000, left: 10000 / 12000 * 100, width: 2000 / 12000 * 100 },
    ]);
    const zoomed = frameCells([7000, 9000], 60000);
    expect(zoomed).toEqual([{ ms: 5000, left: -100, width: 250 }]);
  });
});
