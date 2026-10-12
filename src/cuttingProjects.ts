import { draftStorageKey, maxDraftCharacters, readStoredRecord, storedResourceId } from './browserStorage';
import { restoreRanges } from './clipCollection';
import { readOutputSettings } from './preferences';
import { maxClientRanges } from './limits';
import type { ClipRange, OutputSettings, Source } from './types';

export const projectsStorageKey = 'cutmy.projects.v1';
export const maxProjectCharacters = 4 * 1024 * 1024;
export const maxProjects = 100;
export interface CuttingProject { id: string; updated_at: number; draft: Record<string, unknown>; }
export interface ProjectStore { version: 1; active_id: string | null; projects: CuttingProject[]; }
const maximumDuration = 366 * 24 * 60 * 60 * 1000;
const safeText = (value: unknown, maximum = 500): value is string => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

export function validProjectDraft(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return storedResourceId(d.source_id) && safeText(d.source_title ?? '') && typeof d.source_duration_ms === 'number' && Number.isSafeInteger(d.source_duration_ms) && d.source_duration_ms > 0 && d.source_duration_ms <= maximumDuration && Array.isArray(d.ranges) && d.ranges.length <= maxClientRanges;
}

export function readProjects(): ProjectStore {
  const saved = readStoredRecord(projectsStorageKey, maxProjectCharacters);
  const seen = new Set<string>();
  const projects = saved.version === 1 && Array.isArray(saved.projects) ? saved.projects.filter((item): item is CuttingProject => {
    if (!item || typeof item !== 'object' || !storedResourceId(item.id) || seen.has(item.id) || !validProjectDraft(item.draft) || typeof item.updated_at !== 'number' || !Number.isFinite(item.updated_at)) return false;
    seen.add(item.id); return true;
  }).slice(0, maxProjects) : [];
  if (saved.version !== 1 && !projects.length) {
    const legacy = readStoredRecord(draftStorageKey);
    // Legacy drafts sometimes omitted duration; recover it from the intervals.
    if (!legacy.source_duration_ms && Array.isArray(legacy.ranges)) legacy.source_duration_ms = legacy.ranges.reduce((max: number, item) => typeof item?.end_ms === 'number' && Number.isSafeInteger(item.end_ms) ? Math.max(max, item.end_ms) : max, 0);
    if (validProjectDraft(legacy)) projects.push({ id: legacy.source_id as string, updated_at: Date.now(), draft: legacy });
  }
  return { version: 1, active_id: storedResourceId(saved.active_id) && projects.some(project => project.id === saved.active_id) ? saved.active_id : projects[0]?.id ?? null, projects };
}

export function upsertProject(store: ProjectStore, id: string, draft: Record<string, unknown>): ProjectStore {
  if (!validProjectDraft(draft)) return store;
  const existing = store.projects.findIndex(project => project.id === id);
  if (existing < 0 && store.projects.length >= maxProjects) throw new Error('Слишком много проектов. Сохраните планы и удалите ненужные проекты.');
  const project = { id, updated_at: Date.now(), draft };
  const next = { ...store, active_id: id, projects: existing < 0 ? [project, ...store.projects] : store.projects.map((value, index) => index === existing ? project : value) };
  const encoded = JSON.stringify(next);
  if (encoded.length > maxProjectCharacters) throw new Error('Хранилище проектов заполнено. Сохраните планы и удалите ненужные проекты.');
  return next;
}

/** Compare metadata before attaching saved intervals to newly opened media. */
export function sourceMismatch(draft: Record<string, unknown>, source: Source): boolean {
  if (draft.source_provider_video_id && draft.source_provider_video_id !== source.provider_video_id) return true;
  if (typeof draft.source_duration_ms === 'number' && Math.abs(draft.source_duration_ms - source.duration_ms) > 1000) return true;
  if (draft.source_width && source.width && draft.source_width !== source.width || draft.source_height && source.height && draft.source_height !== source.height) return true;
  return typeof draft.source_title === 'string' && draft.source_title !== '' && draft.source_title !== source.title;
}

export interface CuttingPlan { version: 1; input: string; ranges: { label: string; start_ms: number; end_ms: number }[]; options: Omit<OutputSettings, 'output_mode' | 'cleanup_source'>; output_mode?: 'separate' | 'joined'; }
/** The local engine's strict v1 schema: no resource IDs, URLs or credentials. */
export function exportCuttingPlan(title: string, ranges: ClipRange[], output: OutputSettings): CuttingPlan {
  const { output_mode, cleanup_source: _cleanup, ...options } = output;
  const input = (/^https?:/i.test(title) ? 'video.mp4' : title).split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500) || 'video.mp4';
  return { version: 1, input, ranges: ranges.map(({ label, start_ms, end_ms }) => ({ label, start_ms, end_ms })), options, ...(output_mode ? { output_mode } : {}) };
}

export function importCuttingPlan(raw: string, duration: number, createID: () => string): { input: string; ranges: ClipRange[]; output: OutputSettings } {
  if (raw.length > maxDraftCharacters) throw new Error('План слишком большой.');
  let plan: Record<string, unknown>;
  try { plan = JSON.parse(raw); } catch { throw new Error('Не удалось прочитать JSON-план.'); }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.version !== 1 || !safeText(plan.input) || !plan.input || !Array.isArray(plan.ranges) || !plan.ranges.length || plan.ranges.length > maxClientRanges) throw new Error('Некорректный план нарезки версии 1.');
  const options = plan.options && typeof plan.options === 'object' && !Array.isArray(plan.options) ? plan.options as Record<string, unknown> : {};
  const output = readOutputSettings({ format: 'mp4', quality: 'best', cut_mode: 'accurate', ...options, ...(plan.output_mode !== undefined ? { output_mode: plan.output_mode } : {}) });
  if (!output) throw new Error('В плане указаны неподдерживаемые настройки экспорта.');
  const candidate = plan.ranges.map(item => item && typeof item === 'object' ? { ...(item as object), id: createID() } : item);
  const ranges = restoreRanges(candidate, duration, maxClientRanges);
  if (ranges.length !== plan.ranges.length) throw new Error('В плане есть некорректные интервалы или моменты за пределами записи.');
  return { input: plan.input, ranges, output };
}
