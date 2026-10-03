import { useLanguage } from './Language';
import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { ClipRange } from './types';
import { formatTimecode } from './timecode';

export function Timeline({ duration, current, ranges, selected, view, showOverview = true, onSeek, onRange }: {
  duration: number;
  current: number;
  ranges: ClipRange[];
  selected: ClipRange;
  view: [number, number];
  showOverview?: boolean;
  onSeek(ms: number): void;
  onRange(start: number, end: number): void;
}) {
  const { t } = useLanguage();
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<'start' | 'end' | null>(null);
  const span = view[1] - view[0];
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms - view[0]) / span * 100));
  const valueAt = (event: PointerEvent) => {
    const rect = track.current!.getBoundingClientRect();
    return Math.round((view[0] + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * span) / 100) * 100;
  };
  const move = (which: 'start' | 'end', value: number) => {
    if (which === 'start') onRange(Math.max(0, Math.min(selected.end_ms - 100, value)), selected.end_ms);
    else onRange(selected.start_ms, Math.min(duration, Math.max(selected.start_ms + 100, value)));
  };
  const onKey = (event: KeyboardEvent, which: 'start' | 'end') => {
    const value = which === 'start' ? selected.start_ms : selected.end_ms;
    const min = which === 'start' ? 0 : selected.start_ms + 100;
    const max = which === 'start' ? selected.end_ms - 100 : duration;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': case 'ArrowDown': next = value - (event.shiftKey ? 1000 : 100); break;
      case 'ArrowRight': case 'ArrowUp': next = value + (event.shiftKey ? 1000 : 100); break;
      case 'PageDown': next = value - 5000; break;
      case 'PageUp': next = value + 5000; break;
      case 'Home': next = min; break;
      case 'End': next = max; break;
      default: return;
    }
    event.preventDefault(); move(which, next);
  };

  const handle = (which: 'start' | 'end') => {
    const value = which === 'start' ? selected.start_ms : selected.end_ms;
    const visible = value >= view[0] && value <= view[1];
    return <button type="button" className={`trim-handle ${which}${!visible ? ' offscreen' : ''}`}
      style={{ left: `${pct(value)}%` }} role="slider" aria-label={which === 'start' ? t("Начало фрагмента на шкале") : t("Конец фрагмента на шкале")}
      aria-valuemin={which === 'start' ? 0 : selected.start_ms + 100}
      aria-valuemax={which === 'start' ? selected.end_ms - 100 : duration}
      aria-valuenow={value} aria-valuetext={formatTimecode(value, true)} aria-orientation="horizontal" aria-describedby="trim-hint"
      onKeyDown={event => onKey(event, which)}
      onPointerDown={event => { event.stopPropagation(); drag.current = which; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (drag.current === which) move(which, valueAt(event)); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    ><span aria-hidden="true">{which === 'start' ? '[' : ']'}</span></button>;
  };

  return <div className="timeline">
    <div className="overview-label">{showOverview ? <label htmlFor="overview">{t("Всё видео")}</label> : <span>{t('Позиция плеера')}</span>}<span>{formatTimecode(current)} / {formatTimecode(duration)}</span></div>
    {showOverview && <div className="overview-track">
      <div className="overview-selections" aria-hidden="true">{ranges.map(range => <span key={range.id} style={{ left: `${range.start_ms / duration * 100}%`, width: `${Math.max(.3, (range.end_ms - range.start_ms) / duration * 100)}%` }} />)}</div>
      <input id="overview" type="range" min={0} max={duration} step={100} value={current} aria-valuetext={formatTimecode(current, true)} onChange={event => onSeek(Number(event.target.value))} />
    </div>}
    <div className="trim-track" ref={track} onPointerDown={event => { if (!(event.target as HTMLElement).closest('.trim-handle')) onSeek(Math.min(duration, valueAt(event))); }}>
      <div className="trim-ticks" aria-hidden="true">{Array.from({ length: 21 }, (_, i) => <i key={i} />)}</div>
      <div className="trim-selection" style={{ left: `${pct(selected.start_ms)}%`, width: `${Math.max(0, pct(selected.end_ms) - pct(selected.start_ms))}%` }} aria-hidden="true" />
      {handle('start')}{handle('end')}
      {current >= view[0] && current <= view[1] && <div className="playhead" style={{ left: `${pct(current)}%` }} aria-hidden="true" />}
    </div>
    <div className="tick-labels" aria-hidden="true"><span>{formatTimecode(view[0])}</span><span>{formatTimecode((view[0] + view[1]) / 2)}</span><span>{formatTimecode(view[1])}</span></div>
    <p id="trim-hint" className="sr-only">{t('Двигайте ручки начала и конца. Стрелки меняют время на 0,1 секунды, Shift — на секунду.')}</p>
  </div>;
}
