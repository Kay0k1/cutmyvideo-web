import { useLanguage } from './Language';
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Source } from './types';
import { Icon } from './Icons';
import './Player.css';
import { WindowPlayer } from './WindowPlayer';
import { usePlaybackClock } from './usePlaybackClock';

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
    events: { onReady(event: { target: YTPlayer }): void; onError(event: { target: YTPlayer }): void };
  }) => YTPlayer;
}
interface YoutubeInstance {
  player: YTPlayer | null;
  ready: boolean;
  failed: boolean;
  disposed: boolean;
  pendingSeek: number | null;
  pendingPause: boolean;
  syncPolling(): void;
  fail(): void;
}
declare global { interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void; } }

let youtubePromise: Promise<YTNamespace> | null = null;
function youtubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubePromise) return youtubePromise;
  youtubePromise = new Promise((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>('script[data-youtube-api]');
    const fail = () => {
      window.clearTimeout(timeout);
      if (script) { script.onerror = null; script.remove(); }
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = undefined;
      youtubePromise = null;
      reject(new Error('embed unavailable'));
    };
    const timeout = window.setTimeout(fail, 15000);
    const ready = () => {
      window.clearTimeout(timeout);
      if (window.YT?.Player) { if (script) script.onerror = null; resolve(window.YT); }
      else fail();
    };
    window.onYouTubeIframeAPIReady = ready;
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.dataset.youtubeApi = 'true';
      script.onerror = fail;
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

export const Player = memo(forwardRef<PlayerControls, {
  source: Source | null;
  active: boolean;
  audioTrack?: number;
  noAudio?: boolean;
  forceWindow?: boolean;
  onGeometry?(width: number, height: number): void;
  onTime(ms: number): void;
  onAvailable(available: boolean): void;
  onSourceUnavailable(id: string, verify?: boolean): void;
}>(({ source, active, audioTrack, noAudio, forceWindow, onGeometry, onTime, onAvailable, onSourceUnavailable }, ref) => {
  const { t } = useLanguage();
  const video = useRef<HTMLVideoElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const youtube = useRef<YoutubeInstance | null>(null);
  const callbacks = useRef({ onTime, onAvailable });
  const lastTime = useRef({ id: source?.id, ms: 0 });
  if (lastTime.current.id !== source?.id) lastTime.current = { id: source?.id, ms: 0 };
  callbacks.current = { onTime: ms => { lastTime.current.ms = ms; onTime(ms); }, onAvailable };
  const pollingActive = useRef(active);
  pollingActive.current = active;
  const [serverPreview, setServerPreview] = useState(false);
  const windowPlayer = useRef<PlayerControls>(null);
  const useWindow = forceWindow || audioTrack !== undefined || noAudio === true || serverPreview || (!!source && !source.preview_url && !embedId(source.embed_url));
  const poster = source && source.thumbnail_url === `/api/v1/sources/${encodeURIComponent(source.id)}/thumbnail` ? source.thumbnail_url : undefined;
  usePlaybackClock(video, active && !useWindow && !!source?.preview_url, () => callbacks.current.onTime(Math.round((video.current?.currentTime ?? 0) * 1000)), source?.id);

  function readyCommand(command: (player: YTPlayer) => void) {
    const instance = youtube.current;
    if (!instance?.ready || instance.failed || instance.disposed || !instance.player) return;
    // Only calls into the external iframe API are contained here. Application
    // callbacks remain outside this boundary so their errors remain visible.
    try { command(instance.player); } catch { instance.fail(); }
  }

  useImperativeHandle(ref, () => ({
    seek: ms => {
      if (windowPlayer.current) { windowPlayer.current.seek(ms); return; }
      if (video.current) video.current.currentTime = ms / 1000;
      const instance = youtube.current;
      if (instance && !instance.ready && !instance.failed && !instance.disposed) instance.pendingSeek = ms;
      else readyCommand(player => player.seekTo(ms / 1000, true));
      callbacks.current.onTime(ms);
    },
    play: () => { if (windowPlayer.current) { windowPlayer.current.play(); return; } void video.current?.play().catch(() => undefined); readyCommand(player => player.playVideo()); },
    pause: () => {
      if (windowPlayer.current) { windowPlayer.current.pause(); return; }
      video.current?.pause();
      const instance = youtube.current;
      if (instance && !instance.ready && !instance.failed && !instance.disposed) instance.pendingPause = true;
      else readyCommand(player => player.pauseVideo());
    },
    toggle: () => {
      if (windowPlayer.current) { windowPlayer.current.toggle(); return; }
      if (video.current) { if (video.current.paused) void video.current.play().catch(() => undefined); else video.current.pause(); }
      readyCommand(player => { if (player.getPlayerState() === 1) player.pauseVideo(); else player.playVideo(); });
    },
  }), []);

  useEffect(() => { youtube.current?.syncPolling(); }, [active]);

  useEffect(() => {
    const visibility = () => {
      if (document.hidden) { windowPlayer.current?.pause(); video.current?.pause(); readyCommand(player => player.pauseVideo()); }
      youtube.current?.syncPolling();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  useEffect(() => {
    setServerPreview(false);
  }, [source?.id]);

  useEffect(() => {
    if (useWindow) return;
    callbacks.current.onAvailable(false);
    const id = embedId(source?.embed_url ?? null);
    if (!id || source?.preview_url || !host.current) return;
    let timer: number | undefined;
    const instance: YoutubeInstance = { player: null, ready: false, failed: false, disposed: false, pendingSeek: lastTime.current.ms || null, pendingPause: false, syncPolling: () => {
      window.clearInterval(timer); timer = undefined;
      if (document.hidden || !pollingActive.current || !instance.ready || instance.failed || instance.disposed) return;
      timer = window.setInterval(() => {
        if (!instance.ready || instance.failed || instance.disposed || youtube.current !== instance || !instance.player) return;
        let seconds: number;
        try { seconds = instance.player.getCurrentTime(); } catch { instance.fail(); return; }
        if (!Number.isFinite(seconds) || seconds < 0) { instance.fail(); return; }
        callbacks.current.onTime(Math.round(seconds * 1000));
      }, 150);
    }, fail: () => {
      if (instance.disposed || youtube.current !== instance) return;
      instance.failed = true; instance.ready = false; instance.pendingSeek = null; instance.pendingPause = false;
      window.clearInterval(timer); timer = undefined;
      setServerPreview(true); callbacks.current.onAvailable(false);
    } };
    youtube.current = instance;
    const element = document.createElement('div');
    host.current.replaceChildren(element);
    void youtubeApi().then(YT => {
      if (instance.disposed || youtube.current !== instance) return;
      instance.player = new YT.Player(element, {
        videoId: id, host: 'https://www.youtube-nocookie.com',
        playerVars: { origin: window.location.origin, playsinline: 1, rel: 0 },
        events: {
          onReady: event => {
            if (instance.disposed || instance.failed || youtube.current !== instance || (instance.player && event.target !== instance.player)) return;
            instance.player = event.target; instance.ready = true;
            const iframe = host.current?.querySelector('iframe');
            if (iframe && source?.title) iframe.title = source.title;
            const pendingSeek = instance.pendingSeek;
            if (pendingSeek !== null) readyCommand(player => player.seekTo(pendingSeek / 1000, true));
            if (instance.pendingPause) readyCommand(player => player.pauseVideo());
            instance.pendingSeek = null; instance.pendingPause = false;
            if (!instance.ready) return;
            callbacks.current.onAvailable(true);
            if (!instance.ready || instance.failed || instance.disposed || youtube.current !== instance) return;
            instance.syncPolling();
          },
          onError: event => { if (!instance.disposed && youtube.current === instance && (!instance.player || event.target === instance.player)) instance.fail(); },
        },
      });
    }).catch(() => { instance.fail(); });
    return () => {
      instance.disposed = true; instance.ready = false; instance.pendingSeek = null; instance.pendingPause = false;
      window.clearInterval(timer);
      if (youtube.current === instance) youtube.current = null;
      // An iframe can remove itself before disposal. Cleanup must not leave the
      // application mounted with references to that external player.
      if (typeof instance.player?.destroy === 'function') {
        try { instance.player.destroy(); } catch { /* The instance is already detached from application state. */ }
      }
    };
  }, [source?.id, source?.embed_url, source?.preview_url, useWindow]);

  if (!source) return <div className="player-empty">
    <div className="empty-cut"><Icon name="cut" size={36} /></div>
    <h2>{t("Здесь будет ваше видео")}</h2>
    <p>{t("Вставьте ссылку или загрузите файл.")}<br />{t("Затем отметьте начало и конец фрагмента.")}</p>
    <div className="empty-rail" aria-hidden="true"><span /><i /><span /></div>
  </div>;

  return <div className="player-frame">
    {useWindow ? <WindowPlayer key={`${source.id}:${audioTrack ?? 'default'}:${noAudio ?? false}`} ref={windowPlayer} source={source} audioTrack={audioTrack} noAudio={noAudio} active={active} poster={poster} initialPosition={lastTime.current.ms} onTime={ms => callbacks.current.onTime(ms)} onAvailable={onAvailable} onGeometry={onGeometry} onSourceUnavailable={onSourceUnavailable} /> : source.preview_url ? <video key={source.id} ref={video} src={source.preview_url} poster={poster} controls playsInline preload="metadata" aria-label={source.title}
      onLoadedMetadata={() => { if (video.current) onGeometry?.(video.current.videoWidth, video.current.videoHeight); if (video.current && lastTime.current.ms > 0) video.current.currentTime = lastTime.current.ms / 1000; callbacks.current.onAvailable(true); }}
      onTimeUpdate={() => { if (!video.current?.seeking) callbacks.current.onTime(Math.round((video.current?.currentTime ?? 0) * 1000)); }}
      onError={() => { setServerPreview(true); callbacks.current.onAvailable(false); }} />
      : <div ref={host} className="youtube-player" />}

  </div>;
}));
