import { describe, expect, it } from 'vitest';
import { CROP_PRESETS, containedMediaBox, cropForAspect, FULL_CROP, moveCrop, parseAspect, scaleCrop, validCrop } from './crop';

describe('upright crop geometry', () => {
  it('fits every preset without changing its displayed ratio', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [480, 120], [120, 480]]) {
      for (const preset of CROP_PRESETS) {
        const ratio = parseAspect(preset)!;
        const crop = cropForAspect(ratio, w, h)!;
        expect(validCrop(crop)).toBe(true);
        expect(crop.width * w / (crop.height * h)).toBeCloseTo(ratio, 9);
        expect(crop.width === 1 || crop.height === 1).toBe(true);
      }
    }
  });
  it('accepts decimal custom ratios and rejects invalid or subpixel areas', () => {
    expect(parseAspect('1.85:1')).toBe(1.85);
    for (const value of ['0:9', '-1:1', 'NaN:1', '1:0', 'Infinity:1', '9']) expect(parseAspect(value)).toBeNull();
    expect(cropForAspect(100000, 1920, 1080)).toBeUndefined();
    for (const value of [null, {}, { ...FULL_CROP, x: .1 }, { ...FULL_CROP, width: NaN }, { ...FULL_CROP, height: 0 }]) expect(validCrop(value)).toBe(false);
  });
  it('keeps moving and resizing inside the source', () => {
    const crop = cropForAspect(1, 1920, 1080)!;
    const moved = moveCrop(crop, 5, -5);
    expect(moved.x).toBe(1 - crop.width); expect(moved.y).toBe(0);
    for (const factor of [.01, .5, 1, 10]) {
      const resized = scaleCrop(crop, factor, 1920, 1080);
      expect(validCrop(resized)).toBe(true);
      expect(resized.width * 1920 / (resized.height * 1080)).toBeCloseTo(1);
      expect(resized.width * 1920).toBeGreaterThanOrEqual(2);
      expect(resized.height * 1080).toBeGreaterThanOrEqual(2);
    }
  });
  it('maps overlays onto visible video excluding letterbox bars', () => {
    expect(containedMediaBox(640, 360, 120, 480)).toEqual({ x: 275, y: 0, width: 90, height: 360 });
    expect(containedMediaBox(400, 400, 1600, 900)).toEqual({ x: 0, y: 87.5, width: 400, height: 225 });
  });
});
