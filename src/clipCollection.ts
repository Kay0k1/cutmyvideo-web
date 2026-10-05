import type { ClipRange } from './types';
import { validateRange } from './timecode';
import { storedResourceId } from './browserStorage';

export const maxClips = 12;
export type WorkbenchStep = 1 | 2 | 3 | 4;

export function restoreRanges(value: unknown, duration: number, maximum = maxClips): ClipRange[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const result: ClipRange[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, label, start_ms, end_ms } = item as Record<string, unknown>;
    if (!storedResourceId(id) || ids.has(id) || typeof label !== 'string' || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label) || new TextEncoder().encode(label).length > 200 || typeof start_ms !== 'number' || typeof end_ms !== 'number' || !Number.isSafeInteger(start_ms) || !Number.isSafeInteger(end_ms) || validateRange(start_ms, end_ms, duration)) continue;
    ids.add(id);
    result.push({ id, label, start_ms, end_ms });
    if (result.length === maximum) break;
  }
  return result;
}

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

export function duplicateRanges(ranges: ClipRange[], selectedIds: string[], createId: () => string, maximum = maxClips): { ranges: ClipRange[]; addedIds: string[] } | null {
  const selected = new Set(selectedIds);
  const originals = ranges.filter(range => selected.has(range.id));
  if (!originals.length || ranges.length + originals.length > maximum) return null;
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
