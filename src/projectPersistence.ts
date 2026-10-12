import { draftStorageKey, readStoredRecord, storedResourceId } from './browserStorage';
import { maxProjectCharacters, maxProjects, ProjectStorageLimitError, readProjects as readLegacyProjects, validProjectDraft } from './cuttingProjects';
import type { CuttingProject, ProjectStore } from './cuttingProjects';

// Each write replaces one complete record. The shared lock makes the revision
// check and replacement a transaction across tabs; tombstones prevent an old tab
// from recreating a deleted project. The old store remains only a migration input.
export const projectRecordPrefix = 'cutmy.project.v2.';
export const projectMigrationKey = 'cutmy.projects.v2.ready';
export const activeProjectKey = 'cutmy.project.active.v2';
const projectViewPrefix = 'cutmy.project.view.v2.';
const projectPendingPrefix = 'cutmy.project.pending.v2.';
const viewFields = ['current_ms', 'timeline_span', 'view_center', 'simple_view', 'selected_id', 'step', 'precision_open', 'start_text', 'end_text'] as const;
const lockName = 'cutmy.projects.v2.transaction';
export interface PersistedProject extends CuttingProject { revision: number; }
interface ProjectRecord { version: 2; id: string; revision: number; updated_at: number; draft?: Record<string, unknown>; deleted?: true; }
export class ProjectConflictError extends Error {
  constructor(public readonly id: string, public readonly deleted: boolean) {
    super(deleted ? 'Проект удалён в другой вкладке. Текущие изменения можно сохранить как копию.' : 'Проект изменён в другой вкладке. Сохраните свои изменения как копию или откройте сохранённую версию.');
  }
}
export class ProjectStorageUnavailableError extends Error {
  constructor() { super('Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.'); }
}

function readRecord(id: string): ProjectRecord | null {
  const raw = readStoredRecord(projectRecordPrefix + id, maxProjectCharacters);
  if (raw.version !== 2 || raw.id !== id || !storedResourceId(id) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || typeof raw.updated_at !== 'number' || !Number.isFinite(raw.updated_at)) return null;
  if (raw.deleted === true) return { version: 2, id, revision: Number(raw.revision), updated_at: raw.updated_at, deleted: true };
  return validProjectDraft(raw.draft) ? { version: 2, id, revision: Number(raw.revision), updated_at: raw.updated_at, draft: raw.draft } : null;
}
function recordIDs(): string[] {
  const ids: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(projectRecordPrefix)) { const id = key.slice(projectRecordPrefix.length); if (storedResourceId(id)) ids.push(id); }
  }
  return ids;
}
function tabView(id: string): Record<string, unknown> {
  try { const raw = sessionStorage.getItem(projectViewPrefix + id); if (!raw || raw.length > 4096) return {}; const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(viewFields.filter(key => key in value).map(key => [key, value[key]])) : {}; } catch { return {}; }
}
function pendingDraft(id: string): { revision: number; draft: Record<string, unknown> } | null {
  try { const raw = sessionStorage.getItem(projectPendingPrefix + id); if (!raw || raw.length > maxProjectCharacters) return null; const value = JSON.parse(raw); return value && Number.isSafeInteger(value.revision) && validProjectDraft(value.draft) ? value : null; } catch { return null; }
}
function projectFromRecord(record: ProjectRecord, recoverPending = true): PersistedProject {
  const pending = recoverPending ? pendingDraft(record.id) : null;
  return { id: record.id, revision: pending?.revision ?? record.revision, updated_at: record.updated_at, draft: { ...(pending?.draft ?? record.draft!), ...tabView(record.id) } };
}
/** Keep the final edit synchronously in this tab before the async lock can yield.
 * Reload/close cannot lose it; a stale revision still requires conflict recovery. */
export function stageProjectSave(id: string, draft: Record<string, unknown>, expectedRevision: number | null) {
  sessionStorage.setItem(projectViewPrefix + id, JSON.stringify(Object.fromEntries(viewFields.map(key => [key, draft[key]]))));
  const record = readRecord(id);
  if (record && (record.deleted || pendingDraft(id) || JSON.stringify(content(record.draft!)) !== JSON.stringify(content(draft)))) {
    sessionStorage.setItem(projectPendingPrefix + id, JSON.stringify({ revision: expectedRevision ?? record.revision, draft }));
  }
}
export function discardProjectView(id: string) { sessionStorage.removeItem(projectViewPrefix + id); sessionStorage.removeItem(projectPendingPrefix + id); }
function acknowledgePending(id: string, draft: Record<string, unknown>, revision: number) {
  const pending = pendingDraft(id); if (!pending) return;
  if (JSON.stringify(content(pending.draft)) === JSON.stringify(content(draft))) sessionStorage.removeItem(projectPendingPrefix + id);
  else sessionStorage.setItem(projectPendingPrefix + id, JSON.stringify({ ...pending, revision }));
}
export function freshProjectID(sourceID: string): string { return readRecord(sourceID) ? `project-${crypto.randomUUID()}` : sourceID; }
export function readProject(id: string): PersistedProject | null { const record = readRecord(id); return record?.draft ? projectFromRecord(record) : null; }
export function readProjects(): ProjectStore {
  try {
    if (!localStorage.getItem(projectMigrationKey)) return readLegacyProjects();
    const projects = recordIDs().map(readRecord).filter((record): record is ProjectRecord => !!record && (!!record.draft || !!pendingDraft(record.id))).map(record => projectFromRecord(record)).sort((a, b) => b.updated_at - a.updated_at).slice(0, maxProjects);
    const id = sessionStorage.getItem(activeProjectKey);
    return { version: 1, active_id: id && projects.some(project => project.id === id) ? id : null, projects };
  } catch { return { version: 1, active_id: null, projects: [] }; }
}
export function setActiveProject(id: string | null) { if (id) sessionStorage.setItem(activeProjectKey, id); else sessionStorage.removeItem(activeProjectKey); }
export function hasMigratedProjects() { try { return !!localStorage.getItem(projectMigrationKey); } catch { return false; } }
function content(draft: Record<string, unknown>) { return Object.fromEntries(Object.entries(draft).filter(([key]) => !viewFields.includes(key as typeof viewFields[number]))); }
async function transaction<T>(run: () => T): Promise<T> {
  if (!navigator.locks) throw new ProjectStorageUnavailableError();
  return navigator.locks.request(lockName, run);
}

export async function initializeProjects(): Promise<ProjectStore> {
  return transaction(() => {
    if (!localStorage.getItem(projectMigrationKey)) {
      const legacy = readLegacyProjects();
      for (const project of legacy.projects) {
        // A quota failure can leave some migrated records. Resume safely.
        if (!readRecord(project.id)) localStorage.setItem(projectRecordPrefix + project.id, JSON.stringify({ version: 2, ...project, revision: 1 }));
      }
      if (legacy.active_id) setActiveProject(legacy.active_id);
      localStorage.setItem(projectMigrationKey, '1');
    }
    return readProjects();
  });
}

export async function saveProject(id: string, draft: Record<string, unknown>, expectedRevision: number | null, viewAlreadyStaged = false): Promise<PersistedProject> {
  if (!storedResourceId(id) || !validProjectDraft(draft)) throw new ProjectStorageUnavailableError();
  return transaction(() => {
    if (!hasMigratedProjects()) throw new ProjectStorageUnavailableError();
    const previous = readRecord(id);
    const unchanged = !!previous?.draft && JSON.stringify(content(previous.draft)) === JSON.stringify(content(draft));
    if (previous?.deleted || (previous?.revision ?? null) !== expectedRevision && !unchanged) throw new ProjectConflictError(id, !!previous?.deleted);
    // Playback and viewport changes belong to this tab. They do not repeatedly
    // serialize/write project content or create conflicts in another tab.
    if (!viewAlreadyStaged) sessionStorage.setItem(projectViewPrefix + id, JSON.stringify(Object.fromEntries(viewFields.map(key => [key, draft[key]]))));
    if (previous && unchanged) { acknowledgePending(id, draft, previous.revision); return projectFromRecord(previous, false); }
    const record: ProjectRecord = { version: 2, id, revision: (previous?.revision ?? 0) + 1, updated_at: Date.now(), draft };
    const encoded = JSON.stringify(record);
    let count = 0, size = encoded.length;
    for (const otherID of recordIDs()) {
      if (otherID === id) continue;
      const raw = localStorage.getItem(projectRecordPrefix + otherID);
      // Tombstones are tiny and count toward storage, but not project capacity.
      if (raw) { size += raw.length; if (!readRecord(otherID)?.deleted) count++; }
    }
    if (!previous && count >= maxProjects) throw new ProjectStorageLimitError('Слишком много проектов. Сохраните планы и удалите ненужные проекты.');
    if (size > maxProjectCharacters) throw new ProjectStorageLimitError('Хранилище проектов заполнено. Сохраните планы и удалите ненужные проекты.');
    localStorage.setItem(projectRecordPrefix + id, encoded);
    acknowledgePending(id, draft, record.revision);
    return projectFromRecord(record, false);
  });
}
export async function deleteStoredProject(id: string, expectedRevision: number): Promise<void> {
  return transaction(() => {
    const previous = readRecord(id);
    if (!previous || previous.deleted || previous.revision !== expectedRevision) throw new ProjectConflictError(id, !!previous?.deleted);
    localStorage.setItem(projectRecordPrefix + id, JSON.stringify({ version: 2, id, revision: previous.revision + 1, updated_at: Date.now(), deleted: true }));
    discardProjectView(id);
    if (sessionStorage.getItem(activeProjectKey) === id) setActiveProject(null);
  });
}
/** Legacy draft is read once during migration, never as a cross-tab active view. */
export function readInitialDraft(store: ProjectStore): Record<string, unknown> { return store.projects.find(project => project.id === store.active_id)?.draft ?? (hasMigratedProjects() ? {} : readStoredRecord(draftStorageKey)); }
export function isProjectStorageEvent(key: string | null) { return key === null || key === projectMigrationKey || !!key?.startsWith(projectRecordPrefix); }
