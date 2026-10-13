type TimelineSelection = { start_ms: number; end_ms: number };
type TimelineInterval = [number, number];

/** Keep a saved editing section only when it still contains the whole cut. */
export function normalizeTimelineSection(duration: number, selected: TimelineSelection, saved: unknown): TimelineInterval {
  if (!Number.isFinite(duration) || duration <= 0) return [0, 0];
  if (Array.isArray(saved) && saved.length === 2 && saved.every(value => typeof value === 'number' && Number.isSafeInteger(value))
    && saved[0] >= 0 && saved[1] <= duration && saved[1] > saved[0]
    && saved[0] <= selected.start_ms && saved[1] >= selected.end_ms) return [saved[0], saved[1]];
  const clipLength = selected.end_ms - selected.start_ms;
  const span = Math.min(duration, clipLength <= 60000 ? 60000 : clipLength * 2);
  const center = (selected.start_ms + selected.end_ms) / 2;
  const start = Math.max(0, Math.min(duration - span, Math.round(center - span / 2)));
  return [start, start + span];
}

/** Zoom is a viewport inside the chosen section; it never changes cut bounds. */
export function timelineView(section: TimelineInterval, center: number, span: number): TimelineInterval {
  const sectionSpan = section[1] - section[0];
  if (sectionSpan <= 0) return [...section];
  const width = Math.max(Math.min(1000, sectionSpan), Math.min(sectionSpan, Number.isFinite(span) ? span : sectionSpan));
  const midpoint = Number.isFinite(center) ? center : (section[0] + section[1]) / 2;
  const start = Math.max(section[0], Math.min(section[1] - width, midpoint - width / 2));
  return [start, start + width];
}

/** Move the section and its cut together, preserving the exact cut offsets. */
export function moveTimelineSection(duration: number, selected: TimelineSelection, section: TimelineInterval, start: number): { section: TimelineInterval; range: TimelineInterval } {
  const previous = normalizeTimelineSection(duration, selected, section);
  const span = previous[1] - previous[0];
  const nextStart = Math.max(0, Math.min(Math.max(0, duration - span), Number.isFinite(start) ? Math.round(start) : previous[0]));
  const delta = nextStart - previous[0];
  return { section: [nextStart, nextStart + span], range: [selected.start_ms + delta, selected.end_ms + delta] };
}

/** Only the moving boundary is limited; the opposite boundary stays fixed. */
export function trimBoundaryLimits(which: 'start' | 'end', selected: TimelineSelection, section: TimelineInterval, maximumMS = Infinity): TimelineInterval {
  const minimum = which === 'start' ? Math.max(section[0], selected.end_ms - maximumMS) : Math.max(section[0], selected.start_ms + 100);
  const maximum = which === 'start' ? Math.min(section[1], selected.end_ms - 100) : Math.min(section[1], selected.start_ms + maximumMS);
  const current = which === 'start' ? selected.start_ms : selected.end_ms;
  return minimum <= maximum ? [minimum, maximum] : [current, current];
}

/** Keep the time under the pointer at the same screen fraction when possible. */
export function zoomTimelineView(section: TimelineInterval, view: TimelineInterval, anchor: number, factor: number): TimelineInterval {
  const previous = timelineView(section, (view[0] + view[1]) / 2, view[1] - view[0]);
  const span = previous[1] - previous[0];
  if (span <= 0 || !Number.isFinite(factor) || factor <= 0) return previous;
  const point = Math.max(previous[0], Math.min(previous[1], Number.isFinite(anchor) ? anchor : (previous[0] + previous[1]) / 2));
  const fraction = (point - previous[0]) / span;
  const nextSpan = Math.max(Math.min(1000, section[1] - section[0]), Math.min(section[1] - section[0], span * factor));
  return timelineView(section, point - nextSpan * fraction + nextSpan / 2, nextSpan);
}

export function panTimelineView(section: TimelineInterval, view: TimelineInterval, delta: number): TimelineInterval {
  return timelineView(section, (view[0] + view[1]) / 2 + (Number.isFinite(delta) ? delta : 0), view[1] - view[0]);
}

/** Position a section at millisecond precision rather than trim-step precision. */
export function pointerTimelineTime(point: number, left: number, width: number, view: TimelineInterval): number {
  if (width <= 0) return view[0];
  const fraction = Math.max(0, Math.min(1, (point - left) / width));
  if (fraction === 0) return view[0];
  if (fraction === 1) return view[1];
  return Math.max(view[0], Math.min(view[1], Math.round(view[0] + fraction * (view[1] - view[0]))));
}

export function keyboardTrimValue(key: string, value: number, minimum: number, maximum: number, shift = false): number | null {
  const step = shift ? 1000 : 100;
  let next: number;
  switch (key) {
    case 'ArrowLeft': case 'ArrowDown': next = value - step; break;
    case 'ArrowRight': case 'ArrowUp': next = value + step; break;
    case 'PageDown': next = value - 5000; break;
    case 'PageUp': next = value + 5000; break;
    case 'Home': next = minimum; break;
    case 'End': next = maximum; break;
    default: return null;
  }
  return Math.max(minimum, Math.min(maximum, next));
}

export function pointerTrimValue(original: number, movement: number, width: number, span: number): number {
  if (width <= 0) return original;
  // Measure movement from the grab point, keeping the existing millisecond
  // precision and avoiding a jump when the larger hit area is grabbed.
  return original + Math.round(movement / width * span / 100) * 100;
}

/** Translate a point on the visible track without losing its time offset. */
export function pointerSeekValue(point: number, left: number, width: number, view: [number, number]): number {
  if (width <= 0) return view[0];
  const fraction = Math.max(0, Math.min(1, (point - left) / width));
  if (fraction === 0) return view[0];
  if (fraction === 1) return view[1];
  const value = Math.round((view[0] + fraction * (view[1] - view[0])) / 100) * 100;
  return Math.max(view[0], Math.min(view[1], value));
}
