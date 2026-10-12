export const PREVIEW_WINDOW_MS = 30_000;
export const QUICK_PREVIEW_WINDOW_MS = 6_000;
export const PREVIEW_WINDOW_MAX_BYTES = 16 * 1024 * 1024;

/** Brief metadata leases should not add a whole second before playback. */
export function foregroundPreviewRetryDelay(attempt: number): number {
  return Math.min(1000, 100 * 2 ** Math.min(4, Math.max(0, attempt)));
}

export interface PreviewWindow {
  start: number;
  end: number;
  url: string;
  bytes: number; display_width?: number; display_height?: number;
}

// Object URLs own decoded/downloaded media until explicitly released. Bound both
// the number of windows and their bytes, including speculative next intervals.
export class PreviewWindowCache {
  private entries = new Map<string, PreviewWindow>();
  private bytes = 0;

  constructor(
    private release: (url: string) => void,
    private maxBytes = 64 * 1024 * 1024,
    private maxWindows = 8,
  ) {}

  get(start: number, end?: number): PreviewWindow | undefined {
    const entry = [...this.entries.values()].filter(value => value.start === start && (end === undefined || value.end === end)).sort((a, b) => b.end - a.end)[0];
    if (entry) this.touch(entry);
    return entry;
  }

  covering(position: number): PreviewWindow | undefined {
    const entry = [...this.entries.values()].filter(value => value.start <= position && value.end > position).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
    if (entry) this.touch(entry);
    return entry;
  }

  private touch(entry: PreviewWindow) {
    const key = `${entry.start}:${entry.end}`;
    this.entries.delete(key); this.entries.set(key, entry);
  }

  has(start: number): boolean { return [...this.entries.values()].some(entry => entry.start === start); }

  add(entry: PreviewWindow, activeStart: number): void {
    if (entry.bytes > this.maxBytes) { this.release(entry.url); throw new Error('preview exceeds cache budget'); }
    const key = `${entry.start}:${entry.end}`;
    this.removeKey(key);
    this.entries.set(key, entry); this.bytes += entry.bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxWindows) {
      const oldest = [...this.entries].find(([candidate, value]) => value.start !== activeStart && candidate !== key)?.[0]
        ?? [...this.entries.keys()].find(candidate => candidate !== key);
      if (oldest === undefined) break;
      this.removeKey(oldest);
    }
  }

  remove(start: number): void {
    for (const [key, entry] of this.entries) if (entry.start === start) this.removeKey(key);
  }

  private removeKey(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.bytes -= entry.bytes; this.release(entry.url);
  }

  ranges(): Array<{ start: number; end: number }> {
    return [...this.entries.values()].map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
  }

  clear(): void { for (const key of this.entries.keys()) this.removeKey(key); }
}
