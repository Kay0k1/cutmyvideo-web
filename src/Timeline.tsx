import { useLanguage } from './Language';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { ClipRange } from './types';
import { formatTimecode } from './timecode';
import { keyboardTrimValue, pointerSeekValue, pointerTrimValue } from './timelineControls';
import type { PlaybackPosition } from './playbackPosition';
import { Waveform } from './Waveform';
import { Storyboard } from './Storyboard';
import { Icon } from './Icons';
import './Timeline.css';

export function Timeline({ duration, position, ranges, selected, view, showOverview = true, compact = false, sourceID, active, audioTrack, noAudio, onSeek, onRange, onReveal, onBeginChange, onEndChange }: {
  duration: number;
  position: PlaybackPosition;
  ranges: ClipRange[];
  selected: ClipRange;
  view: [number, number];
  showOverview?: boolean;
  compact?: boolean;
  sourceID: string;
  active: boolean;
  audioTrack?: number;
  noAudio?: boolean;
  onSeek(ms: number): void;
  onRange(start: number, end: number): void;
  onReveal(ms: number): void;
  onBeginChange?(): void;
  onEndChange?(): void;
}) {
  const { t } = useLanguage();
  const current = useSyncExternalStore(position.subscribe, position.getSnapshot);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ which: 'start' | 'end'; pointer: number; x: number; value: number; width: number; span: number } | null>(null);
  const scrub = useRef<{ pointer: number; x: number; y: number; started: boolean } | null>(null);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const [mediaOpen, setMediaOpen] = useState(false);
  const span = view[1] - view[0];
  useEffect(() => { setMediaOpen(false); }, [sourceID]);
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const measure = () => setTrackWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms - view[0]) / span * 100));
  const valueAt = (event: PointerEvent) => {
    const rect = track.current!.getBoundingClientRect();
    return pointerSeekValue(event.clientX, rect.left, rect.width, view);
  };
  const move = (which: 'start' | 'end', value: number) => {
    if (which === 'start') onRange(Math.max(0, Math.min(selected.end_ms - 100, value)), selected.end_ms);
    else onRange(selected.start_ms, Math.min(duration, Math.max(selected.start_ms + 100, value)));
  };
  const onKey = (event: KeyboardEvent, which: 'start' | 'end') => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const value = which === 'start' ? selected.start_ms : selected.end_ms;
    const min = which === 'start' ? 0 : selected.start_ms + 100;
    const max = which === 'start' ? selected.end_ms - 100 : duration;
    const next = keyboardTrimValue(event.key, value, min, max, event.shiftKey);
    if (next === null) return;
    event.preventDefault(); move(which, next); onReveal(next);
  };
  const endDrag = (which: 'start' | 'end', pointer: number) => {
    if (drag.current?.which === which && drag.current.pointer === pointer) { drag.current = null; setDragging(null); onEndChange?.(); }
  };
  const endScrub = (pointer: number) => {
    if (scrub.current?.pointer === pointer) { scrub.current = null; setScrubbing(false); }
  };
  const closeHandles = (pct(selected.end_ms) - pct(selected.start_ms)) / 100 * trackWidth < 18;

  const handle = (which: 'start' | 'end') => {
    const value = which === 'start' ? selected.start_ms : selected.end_ms;
    const visible = value >= view[0] && value <= view[1];
    return <button type="button" className={`trim-handle ${which}${!visible ? ' offscreen' : ''}${closeHandles ? ' close-handles' : ''}`} data-dragging={dragging === which || undefined}
      style={{ left: `${pct(value)}%` }} role="slider" aria-label={which === 'start' ? t("Начало фрагмента на шкале") : t("Конец фрагмента на шкале")}
      aria-valuemin={which === 'start' ? 0 : selected.start_ms + 100}
      aria-valuemax={which === 'start' ? selected.end_ms - 100 : duration}
      aria-valuenow={value} aria-valuetext={formatTimecode(value, true)} aria-orientation="horizontal" aria-describedby="trim-hint"
      onKeyDown={event => onKey(event, which)}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current || scrub.current) return;
        event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
        onBeginChange?.();
        drag.current = { which, pointer: event.pointerId, x: event.clientX, value, width: track.current!.getBoundingClientRect().width, span };
        setDragging(which); event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const original = drag.current;
        if (original?.which === which && original.pointer === event.pointerId) move(which, pointerTrimValue(original.value, event.clientX - original.x, original.width, original.span));
      }}
      onPointerUp={event => endDrag(which, event.pointerId)} onPointerCancel={event => endDrag(which, event.pointerId)} onLostPointerCapture={event => endDrag(which, event.pointerId)}
    ><span className="trim-grip" aria-hidden="true" /><span className={`trim-tooltip ${pct(value) < 50 ? 'align-start' : 'align-end'}`} aria-hidden="true">{which === 'start' ? t('Начало') : t('Конец')}<strong>{formatTimecode(value, true)}</strong></span></button>;
  };

  const mediaTools = <>
    <Waveform sourceID={sourceID} duration={duration} current={current} view={view} active={active} audioTrack={audioTrack} noAudio={noAudio} onSeek={ms => { onSeek(ms); onReveal(ms); }} />
    <Storyboard sourceID={sourceID} duration={duration} current={current} active={active} onSeek={ms => { onSeek(ms); onReveal(ms); }} />
  </>;

  return <div className={`timeline${compact ? ' timeline-compact' : ''}`}>
    <div className="overview-label">{showOverview ? <label htmlFor="overview">{t("Всё видео")}</label> : <span>{t('Позиция плеера')}</span>}<span>{formatTimecode(current)} / {formatTimecode(duration)}</span></div>
    {showOverview && <div className="overview-track">
      <div className="overview-selections" aria-hidden="true">{ranges.map(range => <span key={range.id} style={{ left: `${range.start_ms / duration * 100}%`, width: `${Math.max(.3, (range.end_ms - range.start_ms) / duration * 100)}%` }} />)}</div>
      <input id="overview" type="range" min={0} max={duration} step={100} value={current} aria-valuetext={formatTimecode(current, true)} onChange={event => onSeek(Number(event.target.value))} />
    </div>}
    <div className="trim-track" ref={track}>
      <div className="trim-ticks" aria-hidden="true">{Array.from({ length: 21 }, (_, i) => <i key={i} />)}</div>
      <div className="trim-selection" style={{ left: `${pct(selected.start_ms)}%`, width: `${Math.max(0, pct(selected.end_ms) - pct(selected.start_ms))}%` }} aria-hidden="true" />
      <div className="track-scrubber" role="slider" tabIndex={0} aria-label={t('Позиция плеера')}
        aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.min(duration, current)} aria-valuetext={formatTimecode(current, true)} aria-orientation="horizontal" aria-describedby="seek-hint"
        data-scrubbing={scrubbing || undefined}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
          const next = keyboardTrimValue(event.key, current, 0, duration, event.shiftKey);
          if (next === null) return;
          event.preventDefault(); onSeek(next); onReveal(next);
        }}
        onPointerDown={event => {
          if (event.button !== 0 || drag.current || scrub.current) return;
          const touch = event.pointerType === 'touch';
          scrub.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, started: !touch };
          event.currentTarget.setPointerCapture(event.pointerId);
          if (!touch) { event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); setScrubbing(true); onSeek(Math.min(duration, valueAt(event))); }
        }}
        onPointerMove={event => {
          const original = scrub.current;
          if (!original || original.pointer !== event.pointerId) return;
          if (!original.started) {
            const x = Math.abs(event.clientX - original.x), y = Math.abs(event.clientY - original.y);
            // Let a vertical gesture scroll the page without changing playback.
            if (y > 6 && y > x) { endScrub(event.pointerId); event.currentTarget.releasePointerCapture(event.pointerId); return; }
            if (x < 6) return;
            original.started = true; setScrubbing(true); event.currentTarget.focus({ preventScroll: true });
          }
          onSeek(Math.min(duration, valueAt(event)));
        }}
        onPointerUp={event => {
          if (scrub.current?.pointer !== event.pointerId) return;
          event.currentTarget.focus({ preventScroll: true }); onSeek(Math.min(duration, valueAt(event))); endScrub(event.pointerId);
        }}
        onPointerCancel={event => endScrub(event.pointerId)} onLostPointerCapture={event => endScrub(event.pointerId)}
      />
      {handle('start')}{handle('end')}
      {current >= view[0] && current <= view[1] && <div className="playhead" style={{ left: `${pct(current)}%` }} aria-hidden="true" />}
    </div>
    <div className="tick-labels" aria-hidden="true"><span>{formatTimecode(view[0])}</span><span>{formatTimecode((view[0] + view[1]) / 2)}</span><span>{formatTimecode(view[1])}</span></div>
    {compact ? <details className="timeline-media-disclosure" open={mediaOpen} onToggle={event => setMediaOpen(event.currentTarget.open)}>
      <summary>{t('Кадры и звук')}<Icon name="chevron" size={15} /></summary>
      {mediaOpen && <div className="timeline-media-content">{mediaTools}</div>}
    </details> : mediaTools}
    <p id="trim-hint" className="sr-only">{t('Двигайте ручки начала и конца. Стрелки меняют время на 0,1 секунды, Shift — на секунду.')}</p>
    <p id="seek-hint" className="sr-only">{t('Нажмите на шкалу или двигайте указатель, чтобы перемотать. Стрелки — 0,1 секунды, Shift — секунда; Home и End — начало и конец видео.')}</p>
  </div>;
}
