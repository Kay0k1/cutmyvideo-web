import { afterEach, expect, it, vi } from 'vitest';
import { collectionStorageKey, readSavedCollection, saveCollection } from './collectionStorage';
import type { SavedCollection } from './collectionStorage';
const value: SavedCollection = { version: 1, id: 'local-a', document: { kind: 'cutmy.collection.project', version: 1, plan: { version: 1, clips: [{ id: 'constructor', ranges: [{ start_ms: 1000, end_ms: 2000 }] }, { id: '2', ranges: [{ start_ms: 3000, end_ms: 4000 }] }] } }, selected_ids: ['constructor', '2'], selected_clip: '2', selected_range: 0, collection_key: 'saved-key', jobs: {}, next_submit_at: 9999999999999, retry_attempt: { key: 'retry-key', revision: 3, clip_ids: ['2'], pending_ids: ['2'] } };
let raw = '';
function storage() { raw = ''; vi.stubGlobal('localStorage', { getItem: (key: string) => key === collectionStorageKey ? raw || null : null, setItem: (_key: string, value: string) => { raw = value; } }); }
afterEach(() => vi.unstubAllGlobals());
it('restores pending admission deadlines and exact retry identity without treating object names as clip rows', () => {
  storage(); saveCollection(value); const restored = readSavedCollection()!;
  expect(restored.retry_attempt).toEqual(value.retry_attempt); expect(restored.next_submit_at).toBe(value.next_submit_at); expect(restored.jobs.constructor).toBeUndefined(); expect(restored.selected_ids).toEqual(['constructor', '2']);
});
it('rejects corrupt retry fields or secret-key shapes rather than minting another attempt', () => {
  storage();
  for (const patch of [{ collection_key: 42 }, { retry_attempt: { ...value.retry_attempt, key: 42 } }, { retry_attempt: { ...value.retry_attempt, key: 'bad\r\nkey' } }, { retry_attempt: { ...value.retry_attempt, pending_ids: ['missing'] } }, { retry_attempt: { ...value.retry_attempt, revision: -1 } }]) { raw = JSON.stringify({ ...value, ...patch }); expect(readSavedCollection()).toBeNull(); }
});
