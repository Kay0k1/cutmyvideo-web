import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectionAPI, readAgentProject } from './collectionApi';
import { ApiError } from './api';
import { readCollectionDocument } from './collectionProject';
const plan = { version: 1 as const, clips: [{ id: 'clip-1', ranges: [{ start_ms: 0, end_ms: 1000 }] }] };
const source = { id: 'source-a', title: 'Talk', duration_ms: 12000, kind: 'upload', preview_url: '/api/v1/projects/project-a/sources/source-a/media', thumbnail_url: null };
const project = { version: 1, id: 'project-a', revision: 1, plan, source, jobs: [], rendition: 'final', expires_at: '2026-12-01T00:00:00Z' };
afterEach(() => vi.unstubAllGlobals());
describe('scoped collection transport', () => {
  it('attaches duplicate effective requests by explicit clip/job pairs rather than ambiguous job IDs', async () => {
    const duplicate = { ...plan, clips: [plan.clips[0], { ...plan.clips[0], id: 'clip-2' }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...project, plan: duplicate }))); vi.stubGlobal('fetch', fetch);
    const pairs = [{ clip_id: 'clip-1', job_id: 'job-first' }, { clip_id: 'clip-2', job_id: 'job-second' }];
    await collectionAPI.create(readCollectionDocument(duplicate), 'source-a', 'saved-workflow-key', pairs);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.clip_jobs).toEqual(pairs); expect(body).not.toHaveProperty('job_ids'); expect(body.collection_key).toBe('saved-workflow-key'); expect(body.plan.clips).toEqual(duplicate.clips);
  });
  it('keeps admitted jobs and global Retry-After on partial queue refusal', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 1, rendition: 'final', complete: false, clips: [{ clip_id: 'clip-1', retryable: false, job: { id: 'job-a', status: 'queued', items: [] } }, { clip_id: 'clip-2', retryable: true, error: { code: 'job_limit', message: 'Capacity', cookie: 'must-not-retain' } }] }), { status: 202, headers: { 'Retry-After': '60' } })); vi.stubGlobal('fetch', fetch);
    const result = await collectionAPI.submitProject('project-a'); expect(result.clips[0].job?.id).toBe('job-a'); expect(result.retry_after_seconds).toBe(60); expect(result.clips[1].error).toEqual({ code: 'job_limit', message: 'Capacity' });
    const [path, options] = fetch.mock.calls[0]; expect(path).toBe('/api/v1/projects/project-a/collections'); expect(options.body).toBe('{}'); expect(options.headers).not.toHaveProperty('Idempotency-Key'); expect(options.credentials).toBe('same-origin');
  });
  it.each([401, 403, 418])('rejects a shape-valid collection body on unauthorized/unexpected status %i', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 1, complete: true, clips: [], rendition: 'final' }), { status })));
    await expect(collectionAPI.submitProject('project-a')).rejects.toMatchObject({ httpStatus: status });
  });
  it('requires source URLs in the fixed project scope and constructs downloads from attached IDs', () => {
    expect(readAgentProject(project).source.preview_url).toBe(source.preview_url);
    expect(() => readAgentProject({ ...project, source: { ...source, preview_url: '/api/v1/sources/source-a/media' } })).toThrow(ApiError);
    expect(() => readAgentProject({ ...project, source: { ...source, preview_url: 'https://unrelated.invalid/video' } })).toThrow(ApiError);
    expect(collectionAPI.artifactPath('artifact-a', 'project-a')).toBe('/api/v1/projects/project-a/artifacts/artifact-a/download');
  });
  it('does not retain secret unknown fields from project or token redemption', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ project: { ...project, collection_key: 'server-secret', owner: 'owner-secret' }, token: 'do-not-store' }))));
    const result = await collectionAPI.redeem('A'.repeat(43)); expect(JSON.stringify(result)).not.toMatch(/server-secret|owner-secret|do-not-store/);
  });
});
