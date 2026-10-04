import { describe, expect, it } from 'vitest';
import { encodingProgress } from './encodingProgress';
import { translate } from './locales';
import type { Job } from './types';

function item(duration: number, progress?: number, status: Job['items'][number]['status'] = 'running'): Job['items'][number] {
  return { id: 'item', label: '', start_ms: 5000, end_ms: 5000 + duration, status, progress_ms: progress, artifact: null };
}
function job(items: Job['items'], overrides: Partial<Job> = {}): Job {
  return { id: 'job', status: 'running', stage: 'processing', message: '', items, ...overrides };
}

describe('measured export progress', () => {
  it('weights actual encoded media time by each clip duration', () => {
    expect(encodingProgress(job([item(1000, 1000, 'succeeded'), item(9000, 4500), item(2000, 0, 'queued')]))).toEqual({ processedMS: 5500, totalMS: 12000, percent: 45 });
  });

  it('counts completed clips in full even when their old payload has no counter', () => {
    expect(encodingProgress(job([item(1000, undefined, 'succeeded'), item(3000, 1500)]))).toEqual({ processedMS: 2500, totalMS: 4000, percent: 62 });
  });

  it('keeps stage-only UI for old jobs, zero counters and empty jobs', () => {
    expect(encodingProgress(job([item(1000, undefined, 'succeeded'), item(1000)]))).toBeNull();
    expect(encodingProgress(job([item(1000, 0)]))).toBeNull();
    expect(encodingProgress(job([]))).toBeNull();
    expect(encodingProgress(null)).toBeNull();
  });

  it('shows measured progress only during active processing and publishing', () => {
    for (const status of ['queued', 'succeeded', 'failed', 'cancelled'] as const) expect(encodingProgress(job([item(1000, 500)], { status }))).toBeNull();
    for (const stage of ['resolving', 'fetching', 'verifying', 'finished']) expect(encodingProgress(job([item(1000, 500)], { stage }))).toBeNull();
    expect(encodingProgress(job([item(1000, 500)], { stage: 'publishing' }))?.percent).toBe(50);
  });

  it('clamps overshoot and permits encoded 100 percent before publication ends', () => {
    expect(encodingProgress(job([item(1000, 1200)], { stage: 'publishing' }))).toEqual({ processedMS: 1000, totalMS: 1000, percent: 100 });
    expect(encodingProgress(job([item(1000, 999)]))?.percent).toBe(99);
    expect(encodingProgress(job([item(1000, 1000, 'succeeded')]))?.percent).toBe(100);
  });

  it('does not lose a percentage point through floating-point division', () => {
    expect(encodingProgress(job([item(100, 29)]))?.percent).toBe(29);
    expect(encodingProgress(job([item(100, 57)]))?.percent).toBe(57);
  });

  it('never counts failed, cancelled or queued partial output as prepared', () => {
    expect(encodingProgress(job([item(1000, 1000, 'failed'), item(1000, 1000, 'cancelled'), item(1000, 1000, 'queued'), item(1000, 500)]))).toEqual({ processedMS: 500, totalMS: 4000, percent: 12 });
    expect(encodingProgress(job([item(1000, 1000, 'failed'), item(1000, 0)]))).toBeNull();
  });

  it('uses the current retry snapshot rather than retaining earlier high progress', () => {
    expect(encodingProgress(job([item(1000, 800)]))?.percent).toBe(80);
    expect(encodingProgress(job([item(1000, -800)]))).toBeNull();
    expect(encodingProgress(job([item(1000, 200)]))?.percent).toBe(20);
    expect(encodingProgress(job([item(1000, -800), item(1000, 200)]))?.percent).toBe(10);
  });

  it('rejects nonfinite counters and malformed ranges without NaN percentages', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(encodingProgress(job([item(1000, value)]))).toBeNull();
    const invalid = { ...item(1000, 500), end_ms: NaN };
    expect(encodingProgress(job([invalid, item(2000, 1000)]))).toEqual({ processedMS: 1000, totalMS: 2000, percent: 50 });
    expect(encodingProgress(job([item(0, 50), item(-100, 50)]))).toBeNull();
    expect(encodingProgress(job([{ ...item(1000, 500), start_ms: -1 }]))).toBeNull();
    expect(encodingProgress(job([item(Number.MAX_VALUE, 1), item(Number.MAX_VALUE, 1)]))).toBeNull();
  });

  it('has human-facing Russian and English labels', () => {
    expect(translate('Обработка фрагментов', 'ru')).toBe('Обработка фрагментов');
    expect(translate('Обработка фрагментов', 'en')).toBe('Clip processing');
  });
});
