import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { formatTimecode } from './timecode';
import type { Source } from './types';
import type { PlayerControls } from './Player';

// Only the current 30-second window is held in browser memory. Absolute source
// time remains authoritative when seeking and when stopping a selected clip.
export const WindowPlayer = forwardRef<PlayerControls, {
  source: Source; active: boolean; poster?: string; initialPosition: number;
  onTime(ms: number): void; onAvailable(available: boolean): void;
}>(({ source, active, poster, initialPosition, onTime, onAvailable }, ref) => {
  const { t } = useLanguage();
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onTime, onAvailable });
  callbacks.current = { onTime, onAvailable };
  const state = useRef({ start: 0, end: 0, position: initialPosition, playing: false, ready: false, url: '', controller: null as AbortController | null });
  const seekTimer = useRef<number | undefined>(undefined);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(initialPosition);
  const mounted = useRef(false);
  const enabled = useRef(active); enabled.current = active;

  function publish(ms: number) {
    const value = Math.min(source.duration_ms, Math.max(0, Math.round(ms)));
    state.current.position = value; setPosition(value); callbacks.current.onTime(value);
  }

  async function load(ms: number) {
    const current = state.current;
    window.clearTimeout(seekTimer.current);
    seekTimer.current = undefined;
    current.controller?.abort();
    const controller = new AbortController(); current.controller = controller;
    const start = Math.min(Math.max(0, Math.floor(ms / 30000) * 30000), Math.max(0, source.duration_ms - 1));
    setLoading(true); setFailed(false);
    const timer = window.setTimeout(() => controller.abort(), 120000);
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        response = await fetch(`/api/v1/sources/${encodeURIComponent(source.id)}/preview?start_ms=${start}`, { credentials: 'same-origin', signal: controller.signal });
        if (response.ok) break;
        const body = await response.json().catch(() => null);
        if (body?.error?.code !== 'server_busy') throw new Error('preview unavailable');
        await new Promise<void>((resolve, reject) => {
          const stop = () => { window.clearTimeout(wait); reject(new DOMException('Aborted', 'AbortError')); };
          const wait = window.setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve(); }, 1000);
          controller.signal.addEventListener('abort', stop, { once: true });
          if (controller.signal.aborted) stop();
        });
      }
      if (!response?.ok) throw new Error('preview unavailable');
      const blob = await response.blob();
      if (!mounted.current || current.controller !== controller || controller.signal.aborted) return;
      if (blob.size > 16 * 1024 * 1024 || !blob.type.startsWith('video/')) throw new Error('invalid preview');
      if (current.url) URL.revokeObjectURL(current.url);
      current.start = start; current.end = Math.min(start + 30000, source.duration_ms); current.ready = false;
      current.url = URL.createObjectURL(blob); setUrl(current.url);
    } catch {
      if (mounted.current && enabled.current && current.controller === controller) {
        setFailed(true); current.playing = false;
      }
    } finally {
      window.clearTimeout(timer);
      if (mounted.current && current.controller === controller) { current.controller = null; setLoading(false); }
    }
  }

  function seek(ms: number) {
    const current = state.current;
    const target = Math.min(Math.max(0, ms), Math.max(0, source.duration_ms - 1));
    publish(target);
    window.clearTimeout(seekTimer.current);
    seekTimer.current = undefined;
    if (current.url && target >= current.start && target < current.end) {
      current.controller?.abort(); current.controller = null; setLoading(false); setFailed(false);
      if (video.current) video.current.currentTime = (target-current.start)/1000;
    } else if (enabled.current) {
      current.controller?.abort(); current.controller = null;
      setLoading(true);
      seekTimer.current = window.setTimeout(() => { void load(target); }, 180);
    }
  }

  useImperativeHandle(ref, () => ({
    seek,
    play: () => { state.current.playing = true; if (!seekTimer.current && !state.current.controller && state.current.ready && !loading && !failed) void video.current?.play().catch(() => { state.current.playing = false; }); },
    pause: () => { state.current.playing = false; video.current?.pause(); },
    toggle: () => {
      if (state.current.playing) { state.current.playing = false; video.current?.pause(); }
      else { state.current.playing = true; if (!seekTimer.current && !state.current.controller && state.current.ready && !loading && !failed) void video.current?.play().catch(() => { state.current.playing = false; }); }
    },
  }));

  useEffect(() => {
    mounted.current = true;
    // Commands can be queued while an interval is being prepared.
    callbacks.current.onAvailable(true);
    return () => {
      mounted.current = false; state.current.controller?.abort();
      state.current.controller = null;
      window.clearTimeout(seekTimer.current);
      if (state.current.url) URL.revokeObjectURL(state.current.url);
    };
  }, []);

  useEffect(() => {
    if (active) {
      if ((!state.current.url || state.current.position < state.current.start || state.current.position >= state.current.end) && !state.current.controller) void load(state.current.position);
    } else { state.current.playing = false; video.current?.pause(); state.current.controller?.abort(); state.current.controller = null; setLoading(false); window.clearTimeout(seekTimer.current); }
  }, [active]);

  return <div className="window-player">
    <video ref={video} src={url || undefined} poster={poster} controls playsInline preload="metadata" aria-label={source.title}
      onLoadedMetadata={() => {
        state.current.ready = true;
        if (video.current) video.current.currentTime = Math.max(0, (state.current.position-state.current.start)/1000);
        if (state.current.playing) void video.current?.play().catch(() => { state.current.playing = false; });
      }}
      onPlay={() => { state.current.playing = true; }}
      onPause={() => { if (state.current.ready && !video.current?.ended && !state.current.controller && !seekTimer.current) state.current.playing = false; }}
      onTimeUpdate={() => { if (state.current.ready && !loading && !failed && !state.current.controller && !video.current?.seeking) publish(state.current.start+(video.current?.currentTime ?? 0)*1000); }}
      onEnded={() => {
        const current = state.current;
        const shouldContinue = current.playing;
        publish(current.end);
        if (shouldContinue && current.playing && current.end < source.duration_ms && enabled.current) void load(current.end);
        else current.playing = false;
      }}
      onError={() => { if (url && !loading) { setFailed(true); state.current.playing = false; } }} />
    {loading && <div className="window-player-status" role="status"><span className="spinner" />{t('Готовим предпросмотр…')}</div>}
    {failed && <div className="window-player-status" role="status"><p>{t('Не удалось загрузить участок видео.')}</p><button className="button secondary" type="button" onClick={() => void load(state.current.position)}>{t('Повторить')}</button></div>}
    <label className="window-player-seek"><span>{t('Позиция в видео')} · {formatTimecode(position)} / {formatTimecode(source.duration_ms)}</span><input type="range" min="0" max={Math.max(0, source.duration_ms-1)} step="100" value={position} aria-label={t('Позиция в видео')} onChange={event => seek(Number(event.target.value))} /></label>
  </div>;
});
