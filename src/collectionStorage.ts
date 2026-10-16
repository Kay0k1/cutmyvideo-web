import { readCollectionDocument } from './collectionProject';
import type { CollectionProjectDocument } from './collectionProject';
import type { Job, Source } from './types';
import { subtitleInputLimit } from './collectionSubtitles';
import type { CollectionSubtitles } from './collectionSubtitles';

export interface CollectionJobState { job: Job; signature: string; }
export interface CollectionRetry { key: string; revision: number; clip_ids: string[]; pending_ids: string[]; }
export interface SavedCollection {
  version: 1; id: string; document: CollectionProjectDocument; source?: Source; project_id?: string;
  collection_key?: string; jobs: Record<string, CollectionJobState>; selected_ids: string[];
  selected_clip: string; selected_range: number; next_submit_at?: number; rendering?: boolean; retry_attempt?: CollectionRetry; subtitles?: CollectionSubtitles;
}
export const collectionStorageKey = 'cutmy.collection.current.v1';
const limit = 4 * 1024 * 1024;
const safeID = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value);
export function readSavedCollection(): SavedCollection | null {
  try {
    const raw = localStorage.getItem(collectionStorageKey); if (!raw || raw.length > limit) return null;
    const value = JSON.parse(raw); if (!value || value.version !== 1 || !safeID(value.id)) return null;
    const document = readCollectionDocument(value.document), ids = document.plan.clips.map(clip => clip.id);
    if (!Array.isArray(value.selected_ids) || value.selected_ids.some((id: unknown) => typeof id !== 'string' || !ids.includes(id)) || new Set(value.selected_ids).size !== value.selected_ids.length) return null;
    if (!ids.includes(value.selected_clip) || !Number.isSafeInteger(value.selected_range) || value.selected_range < 0) return null;
    if (value.project_id !== undefined && !safeID(value.project_id) || value.collection_key !== undefined && (typeof value.collection_key !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(value.collection_key))) return null;
    if (value.next_submit_at !== undefined && (!Number.isSafeInteger(value.next_submit_at) || value.next_submit_at < 0)) return null;
    const retry = value.retry_attempt;
    if (retry !== undefined && (!retry || typeof retry.key !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(retry.key) || !Number.isSafeInteger(retry.revision) || retry.revision < 1 || !Array.isArray(retry.clip_ids) || !retry.clip_ids.length || retry.clip_ids.length > 128 || new Set(retry.clip_ids).size !== retry.clip_ids.length || retry.clip_ids.some((id: unknown) => typeof id !== 'string' || !ids.includes(id)) || !Array.isArray(retry.pending_ids) || new Set(retry.pending_ids).size !== retry.pending_ids.length || retry.pending_ids.some((id: unknown) => !retry.clip_ids.includes(id)))) return null;
    const source = value.source;
    const subtitles = value.subtitles;
    if (subtitles !== undefined && (!subtitles || !['srt', 'vtt'].includes(subtitles.format) || typeof subtitles.text !== 'string' || new TextEncoder().encode(subtitles.text).length > subtitleInputLimit || typeof subtitles.name !== 'string' || subtitles.name.length > 200)) return null;
    if (source !== undefined && (!source || !safeID(source.id) || typeof source.title !== 'string' || source.title.length > 500 || !Number.isSafeInteger(source.duration_ms) || source.duration_ms <= 0)) return null;
    if (!value.jobs || typeof value.jobs !== 'object' || Array.isArray(value.jobs) || Object.keys(value.jobs).length > 128) return null;
    const jobs: Record<string, CollectionJobState> = Object.create(null);
    for (const [id, entry] of Object.entries(value.jobs)) {
      const row = entry as CollectionJobState;
      if (!ids.includes(id) || !row || typeof row.signature !== 'string' || row.signature.length > 256 * 1024 || !row.job || !safeID(row.job.id) || !Array.isArray(row.job.items) || row.job.items.length > 128 || !['queued', 'running', 'waiting_storage', 'failed', 'cancelled', 'succeeded'].includes(row.job.status)) return null;
      for (const item of row.job.items) if (!item || !safeID(item.id) || item.artifact && !safeID(item.artifact.id)) return null;
      jobs[id] = row;
    }
    return { version: 1, id: value.id, document, ...(source ? { source } : {}), ...(value.project_id ? { project_id: value.project_id } : {}), ...(value.collection_key ? { collection_key: value.collection_key } : {}), jobs, selected_ids: value.selected_ids, selected_clip: value.selected_clip, selected_range: Math.min(value.selected_range, document.plan.clips.find(clip => clip.id === value.selected_clip)!.ranges.length - 1), ...(value.next_submit_at ? { next_submit_at: value.next_submit_at } : {}), rendering: value.rendering === true, ...(retry ? { retry_attempt: { key: retry.key, revision: retry.revision, clip_ids: retry.clip_ids, pending_ids: retry.pending_ids } } : {}), ...(subtitles ? { subtitles: { name: subtitles.name, text: subtitles.text, format: subtitles.format } } : {}) };
  } catch { return null; }
}
export function saveCollection(value: SavedCollection): void {
  const encoded = JSON.stringify(value); if (encoded.length > limit) throw new Error('collection storage full');
  localStorage.setItem(collectionStorageKey, encoded);
}
