import { jobRequestBody } from './api';
import type { ClipRange, Job, OutputSettings } from './types';

/** Recover only canonical known cuts and settings, never an arbitrary stored body. */
export function recoverExportRequest(sourceID: string, ranges: ClipRange[], output: OutputSettings, attempt: { fingerprint: string; key: string } | null): { ranges: ClipRange[]; output: OutputSettings } | null {
  if (!attempt || !ranges.length) return null;
  let stored: { source_id?: unknown; ranges?: unknown };
  try { stored = JSON.parse(attempt.fingerprint); } catch { return null; }
  if (!stored || stored.source_id !== sourceID || !Array.isArray(stored.ranges) || !stored.ranges.length || stored.ranges.length > ranges.length) return null;
  const available = [...ranges], recovered: ClipRange[] = [];
  for (const entry of stored.ranges) {
    if (!entry || typeof entry !== 'object') return null;
    const index = available.findIndex(range => range.start_ms === entry.start_ms && range.end_ms === entry.end_ms && range.label === entry.label);
    if (index < 0) return null;
    recovered.push(available.splice(index, 1)[0]);
  }
  for (const candidate of [output, ...(output.cut_mode === 'copy' ? [{ ...output, quality: 'best' as const }] : [])]) {
    if (jobRequestBody(sourceID, recovered, candidate) === attempt.fingerprint) return { ranges: recovered, output: candidate };
  }
  return null;
}

/** Retry terminal unfinished items exactly once, leaving successful artifacts alone. */
export function unfinishedJobRanges(job: Job | null, ranges: ClipRange[], joined: boolean): ClipRange[] {
  if (!job || !['failed', 'cancelled'].includes(job.status)) return [];
  if (joined) return job.items.some(item => !item.artifact) ? ranges : [];
  const available = [...ranges], pending: ClipRange[] = [];
  for (const item of job.items) {
    const index = available.findIndex(range => range.start_ms === item.start_ms && range.end_ms === item.end_ms && range.label === item.label);
    if (index < 0) { if (!item.artifact) return []; continue; }
    const range = available.splice(index, 1)[0];
    if (!item.artifact) pending.push(range);
  }
  return pending;
}
