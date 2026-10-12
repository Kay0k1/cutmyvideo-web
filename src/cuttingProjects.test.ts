import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportCuttingPlan, importCuttingPlan, projectsStorageKey, readProjects, sourceMismatch, upsertProject } from './cuttingProjects';
import { draftStorageKey } from './browserStorage';
import type { Source } from './types';

function storage(values: Record<string, string> = {}) {
  vi.stubGlobal('localStorage', { getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } });
}
afterEach(() => vi.unstubAllGlobals());
const ranges = [{ id: 'clip-1', label: 'Speech', start_ms: 2000, end_ms: 5000 }];
const draft = { source_id: 'source-a', source_title: 'talk.mp4', source_duration_ms: 12000, ranges, selected_range_ids: [], current_ms: 2500, timeline_span: 10000, output: { format: 'mp4' as const, quality: '720p' as const, cut_mode: 'accurate' as const, crop: { x: .2, y: .1, width: .5, height: .8 } } };

describe('per-video cutting projects', () => {
  it('migrates the single legacy draft while preserving selection and settings', () => {
    storage({ [draftStorageKey]: JSON.stringify(draft) });
    const store = readProjects();
    expect(store.active_id).toBe('source-a'); expect(store.projects[0].draft).toEqual(draft);
  });
  it('keeps media-free projects, empty clips and independent sources after reload', () => {
    storage(); let store = upsertProject(readProjects(), 'project-a', draft);
    store = upsertProject(store, 'project-b', { ...draft, source_id: 'source-b', ranges: [], media_unavailable: true });
    localStorage.setItem(projectsStorageKey, JSON.stringify(store));
    const restored = readProjects(); expect(restored.projects).toHaveLength(2);
    expect(restored.projects.find(project => project.id === 'project-a')?.draft.output).toEqual(draft.output);
    expect(restored.projects.find(project => project.id === 'project-b')?.draft.ranges).toEqual([]);
  });
  it('does not resurrect legacy projects after an intentionally empty project store', () => {
    storage({ [draftStorageKey]: JSON.stringify(draft), [projectsStorageKey]: JSON.stringify({ version: 1, projects: [], active_id: null }) });
    expect(readProjects().projects).toEqual([]);
  });
  it('rejects corrupt, oversized and duplicate records', () => {
    storage({ [projectsStorageKey]: JSON.stringify({ version: 1, projects: [{ id: 'p', updated_at: 1, draft }, { id: 'p', updated_at: 2, draft }, { id: '../p', updated_at: 1, draft }, { id: 'bad', updated_at: 1, draft: { ...draft, source_duration_ms: -1 } }] }) });
    expect(readProjects().projects).toHaveLength(1);
  });
  it('warns before saved cuts are applied to mismatched media', () => {
    const source = { id: 'new', title: 'talk.mp4', duration_ms: 12000, width: 640, height: 360 } as Source;
    expect(sourceMismatch(draft, source)).toBe(false);
    expect(sourceMismatch(draft, { ...source, duration_ms: 30000 })).toBe(true);
    expect(sourceMismatch({ ...draft, source_provider_video_id: 'abc' }, { ...source, provider_video_id: 'def' })).toBe(true);
  });
});

describe('browser plans use the strict engine v1 schema', () => {
  it('round trips range order and output settings without server IDs or credentials', () => {
    const inputRanges = [...ranges, { id: 'server-secret', label: 'First', start_ms: 0, end_ms: 1000 }];
    const plan = exportCuttingPlan('talk.mp4', inputRanges, { ...draft.output, output_mode: 'joined', audio_track: 2, cleanup_source: false });
    const raw = JSON.stringify(plan); expect(raw).not.toContain('server-secret'); expect(raw).not.toContain('source_id');
    expect(raw).not.toContain('cleanup_source');
    const imported = importCuttingPlan(raw, 12000, () => crypto.randomUUID());
    expect(imported.ranges.map(({ id: _id, ...range }) => range)).toEqual(plan.ranges);
    expect(imported.output).toEqual({ ...draft.output, output_mode: 'joined', audio_track: 2 });
    expect(Object.keys(plan).sort()).toEqual(['input', 'options', 'output_mode', 'ranges', 'version']);
    expect(exportCuttingPlan('https://host/private?token=secret', ranges, draft.output).input).toBe('video.mp4');
  });
  it('accepts CLI defaults and rejects invalid boundaries/settings', () => {
    const plan = { version: 1, input: '/local/talk.mp4', ranges: [{ label: 'A', start_ms: 0, end_ms: 1000 }], options: {} };
    expect(importCuttingPlan(JSON.stringify(plan), 12000, () => 'id').output).toEqual({ format: 'mp4', quality: 'best', cut_mode: 'accurate' });
    expect(() => importCuttingPlan(JSON.stringify({ ...plan, ranges: [{ label: '', start_ms: 0, end_ms: 14000 }] }), 12000, () => 'id')).toThrow('интервалы');
    expect(() => importCuttingPlan(JSON.stringify({ ...plan, options: { crop: { x: -1, y: 0, width: 1, height: 1 } } }), 12000, () => 'id')).toThrow('настройки');
    expect(() => importCuttingPlan('{', 12000, () => 'id')).toThrow('JSON');
  });
});
