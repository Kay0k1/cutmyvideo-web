import { describe, expect, it } from 'vitest';
import { keyboardTrimValue, moveTimelineSection, normalizeTimelineSection, panTimelineView, pointerSeekValue, pointerTimelineTime, pointerTrimValue, timelineView, trimBoundaryLimits, zoomTimelineView } from './timelineControls';

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

describe('editing sections and independent zoom views', () => {
  const cut = { start_ms: 1250, end_ms: 31250 };

  it('keeps a saved section containing the entire cut, including exact endpoints', () => {
    expect(normalizeTimelineSection(180000, cut, [1250, 61250])).toEqual([1250, 61250]);
    expect(normalizeTimelineSection(180000, cut, [1250, 31250])).toEqual([1250, 31250]);
  });

  it('repairs obsolete or invalid saved sections without clipping the selected cut', () => {
    const later = { start_ms: 85100, end_ms: 133300 };
    for (const saved of [[62000, 122000], [-1000, 190000], [150000, 160000], [100000, 90000], [0, NaN], ['0', 180000], null]) {
      expect(normalizeTimelineSection(180000, later, saved)).toEqual([79200, 139200]);
    }
    expect(normalizeTimelineSection(180000, { start_ms: 5000, end_ms: 170000 }, null)).toEqual([0, 180000]);
  });

  it('fits short sources and cuts at the beginning and end without shifting their bounds', () => {
    expect(normalizeTimelineSection(900, { start_ms: 100, end_ms: 800 }, null)).toEqual([0, 900]);
    expect(normalizeTimelineSection(180000, cut, null)).toEqual([0, 60000]);
    expect(normalizeTimelineSection(180000, { start_ms: 165123, end_ms: 179999 }, null)).toEqual([120000, 180000]);
    expect(normalizeTimelineSection(0, { start_ms: 0, end_ms: 0 }, null)).toEqual([0, 0]);
  });

  it('uses one minute for ordinary cuts and expands only for cuts already longer than a minute', () => {
    expect(normalizeTimelineSection(180000, { start_ms: 60000, end_ms: 95999 }, null)).toEqual([48000, 108000]);
    expect(normalizeTimelineSection(180000, { start_ms: 60000, end_ms: 120000 }, null)).toEqual([60000, 120000]);
    const long = { start_ms: 60000, end_ms: 120001 };
    const section = normalizeTimelineSection(180000, long, null);
    expect(section).toEqual([30000, 150002]);
    expect(section[0]).toBeLessThanOrEqual(long.start_ms);
    expect(section[1]).toBeGreaterThanOrEqual(long.end_ms);
  });

  it('clamps a zoomed viewport inside the section and limits magnification to one second', () => {
    expect(timelineView([60000, 120000], 80000, 10000)).toEqual([75000, 85000]);
    expect(timelineView([60000, 120000], 0, 10000)).toEqual([60000, 70000]);
    expect(timelineView([60000, 120000], 180000, 10000)).toEqual([110000, 120000]);
    expect(timelineView([60000, 120000], 80000, 100)).toEqual([79500, 80500]);
    expect(timelineView([60000, 120000], NaN, Infinity)).toEqual([60000, 120000]);
    expect(timelineView([100, 900], 300, 10)).toEqual([100, 900]);
    expect(timelineView([0, 0], 0, 1000)).toEqual([0, 0]);
  });

  it('moves the section and cut together, preserving precise cut offsets and duration', () => {
    const first = moveTimelineSection(180000, cut, [0, 60000], 75123);
    expect(first).toEqual({ section: [75123, 135123], range: [76373, 106373] });
    expect(moveTimelineSection(180000, { start_ms: first.range[0], end_ms: first.range[1] }, first.section, 0))
      .toEqual({ section: [0, 60000], range: [1250, 31250] });
  });

  it('repairs legacy fractional sections and keeps odd-duration cuts at safe millisecond precision', () => {
    const odd = { start_ms: 85100, end_ms: 133301 };
    const section = normalizeTimelineSection(180001, odd, [60999.5, 157401.5]);
    expect(section).toEqual([79201, 139201]);
    const moved = moveTimelineSection(180001, odd, section, 70000.6);
    expect(moved).toEqual({ section: [70001, 130001], range: [75900, 124101] });
    expect([...moved.section, ...moved.range].every(Number.isSafeInteger)).toBe(true);
    expect(moved.range[1] - moved.range[0]).toBe(48201);
  });

  it('stops a moved section at source edges and normalizes stale sections first', () => {
    expect(moveTimelineSection(180000, cut, [0, 60000], 200000)).toEqual({ section: [120000, 180000], range: [121250, 151250] });
    expect(moveTimelineSection(180000, cut, [0, 60000], -10000)).toEqual({ section: [0, 60000], range: [1250, 31250] });
    expect(moveTimelineSection(180000, { start_ms: 5000, end_ms: 170000 }, [0, 60000], 60000))
      .toEqual({ section: [0, 180000], range: [5000, 170000] });
  });

  it('bounds both trim handles to the editing section even when the viewport is narrower', () => {
    const selected = { start_ms: 80000, end_ms: 100000 };
    expect(trimBoundaryLimits('start', selected, [60000, 120000])).toEqual([60000, 99900]);
    expect(trimBoundaryLimits('end', selected, [60000, 120000])).toEqual([80100, 120000]);
    expect(trimBoundaryLimits('start', selected, [60000, 120000], 30000)).toEqual([70000, 99900]);
    expect(trimBoundaryLimits('end', selected, [60000, 120000], 30000)).toEqual([80100, 110000]);
  });

  it('prevents crossing and freezes a handle when no valid movement remains', () => {
    const tiny = { start_ms: 85000, end_ms: 85100 };
    expect(trimBoundaryLimits('start', tiny, [85000, 85100])).toEqual([85000, 85000]);
    expect(trimBoundaryLimits('end', tiny, [85000, 85100])).toEqual([85100, 85100]);
    expect(trimBoundaryLimits('start', { start_ms: 1250, end_ms: 31250 }, [60000, 120000])).toEqual([1250, 1250]);
    expect(trimBoundaryLimits('end', { start_ms: 130000, end_ms: 135000 }, [60000, 120000])).toEqual([135000, 135000]);
  });

  it('zooms around the pointer while preserving its screen fraction away from section edges', () => {
    const section: [number, number] = [60000, 120000];
    const view: [number, number] = [70000, 90000];
    expect(zoomTimelineView(section, view, 75000, .5)).toEqual([72500, 82500]);
    expect(zoomTimelineView(section, view, 75000, 2)).toEqual([65000, 105000]);
    expect(zoomTimelineView(section, view, 70000, .5)).toEqual([70000, 80000]);
    expect(zoomTimelineView(section, view, 90000, .5)).toEqual([80000, 90000]);
  });

  it('keeps zoom and panning bounded without changing viewport duration when panning', () => {
    const section: [number, number] = [60000, 120000];
    expect(zoomTimelineView(section, [60000, 70000], 65000, 2)).toEqual([60000, 80000]);
    expect(zoomTimelineView(section, [70000, 90000], 75000, 100)).toEqual(section);
    expect(zoomTimelineView(section, [70000, 90000], 75000, .0001)).toEqual([74750, 75750]);
    expect(zoomTimelineView([100, 900], [100, 900], 300, .5)).toEqual([100, 900]);
    expect(panTimelineView(section, [70000, 90000], 1234)).toEqual([71234, 91234]);
    expect(panTimelineView(section, [70000, 90000], -100000)).toEqual([60000, 80000]);
    expect(panTimelineView(section, [70000, 90000], 100000)).toEqual([100000, 120000]);
  });

  it('positions sections at individual milliseconds while preserving exact track endpoints', () => {
    expect(pointerTimelineTime(350, 100, 500, [1251, 3751])).toBe(2501);
    expect(pointerTimelineTime(123, 100, 500, [1000, 61000])).toBe(3760);
    expect(pointerTimelineTime(0, 100, 500, [1251, 3751])).toBe(1251);
    expect(pointerTimelineTime(900, 100, 500, [1251, 3751])).toBe(3751);
    expect(pointerTimelineTime(350, 100, 0, [1251, 3751])).toBe(1251);
  });
});
