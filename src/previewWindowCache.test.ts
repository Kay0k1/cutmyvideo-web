import { describe, expect, it, vi } from 'vitest';
import { PreviewWindowCache } from './previewWindowCache';

const windowAt = (start: number, bytes = 8) => ({ start, end: start + 30_000, url: `blob:${start}`, bytes });

describe('preview media ownership', () => {
  it('retains a quick window while its longer replacement loads and reuses covering windows', () => {
    const release = vi.fn();
    const cache = new PreviewWindowCache(release, 64, 4);
    const quick = { start: 36_000, end: 42_000, url: 'blob:quick', bytes: 8 };
    const full = { start: 30_000, end: 60_000, url: 'blob:full', bytes: 20 };
    cache.add(quick, quick.start); cache.add(full, quick.start);
    expect(release).not.toHaveBeenCalled();
    expect(cache.covering(37_000)).toBe(full);
    expect(cache.covering(59_999)).toBe(full);
    expect(cache.covering(60_000)).toBeUndefined();
    expect(cache.get(36_000, 42_000)).toBe(quick);
    cache.add({ start: 36_000, end: 66_000, url: 'blob:overlap', bytes: 20 }, quick.start);
    expect(cache.get(36_000)).toHaveProperty('url', 'blob:overlap');
    expect(cache.get(36_000, 42_000)).toBe(quick);
    cache.clear();
    expect(release.mock.calls.flat().sort()).toEqual(['blob:full', 'blob:overlap', 'blob:quick']);
  });

  it('keeps frequently revisited intervals and releases the oldest unused object URLs', () => {
    const release = vi.fn();
    const cache = new PreviewWindowCache(release, 64, 3);
    cache.add(windowAt(0), 0); cache.add(windowAt(30_000), 0); cache.add(windowAt(60_000), 0);
    cache.get(30_000);
    cache.add(windowAt(90_000), 0);
    expect(cache.ranges().map(range => range.start)).toEqual([0, 30_000, 90_000]);
    expect(release).toHaveBeenCalledExactlyOnceWith('blob:60000');
  });

  it('bounds bytes as well as count even when each interval has a different bitrate', () => {
    const release = vi.fn();
    const cache = new PreviewWindowCache(release, 64, 8);
    for (let start = 0; start < 5; start++) cache.add(windowAt(start, 16), 0);
    expect(cache.ranges().map(range => range.start)).toEqual([0, 2, 3, 4]);
    expect(release).toHaveBeenCalledExactlyOnceWith('blob:1');
    cache.clear();
    expect(cache.ranges()).toEqual([]);
    expect(release.mock.calls.flat().sort()).toEqual(['blob:0', 'blob:1', 'blob:2', 'blob:3', 'blob:4']);
    cache.clear();
    expect(release).toHaveBeenCalledTimes(5);
  });

  it('releases invalid oversized media without displacing usable cached intervals', () => {
    const release = vi.fn();
    const cache = new PreviewWindowCache(release, 64, 8);
    cache.add(windowAt(0), 0);
    expect(() => cache.add(windowAt(30_000, 65), 0)).toThrow('preview exceeds cache budget');
    expect(cache.has(0)).toBe(true);
    expect(cache.has(30_000)).toBe(false);
    expect(release).toHaveBeenCalledExactlyOnceWith('blob:30000');
  });
});
