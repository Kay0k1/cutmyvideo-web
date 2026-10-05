import { describe, expect, it, vi } from 'vitest';
import { createPlaybackPosition } from './playbackPosition';

describe('playback position', () => {
  it('notifies only when the rounded position changes and releases subscribers', () => {
    const position = createPlaybackPosition();
    const listener = vi.fn(() => position.getSnapshot());
    const unsubscribe = position.subscribe(listener);
    position.set(150); position.set(150.1); position.set(NaN); position.set(Infinity);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveReturnedWith(150);
    unsubscribe(); position.set(300);
    expect(position.getSnapshot()).toBe(300);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps separate editors independent and clamps negative times', () => {
    const first = createPlaybackPosition();
    const second = createPlaybackPosition();
    first.set(5000);
    expect(second.getSnapshot()).toBe(0);
    first.set(-20);
    expect(first.getSnapshot()).toBe(0);
  });
});
