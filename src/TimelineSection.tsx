import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { useLanguage } from './Language';
import { formatTimecode } from './timecode';
import { keyboardTrimValue, pointerTimelineTime } from './timelineControls';
import type { ClipRange } from './types';
import './TimelineSection.css';

interface SectionDrag {
  pointer: number;
  x: number;
  y: number;
  left: number;
  width: number;
  duration: number;
  start: number;
  span: number;
  inside: boolean;
  started: boolean;
  begun: boolean;
  last: number;
}

export function TimelineSection({ duration, section, ranges, selected, current = 0, onSeek, showPlayback = false, onChange, onBeginChange, onEndChange }: {
  duration: number;
  section: [number, number];
  ranges: ClipRange[];
  selected: ClipRange;
  current?: number;
  onSeek?(ms: number): void;
  showPlayback?: boolean;
  onChange(start: number): void;
  onBeginChange?(): void;
  onEndChange?(): void;
}) {
  const { t } = useLanguage();
  const hintID = useId();
  const track = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLButtonElement>(null);
  const drag = useRef<SectionDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const length = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const span = Math.max(0, Math.min(length, section[1] - section[0]));
  const maximum = Math.max(0, length - span);
  const start = Math.max(0, Math.min(maximum, section[0]));
  const end = start + span;
  const disabled = maximum === 0 || span === 0;
  const percent = (value: number) => length > 0 ? Math.max(0, Math.min(100, value / length * 100)) : 0;
  const exactWidth = length > 0 ? span / length * trackWidth : 0;
  const hitWidth = Math.min(trackWidth, Math.max(44, exactWidth));
  const hitLeft = Math.max(0, Math.min(trackWidth - hitWidth, percent(start) / 100 * trackWidth - (hitWidth - exactWidth) / 2));

  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const measure = () => setTrackWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const update = (original: SectionDrag, point: number) => {
    if (original.width <= 0) return;
    // Keep the original time and grab point throughout the gesture. The parent
    // can move the clip on each update without changing our next movement.
    const value = original.inside
      ? original.start + Math.round((point - original.x) / original.width * original.duration)
      : Math.round(pointerTimelineTime(point, original.left, original.width, [0, original.duration]) - original.span / 2);
    const next = Math.max(0, Math.min(original.duration - original.span, value));
    if (next === original.last) return;
    if (!original.begun) { original.begun = true; onBeginChange?.(); }
    original.last = next;
    onChange(next);
  };

  const finish = (pointer: number) => {
    const original = drag.current;
    if (!original || original.pointer !== pointer) return;
    drag.current = null;
    setDragging(false);
    if (original.begun) onEndChange?.();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || drag.current || !track.current) return;
    const rect = track.current.getBoundingClientRect();
    const touch = event.pointerType === 'touch';
    const inside = event.target instanceof Element && Boolean(event.target.closest('.timeline-section-window'));
    const original: SectionDrag = {
      pointer: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, width: rect.width, duration: length, start, span,
      inside, started: !touch, begun: false, last: start,
    };
    drag.current = original;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!touch) {
      event.preventDefault();
      slider.current?.focus({ preventScroll: true });
      setDragging(true);
      if (!inside) update(original, event.clientX);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const original = drag.current;
    if (!original || original.pointer !== event.pointerId) return;
    if (!original.started) {
      const x = Math.abs(event.clientX - original.x), y = Math.abs(event.clientY - original.y);
      // A vertical touch gesture scrolls the page without moving the section.
      if (y > 6 && y > x) {
        finish(event.pointerId);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        return;
      }
      if (x < 6) return;
      original.started = true;
      setDragging(true);
      slider.current?.focus({ preventScroll: true });
    }
    event.preventDefault();
    update(original, event.clientX);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const original = drag.current;
    if (!original || original.pointer !== event.pointerId) return;
    event.preventDefault();
    slider.current?.focus({ preventScroll: true });
    if (original.started || !original.inside) update(original, event.clientX);
    finish(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const next = keyboardTrimValue(event.key, start, 0, maximum, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    if (next === start) return;
    onBeginChange?.();
    onChange(next);
    onEndChange?.();
  };

  return <div className="timeline-section">
    <div className="timeline-section-heading">
      <span>{t('Выберите участок')}</span>
      <span>{formatTimecode(start)} – {formatTimecode(end)}</span>
    </div>
    <div className="timeline-section-track" ref={track} data-dragging={dragging || undefined} data-disabled={disabled || undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={event => finish(event.pointerId)} onLostPointerCapture={event => finish(event.pointerId)}>
      <div className="timeline-section-baseline" aria-hidden="true" />
      <div className="timeline-section-clips" aria-hidden="true">
        {ranges.map(range => <span key={range.id} data-selected={range.id === selected.id || undefined}
          style={{ left: `${percent(range.start_ms)}%`, width: `${Math.max(0, percent(range.end_ms) - percent(range.start_ms))}%` }} />)}
      </div>
      <div className="timeline-section-range" aria-hidden="true" style={{ left: `${percent(start)}%`, width: `${percent(end) - percent(start)}%` }}>
        <span className="timeline-section-edge start" /><span className="timeline-section-edge end" />
      </div>
      {showPlayback && <input id="overview" className="timeline-section-playback" type="range" min={0} max={length} step={100}
        value={Math.max(0, Math.min(length, current))} disabled={length === 0} aria-label={t('Всё видео')}
        aria-valuetext={formatTimecode(current, true)} onChange={event => onSeek?.(Number(event.target.value))} />}
      <button className="timeline-section-window" type="button" role="slider" ref={slider} disabled={disabled}
        aria-label={t('Участок для обрезки')} aria-valuemin={0} aria-valuemax={maximum}
        aria-valuenow={start} aria-valuetext={`${formatTimecode(start, true)} – ${formatTimecode(end, true)}`}
        aria-orientation="horizontal" aria-describedby={hintID} onKeyDown={onKeyDown}
        style={trackWidth > 0 ? { left: hitLeft, width: hitWidth } : { left: `${percent(start)}%`, width: `${percent(end) - percent(start)}%` }} />
    </div>
    <div className="timeline-section-labels" aria-hidden="true"><span>{formatTimecode(0)}</span><span>{formatTimecode(length)}</span></div>
    <p className="sr-only" id={hintID}>{t('Перемещайте участок целиком или нажмите на шкалу. Стрелки — 0,1 секунды, Shift — секунда, Page Up и Page Down — 5 секунд; Home и End — края видео.')}</p>
  </div>;
}
