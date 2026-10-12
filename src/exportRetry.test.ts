import { describe, expect, it } from 'vitest';
import { jobRequestBody } from './api';
import { recoverExportRequest, unfinishedJobRanges } from './exportRetry';
import type { ClipRange, Job, OutputSettings } from './types';

const ranges: ClipRange[] = [{ id: 'a', label: 'A', start_ms: 1000, end_ms: 2000 }, { id: 'b', label: 'B', start_ms: 3000, end_ms: 4000 }];
const output: OutputSettings = { format: 'mp4', quality: '720p', cut_mode: 'accurate' };
const job: Job = { id: 'j', status: 'failed', stage: 'failed', message: '', items: [{ ...ranges[0], id: 'item-a', status: 'succeeded', artifact: { id: 'ready', download_url: '/ready', filename: 'A.mp4', size_bytes: 10, actual_start_ms: 1000, actual_end_ms: 2000 } }, { ...ranges[1], id: 'item-b', status: 'failed', artifact: null }] };
describe('terminal and uncertain export retry', () => {
  it('retries only missing artifacts and retries an unfinished joined job as a whole', () => {
    expect(unfinishedJobRanges(job, ranges, false)).toEqual([ranges[1]]);
    expect(unfinishedJobRanges({ ...job, items: [job.items[1]] }, ranges, true)).toEqual(ranges);
    expect(unfinishedJobRanges({ ...job, status: 'running' }, ranges, false)).toEqual([]);
    expect(unfinishedJobRanges(job, [ranges[0]], false)).toEqual([]);
  });
  it('recovers a subset with the exact request body while retaining the full project selection', () => {
    const attempt = { fingerprint: jobRequestBody('s', [ranges[1]], output), key: 'accepted' };
    expect(recoverExportRequest('s', ranges, output, attempt)).toEqual({ ranges: [ranges[1]], output });
    expect(recoverExportRequest('other', ranges, output, attempt)).toBeNull();
    expect(recoverExportRequest('s', ranges, { ...output, no_audio: true }, attempt)).toBeNull();
    expect(recoverExportRequest('s', ranges, output, { ...attempt, fingerprint: attempt.fingerprint.replace('3000', '9999') })).toBeNull();
  });
  it('matches duplicate intervals independently without inventing additional cuts', () => {
    const duplicates = [ranges[0], { ...ranges[0], id: 'copy' }];
    const attempt = { key: 'accepted', fingerprint: jobRequestBody('s', duplicates, output) };
    expect(recoverExportRequest('s', duplicates, output, attempt)?.ranges).toEqual(duplicates);
    expect(recoverExportRequest('s', [ranges[0]], output, attempt)).toBeNull();
  });
});
