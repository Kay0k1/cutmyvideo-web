import { describe, expect, it } from 'vitest';
import { keyboardTrimValue, pointerTrimValue } from './timelineControls';

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
});
