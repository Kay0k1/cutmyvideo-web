export interface PlaybackPosition {
  getSnapshot(): number;
  subscribe(listener: () => void): () => void;
  set(ms: number): void;
}

// Playback changes independently of the editor. Only the timeline subscribes
// through React; shortcuts and persistence can read the latest value directly.
export function createPlaybackPosition(): PlaybackPosition {
  let current = 0;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: ms => {
      if (!Number.isFinite(ms)) return;
      const next = Math.max(0, Math.round(ms));
      if (next === current) return;
      current = next;
      listeners.forEach(listener => listener());
    },
  };
}
