import type { Job } from './types';

export interface EncodingProgress {
  processedMS: number;
  totalMS: number;
  percent: number;
}

/** Media time describes encoding work, not download time or time remaining. */
export function encodingProgress(job: Job | null): EncodingProgress | null {
  if (!job || job.status !== 'running' || !['processing', 'publishing'].includes(job.stage)) return null;
  let totalMS = 0;
  let processedMS = 0;
  let observedProgress = false;
  for (const item of job.items) {
    const duration = item.end_ms - item.start_ms;
    if (!Number.isSafeInteger(item.start_ms) || !Number.isSafeInteger(item.end_ms) || item.start_ms < 0 || duration <= 0) continue;
    totalMS += duration;
    if (item.status !== 'running' && item.status !== 'succeeded') continue;
    const measured = typeof item.progress_ms === 'number' && Number.isFinite(item.progress_ms)
      ? Math.max(0, Math.min(duration, Math.trunc(item.progress_ms))) : 0;
    if (measured > 0) observedProgress = true;
    processedMS += item.status === 'succeeded' ? duration : measured;
  }
  // Older servers and untouched retry items only have stages, not measured time.
  if (!observedProgress || totalMS <= 0 || !Number.isSafeInteger(totalMS) || !Number.isFinite(processedMS)) return null;
  processedMS = Math.min(totalMS, processedMS);
  const percent = processedMS === totalMS ? 100 : Math.min(99, Math.floor(processedMS * 100 / totalMS));
  return { processedMS, totalMS, percent };
}
