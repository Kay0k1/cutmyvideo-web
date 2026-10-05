import { useLanguage } from './Language';
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Source } from './types';
import { Icon } from './Icons';
import { providerName } from './sourceInput';
import './Player.css';

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
  onTime(ms: number): void;
  onAvailable(available: boolean): void;
}>(({ source, active, onTime, onAvailable }, ref) => {
  const { t } = useLanguage();
  const video = useRef<HTMLVideoElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const youtube = useRef<YoutubeInstance | null>(null);
  const callbacks = useRef({ onTime, onAvailable });
  callbacks.current = { onTime, onAvailable };
  const pollingActive = useRef(active);
  pollingActive.current = active;
  const [error, setError] = useState(false);
  const provider = providerName(source?.provider);
  const poster = source && source.thumbnail_url === `/api/v1/sources/${encodeURIComponent(source.id)}/thumbnail` ? source.thumbnail_url : undefined;
  let pageUrl: string | undefined;
  try {
    const page = source?.source_url ? new URL(source.source_url) : null;
    if (page?.protocol === 'https:' && !page.username && !page.password && (!page.port || page.port === '443')) pageUrl = page.href;
  } catch { /* A malformed source link must not become a navigation target. */ }

  function readyCommand(command: (player: YTPlayer) => void) {
    const instance = youtube.current;
    if (!instance?.ready || instance.failed || instance.disposed || !instance.player) return;
    // Only calls into the external iframe API are contained here. Application
    // callbacks remain outside this boundary so their errors remain visible.
    try { command(instance.player); } catch { instance.fail(); }
  }

  useImperativeHandle(ref, () => ({
    seek: ms => {
      if (video.current) video.current.currentTime = ms / 1000;
      const instance = youtube.current;
      if (instance && !instance.ready && !instance.failed && !instance.disposed) instance.pendingSeek = ms;
      else readyCommand(player => player.seekTo(ms / 1000, true));
      callbacks.current.onTime(ms);
    },
    play: () => { void video.current?.play().catch(() => undefined); readyCommand(player => player.playVideo()); },
    pause: () => {
      video.current?.pause();
      const instance = youtube.current;
      if (instance && !instance.ready && !instance.failed && !instance.disposed) instance.pendingPause = true;
      else readyCommand(player => player.pauseVideo());
    },
    toggle: () => {
      if (video.current) { if (video.current.paused) void video.current.play().catch(() => undefined); else video.current.pause(); }
      readyCommand(player => { if (player.getPlayerState() === 1) player.pauseVideo(); else player.playVideo(); });
    },
  }), []);

  useEffect(() => { youtube.current?.syncPolling(); }, [active]);

  useEffect(() => {
    const visibility = () => {
      if (document.hidden) { video.current?.pause(); readyCommand(player => player.pauseVideo()); }
      youtube.current?.syncPolling();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  useEffect(() => {
    setError(false);
    callbacks.current.onAvailable(false);
    const id = embedId(source?.embed_url ?? null);
    if (!id || source?.preview_url || !host.current) return;
    let timer: number | undefined;
    const instance: YoutubeInstance = { player: null, ready: false, failed: false, disposed: false, pendingSeek: null, pendingPause: false, syncPolling: () => {
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
      setError(true); callbacks.current.onAvailable(false);
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
  }, [source?.id, source?.embed_url, source?.preview_url]);

  if (!source) return <div className="player-empty">
    <div className="empty-cut"><Icon name="cut" size={36} /></div>
    <h2>{t("Здесь будет ваше видео")}</h2>
    <p>{t("Вставьте ссылку или загрузите файл.")}<br />{t("Затем отметьте начало и конец фрагмента.")}</p>
    <div className="empty-rail" aria-hidden="true"><span /><i /><span /></div>
  </div>;

  return <div className="player-frame">
    {source.preview_url ? <video key={source.id} ref={video} src={source.preview_url} poster={poster} controls playsInline preload="metadata"
      onLoadedMetadata={() => callbacks.current.onAvailable(true)}
      onTimeUpdate={() => callbacks.current.onTime(Math.round((video.current?.currentTime ?? 0) * 1000))}
      onError={() => { setError(true); callbacks.current.onAvailable(false); }} />
      : embedId(source.embed_url) ? <div ref={host} className="youtube-player" />
      : <div className={`player-unavailable platform-preview${poster ? ' has-poster' : ''}`}>
        {poster && <img className="platform-poster" src={poster} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />}
        <div className="platform-preview-copy">
          <span className="platform-preview-provider">{provider ? t(provider) : t('Видео по ссылке')}</span>
          <h2>{t('Видео открыто')}</h2>
          <p>{t('У этого источника нет встроенного предпросмотра. Задайте начало и конец по таймкодам.')}</p>
          {pageUrl && <a className="platform-source-link" href={pageUrl} target="_blank" rel="noopener noreferrer">{t('Посмотреть исходное видео')}<Icon name="link" size={15} /></a>}
        </div>
      </div>}
    {error && <div className="player-error" role="status">{t("Не удалось открыть плеер. Вы можете задать границы по таймкодам и вырезать фрагмент.")}</div>}
  </div>;
}));
