import { useLanguage } from './Language';
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { ClipRange } from './types';
import { durationLabel, formatTimecode } from './timecode';
import { keyboardTrimValue, panTimelineView, pointerSeekValue, pointerTimelineTime, pointerTrimValue, trimBoundaryLimits, zoomTimelineView } from './timelineControls';
import type { PlaybackPosition } from './playbackPosition';
import { waveformPath } from './waveformData';
import type { WaveformWindow } from './waveformData';
import { frameCellMS, frameCells, loadStoryboard, loadWaveform, mediaWindowMS, useMediaWindows, visibleMediaWindows } from './trackMedia';
import type { FrameStrip } from './trackMedia';
import { useSourceBase } from './SourceAccess';
import { TimelineSection } from './TimelineSection';
import './Timeline.css';

export function Timeline({ duration, position, ranges, selected, section, view, maximumRange = Infinity, showOverview = true, compact = false, zoomInFooter = false, sourceID, active, audioTrack, noAudio, cutting, onSeek, onRange, onReveal, onSection, onView, onSelectRange, onBeginChange, onEndChange }: {
  duration: number;
  position: PlaybackPosition;
  ranges: ClipRange[];
  selected: ClipRange;
  section: [number, number];
  view: [number, number];
  maximumRange?: number;
  showOverview?: boolean;
  compact?: boolean;
  /** Puts the zoom buttons in the label row under the track instead of above it. */
  zoomInFooter?: boolean;
  sourceID: string;
  active: boolean;
  audioTrack?: number;
  noAudio?: boolean;
  /** While the selection is being cut: the encoding percent when the server reports one. */
  cutting?: { percent?: number } | null;
  onSeek(ms: number): void;
  onRange(start: number, end: number): void;
  onReveal(ms: number): void;
  onSection(start: number): void;
  onView(view: [number, number]): void;
  /** Double-clicking another clip on the track makes it the edited one. */
  onSelectRange?(id: string): void;
  onBeginChange?(): void;
  onEndChange?(): void;
}) {
  const { locale, t } = useLanguage();
  const current = useSyncExternalStore(position.subscribe, position.getSnapshot);
  const track = useRef<HTMLDivElement>(null);
  const framesLayer = useRef<HTMLDivElement>(null);
  const [frameHeight, setFrameHeight] = useState(0);
  const sourceBase = useSourceBase(sourceID);
  const drag = useRef<{ which: 'start' | 'end'; pointer: number; x: number; value: number; width: number; span: number } | null>(null);
  const scrub = useRef<{ pointer: number; x: number; y: number; started: boolean } | null>(null);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
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
  const footer = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const durationPill = useRef<HTMLSpanElement>(null);
  const [footerBox, setFooterBox] = useState<{ trackLeft: number; first: number; last: number; top: number; height: number; pill: number; pillHeight: number } | null>(null);
  useEffect(() => {
    const node = track.current, frames = framesLayer.current, row = footer.current, ticks = labels.current;
    if (!node || !frames || !row || !ticks) return;
    const measure = () => {
      const trackBox = node.getBoundingClientRect(), rowBox = row.getBoundingClientRect(), ticksBox = ticks.getBoundingClientRect();
      const [first, last] = [ticks.firstElementChild, ticks.lastElementChild].map(label => label?.getBoundingClientRect());
      setTrackWidth(trackBox.width); setFrameHeight(frames.getBoundingClientRect().height);
      setFooterBox(first && last ? { trackLeft: trackBox.left - rowBox.left, first: first.right - rowBox.left, last: last.left - rowBox.left, top: ticksBox.top - rowBox.top, height: ticksBox.height, pill: durationPill.current?.offsetWidth ?? 0, pillHeight: durationPill.current?.offsetHeight ?? 0 } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const target of [node, frames, row, ticks, ...ticks.children]) observer.observe(target);
    if (durationPill.current) observer.observe(durationPill.current);
    return () => observer.disconnect();
  }, []);

  // Frames and the waveform live in the track. Only windows crossing the
  // visible part are prepared, nearest to the playhead first.
  const cellWidth = span > 0 ? frameCellMS / span * trackWidth : 0;
  const framesShown = cellWidth >= 20;
  const playheadWindow = Math.floor(current / mediaWindowMS);
  const windows = useMemo(() => visibleMediaWindows(view, duration, playheadWindow * mediaWindowMS), [view[0], view[1], duration, playheadWindow]);
  const storyboards = useMediaWindows<FrameStrip>({
    cacheKey: `${sourceID}|${sourceBase}`, starts: framesShown ? windows : [], enabled: active && framesShown,
    delay: 700, retries: 9, timeout: 15000, maxEntries: 8, maxBytes: 8 * 1024 * 1024,
    load: (start, signal) => loadStoryboard(sourceBase, start, duration, signal), release: strip => URL.revokeObjectURL(strip.url),
  });
  const waves = useMediaWindows<WaveformWindow>({
    cacheKey: `${sourceBase}|${audioTrack ?? 'default'}`, starts: noAudio ? [] : windows, enabled: active && !noAudio,
    delay: 1000, retries: 8, timeout: 25000, maxEntries: 256, maxBytes: Infinity,
    load: (start, signal) => loadWaveform(sourceBase, start, duration, audioTrack, signal),
  });
  const waveWindows = useMemo(() => [...waves.ready.values()], [waves.ready]);
  const wavePath = useMemo(() => waveformPath(waveWindows, view), [waveWindows, view[0], view[1]]);
  const focusWindow = windows.find(start => current >= start && current < start + mediaWindowMS) ?? windows[0];
  const focusWave = focusWindow === undefined ? undefined : waves.ready.get(focusWindow);
  const text = (ru: string, en: string) => locale === 'en' ? en : ru;
  const waveLabel = focusWave && !focusWave.has_audio ? text('В источнике нет звука', 'This source has no audio')
    : focusWindow !== undefined && waves.failed.has(focusWindow) ? text('Звуковая волна недоступна', 'Audio waveform unavailable')
      : !focusWave ? text('Готовим звуковую волну…', 'Preparing audio waveform…') : text('Звуковая волна', 'Audio waveform');
  const pct = (ms: number) => Math.max(0, Math.min(100, (ms - view[0]) / span * 100));
  const valueAt = (event: { clientX: number }) => {
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

  // Playback re-renders the timeline on every tick; frames depend only on the view.
  const frames = useMemo(() => (framesShown ? frameCells(view, duration) : []).map(cell => {
    const windowStart = Math.floor(cell.ms / mediaWindowMS) * mediaWindowMS;
    const strip = storyboards.ready.get(windowStart);
    const index = (cell.ms - windowStart) / frameCellMS;
    const ready = !!strip && index < strip.frames;
    // A frame keeps its own five seconds: wide cells repeat it, narrow cells
    // show its middle.
    const frameWidth = frameHeight * (strip?.aspect ?? 16 / 9);
    const cellPixels = cell.width / 100 * trackWidth;
    const copies = ready && frameWidth > 0 ? Math.max(1, Math.ceil(cellPixels / frameWidth)) : 0;
    const offset = copies === 1 ? (cellPixels - frameWidth) / 2 : 0;
    return <span key={cell.ms} className="track-frame" data-ms={cell.ms} data-ready={ready || undefined} style={{ left: `${cell.left}%`, width: `${cell.width}%` }}>
      {Array.from({ length: copies }, (_, copy) => <i key={copy} style={{ left: offset + copy * frameWidth, width: frameWidth, backgroundImage: `url(${strip!.url})`, backgroundSize: `${frameWidth * 6}px 100%`, backgroundPosition: `${-index * frameWidth}px 0` }} />)}
    </span>;
  }), [framesShown, view[0], view[1], duration, storyboards.ready, frameHeight, trackWidth]);
  const selectionLeft = pct(selected.start_ms), selectionRight = pct(selected.end_ms);
  // The duration sits under the middle of the selection, between the edge
  // times, so it never covers them or the zoom buttons.
  const durationCenter = (selectionLeft + selectionRight) / 2;
  const durationStyle = (() => {
    if (!footerBox) return { left: `${Math.max(8, Math.min(92, durationCenter))}%` };
    const half = footerBox.pill / 2, low = footerBox.first + 6 + half, high = footerBox.last - 6 - half;
    const center = footerBox.trackLeft + durationCenter / 100 * trackWidth;
    return { left: `${low <= high ? Math.max(low, Math.min(high, center)) : (footerBox.first + footerBox.last) / 2}px`, top: `${footerBox.top + (footerBox.height - footerBox.pillHeight) / 2}px` };
  })();
  const others = ranges.filter(range => range.id !== selected.id && range.end_ms > view[0] && range.start_ms < view[1]);

  const zoomTools = <div className="timeline-detail-label"><span>{t('Уточните границы')}</span><div className="timeline-zoom-buttons"><button type="button" aria-label={t('Отдалить шкалу')} title={t('Отдалить шкалу')} disabled={!zoomed} onClick={() => zoomAt(2)}>−</button><button type="button" aria-label={t('Приблизить шкалу')} title={t('Приблизить шкалу')} disabled={span <= Math.min(1000, sectionSpan) + 1} onClick={() => zoomAt(.5)}>+</button>{closeHandles && span > 1000 ? <button type="button" className="text-button" onClick={fitBoundaries}>{t('Приблизить границы')}</button> : <button type="button" className="text-button" aria-label={t('Показать весь участок')} disabled={!zoomed} onClick={() => onView(section)}>{t('Весь участок')}</button>}</div></div>;

  return <div className={`timeline${compact ? ' timeline-compact' : ''}${showOverview ? ' timeline-overview' : ''}`} data-section-start={section[0]} data-section-end={section[1]} data-view-start={view[0]} data-view-end={view[1]}>
    <TimelineSection duration={duration} section={section} ranges={ranges} selected={selected} current={current} onSeek={onSeek} showPlayback={showOverview} onChange={onSection} onBeginChange={onBeginChange} onEndChange={onEndChange} />
    {!zoomInFooter && zoomTools}
    <div className="trim-track" ref={track} data-frames={framesShown || undefined}>
      <div className="track-media">
        <div className="track-frames" ref={framesLayer} aria-hidden="true">{frames}</div>
        <div className="track-wave">{!noAudio && !waves.saveData && <div className="audio-waveform"><span className="waveform-label sr-only">{waveLabel}</span><svg className="waveform-detail" viewBox="0 0 600 40" preserveAspectRatio="none" aria-hidden="true"><path d={wavePath} /></svg></div>}</div>
        <span className="track-dim" style={{ left: 0, width: `${selectionLeft}%` }} aria-hidden="true" />
        <span className="track-dim" style={{ left: `${selectionRight}%`, right: 0 }} aria-hidden="true" />
      </div>
      {others.map(range => <span key={range.id} className="track-range" style={{ left: `${pct(range.start_ms)}%`, width: `${Math.max(0, pct(range.end_ms) - pct(range.start_ms))}%` }} aria-hidden="true" />)}
      <div className="trim-selection" style={{ left: `${selectionLeft}%`, width: `${Math.max(0, selectionRight - selectionLeft)}%` }} aria-hidden="true" />
      {cutting && <span className="track-progress" data-indeterminate={cutting.percent === undefined || undefined} style={{ left: `${selectionLeft}%`, width: `${Math.max(0, selectionRight - selectionLeft)}%` }} aria-hidden="true"><i style={cutting.percent === undefined ? undefined : { width: `${Math.max(0, Math.min(100, cutting.percent))}%` }} /></span>}
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
        onDoubleClick={event => {
          const ms = valueAt(event);
          const other = onSelectRange && others.find(range => ms >= range.start_ms && ms <= range.end_ms);
          if (other) onSelectRange!(other.id);
        }}
      />
      {handle('start')}{handle('end')}
      {current >= view[0] && current <= view[1] && <div className="playhead" style={{ left: `${pct(current)}%` }} aria-hidden="true" />}
    </div>
    <div className="timeline-footer" ref={footer}>
      <div className="tick-labels" ref={labels} aria-hidden="true"><span>{formatTimecode(view[0], span < 10000)}</span><span>{formatTimecode(view[1], span < 10000)}</span></div>
      <span className="track-duration" ref={durationPill} hidden={!(selected.end_ms > view[0] && selected.start_ms < view[1])} style={durationStyle} aria-hidden="true">{durationLabel(selected.end_ms - selected.start_ms, locale)}</span>
      {zoomInFooter && zoomTools}
    </div>
    <div className="timeline-zoom-hint"><span>{t('Колесо или жест сведения — масштаб; жест вбок — перемещение.')}</span></div>
    <p id="trim-hint" className="sr-only">{t('Двигайте ручки начала и конца. Стрелки меняют время на 0,1 секунды, Shift — на секунду.')}</p>
    <p id="seek-hint" className="sr-only">{t('Нажмите на шкалу или двигайте указатель, чтобы перемотать. Стрелки — 0,1 секунды, Shift — секунда; Home и End — начало и конец видео.')}</p>
  </div>;
}
