import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { parseWaveform } from './waveformData';
import type { WaveformWindow } from './waveformData';

/** Frames and waveform are prepared by the server in windows of this length. */
export const mediaWindowMS = 30000;
/** Each storyboard frame stands for this much of the source. */
export const frameCellMS = 5000;

/**
 * Windows crossing the visible part of the timeline, nearest to the playhead
 * first. Long views keep only the closest windows, so a wide view never asks
 * the server for more than `limit` preparations at once.
 */
export function visibleMediaWindows(view: [number, number], duration: number, current: number, limit = 4): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !(view[1] > view[0]) || limit <= 0) return [];
  const end = Math.min(view[1], duration);
  const starts: number[] = [];
  for (let start = Math.max(0, Math.floor(view[0] / mediaWindowMS) * mediaWindowMS); start < end; start += mediaWindowMS) starts.push(start);
  const distance = (start: number) => current < start ? start - current : current >= start + mediaWindowMS ? current - start - mediaWindowMS + 1 : 0;
  return starts.sort((a, b) => distance(a) - distance(b) || a - b).slice(0, limit);
}

/** Visible five-second cells: source time and its place on the track in percent. */
export function frameCells(view: [number, number], duration: number): { ms: number; left: number; width: number }[] {
  const span = view[1] - view[0];
  if (!Number.isFinite(duration) || duration <= 0 || !(span > 0)) return [];
  const cells = [];
  const end = Math.min(view[1], duration);
  for (let ms = Math.max(0, Math.floor(view[0] / frameCellMS) * frameCellMS); ms < end; ms += frameCellMS) {
    cells.push({ ms, left: (ms - view[0]) / span * 100, width: (Math.min(ms + frameCellMS, duration) - ms) / span * 100 });
  }
  return cells;
}

export function prefersSavedData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
}

export type WindowResult<T> = { status: 'ready'; value: T; bytes: number } | { status: 'busy' } | { status: 'failed' };

export interface MediaWindowOptions<T> {
  /** A different key (source, access base, audio track) starts an empty cache. */
  cacheKey: string;
  /** Wanted window starts in priority order. */
  starts: number[];
  enabled: boolean;
  /** Settling time after seeking or zooming before the first request. */
  delay: number;
  /** Extra attempts after a busy reply (429 or 503). */
  retries: number;
  /** One window gives up after this long, retries included. */
  timeout: number;
  maxEntries: number;
  maxBytes: number;
  load(start: number, signal: AbortSignal): Promise<WindowResult<T>>;
  release?(value: T): void;
}

const retryDelayMS = 1500;

/**
 * Prepares wanted windows one at a time, nearest first, and keeps a bounded
 * cache. Nothing is requested while the tab is hidden or the browser asks to
 * save data; leaving a view cancels its pending work.
 */
export function useMediaWindows<T>(options: MediaWindowOptions<T>): { ready: ReadonlyMap<number, T>; failed: ReadonlySet<number>; saveData: boolean } {
  const { cacheKey, starts, enabled, delay, retries, timeout, maxEntries, maxBytes } = options;
  const [visible, setVisible] = useState(() => !document.hidden);
  const saveData = prefersSavedData();
  const cache = useRef<{ key: string; entries: Map<number, { value: T; bytes: number }> }>({ key: cacheKey, entries: new Map() });
  const [revision, setRevision] = useState(0);
  const [failed, setFailed] = useState<{ key: string; starts: Set<number> }>({ key: cacheKey, starts: new Set() });
  const release = useRef(options.release);
  release.current = options.release;
  const load = useEffectEvent((start: number, signal: AbortSignal) => options.load(start, signal));
  // The wanted set, not its order, decides when work restarts: the order only
  // follows the playhead and is read when preparation begins.
  const order = useRef(starts);
  order.current = starts;
  const wanted = [...starts].sort((a, b) => a - b).join(',');

  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);

  useEffect(() => {
    const entries = new Map<number, { value: T; bytes: number }>();
    cache.current = { key: cacheKey, entries };
    setFailed({ key: cacheKey, starts: new Set() });
    setRevision(value => value + 1);
    return () => { for (const entry of entries.values()) release.current?.(entry.value); entries.clear(); };
  }, [cacheKey]);

  useEffect(() => {
    if (!enabled || !visible || saveData || !wanted) return;
    const entries = cache.current.entries;
    const priority = order.current.filter(start => wanted.split(',').includes(String(start)));
    // Recently shown windows survive eviction longest.
    for (const start of [...priority].reverse()) { const entry = entries.get(start); if (entry) { entries.delete(start); entries.set(start, entry); } }
    const pending = priority.filter(start => !entries.has(start));
    if (!pending.length) return;
    // Windows that failed before get one fresh attempt when the view changes.
    setFailed(previous => previous.key === cacheKey && previous.starts.size ? { key: cacheKey, starts: new Set() } : previous);
    const controller = new AbortController();
    let timer: number | undefined;
    const evict = () => {
      let bytes = 0;
      for (const entry of entries.values()) bytes += entry.bytes;
      while (entries.size > maxEntries || bytes > maxBytes && entries.size > 1) {
        const [oldest, entry] = entries.entries().next().value!;
        entries.delete(oldest); bytes -= entry.bytes; release.current?.(entry.value);
      }
    };
    const run = async (index: number, attempt: number, deadline: number): Promise<void> => {
      if (controller.signal.aborted || index >= pending.length) return;
      const start = pending[index];
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener('abort', abort);
      const expiry = window.setTimeout(abort, Math.max(0, deadline - Date.now()));
      let result: WindowResult<T>;
      try { result = await load(start, request.signal); } catch { result = { status: 'failed' }; }
      window.clearTimeout(expiry);
      controller.signal.removeEventListener('abort', abort);
      if (controller.signal.aborted) { if (result.status === 'ready') release.current?.(result.value); return; }
      if (result.status === 'busy' && attempt < retries && Date.now() + retryDelayMS < deadline) {
        timer = window.setTimeout(() => void run(index, attempt + 1, deadline), retryDelayMS);
        return;
      }
      if (result.status === 'ready') {
        entries.set(start, { value: result.value, bytes: result.bytes });
        evict();
        setRevision(value => value + 1);
      } else {
        setFailed(previous => previous.key === cacheKey ? { key: cacheKey, starts: new Set(previous.starts).add(start) } : previous);
      }
      void run(index + 1, 0, Date.now() + timeout);
    };
    timer = window.setTimeout(() => void run(0, 0, Date.now() + timeout), delay);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [cacheKey, wanted, enabled, visible, saveData, delay, retries, timeout, maxEntries, maxBytes]);

  const ready = useMemo(() => {
    const current = cache.current;
    return current.key === cacheKey ? new Map([...current.entries].map(([start, entry]) => [start, entry.value])) : new Map<number, T>();
  }, [cacheKey, revision]);
  return { ready, failed: failed.key === cacheKey ? failed.starts : new Set(), saveData };
}

export type FrameStrip = { url: string; start: number; end: number; frames: number; aspect: number };

/** A sprite of up to six frames, five seconds apart, for one window. */
export async function loadStoryboard(sourceBase: string, start: number, duration: number, signal: AbortSignal): Promise<WindowResult<FrameStrip>> {
  const response = await fetch(`${sourceBase}/storyboard?start_ms=${start}&priority=background`, { credentials: 'same-origin', signal });
  if (!response.ok) return [429, 503].includes(response.status) ? { status: 'busy' } : { status: 'failed' };
  const frames = Number(response.headers.get('X-Storyboard-Frames'));
  const step = Number(response.headers.get('X-Storyboard-Step-MS'));
  const actualStart = Number(response.headers.get('X-Preview-Start-MS'));
  const actualEnd = Number(response.headers.get('X-Preview-End-MS'));
  if (!Number.isInteger(frames) || frames < 1 || frames > 6 || step !== frameCellMS || actualStart !== start || actualEnd <= start || actualEnd > Math.min(duration, start + mediaWindowMS)) return { status: 'failed' };
  const blob = await response.blob();
  if (!blob.type.startsWith('image/') || blob.size > 1024 * 1024) return { status: 'failed' };
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    if (signal.aborted || !image.naturalWidth || !image.naturalHeight) throw new Error('unusable storyboard');
  } catch (error) {
    URL.revokeObjectURL(url);
    if (signal.aborted) throw error;
    return { status: 'failed' };
  }
  // The sprite always has six slots; the last window may fill fewer of them.
  return { status: 'ready', value: { url, start, end: actualEnd, frames, aspect: image.naturalWidth / 6 / image.naturalHeight }, bytes: blob.size };
}

export async function loadWaveform(sourceBase: string, start: number, duration: number, audioTrack: number | undefined, signal: AbortSignal): Promise<WindowResult<WaveformWindow>> {
  const response = await fetch(`${sourceBase}/waveform?start_ms=${start}${audioTrack !== undefined ? `&audio_track=${audioTrack}` : ''}&priority=background`, { credentials: 'same-origin', signal });
  if (!response.ok) return [429, 503].includes(response.status) ? { status: 'busy' } : { status: 'failed' };
  const raw = await response.text();
  if (raw.length >= 65536) return { status: 'failed' };
  const data = parseWaveform(JSON.parse(raw), start, duration);
  if (!data || audioTrack !== undefined && data.has_audio && data.audio_track !== audioTrack) return { status: 'failed' };
  return { status: 'ready', value: data, bytes: raw.length };
}
