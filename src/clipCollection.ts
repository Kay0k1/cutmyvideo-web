import type { ClipRange } from './types';

export const maxClips = 12;
export type WorkbenchStep = 1 | 2 | 3 | 4;

export function restoredStep(step: unknown, workflowVersion: unknown): WorkbenchStep | undefined {
  if (step !== 1 && step !== 2 && step !== 3 && step !== 4) return undefined;
  if (workflowVersion !== 2 && step === 3) return 4;
  return step;
}

export function rangeSelection(ranges: ClipRange[], saved: unknown): string[] {
  if (!Array.isArray(saved)) return ranges.map(range => range.id);
  const requested = new Set(saved.filter(id => typeof id === 'string'));
  return ranges.filter(range => requested.has(range.id)).map(range => range.id);
}

export function duplicateRanges(ranges: ClipRange[], selectedIds: string[], createId: () => string): { ranges: ClipRange[]; addedIds: string[] } | null {
  const selected = new Set(selectedIds);
  const originals = ranges.filter(range => selected.has(range.id));
  if (!originals.length || ranges.length + originals.length > maxClips) return null;
  const copies = originals.map(range => ({ ...range, id: createId() }));
  return { ranges: [...ranges, ...copies], addedIds: copies.map(range => range.id) };
}

export function removeRanges(ranges: ClipRange[], selectedIds: string[]): ClipRange[] {
  const selected = new Set(selectedIds);
  return ranges.filter(range => !selected.has(range.id));
}

export function markBounds(range: ClipRange, current: number, which: 'start' | 'end', duration: number): [number, number] {
  const length = range.end_ms - range.start_ms;
  if (which === 'start') return [current, current >= range.end_ms ? Math.min(duration, current + length) : range.end_ms];
  return [current <= range.start_ms ? Math.max(0, current - length) : range.start_ms, current];
}
