export const PREVIEW_WINDOW_MS = 30_000;
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
  private entries = new Map<number, PreviewWindow>();
  private bytes = 0;

  constructor(
    private release: (url: string) => void,
    private maxBytes = 64 * 1024 * 1024,
    private maxWindows = 8,
  ) {}

  get(start: number): PreviewWindow | undefined {
    const entry = this.entries.get(start);
    if (entry) { this.entries.delete(start); this.entries.set(start, entry); }
    return entry;
  }

  has(start: number): boolean { return this.entries.has(start); }

  add(entry: PreviewWindow, activeStart: number): void {
    if (entry.bytes > this.maxBytes) { this.release(entry.url); throw new Error('preview exceeds cache budget'); }
    this.remove(entry.start);
    this.entries.set(entry.start, entry); this.bytes += entry.bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxWindows) {
      const oldest = [...this.entries.keys()].find(start => start !== activeStart && start !== entry.start)
        ?? [...this.entries.keys()].find(start => start !== entry.start);
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  remove(start: number): void {
    const entry = this.entries.get(start);
    if (!entry) return;
    this.entries.delete(start); this.bytes -= entry.bytes; this.release(entry.url);
  }

  ranges(): Array<{ start: number; end: number }> {
    return [...this.entries.values()].map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
  }

  clear(): void { for (const start of this.entries.keys()) this.remove(start); }
}
