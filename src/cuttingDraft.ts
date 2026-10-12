import { restoreRanges, rangeSelection } from './clipCollection';
import { maxClientRanges } from './limits';
import { storedResourceId } from './browserStorage';
import type { ClipRange } from './types';
import { formatTimecode, parseTimecode } from './timecode';

export interface RecoverableSource { id: string; title: string; duration_ms: number; }

/** Recover cuts even from old drafts whose source metadata was not persisted. */
export function recoverCuttingDraft(saved: Record<string, unknown>): { source: RecoverableSource; ranges: ClipRange[]; selectedId: string; selectedIds: string[] } | null {
  if (!storedResourceId(saved.source_id)) return null;
  const maximumDuration = 366 * 24 * 60 * 60 * 1000;
  const duration = typeof saved.source_duration_ms === 'number' && Number.isSafeInteger(saved.source_duration_ms) && saved.source_duration_ms > 0 && saved.source_duration_ms <= maximumDuration
    ? saved.source_duration_ms
    : Array.isArray(saved.ranges) ? saved.ranges.reduce((maximum: number, item: unknown) => {
      const end = typeof item === 'object' && item !== null ? (item as Record<string, unknown>).end_ms : undefined;
      return typeof end === 'number' && Number.isSafeInteger(end) && end > 0 && end <= maximumDuration ? Math.max(maximum, end) : maximum;
    }, 0) : 0;
  if (!duration) return null;
  const ranges = restoreRanges(saved.ranges, duration, maxClientRanges);
  if (!ranges.length) return null;
  const title = typeof saved.source_title === 'string' && saved.source_title.length <= 500 && !/[\u0000-\u001f\u007f]/.test(saved.source_title) ? saved.source_title : '';
  return { source: { id: saved.source_id, title, duration_ms: duration }, ranges,
    selectedId: ranges.find(range => range.id === saved.selected_id)?.id ?? ranges[0].id,
    selectedIds: rangeSelection(ranges, saved.selected_range_ids) };
}

/** Audition both sides of a cut, clamped to the source's first/last frame. */
export function boundaryAudition(boundary: number, duration: number): [number, number] {
  return [Math.max(0, boundary - 1500), Math.min(duration, boundary + 1500)];
}

/** Committed values use canonical times; preserve only unfinished edits. */
export function restoredTimeText(value: unknown, committedMS: number): string {
  return typeof value === 'string' && value.length <= 64 && parseTimecode(value) !== committedMS
    ? value : formatTimecode(committedMS, true);
}
