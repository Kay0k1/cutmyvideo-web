import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { formatTimecode } from './timecode';

type Strip = { sourceID: string; url: string; start: number; end: number; step: number; frames: number; bytes: number };
const windowMS = 30000;

/** Six real frames from the current area, prepared only after seeking settles. */
export function Storyboard({ sourceID, duration, current, active, onSeek }: { sourceID: string; duration: number; current: number; active: boolean; onSeek(ms: number): void }) {
  const { t } = useLanguage();
  const [strip, setStrip] = useState<Strip | null>(null);
  const [unavailable, setUnavailable] = useState<{ sourceID: string; start: number } | null>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const cache = useRef(new Map<number, Strip>());
  const start = Math.floor(Math.min(current, Math.max(0, duration - 1)) / windowMS) * windowMS;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const saveData = connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '');
  const frameCount = Math.min(6, Math.ceil(Math.min(windowMS, duration - start) / 5000));

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  useEffect(() => {
    const entries = cache.current;
    setStrip(null);
    setUnavailable(null);
    return () => { for (const entry of entries.values()) URL.revokeObjectURL(entry.url); entries.clear(); };
  }, [sourceID]);

  useEffect(() => {
    if (!active || !visible) return;
    const entries = cache.current;
    const cached = entries.get(start);
    if (cached) { entries.delete(start); entries.set(start, cached); setStrip(cached); return; }
    setStrip(null);
    setUnavailable(null);
    if (saveData) return;
    const controller = new AbortController();
    let disposed = false;
    let retry: number | undefined;
    const failed = () => { window.clearTimeout(timeout); if (!disposed) setUnavailable({ sourceID, start }); };
    async function prepare(attempt = 0) {
      try {
        const response = await fetch(`/api/v1/sources/${encodeURIComponent(sourceID)}/storyboard?start_ms=${start}&priority=background`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) {
          if ([429, 503].includes(response.status) && attempt < 9 && !controller.signal.aborted) retry = window.setTimeout(() => { void prepare(attempt + 1); }, 1500);
          else failed();
          return;
        }
        const frameCount = Number(response.headers.get('X-Storyboard-Frames'));
        const frameStep = Number(response.headers.get('X-Storyboard-Step-MS'));
        const actualStart = Number(response.headers.get('X-Preview-Start-MS'));
        const actualEnd = Number(response.headers.get('X-Preview-End-MS'));
        if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 6 || frameStep !== 5000 || actualStart !== start || actualEnd <= start || actualEnd > Math.min(duration, start + windowMS)) { failed(); return; }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!blob.type.startsWith('image/') || blob.size > 1024 * 1024) { failed(); return; }
        const entry = { sourceID, url: URL.createObjectURL(blob), start, end: actualEnd, step: frameStep, frames: frameCount, bytes: blob.size };
        entries.set(start, entry);
        while (entries.size > 8 || [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 8 * 1024 * 1024) {
          const oldest = entries.keys().next().value!;
          URL.revokeObjectURL(entries.get(oldest)!.url); entries.delete(oldest);
        }
        window.clearTimeout(timeout);
        setStrip(entry);
      } catch { failed(); /* Search and playback remain available if frames are unavailable. */ }
    }
    // Foreground playback has priority; scrub gestures never prepare every stop.
    const timer = window.setTimeout(() => { void prepare(); }, 700);
    const timeout = window.setTimeout(() => { failed(); controller.abort(); }, 15000);
    const hidden = () => { if (document.hidden) controller.abort(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { disposed = true; controller.abort(); window.clearTimeout(timer); window.clearTimeout(timeout); window.clearTimeout(retry); document.removeEventListener('visibilitychange', hidden); };
  }, [sourceID, duration, start, active, visible, saveData]);

  if (saveData || frameCount < 1) return null;
  const ready = strip?.sourceID === sourceID && strip.start === start ? strip : null;
  const failedWindow = unavailable?.sourceID === sourceID && unavailable.start === start;
  // Frame preparation must not move the controls while someone scrolls or taps.
  // The source duration determines the same bounded cell geometry in advance.
  return <div className={`storyboard${failedWindow && !ready ? ' storyboard-unavailable' : ''}`} aria-label={t('Кадры рядом с позицией плеера')} aria-busy={!ready && !failedWindow}>
    <span className="storyboard-label">{t(failedWindow && !ready ? 'Кадры недоступны' : 'Кадры рядом с позицией плеера')}</span>
    <div className="storyboard-frames">{Array.from({ length: frameCount }, (_, index) => {
      const ms = start + index * 5000;
      if (!ready || index >= ready.frames) return <span key={ms} className="storyboard-placeholder" aria-hidden="true"><span className="storyboard-frame" /><span>{formatTimecode(ms)}</span></span>;
      return <button key={ms} type="button" aria-label={t('Перейти к кадру {time}', { time: formatTimecode(ms) })} onClick={() => onSeek(ms)}>
        <span className="storyboard-frame" style={{ backgroundImage: `url(${ready.url})`, backgroundPosition: `${index * 20}% 0` }} aria-hidden="true" />
        <span>{formatTimecode(ms)}</span>
      </button>;
    })}</div>
  </div>;
}
