import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Update the playhead and stop cuts promptly without polling paused media. */
export function usePlaybackClock(video: RefObject<HTMLVideoElement | null>, active: boolean, onTime: () => void, mediaKey?: string) {
  const callback = useRef(onTime); callback.current = onTime;
  useEffect(() => {
    const node = video.current;
    if (!node || !active) return;
    let frame: number | undefined, last = 0;
    const tick = (now: number) => {
      frame = undefined;
      if (node.paused || document.hidden) return;
      if (!node.seeking && now - last >= 40) { last = now; callback.current(); }
      if (!node.paused) frame = window.requestAnimationFrame(tick);
    };
    const start = () => { if (frame === undefined && !document.hidden && !node.paused) frame = window.requestAnimationFrame(tick); };
    const stop = () => { if (frame !== undefined) window.cancelAnimationFrame(frame); frame = undefined; };
    const visibility = () => { if (document.hidden) stop(); else start(); };
    node.addEventListener('play', start); node.addEventListener('pause', stop); document.addEventListener('visibilitychange', visibility); start();
    return () => { stop(); node.removeEventListener('play', start); node.removeEventListener('pause', stop); document.removeEventListener('visibilitychange', visibility); };
  }, [video, active, mediaKey]);
}
