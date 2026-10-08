import { describe, expect, it } from 'vitest';
import { keyboardTrimValue, pointerSeekValue, pointerTrimValue } from './timelineControls';

describe('compact timeline controls', () => {
  it('retains exact time and moves by the pointer delta anywhere in the hit area', () => {
    expect(pointerTrimValue(1250, 0, 500, 60000)).toBe(1250);
    expect(pointerTrimValue(1250, 50, 500, 60000)).toBe(7250);
    expect(pointerTrimValue(44100, -50, 500, 60000)).toBe(38100);
    expect(pointerTrimValue(1250, 0, 0, 60000)).toBe(1250);
    expect(pointerTrimValue(1250, 20, 200, 60000)).toBe(7250);
  });

  it('keeps short selections within the dependent boundary limits', () => {
    expect(keyboardTrimValue('ArrowRight', 25600, 0, 25650)).toBe(25650);
    expect(keyboardTrimValue('ArrowLeft', 25750, 25700, 994000)).toBe(25700);
    expect(keyboardTrimValue('Home', 44100, 25700, 994000)).toBe(25700);
    expect(keyboardTrimValue('End', 25600, 0, 44000)).toBe(44000);
  });

  it('supports fine, Shift and page adjustments without handling unrelated shortcuts', () => {
    expect(keyboardTrimValue('ArrowUp', 1250, 0, 60000)).toBe(1350);
    expect(keyboardTrimValue('ArrowDown', 1250, 0, 60000, true)).toBe(250);
    expect(keyboardTrimValue('PageUp', 1250, 0, 60000)).toBe(6250);
    expect(keyboardTrimValue('PageDown', 1250, 0, 60000)).toBe(0);
    expect(keyboardTrimValue(' ', 1250, 0, 60000)).toBeNull();
  });

  it('seeks inside a zoomed middle section rather than multiplying its offset', () => {
    expect(pointerSeekValue(350, 100, 500, [4_990_000, 5_050_000])).toBe(5_020_000);
    expect(pointerSeekValue(100, 100, 500, [4_990_000, 5_050_000])).toBe(4_990_000);
    expect(pointerSeekValue(600, 100, 500, [4_990_000, 5_050_000])).toBe(5_050_000);
  });

  it('keeps scrubbing at the visible edges and preserves non-rounded endpoints', () => {
    expect(pointerSeekValue(0, 100, 500, [1250, 3750])).toBe(1250);
    expect(pointerSeekValue(900, 100, 500, [1250, 3750])).toBe(3750);
    expect(pointerSeekValue(350, 100, 500, [1250, 3750])).toBe(2500);
    expect(pointerSeekValue(350, 100, 0, [1250, 3750])).toBe(1250);
  });
});
