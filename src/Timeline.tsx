import { createPortal } from 'react-dom';
import { useLanguage } from './Language';
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { ClipRange } from './types';
import { formatTimecode } from './timecode';
import { keyboardTrimValue, panTimelineView, pointerSeekValue, pointerTimelineTime, pointerTrimValue, trimBoundaryLimits, zoomTimelineView } from './timelineControls';
import type { PlaybackPosition } from './playbackPosition';
import { Waveform } from './Waveform';
import { Storyboard } from './Storyboard';
import { Icon } from './Icons';
import { TimelineSection } from './TimelineSection';
import './Timeline.css';

export function Timeline({ duration, position, ranges, selected, section, view, maximumRange = Infinity, showOverview = true, compact = false, toolsContainer, sourceID, active, audioTrack, noAudio, onSeek, onRange, onReveal, onSection, onView, onBeginChange, onEndChange }: {
  duration: number;
  position: PlaybackPosition;
  ranges: ClipRange[];
  selected: ClipRange;
  section: [number, number];
  view: [number, number];
  maximumRange?: number;
  showOverview?: boolean;
  compact?: boolean;
  toolsContainer?: HTMLElement | null;
  sourceID: string;
  active: boolean;
  audioTrack?: number;
  noAudio?: boolean;
  onSeek(ms: number): void;
  onRange(start: number, end: number): void;
  onReveal(ms: number): void;
  onSection(start: number): void;
  onView(view: [number, number]): void;
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
  const wheelView = useRef(view);
  const gesture = useRef<{ view: [number, number]; anchor: number } | null>(null);
  wheelView.current = view;
  const span = view[1] - view[0];
  const sectionSpan = section[1] - section[0];
  const zoomed = span < sectionSpan - 1;
  const wheel = useEffectEvent((event: WheelEvent) => {
    if (drag.current || scrub.current || gesture.current || event.altKey || event.metaKey) return;
    const rect = track.current!.getBoundingClientRect();
    if (rect.width <= 0 || !event.deltaX && !event.deltaY) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.width : 1;
    const currentView = wheelView.current;
    const horizontal = !event.ctrlKey && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY));
    const next = horizontal
      ? panTimelineView(section, currentView, (event.deltaX || event.deltaY) * unit / rect.width * (currentView[1] - currentView[0]))
      : zoomTimelineView(section, currentView, pointerTimelineTime(event.clientX, rect.left, rect.width, currentView), Math.exp(Math.max(-1, Math.min(1, event.deltaY * unit * (event.ctrlKey ? .012 : .003)))));
    event.preventDefault();
    wheelView.current = next; onView(next);
  });
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const listener = (event: WheelEvent) => wheel(event);
    node.addEventListener('wheel', listener, { passive: false });
    return () => node.removeEventListener('wheel', listener);
  }, []);
  // Safari reports trackpad pinches as GestureEvents rather than ctrl+wheel.
  const pinch = useEffectEvent((event: Event) => {
    const native = event as Event & { scale?: number; clientX?: number };
    if (drag.current) return;
    if (event.type === 'gesturestart') {
      const rect = track.current!.getBoundingClientRect();
      const currentView = wheelView.current;
      const x = typeof native.clientX === 'number' && native.clientX >= rect.left && native.clientX <= rect.right ? native.clientX : rect.left + rect.width / 2;
      gesture.current = { view: currentView, anchor: pointerTimelineTime(x, rect.left, rect.width, currentView) };
      scrub.current = null; setScrubbing(false); event.preventDefault();
    } else if (gesture.current) {
      event.preventDefault();
      if (event.type === 'gestureend') { gesture.current = null; return; }
      if (typeof native.scale !== 'number' || !Number.isFinite(native.scale) || native.scale <= 0) return;
      const next = zoomTimelineView(section, gesture.current.view, gesture.current.anchor, 1 / native.scale);
      wheelView.current = next; onView(next);
    }
  });
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const listener = (event: Event) => pinch(event);
    const events = ['gesturestart', 'gesturechange', 'gestureend'];
    for (const name of events) node.addEventListener(name, listener, { passive: false });
    return () => { for (const name of events) node.removeEventListener(name, listener); };
  }, []);
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
    const [minimum, maximum] = trimBoundaryLimits(which, selected, section, maximumRange);
    const next = Math.max(minimum, Math.min(maximum, value));
    if (which === 'start') onRange(next, selected.end_ms);
    else onRange(selected.start_ms, next);
  };
  const onKey = (event: KeyboardEvent, which: 'start' | 'end') => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const value = which === 'start' ? selected.start_ms : selected.end_ms;
    const [min, max] = trimBoundaryLimits(which, selected, section, maximumRange);
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
  const closeHandles = selected.start_ms >= view[0] && selected.end_ms <= view[1] && (pct(selected.end_ms) - pct(selected.start_ms)) / 100 * trackWidth < 44;
  const zoomAt = (factor: number) => onView(zoomTimelineView(section, view, (view[0] + view[1]) / 2, factor));
  const fitBoundaries = () => {
    const width = Math.min(sectionSpan, Math.max(1000, (selected.end_ms - selected.start_ms) * 2));
    const center = (selected.start_ms + selected.end_ms) / 2;
    onView(panTimelineView(section, [center - width / 2, center + width / 2], 0));
  };

  const handle = (which: 'start' | 'end') => {
    const value = which === 'start' ? selected.start_ms : selected.end_ms;
    const visible = value >= view[0] && value <= view[1];
    const [minimum, maximum] = trimBoundaryLimits(which, selected, section, maximumRange);
    return <button type="button" className={`trim-handle ${which}${!visible ? ' offscreen' : ''}${closeHandles ? ' close-handles' : ''}`} data-dragging={dragging === which || undefined}
      style={{ left: `${pct(value)}%` }} role="slider" aria-label={which === 'start' ? t("Начало фрагмента на шкале") : t("Конец фрагмента на шкале")}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={value} aria-valuetext={formatTimecode(value, true)} aria-orientation="horizontal" aria-describedby="trim-hint"
      onKeyDown={event => onKey(event, which)}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current || scrub.current) return;
        event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
        if (!visible) { onReveal(value); return; }
        onBeginChange?.();
        drag.current = { which, pointer: event.pointerId, x: event.clientX, value, width: track.current!.getBoundingClientRect().width, span };
        setDragging(which); event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const original = drag.current;
        if (original?.which === which && original.pointer === event.pointerId) move(which, Math.max(Math.ceil(view[0]), Math.min(Math.floor(view[1]), pointerTrimValue(original.value, event.clientX - original.x, original.width, original.span))));
      }}
      onPointerUp={event => endDrag(which, event.pointerId)} onPointerCancel={event => endDrag(which, event.pointerId)} onLostPointerCapture={event => endDrag(which, event.pointerId)}
    ><span className="trim-grip" aria-hidden="true" /><span className={`trim-tooltip ${pct(value) < 50 ? 'align-start' : 'align-end'}`} aria-hidden="true">{which === 'start' ? t('Начало') : t('Конец')}<strong>{formatTimecode(value, true)}</strong></span></button>;
  };

  const mediaTools = <>
    <Waveform sourceID={sourceID} duration={duration} current={current} view={view} active={active} audioTrack={audioTrack} noAudio={noAudio} onSeek={ms => { onSeek(ms); onReveal(ms); }} />
    <Storyboard sourceID={sourceID} duration={duration} current={current} active={active} onSeek={ms => { onSeek(ms); onReveal(ms); }} />
  </>;

  const zoomTools = <div className="timeline-detail-label"><span>{t('Уточните границы')}</span><div className="timeline-zoom-buttons"><button type="button" aria-label={t('Отдалить шкалу')} title={t('Отдалить шкалу')} disabled={!zoomed} onClick={() => zoomAt(2)}>−</button><button type="button" aria-label={t('Приблизить шкалу')} title={t('Приблизить шкалу')} disabled={span <= Math.min(1000, sectionSpan) + 1} onClick={() => zoomAt(.5)}>+</button>{closeHandles && span > 1000 ? <button type="button" className="text-button" onClick={fitBoundaries}>{t('Приблизить границы')}</button> : <button type="button" className="text-button" aria-label={t('Показать весь участок')} disabled={!zoomed} onClick={() => onView(section)}>{t('Весь участок')}</button>}</div></div>;

  const mediaDisclosure = <details className="timeline-media-disclosure" open={mediaOpen} onToggle={event => setMediaOpen(event.currentTarget.open)}>
      <summary>{t('Кадры и звук')}<Icon name="chevron" size={15} /></summary>
      {mediaOpen && <div className="timeline-media-content">{mediaTools}</div>}
    </details>;

  return <div className={`timeline${compact ? ' timeline-compact' : ''}${showOverview ? ' timeline-overview' : ''}`} data-section-start={section[0]} data-section-end={section[1]} data-view-start={view[0]} data-view-end={view[1]}>
    <TimelineSection duration={duration} section={section} ranges={ranges} selected={selected} current={current} onSeek={onSeek} showPlayback={showOverview} onChange={onSection} onBeginChange={onBeginChange} onEndChange={onEndChange} />
    {toolsContainer ? createPortal(zoomTools, toolsContainer) : zoomTools}
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
    <div className="tick-labels" aria-hidden="true"><span>{formatTimecode(view[0], span < 10000)}</span><span>{formatTimecode((view[0] + view[1]) / 2, span < 10000)}</span><span>{formatTimecode(view[1], span < 10000)}</span></div>
    <div className="timeline-zoom-hint"><span>{t('Колесо или жест сведения — масштаб; жест вбок — перемещение.')}</span></div>
    {compact ? (toolsContainer ? createPortal(mediaDisclosure, toolsContainer) : mediaDisclosure) : mediaTools}
    <p id="trim-hint" className="sr-only">{t('Двигайте ручки начала и конца. Стрелки меняют время на 0,1 секунды, Shift — на секунду.')}</p>
    <p id="seek-hint" className="sr-only">{t('Нажмите на шкалу или двигайте указатель, чтобы перемотать. Стрелки — 0,1 секунды, Shift — секунда; Home и End — начало и конец видео.')}</p>
  </div>;
}
