import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Source } from './types';
import { Icon } from './Icons';

export interface PlayerControls { seek(ms: number): void; play(): void; pause(): void; toggle(): void; }
interface YTPlayer {
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}
interface YTNamespace {
  Player: new (element: HTMLElement, options: {
    videoId: string;
    host: string;
    playerVars: Record<string, string | number>;
    events: { onReady(): void; onError(): void };
  }) => YTPlayer;
}
declare global { interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void; } }

let youtubePromise: Promise<YTNamespace> | null = null;
function youtubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubePromise) return youtubePromise;
  youtubePromise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { youtubePromise = null; reject(new Error('embed unavailable')); }, 15000);
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout);
      if (window.YT) resolve(window.YT); else reject(new Error('embed unavailable'));
    };
    if (!document.querySelector('script[data-youtube-api]')) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.dataset.youtubeApi = 'true';
      script.onerror = () => { window.clearTimeout(timeout); youtubePromise = null; reject(new Error('embed unavailable')); };
      document.head.appendChild(script);
    }
  });
  return youtubePromise;
}

function embedId(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!['www.youtube.com', 'youtube.com', 'www.youtube-nocookie.com'].includes(parsed.hostname)) return null;
    const id = parsed.pathname.split('/embed/')[1]?.split('/')[0];
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export const Player = forwardRef<PlayerControls, {
  source: Source | null;
  onTime(ms: number): void;
  onAvailable(available: boolean): void;
}>(({ source, onTime, onAvailable }, ref) => {
  const video = useRef<HTMLVideoElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const youtube = useRef<YTPlayer | null>(null);
  const callbacks = useRef({ onTime, onAvailable });
  callbacks.current = { onTime, onAvailable };
  const [error, setError] = useState(false);

  useImperativeHandle(ref, () => ({
    seek: ms => { if (video.current) video.current.currentTime = ms / 1000; youtube.current?.seekTo(ms / 1000, true); callbacks.current.onTime(ms); },
    play: () => { void video.current?.play().catch(() => undefined); youtube.current?.playVideo(); },
    pause: () => { video.current?.pause(); youtube.current?.pauseVideo(); },
    toggle: () => {
      if (video.current) { if (video.current.paused) void video.current.play().catch(() => undefined); else video.current.pause(); }
      if (youtube.current) { if (youtube.current.getPlayerState() === 1) youtube.current.pauseVideo(); else youtube.current.playVideo(); }
    },
  }), []);

  useEffect(() => {
    setError(false);
    callbacks.current.onAvailable(false);
    const id = embedId(source?.embed_url ?? null);
    if (!id || source?.preview_url || !host.current) return;
    let disposed = false;
    let timer: number | undefined;
    const element = document.createElement('div');
    host.current.replaceChildren(element);
    void youtubeApi().then(YT => {
      if (disposed) return;
      youtube.current = new YT.Player(element, {
        videoId: id, host: 'https://www.youtube-nocookie.com',
        playerVars: { origin: window.location.origin, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            if (disposed) return;
            callbacks.current.onAvailable(true);
            timer = window.setInterval(() => callbacks.current.onTime(Math.round((youtube.current?.getCurrentTime() ?? 0) * 1000)), 150);
          },
          onError: () => { if (!disposed) { setError(true); callbacks.current.onAvailable(false); } },
        },
      });
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; window.clearInterval(timer); youtube.current?.destroy(); youtube.current = null; };
  }, [source?.id, source?.embed_url, source?.preview_url]);

  if (!source) return <div className="player-empty">
    <div className="empty-cut"><Icon name="cut" size={36} /></div>
    <h2>Здесь будет ваше видео</h2>
    <p>Вставьте ссылку или загрузите файл.<br />Затем отметьте начало и конец фрагмента.</p>
    <div className="empty-rail" aria-hidden="true"><span /><i /><span /></div>
  </div>;

  return <div className="player-frame">
    {source.preview_url ? <video key={source.id} ref={video} src={source.preview_url} controls playsInline preload="metadata"
      onLoadedMetadata={() => callbacks.current.onAvailable(true)}
      onTimeUpdate={() => callbacks.current.onTime(Math.round((video.current?.currentTime ?? 0) * 1000))}
      onError={() => { setError(true); callbacks.current.onAvailable(false); }} />
      : embedId(source.embed_url) ? <div ref={host} className="youtube-player" />
      : <div className="player-unavailable"><Icon name="file" size={30} /><h2>Предпросмотр недоступен</h2><p>Выберите фрагмент по таймкодам.<br />Экспорт остаётся доступным.</p></div>}
    {error && <div className="player-error" role="status">Не удалось открыть плеер. Вы можете задать границы по таймкодам и вырезать фрагмент.</div>}
  </div>;
});
