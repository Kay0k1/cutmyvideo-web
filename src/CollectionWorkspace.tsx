import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage, request } from './api';
import { collectionAPI } from './collectionApi';
import type { AgentProject } from './collectionApi';
import { CollectionProjectError, clipSignature, collectionDocumentLimit, collectionRequest, compareCollectionSource, effectiveCollectionOptions, readCollectionDocument, selectedCollectionIDs, sourceIdentity } from './collectionProject';
import type { CollectionClip, CollectionOptions, CollectionProjectDocument } from './collectionProject';
import { collectionStorageKey, readSavedCollection, saveCollection } from './collectionStorage';
import type { SavedCollection } from './collectionStorage';
import { SourceAccess } from './SourceAccess';
import { SourceChooser } from './SourceChooser';
import { SourceLibrary } from './SourceLibrary';
import { Player } from './Player';
import type { PlayerControls } from './Player';
import { Timeline } from './Timeline';
import { CropEditor } from './CropEditor';
import { CropPreview } from './CropPreview';
import { AudioTrackSelector } from './AudioTrackSelector';
import { withAudioSelection } from './mediaTracks';
import { createPlaybackPosition } from './playbackPosition';
import { normalizeTimelineSection, timelineView } from './timelineControls';
import { beginGesture, emptyHistory, finishGesture, rememberEdit, redoEdit, undoEdit } from './editHistory';
import { formatBytes, formatTimecode, parseTimecode, validateRange } from './timecode';
import { defaultLimits, readPublicLimits } from './limits';
import { validateVideo, canonicalSourceUrl } from './sourceInput';
import { useLanguage } from './Language';
import { LanguageSwitch } from './WorkspaceNav';
import { ThemeToggle } from './Theme';
import { Icon } from './Icons';
import { RetentionNotice } from './RetentionNotice';
import { useWorkspaceViewport } from './useWorkspaceViewport';
import type { Artifact, MediaTrack, OutputSettings, Source, UploadProgress } from './types';
import { readCollectionSubtitles, retimeCollectionSubtitles } from './collectionSubtitles';
import { collectionArtifactAvailable, collectionJobReady, collectionJobRetryable } from './collectionJobs';
import './Workspace.css';
import './CollectionWorkspace.css';

export interface CollectionOpening { document?: CollectionProjectDocument; source?: Source; project?: AgentProject; fresh?: boolean; }
const activeJob = (status?: string) => status === 'queued' || status === 'running' || status === 'waiting_storage';
export function newCollection(document?: CollectionProjectDocument, source?: Source): SavedCollection {
  const doc = document ?? { kind: 'cutmy.collection.project', version: 1, plan: { version: 1, options: { format: 'mp4', cut_mode: 'accurate' }, clips: [{ id: 'clip-01', label: '', ranges: [{ start_ms: 0, end_ms: Math.min(source?.duration_ms ?? 1000, 30000) }] }] } };
  return { version: 1, id: crypto.randomUUID(), document: structuredClone(doc), ...(source ? { source } : {}), jobs: Object.create(null), selected_ids: selectedCollectionIDs(doc), selected_clip: doc.plan.clips[0].id, selected_range: 0 };
}
export function projectDocument(project: AgentProject): CollectionProjectDocument {
  return { kind: 'cutmy.collection.project', version: 1, source: sourceIdentity(project.source), plan: project.plan, ...(project.clip_ids ? { clip_ids: project.clip_ids } : {}), rendition: project.rendition };
}
function initialCollection(opening: CollectionOpening): SavedCollection {
  if (opening.project) { const value = newCollection(projectDocument(opening.project), opening.project.source); value.project_id = opening.project.id; return withProjectJobs(value, opening.project); }
  return opening.document || opening.fresh ? newCollection(opening.document, opening.source) : readSavedCollection() ?? newCollection(undefined, opening.source);
}
/** The backend decides request identity; signatures only label stale browser results. */
export function withProjectJobs(value: SavedCollection, project: AgentProject): SavedCollection {
  const jobs = Object.assign(Object.create(null), value.jobs) as SavedCollection['jobs'], document = projectDocument(project);
  for (const row of project.jobs) {
    if (!row.current) continue;
    const clip = document.plan.clips.find(clip => clip.id === row.clip_id);
    if (clip) jobs[row.clip_id] = { job: row.job, signature: clipSignature(document, clip, project.source.id) };
  }
  return { ...value, source: project.source, jobs, project_id: project.id };
}
function downloadJSON(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CollectionWorkspace({ opening, onExit }: { opening: CollectionOpening; onExit(): void }) {
  const { locale, t } = useLanguage();
  const [value, setValue] = useState(() => initialCollection(opening)), current = useRef(value); current.current = value;
  const [project, setProject] = useState<AgentProject | null>(opening.project ?? null), projectRef = useRef(project); projectRef.current = project;
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [sourceBusy, setSourceBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [storageError, setStorageError] = useState('');
  const [limits, setLimits] = useState(defaultLimits), [url, setURL] = useState(''), [progress, setProgress] = useState<UploadProgress | null>(null);
  const [candidate, setCandidate] = useState<Source | null>(null), [candidateWarning, setCandidateWarning] = useState('');
  const [tracks, setTracks] = useState<MediaTrack[] | null>(null), [tracksError, setTracksError] = useState(''), [tracksLoading, setTracksLoading] = useState(false), [tracksAttempt, setTracksAttempt] = useState(0);
  const [position] = useState(createPlaybackPosition), player = useRef<PlayerControls>(null), workspace = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null), [available, setAvailable] = useState(false), [cropOpen, setCropOpen] = useState(false);
  const [geometry, setGeometry] = useState({ width: 0, height: 0 }), [section, setSection] = useState<[number, number]>([0, 60000]), [view, setView] = useState<[number, number]>([0, 60000]);
  const [startText, setStartText] = useState(''), [endText, setEndText] = useState(''), [historyVersion, setHistoryVersion] = useState(0);
  const history = useRef(emptyHistory<CollectionProjectDocument>()), sourceController = useRef<AbortController | null>(null), workerBusy = useRef(false);
  const storedSnapshot = useRef<string | null | undefined>(undefined);
  if (storedSnapshot.current === undefined) { try { storedSnapshot.current = localStorage.getItem(collectionStorageKey); } catch { storedSnapshot.current = null; } }
  const sequence = useRef<{ ranges: CollectionClip['ranges']; index: number; seeking: boolean } | null>(null), [previewing, setPreviewing] = useState(false);
  const source = ready ? value.source : undefined, clip = value.document.plan.clips.find(clip => clip.id === value.selected_clip) ?? value.document.plan.clips[0];
  const selectedRange = Math.min(value.selected_range, clip.ranges.length - 1), range = clip.ranges[selectedRange];
  const duration = source?.duration_ms ?? Math.max(30000, ...value.document.plan.clips.flatMap(clip => clip.ranges.map(range => range.end_ms)));
  const options = effectiveCollectionOptions(value.document.plan, clip), output = options as OutputSettings;
  const locked = busy || value.rendering === true, selectedIDs = value.document.plan.clips.filter(clip => value.selected_ids.includes(clip.id)).map(clip => clip.id);
  useWorkspaceViewport(!!source);

  function persist(next: SavedCollection) {
    try {
      if (localStorage.getItem(collectionStorageKey) !== storedSnapshot.current) { setStorageError(t('Коллекция изменена в другой вкладке. Скачайте свои правки и откройте сохранённую версию заново.')); return false; }
      saveCollection(next); storedSnapshot.current = localStorage.getItem(collectionStorageKey); setStorageError(''); return true;
    }
    catch { setStorageError(t('Не удалось сохранить коллекцию в браузере. Скачайте проект, чтобы не потерять изменения.')); return false; }
  }
  function change(next: SavedCollection) { next = { ...next, jobs: Object.assign(Object.create(null), next.jobs) }; current.current = next; setValue(next); persist(next); }
  function edit(document: CollectionProjectDocument) {
    if (locked) return;
    rememberEdit(history.current, current.current.document); setHistoryVersion(count => count + 1);
    change({ ...current.current, document, rendering: false, retry_attempt: undefined }); setNotice('');
  }
  function editClip(patch: Partial<CollectionClip>) { edit({ ...value.document, plan: { ...value.document.plan, clips: value.document.plan.clips.map(item => item.id === clip.id ? { ...item, ...patch } : item) } }); }
  function clipOptions(patch: CollectionOptions) { const next = { ...clip.options, ...patch }; for (const key of Object.keys(next) as (keyof CollectionOptions)[]) if (next[key] === undefined) delete next[key]; editClip({ options: next }); }
  function beginEdit() { beginGesture(history.current, current.current.document); }
  function endEdit() { finishGesture(history.current, current.current.document); setHistoryVersion(count => count + 1); }
  function restoreHistory(redo = false) { const document = (redo ? redoEdit : undoEdit)(history.current, current.current.document); if (document) change({ ...current.current, document, selected_ids: current.current.selected_ids.filter(id => document.plan.clips.some(clip => clip.id === id)), selected_clip: document.plan.clips.some(clip => clip.id === current.current.selected_clip) ? current.current.selected_clip : document.plan.clips[0].id, selected_range: 0 }); setHistoryVersion(count => count + 1); }
  function stopPreview() { sequence.current = null; setPreviewing(false); player.current?.pause(); }
  function chooseClip(id: string, index = 0) { stopPreview(); setCropOpen(false); change({ ...current.current, selected_clip: id, selected_range: index }); }

  useEffect(() => {
    const controller = new AbortController();
    void api.session().then(async session => {
      if (controller.signal.aborted) return;
      setLimits(readPublicLimits(session.limits));
      const saved = current.current;
      if (saved.project_id) {
        const fresh = await collectionAPI.project(saved.project_id, controller.signal);
        if (controller.signal.aborted) return;
        setProject(fresh); change(withProjectJobs(saved, fresh));
      } else if (saved.source) {
        const fresh = await api.source(saved.source.id, controller.signal);
        if (controller.signal.aborted) return;
        // Same resource ID is not enough if stale or untrusted storage is edited.
        if (saved.document.source?.fingerprint && compareCollectionSource(saved.document.source, fresh) === 'different') throw new ApiError('source_identity', 'Source changed');
        change({ ...saved, source: fresh });
      }
      if (!controller.signal.aborted) setReady(true);
    }).catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof ApiError && reason.code === 'source_identity' ? t('Исходная запись изменилась. Привяжите её заново и проверьте границы.') : errorMessage(reason)); setReady(true); change({ ...current.current, source: undefined, rendering: false }); } });
    return () => { controller.abort(); sourceController.current?.abort(); };
  }, []);
  useEffect(() => { setStartText(formatTimecode(range.start_ms, true)); setEndText(formatTimecode(range.end_ms, true)); }, [clip.id, selectedRange, range.start_ms, range.end_ms]);
  useEffect(() => { const bounds = normalizeTimelineSection(duration, range, null); setSection(bounds); setView(bounds); stopPreview(); }, [clip.id, selectedRange, source?.id]);
  useEffect(() => { setContainer(workspace.current?.querySelector('.player-frame') ?? null); }, [source?.id, value.project_id]);
  useEffect(() => {
    setTracks(null); setTracksError(''); setGeometry({ width: source?.width ?? 0, height: source?.height ?? 0 });
    if (!source || !ready) return;
    const controller = new AbortController(); setTracksLoading(true);
    void collectionAPI.tracks(source.id, value.project_id, controller.signal).then(result => { if (!controller.signal.aborted) { setTracks(result.tracks); if (result.display_width && result.display_height) setGeometry({ width: result.display_width, height: result.display_height }); } }).catch(reason => { if (!controller.signal.aborted) setTracksError(errorMessage(reason)); }).finally(() => { if (!controller.signal.aborted) setTracksLoading(false); });
    return () => controller.abort();
  }, [source?.id, value.project_id, ready, tracksAttempt]);
  useEffect(() => {
    if (!ready || !value.project_id) return;
    const controller = new AbortController(), nextPoll = new Map<string, number>();
    let stopped = false;
    async function tick() {
      if (workerBusy.current || stopped || document.hidden) return;
      workerBusy.current = true;
      try {
        let saved = current.current;
        for (const item of saved.document.plan.clips) {
          const entry = saved.jobs[item.id]; if (!entry || !activeJob(entry.job.status) || (nextPoll.get(entry.job.id) ?? 0) > Date.now()) continue;
          nextPoll.set(entry.job.id, Date.now() + 1000);
          try {
            const job = await collectionAPI.job(entry.job.id, saved.project_id, controller.signal);
            if (stopped) return;
            saved = { ...current.current, jobs: { ...current.current.jobs, [item.id]: { ...entry, job } } }; change(saved);
          } catch (reason) { if (controller.signal.aborted) return; if (reason instanceof ApiError && reason.retryAfterSeconds !== undefined) nextPoll.set(entry.job.id, Date.now() + reason.retryAfterSeconds * 1000); else throw reason; }
        }
        if (!saved.rendering || !projectRef.current) return;
        const selected = saved.document.plan.clips.filter(clip => saved.selected_ids.includes(clip.id));
        const missing = selected.filter(clip => saved.retry_attempt ? saved.retry_attempt.pending_ids.includes(clip.id) : !saved.jobs[clip.id] || saved.jobs[clip.id].signature !== clipSignature(saved.document, clip, saved.source!.id));
        if (!missing.length) { change({ ...current.current, rendering: false, retry_attempt: undefined }); setNotice(t('Задания сохранены. Готовые файлы появятся рядом с роликами.')); return; }
        if ((saved.next_submit_at ?? 0) > Date.now()) return;
        if (!persist(saved)) { current.current = { ...saved, rendering: false }; setValue(current.current); return; }
        const result = saved.retry_attempt ? await collectionAPI.retryProject(saved.project_id!, saved.retry_attempt.revision, saved.retry_attempt.clip_ids, saved.retry_attempt.key, controller.signal) : await collectionAPI.submitProject(saved.project_id!, controller.signal);
        if (stopped) return;
        const jobs = { ...current.current.jobs };
        for (const row of result.clips) {
          const item = selected.find(clip => clip.id === row.clip_id);
          if (!item) throw new ApiError('invalid_response', 'Unexpected clip');
          if (row.job) jobs[row.clip_id] = { job: row.job, signature: clipSignature(saved.document, item, saved.source!.id) };
        }
        const refusal = result.clips.find(row => !row.job && !row.retryable);
        const retry = current.current.retry_attempt;
        const next = { ...current.current, jobs, ...(retry ? { retry_attempt: { ...retry, pending_ids: retry.pending_ids.filter(id => !result.clips.some(row => row.clip_id === id && row.job)) } } : {}), next_submit_at: Date.now() + Math.max(1, result.retry_after_seconds ?? 3) * 1000, ...(refusal ? { rendering: false } : {}) };
        change(next);
        if (refusal) setError((refusal.error?.clip_id ?? refusal.clip_id) + ': ' + (refusal.error?.message ?? t('Проверьте границы и настройки клипа.')));
      } catch (reason) {
        if (controller.signal.aborted) return;
        const wait = reason instanceof ApiError ? reason.retryAfterSeconds : undefined;
        change({ ...current.current, next_submit_at: Date.now() + Math.max(3, wait ?? 5) * 1000, rendering: false });
        setError(t('Не удалось подтвердить состояние. Принятые задания сохранены; повторите продолжение с тем же проектом.'));
      } finally { workerBusy.current = false; }
    }
    void tick(); const timer = setInterval(() => void tick(), 1000);
    return () => { stopped = true; controller.abort(); clearInterval(timer); };
  }, [ready, value.project_id]);

  function confirmSource(opened: Source, explicit = false) {
    if (opened.media_removed) { setError(t('Оригинал уже удалён. Выберите доступную запись.')); return; }
    const comparison = compareCollectionSource(value.document.source, opened);
    if (!explicit && value.document.source && comparison !== 'content_match') {
      setCandidate(opened); setCandidateWarning(comparison === 'different' ? t('Отпечаток отличается: это другая запись. Интервалы могут указывать на другие слова.') : comparison === 'provider_match' ? t('Совпадает запись на площадке. Её содержимое не проверено побайтово; проверьте интервалы.') : t('У плана нет подтверждённого отпечатка. Одинаковое название и длительность не гарантируют, что это та же запись.')); return;
    }
    if (value.document.plan.clips.some(clip => clip.ranges.some(range => range.end_ms > opened.duration_ms))) { setError(t('В плане есть интервалы за пределами этой записи. Сначала исправьте границы.')); return; }
    const plan = { ...value.document.plan }; if (comparison !== 'content_match') delete plan.input;
    change({ ...current.current, source: opened, project_id: undefined, collection_key: undefined, jobs: {}, document: { ...value.document, plan, source: sourceIdentity(opened) }, rendering: false }); setProject(null); setCandidate(null); setError(''); setNotice(comparison === 'content_match' ? t('Содержимое исходника совпадает.') : t('Запись привязана. Проверьте границы перед экспортом.'));
  }
  async function openSource(file?: File) {
    if (sourceBusy || !ready || value.project_id) return;
    const controller = new AbortController(); sourceController.current = controller; setSourceBusy(true); setError('');
    try { if (file) { const invalid = await validateVideo(file, limits.max_source_bytes); if (invalid) throw new Error(invalid); } const sourceURL = file ? null : canonicalSourceUrl(url); if (!file && !sourceURL) throw new Error(t('Введите ссылку на видео.')); const opened = file ? await api.upload(file, controller.signal, setProgress) : await api.open(sourceURL!, controller.signal); if (!controller.signal.aborted) confirmSource(opened); }
    catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error && !(reason instanceof ApiError) ? reason.message : errorMessage(reason, 'source-create')); }
    finally { if (sourceController.current === controller) { setSourceBusy(false); setProgress(null); sourceController.current = null; } }
  }
  async function importProject(file: File) {
    try { if (file.size > collectionDocumentLimit) throw new Error(t('План слишком большой.')); const document = readCollectionDocument(await file.text()); if (value.document.plan.clips.length && !window.confirm(t('Открыть другую коллекцию? Текущую можно сохранить файлом проекта.'))) return; stopPreview(); history.current = emptyHistory(); setProject(null); change(newCollection(document)); setNotice(t('План открыт. Привяжите исходную запись; ID и порядок частей сохранены.')); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('Не удалось прочитать проект.')); }
  }
  function changeBounds(start: number, end: number) { const invalid = validateRange(start, end, duration, limits.max_range_ms); if (invalid) { setError(t(invalid)); return; } setError(''); editClip({ ranges: clip.ranges.map((item, index) => index === selectedRange ? { ...item, start_ms: start, end_ms: end } : item) }); }
  function applyTimes() { const start = parseTimecode(startText), end = parseTimecode(endText); const invalid = validateRange(start, end, duration, limits.max_range_ms); if (invalid) { setError(t(invalid)); return; } changeBounds(start!, end!); }
  function seek(ms: number) { sequence.current = null; setPreviewing(false); player.current?.seek(ms); position.set(ms); }
  function preview() { if (previewing) { stopPreview(); return; } sequence.current = { ranges: structuredClone(clip.ranges), index: 0, seeking: true }; setPreviewing(true); player.current?.seek(clip.ranges[0].start_ms); player.current?.play(); }
  function onTime(ms: number, confirmed?: boolean) {
    position.set(ms); const active = sequence.current; if (!active) return; const part = active.ranges[active.index];
    if (active.seeking) { if (confirmed && ms >= part.start_ms - 100 && ms < part.end_ms) active.seeking = false; return; }
    if (ms >= part.end_ms - 35) { if (active.index + 1 >= active.ranges.length) { stopPreview(); return; } active.index++; active.seeking = true; player.current?.seek(active.ranges[active.index].start_ms); player.current?.play(); }
  }
  async function saveServer(start = false) {
    if (!source || !selectedIDs.length || busy || storageError || !ready) return;
    setBusy(true); setError(''); stopPreview();
    try {
      const document = readCollectionDocument({ ...value.document, clip_ids: selectedIDs });
      const saved = { ...current.current, document, collection_key: current.current.collection_key ?? 'web-' + crypto.randomUUID() };
      if (!persist(saved)) return;
      current.current = saved; setValue(saved);
      let fresh = projectRef.current;
      if (!fresh) fresh = await collectionAPI.create(document, source.id, saved.collection_key!, document.plan.clips.flatMap(clip => { const row = saved.jobs[clip.id]; return row?.signature === clipSignature(document, clip, source.id) ? [{ clip_id: clip.id, job_id: row.job.id }] : []; }));
      else fresh = await collectionAPI.update(fresh, document);
      setProject(fresh); projectRef.current = fresh;
      change(withProjectJobs({ ...current.current, document, rendering: false }, fresh));
      if (start) { await collectionAPI.validateProject(fresh.id); change({ ...current.current, rendering: true }); setNotice(t('Экспорт продолжается по сохранённому плану. Неизменённые ролики используют прежние задания.')); }
      else setNotice(t('Редакция проекта сохранена.'));
    } catch (reason) { setError(reason instanceof CollectionProjectError ? reason.field + ': ' + reason.message : reason instanceof ApiError && reason.code === 'invalid_collection' ? reason.message : reason instanceof ApiError && reason.code === 'project_conflict' ? t('Проект изменён в другой вкладке. Ваши правки остались здесь: скачайте их или откройте серверную версию.') : errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function reloadProject() { if (!value.project_id || !window.confirm(t('Открыть сохранённую серверную версию? Сначала скачайте свои несохранённые правки.'))) return; setBusy(true); try { const fresh = await collectionAPI.project(value.project_id); setProject(fresh); projectRef.current = fresh; change(withProjectJobs(newCollection(projectDocument(fresh), fresh.source), fresh)); history.current = emptyHistory(); setError(''); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } }
  function retryFailed() {
    if (!project || !source || locked || storageError) return;
    const failed = selectedIDs.filter(id => { const item = value.document.plan.clips.find(clip => clip.id === id)!, row = value.jobs[id]; return row && collectionJobRetryable(row.job) && row.signature === clipSignature(value.document, item, source.id); });
    const attempt = value.retry_attempt ?? { key: 'retry-' + crypto.randomUUID(), revision: project.revision, clip_ids: failed, pending_ids: failed };
    if (!attempt.pending_ids.length) return;
    const next = { ...current.current, retry_attempt: attempt, rendering: true };
    if (!persist(next)) return; current.current = next; setValue(next); setError('');
  }
  async function cancelClip(id: string) {
    const entry = current.current.jobs[id]; if (!entry || !value.project_id || busy) return;
    setBusy(true); try { const job = await collectionAPI.cancel(entry.job.id, value.project_id); change({ ...current.current, jobs: { ...current.current.jobs, [id]: { ...entry, job } } }); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function importSubtitles(file: File) { try { const subtitles = await readCollectionSubtitles(file); change({ ...current.current, subtitles }); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : t('Не удалось прочитать субтитры.')); } }
  async function downloadSubtitles(clipID: string, artifact: Artifact) {
    if (!value.subtitles || busy) return; setBusy(true); setError('');
    try { const output = await retimeCollectionSubtitles(clipID, artifact, value.subtitles); const url = URL.createObjectURL(new Blob([output.text], { type: output.format === 'vtt' ? 'text/vtt;charset=utf-8' : 'application/x-subrip;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = clipID + '.' + output.format; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : reason instanceof Error ? reason.message : t('Не удалось подготовить субтитры.')); }
    finally { setBusy(false); }
  }
  async function share() {
    if (!project || busy) return; setBusy(true); setError('');
    try {
      const document = readCollectionDocument({ ...value.document, clip_ids: selectedIDs.length ? selectedIDs : undefined });
      if (!persist({ ...current.current, document })) return;
      const fresh = await collectionAPI.update(project, document); setProject(fresh); projectRef.current = fresh; change(withProjectJobs({ ...current.current, document }, fresh));
      const response = await request<{ token: string }>('/projects/' + encodeURIComponent(fresh.id) + '/handoffs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(response.token)) throw new Error();
      await navigator.clipboard.writeText(location.origin + location.pathname + '#handoff=' + response.token); setNotice(t('Ссылка скопирована. Она действует 10 минут и передаёт доступ только к этому проекту одному получателю на сутки.'));
    } catch { setError(t('Не удалось скопировать ссылку. Создавать приглашения может владелец проекта.')); } finally { setBusy(false); }
  }
  function addClip() { let index = value.document.plan.clips.length + 1, id = ''; do { id = 'clip-' + String(index++).padStart(2, '0'); } while (value.document.plan.clips.some(clip => clip.id === id)); const next = { id, ranges: [{ start_ms: 0, end_ms: Math.min(duration, 30000, limits.max_range_ms) }] }; edit({ ...value.document, plan: { ...value.document.plan, clips: [...value.document.plan.clips, next] } }); change({ ...current.current, selected_ids: [...current.current.selected_ids, id], selected_clip: id, selected_range: 0 }); }
  function moveClip(delta: number) { const clips = [...value.document.plan.clips], index = clips.findIndex(item => item.id === clip.id), target = index + delta; if (target < 0 || target >= clips.length) return; [clips[index], clips[target]] = [clips[target], clips[index]]; edit({ ...value.document, plan: { ...value.document.plan, clips } }); }
  function movePart(delta: number) { const ranges = [...clip.ranges], target = selectedRange + delta; if (target < 0 || target >= ranges.length) return; [ranges[selectedRange], ranges[target]] = [ranges[target], ranges[selectedRange]]; editClip({ ranges }); change({ ...current.current, selected_range: target }); }
  const readyCount = selectedIDs.filter(id => { const item = value.document.plan.clips.find(clip => clip.id === id)!; const row = value.jobs[id]; return source && row?.signature === clipSignature(value.document, item, source.id) && collectionJobReady(row.job); }).length;
  void historyVersion;
  return <SourceAccess.Provider value={value.project_id}><div className={`app-shell collection-shell${source ? ' workspace-shell' : ''}`} ref={workspace}>
    <a className="skip-link" href="#collection-editor">{t('К выбору фрагмента')}</a>
    <header className="site-header"><div className="header-inner"><a className="brand" href="/" onClick={event => { event.preventDefault(); onExit(); }}><span className="brand-symbol"><Icon name="cut" size={20} /></span><span>cutmy<span className="brand-suffix">video</span></span></a><span className="collection-header-label">{t('Коллекция')}</span><div className="header-actions"><button className="text-button" onClick={onExit}>{t('Обычный редактор')}</button><LanguageSwitch /><ThemeToggle /></div></div></header>
    <main id="collection-editor" className={`stage-page collection-page${source ? ' workspace-page' : ''}`} data-bootstrap-state={ready ? 'ready' : 'loading'}>
      <div className="page-heading"><div><h1>{t('Коллекция роликов')}</h1><p>{source?.title ?? value.document.source?.title ?? t('Откройте план от агента или соберите свой')}</p></div><div className="collection-document-actions"><label className="button secondary">{t('Открыть план')}<input type="file" accept=".json,application/json" hidden disabled={locked} aria-label={t('Открыть план коллекции')} onChange={event => { const file = event.target.files?.[0]; if (file) void importProject(file); event.target.value = ''; }} /></label><button className="button secondary" onClick={() => downloadJSON({ ...value.document, ...(source ? { source: sourceIdentity(source) } : {}), clip_ids: selectedIDs.length ? selectedIDs : undefined }, 'cutmy-collection.json')}>{t('Скачать проект')}</button><details className="collection-plan-menu"><summary>{t('Для агента')}</summary><button className="text-button" onClick={() => downloadJSON(value.document.plan, 'collection-plan.json')}>CollectionPlan</button>{source && <button className="text-button" onClick={() => downloadJSON(collectionRequest(value.document, source.id, selectedIDs.length ? selectedIDs : undefined), 'collection-request.json')}>CollectionRequest</button>}<p className="field-hint">{t('Секретный ключ коллекции хранится отдельно у агента. Сохраните ID клипов при возврате плана.')}</p></details></div></div>
      {(error || storageError || notice) && <div className="collection-messages">{error && <p className="error-message" role="alert">{t(error)}</p>}{storageError && <p className="error-message" role="alert">{storageError}</p>}{notice && <p role="status">{notice}</p>}{value.project_id && error && <button className="text-button" disabled={busy} onClick={() => void reloadProject()}>{t('Открыть серверную версию')}</button>}</div>}
      {!source && !value.project_id && <div className="collection-source"><SourceChooser url={url} onUrl={setURL} onOpen={() => void openSource()} onFile={file => void openSource(file)} busy={sourceBusy} progress={progress} maximumBytes={limits.max_source_bytes} blocked={false} processing={false} ready={ready} error="" onCancel={() => sourceController.current?.abort()} onReconnect={() => location.reload()} /><SourceLibrary disabled={!ready || sourceBusy} currentBusy={false} onBusy={setSourceBusy} onOpen={opened => confirmSource(opened)} onDeleted={() => {}} /></div>}
      {candidate && <section className="collection-relink" role="region" aria-label={t('Подтвердите исходник')}><h2>{t('Подтвердите исходник')}</h2><p>{candidateWarning}</p><p>{candidate.title} · {formatTimecode(candidate.duration_ms)}</p><button className="button primary" onClick={() => confirmSource(candidate, true)}>{t('Использовать эту запись и проверить границы')}</button><button className="text-button" onClick={() => setCandidate(null)}>{t('Отмена')}</button></section>}
      <div className="editor-workspace"><section className="moments-stage" aria-label={t('Выбранный ролик')}><div className="editing-panel"><div className="media-heading"><div><strong>{clip.label || clip.id}</strong><span className="collection-id">{clip.id}</span></div><div className="edit-history-actions"><button className="icon-button" aria-label={t('Отменить правку')} disabled={locked || !history.current.past.length} onClick={() => restoreHistory()}>↶</button><button className="icon-button" aria-label={t('Повторить правку')} disabled={locked || !history.current.future.length} onClick={() => restoreHistory(true)}>↷</button></div></div><div className="moment-layout">
        <Player key={(value.project_id ?? 'owner') + ':' + (source?.id ?? '')} ref={player} source={source ?? null} active={ready} audioTrack={options.audio_track} noAudio={options.no_audio} onTime={onTime} onAvailable={setAvailable} onGeometry={(width, height) => setGeometry({ width, height })} onSourceUnavailable={() => { stopPreview(); setError(t('Исходник больше недоступен. План и готовые файлы сохранены. Скачайте проект для привязки новой записи.')); }} />
        {options.crop && container && !cropOpen && <CropPreview crop={options.crop} container={container} />}
        <div className="moment-controls collection-controls"><div className="collection-part-tabs" role="group" aria-label={t('Части ролика')}>{clip.ranges.map((part, index) => <button className="button secondary" key={index} aria-pressed={index === selectedRange} onClick={() => chooseClip(clip.id, index)}>{t('Часть')} {index + 1}<span>{formatTimecode(part.start_ms)}–{formatTimecode(part.end_ms)}</span></button>)}<button className="text-button" disabled={locked || clip.ranges.length >= 128} onClick={() => { const start = Math.min(Math.max(0, duration - 100), range.end_ms); editClip({ ranges: [...clip.ranges, { start_ms: start, end_ms: Math.min(duration, start + 30000, start + limits.max_range_ms) }] }); change({ ...current.current, selected_range: clip.ranges.length }); }}>{t('Добавить часть')}</button></div>
          <div className="moment-boundaries"><div><label htmlFor="collection-start">{t('Начало')}</label><input id="collection-start" className="time-input" value={startText} disabled={locked} onChange={event => setStartText(event.target.value)} onBlur={applyTimes} onKeyDown={event => { if (event.key === 'Enter') applyTimes(); }} /></div><div><label htmlFor="collection-end">{t('Конец')}</label><input id="collection-end" className="time-input" value={endText} disabled={locked} onChange={event => setEndText(event.target.value)} onBlur={applyTimes} onKeyDown={event => { if (event.key === 'Enter') applyTimes(); }} /></div><div className="moment-duration"><span>{t('Длительность ролика')}</span><strong>{((clip.ranges.reduce((sum, part) => sum + part.end_ms - part.start_ms, 0)) / 1000).toFixed(3)} {t('с')}</strong></div></div>
          {source && <Timeline duration={duration} position={position} ranges={clip.ranges.map((part, index) => ({ ...part, id: String(index), label: part.label ?? '' }))} selected={{ ...range, id: String(selectedRange), label: range.label ?? '' }} section={section} view={view} compact showOverview={false} maximumRange={limits.max_range_ms} sourceID={source.id} active={ready} audioTrack={options.audio_track} noAudio={options.no_audio} onSeek={seek} onRange={changeBounds} onReveal={ms => { if (ms < view[0] || ms > view[1]) { const next = normalizeTimelineSection(duration, { start_ms: Math.min(ms, range.start_ms), end_ms: Math.max(ms, range.end_ms) }, null); setSection(next); setView(next); } }} onSection={start => { const next: [number, number] = [start, Math.min(duration, start + section[1] - section[0])]; setSection(next); setView(timelineView(next, (view[0] + view[1]) / 2, view[1] - view[0])); }} onView={setView} onBeginChange={beginEdit} onEndChange={endEdit} />}
          <div className="workspace-toolstrip"><button className="button secondary" disabled={!available} onClick={preview}><Icon name={previewing ? 'pause' : 'play'} size={16} />{t(previewing ? 'Остановить просмотр' : 'Посмотреть ролик')}</button><button className="text-button" disabled={locked || selectedRange === 0} onClick={() => movePart(-1)}>{t('Часть раньше')}</button><button className="text-button" disabled={locked || selectedRange === clip.ranges.length - 1} onClick={() => movePart(1)}>{t('Часть позже')}</button><button className="text-button" disabled={locked || clip.ranges.length === 1} onClick={() => { editClip({ ranges: clip.ranges.filter((_, index) => index !== selectedRange) }); change({ ...current.current, selected_range: Math.max(0, selectedRange - 1) }); }}>{t('Удалить часть')}</button></div>
        </div></div></div></section>
        <aside className="workspace-sidebar"><section className="collection-clip-list"><div className="collection-list-heading"><h2>{t('Ролики')} <span>{value.document.plan.clips.length}</span></h2><button className="text-button" disabled={locked || value.document.plan.clips.length >= 128} onClick={addClip}>{t('Добавить')}</button></div><div className="collection-select-actions"><button className="text-button" disabled={locked} onClick={() => change({ ...value, selected_ids: value.document.plan.clips.map(clip => clip.id) })}>{t('Выбрать все')}</button><button className="text-button" disabled={locked} onClick={() => change({ ...value, selected_ids: [] })}>{t('Снять выбор')}</button><span>{readyCount}/{selectedIDs.length} {t('готово')}</span></div><ol>{value.document.plan.clips.map((item, index) => { const row = value.jobs[item.id], current = !!source && row?.signature === clipSignature(value.document, item, source.id), artifacts = row?.job.items.flatMap(item => item.artifact ? [item.artifact] : []) ?? []; return <li key={item.id} data-clip-id={item.id} data-selected={item.id === clip.id || undefined}><input type="checkbox" aria-label={t('Экспортировать') + ' ' + (item.label || item.id)} checked={selectedIDs.includes(item.id)} disabled={locked} onChange={event => change({ ...value, selected_ids: event.target.checked ? [...value.selected_ids, item.id] : value.selected_ids.filter(id => id !== item.id) })} /><div><button className="collection-clip-name" aria-pressed={item.id === clip.id} onClick={() => chooseClip(item.id)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{item.label || item.id}</strong><small>{item.ranges.length} {t('частей')} · {item.id}</small></button>{row && activeJob(row.job.status) && value.project_id && <button className="text-button" disabled={busy} onClick={() => void cancelClip(item.id)}>{t('Отменить обработку')}</button>}{row && ['failed', 'cancelled'].includes(row.job.status) && <p className="field-hint">{row.job.items.find(part => part.error_code || part.message)?.message || row.job.message}</p>}{row && <p className="field-hint">{current ? collectionJobReady(row.job) ? t('Готово') : row.job.status === 'succeeded' ? t('Срок хранения файла закончился.') : activeJob(row.job.status) ? t('Обрабатывается') : t('Не удалось создать ролик') : t('Есть предыдущая версия')}</p>}{artifacts.filter(artifact => collectionArtifactAvailable(artifact)).map(artifact => <div key={artifact.id}><a className="text-button" href={collectionAPI.artifactPath(artifact.id, value.project_id)} download>{t(current ? 'Скачать' : 'Скачать прежний файл')} · {formatBytes(artifact.size_bytes, locale)}</a>{value.subtitles && artifact.segments?.length && <button className="text-button" disabled={busy} onClick={() => void downloadSubtitles(item.id, artifact)}>{t('Скачать субтитры')} · {value.subtitles.format.toUpperCase()}</button>}</div>)}</div></li>; })}</ol></section>
          <section className="export-panel collection-settings"><details><summary>{t('Субтитры SRT/VTT')}</summary><label className="button secondary">{t('Открыть готовые субтитры')}<input type="file" hidden accept=".srt,.vtt" aria-label={t('Готовые субтитры SRT/VTT')} onChange={event => { const file = event.target.files?.[0]; if (file) void importSubtitles(file); event.target.value = ''; }} /></label><p className="field-hint">{t('Таймкоды исходной записи. Для готовых роликов появится отдельный файл с пересчитанными границами.')}</p>{value.subtitles && <p className="field-hint">{value.subtitles.name} <button className="text-button" onClick={() => change({ ...value, subtitles: undefined })}>{t('Убрать субтитры')}</button></p>}</details><details className="collection-clip-settings"><summary>{t('Настройки выбранного ролика')}</summary><label>{t('Название ролика')}<input aria-label={t('Название ролика')} value={clip.label ?? ''} maxLength={150} disabled={locked} onChange={event => editClip({ label: event.target.value })} /></label><p className="field-hint">ID: {clip.id}</p><div className="collection-order"><button className="text-button" disabled={locked || value.document.plan.clips[0].id === clip.id} onClick={() => moveClip(-1)}>{t('Ролик выше')}</button><button className="text-button" disabled={locked || value.document.plan.clips.at(-1)!.id === clip.id} onClick={() => moveClip(1)}>{t('Ролик ниже')}</button><button className="text-button danger-button" disabled={locked || value.document.plan.clips.length === 1} onClick={() => { const clips = value.document.plan.clips.filter(item => item.id !== clip.id); edit({ ...value.document, plan: { ...value.document.plan, clips } }); change({ ...current.current, selected_clip: clips[0].id, selected_range: 0, selected_ids: value.selected_ids.filter(id => id !== clip.id), jobs: Object.fromEntries(Object.entries(value.jobs).filter(([id]) => id !== clip.id)) }); }}>{t('Удалить ролик')}</button></div>
            <div className="collection-format-fields"><label>{t('Формат')}<select value={options.format} disabled={locked} onChange={event => clipOptions({ format: event.target.value as CollectionOptions['format'] })}><option value="mp4">MP4</option><option value="mp3">MP3</option><option value="mkv">MKV</option></select></label><label>{t('Качество')}<select value={options.quality} disabled={locked} onChange={event => clipOptions({ quality: event.target.value as CollectionOptions['quality'] })}><option value="best">{t('Исходное')}</option><option value="1080p">1080p</option><option value="720p">720p</option></select></label><label>{t('Границы')}<select value={options.cut_mode} disabled={locked} onChange={event => clipOptions({ cut_mode: event.target.value as CollectionOptions['cut_mode'] })}><option value="accurate">{t('Точные')}</option><option value="copy">{t('Копирование')}</option></select></label></div>
            <AudioTrackSelector id="collection-audio" output={output} tracks={tracks} loading={tracksLoading} error={tracksError} disabled={locked} onRetry={() => setTracksAttempt(count => count + 1)} onChange={selection => { const next = withAudioSelection(output, selection); clipOptions({ audio_track: next.audio_track ?? -1, no_audio: next.no_audio ?? false }); }} />
            <h3>{t('Кадр этого клипа')}</h3><CropEditor key={clip.id} value={options.crop} onChange={crop => clipOptions({ crop, clear_crop: !crop })} displayWidth={geometry.width} displayHeight={geometry.height} locale={locale} disabled={locked || options.format !== 'mp4' || options.cut_mode !== 'accurate'} previewContainer={container} onBeginChange={beginEdit} onEndChange={endEdit} onOpenChange={setCropOpen} />
          </details><label>{t('Версия экспорта')}<select aria-label={t('Версия экспорта')} value={value.document.rendition ?? 'final'} disabled={locked} onChange={event => edit({ ...value.document, rendition: event.target.value as 'draft' | 'final' })}><option value="final">{t('Финальная')}</option><option value="draft">{t('Черновая · MP4 до 720p')}</option></select></label>
            <button className="button primary export-submit" disabled={!source || !ready || locked || !selectedIDs.length || !!storageError} onClick={() => void saveServer(true)}>{busy ? t('Проверяем план…') : t('Экспортировать выбранные') + ' · ' + selectedIDs.length}</button>{project && selectedIDs.some(id => value.jobs[id] && collectionJobRetryable(value.jobs[id].job) && source && value.jobs[id].signature === clipSignature(value.document, value.document.plan.clips.find(clip => clip.id === id)!, source.id)) && <button className="text-button" disabled={locked || !!storageError} onClick={retryFailed}>{t(value.retry_attempt ? 'Продолжить повторную попытку' : 'Повторить неудачные ролики')}</button>}{value.rendering && <button className="text-button" onClick={() => change({ ...value, rendering: false })}>{t('Приостановить отправку')}</button>}<p className="field-hint">{t('Каждый ролик объединяет свои части по порядку. Неизменённые ролики повторно не обрабатываются.')}</p>{project && <><button className="text-button" disabled={locked || !selectedIDs.length} onClick={() => void saveServer()}>{t('Сохранить редакцию на сервере')}</button><button className="text-button" disabled={locked} onClick={() => void share()}>{t('Передать проект по ссылке')}</button><p className="field-hint">{t('Проект не продлевает хранение исходника и готовых файлов.')}</p></>}{source && <RetentionNotice expiresAt={source.expires_at} blocked={source.retention_blocked} kind="source" />}
          </section></aside></div>
    </main></div></SourceAccess.Provider>;
}
