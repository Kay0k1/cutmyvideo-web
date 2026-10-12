import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeProjectKey, deleteStoredProject, freshProjectID, discardProjectView, initializeProjects, projectMigrationKey, projectRecordPrefix, ProjectConflictError, readProject, readProjects, saveProject, setActiveProject, stageProjectSave } from './projectPersistence';
import { maxProjects, projectsStorageKey } from './cuttingProjects';
import { draftStorageKey } from './browserStorage';

function memoryStorage() {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear() };
}
const draft = (id = 'source-a', label = 'A') => ({ source_id: id, source_title: `${id}.mp4`, source_duration_ms: 12000, ranges: [{ id: 'clip', label, start_ms: 1000, end_ms: 4000 }], current_ms: 1000, selected_id: 'clip', output: { format: 'mp4', quality: 'best', cut_mode: 'accurate' } });
let tail: Promise<unknown>;
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage()); vi.stubGlobal('sessionStorage', memoryStorage()); tail = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: (_: string, run: () => unknown) => { const result = tail.then(run); tail = result.catch(() => {}); return result; } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('transactional per-project persistence', () => {
  it('migrates the legacy aggregate once and never imports it again after deletion', async () => {
    localStorage.setItem(projectsStorageKey, JSON.stringify({ version: 1, active_id: 'project-a', projects: [{ id: 'project-a', updated_at: 1, draft: draft() }] }));
    localStorage.setItem(draftStorageKey, JSON.stringify(draft('legacy')));
    expect((await initializeProjects()).active_id).toBe('project-a');
    expect(readProject('project-a')?.revision).toBe(1);
    await deleteStoredProject('project-a', 1); await initializeProjects();
    expect(readProjects().projects).toEqual([]); expect(readProject('project-a')).toBeNull();
    await expect(saveProject('project-a', draft(), null)).rejects.toBeInstanceOf(ProjectConflictError);
  });
  it('serializes concurrent updates to independent projects without replacing their neighbours', async () => {
    await initializeProjects(); const a = await saveProject('a', draft(), null), b = await saveProject('b', draft('source-b'), null);
    await Promise.all([saveProject('a', draft('source-a', 'Edited A'), a.revision), saveProject('b', draft('source-b', 'Edited B'), b.revision)]);
    expect(readProject('a')?.draft.ranges).toMatchObject([{ label: 'Edited A' }]); expect(readProject('b')?.draft.ranges).toMatchObject([{ label: 'Edited B' }]);
  });
  it('rejects stale same-project edits and keeps both versions available for an explicit copy', async () => {
    await initializeProjects(); const a = await saveProject('a', draft(), null);
    await saveProject('a', draft('source-a', 'Other tab'), a.revision);
    const localEdit = draft('source-a', 'My work'); stageProjectSave('a', localEdit, a.revision);
    await expect(saveProject('a', localEdit, a.revision)).rejects.toBeInstanceOf(ProjectConflictError);
    expect(readProject('a')?.draft.ranges).toMatchObject([{ label: 'My work' }]);
    await saveProject('copy', localEdit, null); discardProjectView('a');
    expect(readProject('a')?.draft.ranges).toMatchObject([{ label: 'Other tab' }]); expect(readProject('copy')?.draft.ranges).toMatchObject([{ label: 'My work' }]);
  });
  it('keeps playback position tab-local without writing shared content or changing its revision', async () => {
    await initializeProjects(); const a = await saveProject('a', draft(), null);
    const before = localStorage.getItem(projectRecordPrefix + 'a'); const write = vi.spyOn(localStorage, 'setItem');
    await saveProject('a', { ...draft(), current_ms: 9500, view_center: 10000, step: 3 }, a.revision);
    expect(write).not.toHaveBeenCalled(); expect(localStorage.getItem(projectRecordPrefix + 'a')).toBe(before); expect(readProject('a')?.draft.current_ms).toBe(9500);
    sessionStorage.clear(); expect(readProject('a')?.draft.current_ms).toBe(1000); expect(readProjects().active_id).toBeNull();
  });
  it('recovers a synchronously staged edit after reload before the asynchronous save begins', async () => {
    await initializeProjects(); const a = await saveProject('a', draft(), null); setActiveProject('a');
    stageProjectSave('a', draft('source-a', 'Final edit'), a.revision);
    expect(readProjects().projects[0].draft.ranges).toMatchObject([{ label: 'Final edit' }]);
    await saveProject('a', readProject('a')!.draft, a.revision); sessionStorage.clear();
    expect(readProject('a')?.draft.ranges).toMatchObject([{ label: 'Final edit' }]);
  });
  it('identical concurrent changes are harmless and a deliberate reopen gets a fresh identity', async () => {
    await initializeProjects(); const a = await saveProject('a', draft(), null);
    const updated = await saveProject('a', draft('source-a', 'Same edit'), a.revision);
    const repeated = await saveProject('a', { ...draft('source-a', 'Same edit'), current_ms: 7000 }, a.revision);
    expect(repeated.revision).toBe(updated.revision);
    await deleteStoredProject('a', updated.revision); const id = freshProjectID('a'); expect(id).not.toBe('a');
    await saveProject(id, draft(), null); expect(readProject(id)?.draft.source_id).toBe('source-a');
    await expect(saveProject('a', draft(), a.revision)).rejects.toBeInstanceOf(ProjectConflictError);
  });
  it('a failed replacement leaves the shared record and tab-local recovery intact', async () => {
    await initializeProjects(); const a = await saveProject('a', draft(), null); stageProjectSave('a', draft('source-a', 'Unsaved'), a.revision);
    const original = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (key.startsWith(projectRecordPrefix)) throw new DOMException('quota', 'QuotaExceededError'); original(key, value); });
    await expect(saveProject('a', draft('source-a', 'Unsaved'), a.revision)).rejects.toThrow('quota');
    expect(JSON.parse(localStorage.getItem(projectRecordPrefix + 'a')!).draft.ranges[0].label).toBe('A'); expect(readProject('a')?.draft.ranges).toMatchObject([{ label: 'Unsaved' }]);
  });
  it('a missing browser lock fails explicitly and does not touch stored projects', async () => {
    vi.stubGlobal('navigator', {}); await expect(initializeProjects()).rejects.toThrow('Не удалось сохранить'); expect(localStorage.length).toBe(0);
  });
  it('migration resumes after a quota failure without losing already migrated records', async () => {
    localStorage.setItem(projectsStorageKey, JSON.stringify({ version: 1, active_id: 'a', projects: ['a', 'b'].map(id => ({ id, updated_at: 1, draft: draft(id) })) }));
    const original = localStorage.setItem.bind(localStorage); const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => { if (key === projectRecordPrefix + 'b') throw new Error('quota'); original(key, value); });
    await expect(initializeProjects()).rejects.toThrow('quota'); expect(localStorage.getItem(projectMigrationKey)).toBeNull(); spy.mockRestore();
    expect((await initializeProjects()).projects).toHaveLength(2); expect(sessionStorage.getItem(activeProjectKey)).toBe('a');
  });
  it('capacity failures preserve every existing project', async () => {
    localStorage.setItem(projectsStorageKey, JSON.stringify({ version: 1, projects: Array.from({ length: maxProjects }, (_, i) => ({ id: `p-${i}`, updated_at: i, draft: draft(`s-${i}`) })) }));
    await initializeProjects(); await expect(saveProject('extra', draft(), null)).rejects.toThrow('Слишком много'); expect(readProjects().projects).toHaveLength(maxProjects);
  });
});
