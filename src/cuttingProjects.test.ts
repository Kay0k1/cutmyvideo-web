import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportCuttingPlan, importCuttingPlan, projectsStorageKey, readProjects, sourceMismatch, upsertProject, restoredExportAttempt, maxProjects, maxProjectCharacters, ProjectStorageLimitError, restoredProjectOutput, matchingRetryOutput } from './cuttingProjects';
import { jobRequestBody } from './api';
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
  it('honors an explicitly cleared active project and validates persisted retry keys', () => {
    storage({ [projectsStorageKey]: JSON.stringify({ version: 1, active_id: null, projects: [{ id: 'source-a', updated_at: 1, draft }] }) });
    expect(readProjects().active_id).toBeNull();
    expect(restoredExportAttempt({ export_attempt: { fingerprint: 'body', key: 'safe-key' } })).toEqual({ fingerprint: 'body', key: 'safe-key' });
    expect(restoredExportAttempt({ export_attempt: { fingerprint: 'body', key: 'bad\r\nkey' } })).toBeNull();
    expect(restoredExportAttempt({ export_attempt: { fingerprint: 'x'.repeat(128 * 1024 + 1), key: 'safe-key' } })).toBeNull();
  });
  it('capacity failures preserve the existing store instead of dropping projects', () => {
    const store = { version: 1 as const, active_id: 'p-0', projects: Array.from({ length: maxProjects }, (_, index) => ({ id: `p-${index}`, updated_at: index, draft: { ...draft, source_id: `s-${index}` } })) };
    expect(() => upsertProject(store, 'new', draft)).toThrow(ProjectStorageLimitError);
    expect(store.projects).toHaveLength(maxProjects);
    expect(() => upsertProject({ ...store, projects: store.projects.slice(0, 1) }, 'p-0', { ...draft, padding: 'x'.repeat(maxProjectCharacters) })).toThrow(ProjectStorageLimitError);
    expect(store.projects[0].draft).not.toHaveProperty('padding');
  });
  it('warns before saved cuts are applied to mismatched media', () => {
    const source = { id: 'new', title: 'talk.mp4', duration_ms: 12000, width: 640, height: 360 } as Source;
    expect(sourceMismatch(draft, source)).toBe(true); // Legacy metadata needs confirmation.
    const fingerprint = { kind: 'content' as const, sha256: 'a'.repeat(64), size_bytes: 1200 };
    expect(sourceMismatch({ ...draft, source_fingerprint: fingerprint }, { ...source, title: 'renamed.mp4', fingerprint })).toBe(false);
    expect(sourceMismatch({ ...draft, source_fingerprint: fingerprint }, { ...source, fingerprint: { ...fingerprint, sha256: 'b'.repeat(64) } })).toBe(true);
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


describe('legacy retry compatibility and media-free recovery', () => {
  it('keeps only an exactly recreated old request under its original no-cleanup policy', () => {
    const output = { format: 'mp4' as const, quality: '720p' as const, cut_mode: 'accurate' as const };
    const fingerprint = jobRequestBody('source-a', ranges, { ...output, cleanup_source: false });
    const saved = { ...draft, selected_range_ids: ['clip-1'], output, export_attempt: { fingerprint, key: 'legacy-key' } };
    const restored = restoredProjectOutput(saved)!;
    expect(restored.cleanup_source).toBe(false);
    expect(jobRequestBody('source-a', ranges, restored)).toBe(fingerprint);
    expect(output).not.toHaveProperty('cleanup_source');
    expect(restoredProjectOutput({ ...saved, output: { ...output, cleanup_source: true } })?.cleanup_source).toBe(true);
    expect(restoredProjectOutput({ ...saved, export_attempt: { fingerprint: fingerprint + ' ', key: 'legacy-key' } })?.cleanup_source).toBeUndefined();
    expect(restoredProjectOutput({ ...saved, ranges: [{ ...ranges[0], label: 'Edited' }] })?.cleanup_source).toBeUndefined();
  });
  it('requires the saved fingerprint to match known source, ranges and settings before recovering', () => {
    const output = { format: 'mkv' as const, quality: '720p' as const, cut_mode: 'copy' as const, cleanup_source: true };
    const attempt = { fingerprint: jobRequestBody('source-a', ranges, { ...output, quality: 'best' }), key: 'retry-key' };
    expect(matchingRetryOutput('source-a', ranges, output, attempt)?.quality).toBe('best');
    expect(matchingRetryOutput('another-source', ranges, output, attempt)).toBeNull();
    expect(matchingRetryOutput('source-a', [], output, attempt)).toBeNull();
    expect(matchingRetryOutput('source-a', ranges, { ...output, cleanup_source: false }, attempt)).toBeNull();
  });
});
