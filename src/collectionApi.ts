import { ApiError, request } from './api';
import type { Job, Source } from './types';
import type { CollectionPlan, CollectionProjectDocument, CollectionRequest } from './collectionProject';
import { collectionRequest, readCollectionDocument } from './collectionProject';
import { projectAPIBase } from './SourceAccess';

export interface CollectionDiagnostic { code: string; message: string; clip_id?: string; field?: string; }
export interface SubmittedClip { clip_id: string; job?: Job; request?: unknown; retryable: boolean; error?: CollectionDiagnostic; }
export interface CollectionSubmission { version: 1; complete: boolean; clips: SubmittedClip[]; rendition: 'draft' | 'final'; retry_after_seconds?: number; }
export interface AgentProject {
  version: 1; id: string; revision: number; source: Source; plan: CollectionPlan;
  clip_ids?: string[]; rendition: 'draft' | 'final'; jobs: { clip_id: string; job: Job; request?: unknown; current: boolean }[];
  expires_at: string; access_expires_at?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeID = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value);
function requireResponse(value: unknown): asserts value { if (!value) throw new ApiError('invalid_response', 'Invalid project response'); }
function readJob(value: unknown): Job {
  requireResponse(object(value) && safeID(value.id) && ['queued', 'running', 'waiting_storage', 'succeeded', 'failed', 'cancelled'].includes(String(value.status)) && Array.isArray(value.items) && value.items.length <= 128);
  for (const item of value.items) requireResponse(object(item) && safeID(item.id) && (item.artifact === null || item.artifact === undefined || object(item.artifact) && safeID(item.artifact.id)));
  return value as unknown as Job;
}
export function readAgentProject(value: unknown): AgentProject {
  requireResponse(object(value) && value.version === 1 && safeID(value.id) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1 && object(value.source) && safeID(value.source.id));
  const doc = readCollectionDocument({ plan: value.plan, clip_ids: value.clip_ids, rendition: value.rendition });
  const base = projectAPIBase(value.id) + '/sources/' + encodeURIComponent(value.source.id);
  const source = value.source as unknown as Source;
  requireResponse(typeof source.title === 'string' && source.title.length <= 500 && Number.isSafeInteger(source.duration_ms) && source.duration_ms > 0);
  requireResponse(!source.preview_url || source.preview_url === base + '/media');
  requireResponse(!source.thumbnail_url || source.thumbnail_url === base + '/thumbnail');
  requireResponse(Array.isArray(value.jobs) && value.jobs.length <= 512 && typeof value.expires_at === 'string' && Number.isFinite(Date.parse(value.expires_at)));
  const jobs = value.jobs.map(item => { requireResponse(object(item) && typeof item.clip_id === 'string' && doc.plan.clips.some(clip => clip.id === item.clip_id)); return { clip_id: item.clip_id, job: readJob(item.job), current: item.current === true, ...(item.request ? { request: item.request } : {}) }; });
  return { version: 1, id: value.id, revision: Number(value.revision), source, plan: doc.plan, ...(doc.clip_ids ? { clip_ids: doc.clip_ids } : {}), rendition: doc.rendition ?? 'final', jobs, expires_at: value.expires_at, ...(typeof value.access_expires_at === 'string' ? { access_expires_at: value.access_expires_at } : {}) };
}
/** Retain accepted clips even when another clip is refused. No retry is hidden here. */
async function submit(path: string, body: CollectionRequest | Record<string, never> | { revision: number; clip_ids: string[] }, key?: string, signal?: AbortSignal): Promise<CollectionSubmission> {
  const controller = new AbortController(), abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30000);
  try {
    const response = await fetch('/api/v1' + path, { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
    const raw: unknown = await response.json();
    if ([200, 202, 207, 400, 408, 410, 413, 429, 500, 502, 503, 504].includes(response.status) && object(raw) && raw.version === 1 && Array.isArray(raw.clips)) {
      requireResponse(raw.clips.length <= 128 && typeof raw.complete === 'boolean' && (raw.rendition === 'draft' || raw.rendition === 'final'));
      const clips = raw.clips.map(item => { requireResponse(object(item) && typeof item.clip_id === 'string' && typeof item.retryable === 'boolean'); return { clip_id: item.clip_id, retryable: item.retryable, ...(item.job ? { job: readJob(item.job) } : {}), ...(item.request ? { request: item.request } : {}), ...(object(item.error) && typeof item.error.code === 'string' && typeof item.error.message === 'string' ? { error: { code: item.error.code, message: item.error.message, ...(typeof item.error.clip_id === 'string' ? { clip_id: item.error.clip_id } : {}), ...(typeof item.error.field === 'string' ? { field: item.error.field } : {}) } } : {}) }; });
      const header = response.headers.get('Retry-After'), seconds = header && /^\d{1,5}$/.test(header) ? Number(header) : undefined;
      return { version: 1, complete: raw.complete, rendition: raw.rendition, clips, ...(seconds !== undefined && seconds <= 86400 ? { retry_after_seconds: seconds } : {}) };
    }
    const error = object(raw) && object(raw.error) ? raw.error : {};
    throw new ApiError(typeof error.code === 'string' ? error.code : 'invalid_response', typeof error.message === 'string' ? error.message : 'Invalid project response', response.status);
  } catch (error) { if (error instanceof ApiError || signal?.aborted) throw error; throw new ApiError('connection', 'Collection request did not complete'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const collectionAPI = {
  validate: (value: CollectionRequest, signal?: AbortSignal) => request<{ valid: boolean }>('/collections/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal }),
  submit: (value: CollectionRequest, key: string, signal?: AbortSignal) => submit('/collections', value, key, signal),
  project: async (id: string, signal?: AbortSignal) => readAgentProject(await request('/projects/' + encodeURIComponent(id), { signal })),
  redeem: async (token: string) => { const response = await request<{ project: unknown }>('/projects/handoffs/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); return readAgentProject(response.project); },
  create: async (document: CollectionProjectDocument, sourceID: string, key: string, clipJobs: { clip_id: string; job_id: string }[]) => readAgentProject(await request('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...collectionRequest(document, sourceID), collection_key: key, ...(clipJobs.length ? { clip_jobs: clipJobs } : {}) }) })),
  update: async (project: AgentProject, document: CollectionProjectDocument) => readAgentProject(await request('/projects/' + encodeURIComponent(project.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: project.revision, plan: collectionRequest(document, project.source.id).plan, ...(document.clip_ids ? { clip_ids: document.clip_ids } : {}), rendition: document.rendition ?? 'final' }) })),
  validateProject: (id: string, signal?: AbortSignal) => request<{ valid: boolean }>('/projects/' + encodeURIComponent(id) + '/collections/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal }),
  submitProject: (id: string, signal?: AbortSignal) => submit('/projects/' + encodeURIComponent(id) + '/collections', {}, undefined, signal),
  retryProject: (id: string, revision: number, clipIDs: string[], key: string, signal?: AbortSignal) => submit('/projects/' + encodeURIComponent(id) + '/collections/retry', { revision, clip_ids: clipIDs }, key, signal),
  cancel: (jobID: string, projectID: string) => request<Job>('/projects/' + encodeURIComponent(projectID) + '/jobs/' + encodeURIComponent(jobID) + '/cancel', { method: 'POST' }),
  job: (jobID: string, projectID?: string, signal?: AbortSignal) => request<Job>((projectID ? '/projects/' + encodeURIComponent(projectID) : '') + '/jobs/' + encodeURIComponent(jobID), { signal }),
  tracks: (sourceID: string, projectID?: string, signal?: AbortSignal) => request<{ tracks: import('./types').MediaTrack[]; display_width?: number; display_height?: number }>((projectID ? '/projects/' + encodeURIComponent(projectID) : '') + '/sources/' + encodeURIComponent(sourceID) + '/tracks', { signal }),
  artifactPath: (artifactID: string, projectID?: string) => projectAPIBase(projectID) + '/artifacts/' + encodeURIComponent(artifactID) + '/download',
};
