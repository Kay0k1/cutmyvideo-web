import { afterEach, describe, expect, it, vi } from 'vitest';
import { coalescedTask } from './coalescedTask';

afterEach(() => { vi.useRealTimers(); });

describe('coalesced persistence', () => {
  it('writes the latest state at a bounded rate during continuous updates', () => {
    vi.useFakeTimers();
    let position = 0;
    const write = vi.fn(() => position);
    const pending = coalescedTask(write);
    for (let update = 1; update <= 100; update++) {
      position = update * 150;
      pending.schedule();
      vi.advanceTimersByTime(150);
    }
    expect(write.mock.calls.length).toBeLessThanOrEqual(15);
    expect(write.mock.calls.length).toBeGreaterThan(0);
    pending.flush();
    expect(write).toHaveLastReturnedWith(15000);
  });

  it('flushes navigation/unmount immediately and leaves no duplicate timer', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const pending = coalescedTask(write);
    pending.schedule(300);
    pending.flush(); pending.flush();
    vi.runAllTimers();
    expect(write).toHaveBeenCalledTimes(1);
    pending.schedule(); vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
