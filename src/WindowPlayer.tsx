import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { formatTimecode } from './timecode';
import { PREVIEW_WINDOW_MAX_BYTES, PREVIEW_WINDOW_MS, PreviewWindowCache } from './previewWindowCache';
import type { PreviewWindow } from './previewWindowCache';
import type { Source } from './types';
import type { PlayerControls } from './Player';

type PendingWindow = { controller: AbortController; promise: Promise<PreviewWindow>; background: boolean };

// Keep source time independent of the short preview files. Recently visited
// intervals stay in a bounded cache; only the next interval is speculative.
export const WindowPlayer = forwardRef<PlayerControls, {
  source: Source; active: boolean; poster?: string; initialPosition: number;
  onTime(ms: number): void; onAvailable(available: boolean): void;
}>(({ source, active, poster, initialPosition, onTime, onAvailable }, ref) => {
  const { t } = useLanguage();
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onTime, onAvailable });
  callbacks.current = { onTime, onAvailable };
  const state = useRef({ start: 0, end: 0, position: initialPosition, playing: false, ready: false, url: '', loading: false, failed: false, generation: 0 });
  const cache = useRef<PreviewWindowCache | null>(null);
  if (!cache.current) cache.current = new PreviewWindowCache(url => URL.revokeObjectURL(url));
  const pending = useRef(new Map<number, PendingWindow>());
  const seekTimer = useRef<number | undefined>(undefined);
  const prefetchTimer = useRef<number | undefined>(undefined);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(initialPosition);
  const [buffered, setBuffered] = useState<Array<{ start: number; end: number }>>([]);
  const [prefetching, setPrefetching] = useState(false);
  const mounted = useRef(false);
  const enabled = useRef(active); enabled.current = active;

  function publish(ms: number) {
    const value = Math.min(source.duration_ms, Math.max(0, Math.round(ms)));
    state.current.position = value; setPosition(value); callbacks.current.onTime(value);
  }

  function status(busy: boolean, error = false) {
    state.current.loading = busy; state.current.failed = error;
    setLoading(busy); setFailed(error);
  }

  function cancelRequests(exceptStart?: number, nextStart?: number) {
    window.clearTimeout(prefetchTimer.current); prefetchTimer.current = undefined;
    for (const [start, request] of pending.current) {
      if (start !== exceptStart && start !== nextStart) { request.controller.abort(); pending.current.delete(start); }
    }
    setPrefetching([...pending.current.values()].some(request => request.background));
  }

  function requestWindow(start: number, background: boolean): Promise<PreviewWindow> {
    const cached = cache.current!.get(start);
    if (cached) return Promise.resolve(cached);
    const existing = pending.current.get(start);
    if (existing) {
      if (!background) {
        existing.background = false;
        setPrefetching([...pending.current.values()].some(request => request.background));
      }
      return existing.promise;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 120000);
    const request: PendingWindow = { controller, background, promise: null! };
    // Yield once so the request is registered before synchronous failures finish.
    request.promise = Promise.resolve().then(async () => {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        response = await fetch(`/api/v1/sources/${encodeURIComponent(source.id)}/preview?start_ms=${start}${request.background ? '&priority=background' : ''}`, { credentials: 'same-origin', signal: controller.signal });
        if (response.ok) break;
        const body = await response.json().catch(() => null);
        if (request.background || body?.error?.code !== 'server_busy') throw new Error('preview unavailable');
        await new Promise<void>((resolve, reject) => {
          const stop = () => { window.clearTimeout(wait); reject(new DOMException('Aborted', 'AbortError')); };
          const wait = window.setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve(); }, 1000);
          controller.signal.addEventListener('abort', stop, { once: true });
          if (controller.signal.aborted) stop();
        });
      }
      if (!response?.ok) throw new Error('preview unavailable');
      const blob = await response.blob();
      if (!mounted.current || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (blob.size > PREVIEW_WINDOW_MAX_BYTES || !blob.type.startsWith('video/')) throw new Error('invalid preview');
      const end = Math.min(start + PREVIEW_WINDOW_MS, source.duration_ms);
      const entry = { start, end, url: URL.createObjectURL(blob), bytes: blob.size };
      cache.current!.add(entry, state.current.start);
      setBuffered(cache.current!.ranges());
      return entry;
    }).finally(() => {
      window.clearTimeout(timer);
      if (pending.current.get(start) === request) pending.current.delete(start);
    });
    pending.current.set(start, request);
    return request.promise;
  }

  function schedulePrefetch() {
    window.clearTimeout(prefetchTimer.current);
    const current = state.current;
    const next = current.end;
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!enabled.current || document.hidden || current.loading || !current.ready || next >= source.duration_ms || cache.current!.has(next) || connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '')) return;
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = undefined;
      if (!mounted.current || !enabled.current || document.hidden || state.current.end !== next || state.current.loading) return;
      setPrefetching(true);
      void requestWindow(next, true).catch(() => undefined).finally(() => {
        if (mounted.current) setPrefetching([...pending.current.values()].some(request => request.background));
      });
    }, 600);
  }

  function show(entry: PreviewWindow) {
    const current = state.current;
    current.start = entry.start; current.end = entry.end;
    if (current.url === entry.url && current.ready) {
      if (video.current) video.current.currentTime = (current.position - entry.start) / 1000;
      status(false); schedulePrefetch();
      if (current.playing) void video.current?.play().catch(() => { current.playing = false; });
      return;
    }
    current.ready = false; current.url = entry.url;
    status(false); setUrl(entry.url);
  }

  async function load(ms: number) {
    const current = state.current;
    window.clearTimeout(seekTimer.current); seekTimer.current = undefined;
    const start = Math.floor(Math.min(Math.max(0, ms), Math.max(0, source.duration_ms - 1)) / PREVIEW_WINDOW_MS) * PREVIEW_WINDOW_MS;
    const generation = ++current.generation;
    const cached = cache.current!.get(start);
    cancelRequests(start, cached ? start + PREVIEW_WINDOW_MS : undefined);
    if (cached) { show(cached); return; }
    status(true);
    try {
      const entry = await requestWindow(start, false);
      if (mounted.current && enabled.current && generation === current.generation) show(entry);
    } catch {
      if (mounted.current && enabled.current && generation === current.generation) {
        status(false, true); current.playing = false;
      }
    }
  }

  function seek(ms: number) {
    const current = state.current;
    const target = Math.min(Math.max(0, ms), Math.max(0, source.duration_ms - 1));
    publish(target);
    window.clearTimeout(seekTimer.current); seekTimer.current = undefined;
    if (!enabled.current) return;
    const start = Math.floor(target / PREVIEW_WINDOW_MS) * PREVIEW_WINDOW_MS;
    if (cache.current!.has(start)) { void load(target); return; }
    // Protect the desired position from timeupdate events from the old file.
    current.generation++; status(true); cancelRequests(start);
    video.current?.pause();
    seekTimer.current = window.setTimeout(() => { void load(target); }, 180);
  }

  function play() {
    const current = state.current;
    current.playing = true;
    if (!seekTimer.current && current.ready && !current.loading && !current.failed) void video.current?.play().catch(() => { current.playing = false; });
  }

  useImperativeHandle(ref, () => ({
    seek, play,
    pause: () => { state.current.playing = false; video.current?.pause(); },
    toggle: () => { if (state.current.playing) { state.current.playing = false; video.current?.pause(); } else play(); },
  }));

  useEffect(() => {
    mounted.current = true;
    callbacks.current.onAvailable(true);
    const visibility = () => {
      if (document.hidden) { window.clearTimeout(prefetchTimer.current); for (const [start, request] of pending.current) if (request.background) { request.controller.abort(); pending.current.delete(start); } setPrefetching(false); }
      else schedulePrefetch();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false; state.current.generation++;
      for (const request of pending.current.values()) request.controller.abort();
      pending.current.clear();
      window.clearTimeout(seekTimer.current); window.clearTimeout(prefetchTimer.current);
      cache.current!.clear(); state.current.url = ''; state.current.ready = false;
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    if (active) void load(state.current.position);
    else {
      state.current.playing = false; state.current.generation++;
      video.current?.pause(); cancelRequests(); status(false);
      window.clearTimeout(seekTimer.current); seekTimer.current = undefined;
    }
  }, [active]);

  const nextReady = buffered.some(range => range.start === state.current.end);
  return <div className="window-player">
    <div className="window-player-screen">
      <video ref={video} src={url || undefined} poster={poster} controls playsInline preload="auto" aria-label={source.title}
        onLoadedMetadata={() => {
          const current = state.current;
          if (!video.current || video.current.currentSrc !== current.url || current.loading) return;
          current.ready = true;
          video.current.currentTime = Math.max(0, (current.position-current.start)/1000);
          if (current.playing) void video.current.play().catch(() => { current.playing = false; });
          schedulePrefetch();
        }}
        onPlay={() => { state.current.playing = true; schedulePrefetch(); }}
        onPause={() => { if (state.current.ready && !video.current?.ended && !state.current.loading && !seekTimer.current) state.current.playing = false; }}
        onTimeUpdate={() => { if (state.current.ready && !state.current.loading && !state.current.failed && !video.current?.seeking) publish(state.current.start+(video.current?.currentTime ?? 0)*1000); }}
        onEnded={() => {
          const current = state.current;
          const shouldContinue = current.playing;
          publish(current.end);
          if (shouldContinue && current.playing && current.end < source.duration_ms && enabled.current) void load(current.end);
          else current.playing = false;
        }}
        onError={() => { if (url && !state.current.loading) { cache.current!.remove(state.current.start); setBuffered(cache.current!.ranges()); status(false, true); state.current.playing = false; } }} />
      {loading && <div className="window-player-status" role="status"><span className="spinner" />{t('Готовим предпросмотр…')}</div>}
      {failed && <div className="window-player-status" role="status"><p>{t('Не удалось загрузить участок видео.')}</p><button className="button secondary" type="button" onClick={() => void load(state.current.position)}>{t('Повторить')}</button></div>}
    </div>
    <div className="window-player-navigation">
      <label className="window-player-seek">
        <span className="window-player-position"><span>{t('Позиция в видео')}</span><span>{formatTimecode(position)} / {formatTimecode(source.duration_ms)}</span></span>
        <span className="window-player-rail">
          <span className="window-player-buffered" aria-hidden="true">{buffered.map(range => <span key={range.start} style={{ left: `${range.start / source.duration_ms * 100}%`, width: `${(range.end-range.start) / source.duration_ms * 100}%` }} />)}</span>
          <input type="range" min="0" max={Math.max(0, source.duration_ms-1)} step="100" value={position} aria-label={t('Позиция в видео')} aria-valuetext={formatTimecode(position)} onChange={event => seek(Number(event.target.value))} />
        </span>
      </label>
      <span className="window-player-buffer-status">{prefetching ? t('Загружаем следующий участок…') : nextReady ? t('Следующий участок готов') : t('Недавние участки доступны без ожидания')}</span>
    </div>
  </div>;
});
