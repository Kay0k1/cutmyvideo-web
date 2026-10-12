import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { formatTimecode } from './timecode';
import { foregroundPreviewRetryDelay, PREVIEW_WINDOW_MAX_BYTES, PREVIEW_WINDOW_MS, QUICK_PREVIEW_WINDOW_MS, PreviewWindowCache } from './previewWindowCache';
import type { PreviewWindow } from './previewWindowCache';
import type { Source } from './types';
import type { PlayerControls } from './Player';
import { usePlaybackClock } from './usePlaybackClock';

type PendingWindow = { start: number; controller: AbortController; promise: Promise<PreviewWindow>; background: boolean };

// Keep source time independent of the short preview files. Recently visited
// intervals stay in a bounded cache; only the next interval is speculative.
export const WindowPlayer = forwardRef<PlayerControls, {
  source: Source; active: boolean; poster?: string; initialPosition: number;
  audioTrack?: number; noAudio?: boolean;
  onGeometry?(width: number, height: number): void;
  onTime(ms: number, confirmed?: boolean): void; onAvailable(available: boolean): void;
  onSourceUnavailable(id: string, verify?: boolean): void;
}>(({ source, active, poster, initialPosition, audioTrack, noAudio, onGeometry, onTime, onAvailable, onSourceUnavailable }, ref) => {
  const { t } = useLanguage();
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onTime, onAvailable });
  callbacks.current = { onTime, onAvailable };
  const state = useRef({ start: 0, end: 0, position: initialPosition, playing: false, ready: false, url: '', loading: false, failed: false, generation: 0 });
  const cache = useRef<PreviewWindowCache | null>(null);
  if (!cache.current) cache.current = new PreviewWindowCache(url => URL.revokeObjectURL(url));
  const pending = useRef(new Map<string, PendingWindow>());
  const seekTimer = useRef<number | undefined>(undefined);
  const prefetchTimer = useRef<number | undefined>(undefined);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureMessage, setFailureMessage] = useState('Не удалось загрузить участок видео.');
  const [position, setPosition] = useState(initialPosition);
  const [buffered, setBuffered] = useState<Array<{ start: number; end: number }>>([]);
  const [prefetching, setPrefetching] = useState(false);
  const mounted = useRef(false);
  const enabled = useRef(active); enabled.current = active;
  usePlaybackClock(video, active, () => {
    if (state.current.ready && !state.current.loading && !state.current.failed) publish(state.current.start + (video.current?.currentTime ?? 0) * 1000);
  });

  function publish(ms: number, confirmed = true) {
    const value = Math.min(source.duration_ms, Math.max(0, Math.round(ms)));
    state.current.position = value; setPosition(value); callbacks.current.onTime(value, confirmed);
  }

  function status(busy: boolean, error = false) {
    state.current.loading = busy; state.current.failed = error;
    setLoading(busy); setFailed(error);
  }

  function cancelRequests(exceptStart?: number, nextStart?: number) {
    window.clearTimeout(prefetchTimer.current); prefetchTimer.current = undefined;
    for (const [key, request] of pending.current) {
      if (request.start !== exceptStart && request.start !== nextStart) { request.controller.abort(); pending.current.delete(key); }
    }
    setPrefetching([...pending.current.values()].some(request => request.background));
  }

  function requestWindow(start: number, background: boolean, windowMS = PREVIEW_WINDOW_MS): Promise<PreviewWindow> {
    const end = Math.min(start + windowMS, source.duration_ms);
    const key = `${start}:${end}`;
    const cached = cache.current!.get(start, end);
    if (cached) return Promise.resolve(cached);
    const existing = pending.current.get(key);
    if (existing) {
      if (!background) {
        existing.background = false;
        setPrefetching([...pending.current.values()].some(request => request.background));
      }
      return existing.promise;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 120000);
    const request: PendingWindow = { start, controller, background, promise: null! };
    // Yield once so the request is registered before synchronous failures finish.
    request.promise = Promise.resolve().then(async () => {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        response = await fetch(`/api/v1/sources/${encodeURIComponent(source.id)}/preview?start_ms=${start}${windowMS !== PREVIEW_WINDOW_MS ? `&window_ms=${windowMS}` : ''}${audioTrack !== undefined ? `&audio_track=${audioTrack}` : ''}${noAudio ? '&no_audio=true' : ''}${request.background ? '&priority=background' : ''}`, { credentials: 'same-origin', signal: controller.signal });
        if (response.ok) break;
        const body = await response.json().catch(() => null);
        if (body?.error?.code === 'not_found') throw new Error('source_not_found');
        if (response.status === 410 || ['expired', 'source_expired', 'source_unavailable'].includes(body?.error?.code)) throw new Error('source_expired');
        if (body?.error?.code === 'tracks_unavailable') throw new Error('tracks_unavailable');
        if (['audio_track_invalid', 'audio_track_unavailable'].includes(body?.error?.code)) throw new Error('audio_track_invalid');
        if (request.background || body?.error?.code !== 'server_busy') throw new Error('preview unavailable');
        await new Promise<void>((resolve, reject) => {
          const stop = () => { window.clearTimeout(wait); reject(new DOMException('Aborted', 'AbortError')); };
          const wait = window.setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve(); }, foregroundPreviewRetryDelay(attempt));
          controller.signal.addEventListener('abort', stop, { once: true });
          if (controller.signal.aborted) stop();
        });
      }
      if (!response?.ok) throw new Error('preview unavailable');
      const blob = await response.blob();
      if (!mounted.current || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (blob.size > PREVIEW_WINDOW_MAX_BYTES || !blob.type.startsWith('video/')) throw new Error('invalid preview');
      // Source-time headers are authoritative. A previous compatible server
      // can ignore window_ms and return its ordinary aligned 30-second window.
      const responseStart = response.headers.get('X-Preview-Start-MS');
      const responseEnd = response.headers.get('X-Preview-End-MS');
      const actualStart = responseStart === null ? start : Number(responseStart);
      const actualEnd = responseEnd === null ? end : Number(responseEnd);
      if (!Number.isSafeInteger(actualStart) || !Number.isSafeInteger(actualEnd) || actualStart < 0 || actualStart > start || actualEnd <= start || actualEnd > source.duration_ms || actualEnd - actualStart > PREVIEW_WINDOW_MS) throw new Error('invalid preview interval');
      const originalWidth = Number(response.headers.get("X-Source-Display-Width"));
      const originalHeight = Number(response.headers.get("X-Source-Display-Height"));
      const entry = { start: actualStart, end: actualEnd, ...(originalWidth >= 2 && originalHeight >= 2 && originalWidth * originalHeight <= 33554432 ? { display_width: originalWidth, display_height: originalHeight } : {}), url: URL.createObjectURL(blob), bytes: blob.size };
      cache.current!.add(entry, state.current.start);
      setBuffered(cache.current!.ranges());
      return entry;
    }).finally(() => {
      window.clearTimeout(timer);
      if (pending.current.get(key) === request) pending.current.delete(key);
    });
    pending.current.set(key, request);
    return request.promise;
  }

  function schedulePrefetch() {
    window.clearTimeout(prefetchTimer.current);
    const current = state.current;
    const expectedEnd = current.end;
    // A quick foreground window opens first; a normal 30-second rendition is
    // prepared quietly for continued playback and later visits to this area.
    const next = Math.floor(current.end / PREVIEW_WINDOW_MS) * PREVIEW_WINDOW_MS;
    const nextEnd = Math.min(next + PREVIEW_WINDOW_MS, source.duration_ms);
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!enabled.current || document.hidden || current.loading || !current.ready || current.end >= source.duration_ms || cache.current!.get(next, nextEnd) || connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '')) return;
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = undefined;
      if (!mounted.current || !enabled.current || document.hidden || state.current.end !== expectedEnd || state.current.loading) return;
      setPrefetching(true);
      void requestWindow(next, true).catch(() => undefined).finally(() => {
        if (mounted.current) setPrefetching([...pending.current.values()].some(request => request.background));
      });
    }, 600);
  }

  function show(entry: PreviewWindow) {
    const current = state.current;
    current.start = entry.start; current.end = entry.end;
    if (entry.display_width && entry.display_height) onGeometry?.(entry.display_width, entry.display_height);
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
    const target = Math.min(Math.max(0, ms), Math.max(0, source.duration_ms - 1));
    const start = Math.floor(target / QUICK_PREVIEW_WINDOW_MS) * QUICK_PREVIEW_WINDOW_MS;
    const generation = ++current.generation;
    const cached = cache.current!.covering(target);
    cancelRequests(start, cached ? Math.floor(cached.end / PREVIEW_WINDOW_MS) * PREVIEW_WINDOW_MS : undefined);
    if (cached) { show(cached); return; }
    status(true);
    try {
      const entry = await requestWindow(start, false, QUICK_PREVIEW_WINDOW_MS);
      if (mounted.current && enabled.current && generation === current.generation) show(entry);
    } catch (error) {
      if (mounted.current && enabled.current && generation === current.generation) {
        if (error instanceof Error && ['source_expired', 'source_not_found'].includes(error.message)) onSourceUnavailable(source.id, error.message === 'source_not_found');
        setFailureMessage(error instanceof Error && error.message === 'tracks_unavailable'
          ? 'Чтобы выбрать аудиодорожку площадки, загрузите исходный файл. Экспорт без звука доступен.'
          : error instanceof Error && error.message === 'audio_track_invalid' ? 'Выбранная аудиодорожка недоступна. Выберите другую дорожку.' : 'Не удалось загрузить участок видео.');
        status(false, true); current.playing = false;
      }
    }
  }

  function seek(ms: number) {
    const current = state.current;
    const target = Math.min(Math.max(0, ms), source.duration_ms);
    publish(target, false);
    window.clearTimeout(seekTimer.current); seekTimer.current = undefined;
    if (!enabled.current) return;
    const clamped = Math.min(target, Math.max(0, source.duration_ms - 1));
    const start = Math.floor(clamped / QUICK_PREVIEW_WINDOW_MS) * QUICK_PREVIEW_WINDOW_MS;
    if (cache.current!.covering(clamped)) { void load(target); return; }
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

  const nextReady = buffered.some(range => range.start <= state.current.end && range.end > state.current.end);
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
      {failed && <div className="window-player-status" role="status"><p>{t(failureMessage)}</p><button className="button secondary" type="button" onClick={() => void load(state.current.position)}>{t('Повторить')}</button></div>}
    </div>
    <div className="window-player-navigation">
      <label className="window-player-seek">
        <span className="window-player-position"><span>{t('Позиция в видео')}</span><span>{formatTimecode(position)} / {formatTimecode(source.duration_ms)}</span></span>
        <span className="window-player-rail">
          <span className="window-player-buffered" aria-hidden="true">{buffered.map(range => <span key={range.start} style={{ left: `${range.start / source.duration_ms * 100}%`, width: `${(range.end-range.start) / source.duration_ms * 100}%` }} />)}</span>
          <input type="range" min="0" max={source.duration_ms} step="100" value={position} aria-label={t('Позиция в видео')} aria-valuetext={formatTimecode(position)} onChange={event => seek(Number(event.target.value))} />
        </span>
      </label>
      <span className="window-player-buffer-status">{prefetching ? t('Загружаем следующий участок…') : nextReady ? t('Следующий участок готов') : t('Недавние участки доступны без ожидания')}</span>
    </div>
  </div>;
});
