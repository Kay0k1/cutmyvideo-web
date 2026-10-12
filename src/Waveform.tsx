import { useEffect, useMemo, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { parseWaveform, waveformPath } from './waveform';
import type { WaveformWindow } from './waveform';
import './Waveform.css';

/** Only settled, visible source windows are decoded; the overview fills gradually. */
export function Waveform({ sourceID, duration, current, view, active, audioTrack, noAudio, onSeek }: {
  sourceID: string; duration: number; current: number; view: [number, number]; active: boolean;
  audioTrack?: number; noAudio?: boolean; onSeek(ms: number): void;
}) {
  const { locale } = useLanguage();
  const text = (ru: string, en: string) => locale === 'en' ? en : ru;
  const key = `${sourceID}:${audioTrack ?? 'default'}`;
  const cache = useRef<{ key: string; windows: Map<number, WaveformWindow> }>({ key, windows: new Map() });
  const [snapshot, setSnapshot] = useState<{ key: string; windows: WaveformWindow[] }>({ key, windows: [] });
  const [state, setState] = useState<{ key: string; start: number; status: 'loading' | 'ready' | 'unavailable' }>({ key, start: 0, status: 'loading' });
  const [visible, setVisible] = useState(!document.hidden);
  const start = Math.floor(Math.min(current, Math.max(0, duration - 1)) / 30000) * 30000;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  const saveData = connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '');

  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);

  useEffect(() => {
    if (cache.current.key !== key) cache.current = { key, windows: new Map() };
    if (!active || !visible || noAudio || saveData || duration <= 0) return;
    const entries = cache.current.windows;
    if (entries.has(start)) { setSnapshot({ key, windows: [...entries.values()] }); setState({ key, start, status: 'ready' }); return; }
    setState({ key, start, status: 'loading' });
    const controller = new AbortController();
    let timer: number | undefined;
    let disposed = false;
    const fail = () => { if (!disposed) setState({ key, start, status: 'unavailable' }); };
    async function load(attempt = 0): Promise<void> {
      try {
        const response = await fetch(`/api/v1/sources/${encodeURIComponent(sourceID)}/waveform?start_ms=${start}${audioTrack !== undefined ? `&audio_track=${audioTrack}` : ''}&priority=background`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) {
          if ([429, 503].includes(response.status) && attempt < 8 && !controller.signal.aborted) timer = window.setTimeout(() => void load(attempt + 1), 1500);
          else fail();
          return;
        }
        const raw = await response.text();
        if (controller.signal.aborted || disposed) return;
        if (raw.length >= 65536) { fail(); return; }
        const data = parseWaveform(JSON.parse(raw), start, duration);
        if (!data || audioTrack !== undefined && data.has_audio && data.audio_track !== audioTrack) { fail(); return; }
        entries.set(start, data);
        while (entries.size > 256) entries.delete(entries.keys().next().value!);
        setSnapshot({ key, windows: [...entries.values()] });
        setState({ key, start, status: 'ready' });
      } catch { if (!controller.signal.aborted) fail(); }
    }
    // Give playback and its inspection a head start; continuous scrubbing
    // cancels this timer instead of analysing every intermediate position.
    timer = window.setTimeout(() => void load(), 1000);
    const deadline = window.setTimeout(() => { fail(); controller.abort(); }, 25000);
    return () => { disposed = true; controller.abort(); window.clearTimeout(timer); window.clearTimeout(deadline); };
  }, [key, sourceID, duration, start, active, visible, audioTrack, noAudio, saveData]);

  const windows = snapshot.key === key ? snapshot.windows : [];
  const currentWindow = windows.find(window => window.start_ms === start);
  const detail = useMemo(() => waveformPath(windows, view), [windows, view[0], view[1]]);
  const overview = useMemo(() => waveformPath(windows, [0, duration], 600, 12), [windows, duration]);
  if (noAudio || saveData) return null;
  const available = currentWindow?.has_audio;
  const status = state.key === key && state.start === start ? state.status : 'loading';
  const label = currentWindow && !available ? text('В источнике нет звука', 'This source has no audio') : status === 'unavailable'
    ? text('Звуковая волна недоступна', 'Audio waveform unavailable') : status === 'loading'
      ? text('Готовим звуковую волну…', 'Preparing audio waveform…') : text('Звуковая волна', 'Audio waveform');
  return <div className="audio-waveform" aria-label={text('Звуковая волна выбранной дорожки', 'Selected audio waveform')}>
    <span className="waveform-label">{label}</span>
    <svg className="waveform-detail" viewBox="0 0 600 40" preserveAspectRatio="none" aria-hidden="true"><path d={detail} /></svg>
    <button className="waveform-overview" type="button" aria-label={text('Обзор звука всей записи; подготовлены просмотренные участки', 'Whole recording audio overview; visited areas are prepared')}
      onClick={event => { const box = event.currentTarget.getBoundingClientRect(); onSeek(Math.round(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * duration)); }}>
      <svg viewBox="0 0 600 12" preserveAspectRatio="none" aria-hidden="true"><path d={overview} /></svg>
      <span className="waveform-position" style={{ left: `${Math.min(100, current / duration * 100)}%` }} aria-hidden="true" />
    </button>
    <span className="waveform-hint">{text('Участки готовятся по мере просмотра', 'Sections are prepared as you explore')}</span>
  </div>;
}
