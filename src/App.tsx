import { ProjectLibrary } from './ProjectLibrary';
import { exportCuttingPlan, importCuttingPlan, sourceMismatch, ProjectStorageLimitError, restoredExportAttempt, maxProjects, restoredProjectOutput } from './cuttingProjects';
import type { CuttingProject } from './cuttingProjects';
import { readProjects, readProject, readInitialDraft, initializeProjects, saveProject, deleteStoredProject, setActiveProject, hasMigratedProjects, isProjectStorageEvent, ProjectConflictError, stageProjectSave, discardProjectView, freshProjectID } from './projectPersistence';
import type { PersistedProject } from './projectPersistence';
import { beginGesture, emptyHistory, finishGesture, rememberEdit, redoEdit, undoEdit } from './editHistory';
import type { EditHistory } from './editHistory';
import { useLanguage } from './Language';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api, ApiError, errorMessage, jobRequestBody } from './api';
import { Icon } from './Icons';
import { Player } from './Player';
import type { PlayerControls } from './Player';
import { Timeline } from './Timeline';
import { moveTimelineSection, normalizeTimelineSection, timelineView, trimBoundaryLimits } from './timelineControls';
import { CropEditor } from './CropEditor';
import { displayTimecode, durationLabel, formatBytes, formatTimecode, parseTimecode, validateRange, zoomWindow } from './timecode';
import type { ClipRange, Job, OutputSettings, Source, UploadProgress, PublicLimits, MediaTrack } from './types';
import { countLabel } from './locales';
import { LanguageSwitch, WorkspaceNav } from './WorkspaceNav';
import { SourceChooser } from './SourceChooser';
import { ThemeToggle } from './Theme';
import { canonicalSourceUrl, providerName, validateVideo } from './sourceInput';
import { readPreferences, savePreferences, withoutSourceAudio } from './preferences';
import { AudioTrackSelector } from './AudioTrackSelector';
import { ArtifactDetails } from './ArtifactDetails';
import { defaultAudioTrack, includedTrackIndices, supportedSubtitles, trackLabel, withAudioSelection } from './mediaTracks';
import type { Preferences } from './preferences';
import { SelectControl } from './SelectControl';
import { ClipLibrary } from './ClipLibrary';
import { duplicateRanges, markBounds, rangeSelection, removeRanges, restoreRanges, restoredStep } from './clipCollection';
import type { WorkbenchStep } from './clipCollection';
import { exportFailureReason, repeatsFailedExport } from './jobFailure';
import { ExportProgress } from './ExportProgress';
import { recoverExportRequest, unfinishedJobRanges } from './exportRetry';
import { CropPreview } from './CropPreview';
import { createPlaybackPosition } from './playbackPosition';
import { coalescedTask } from './coalescedTask';
import { draftStorageKey as storageKey, readStoredRecord, storedResourceId } from './browserStorage';
import { startVisiblePolling } from './visiblePolling';
import { defaultLimits, maxClientRanges, readPublicLimits } from './limits';
import { SourceLibrary } from './SourceLibrary';
import { JobLibrary } from './JobLibrary';
import { WorkspaceDialog } from './WorkspaceDialog';
import { useDesktopWorkspace, useWorkspaceViewport } from './useWorkspaceViewport';
import './Workspace.css';
import { RetentionNotice } from './RetentionNotice';
import { useWorkflowHistory } from './workflowHistory';
import { boundaryAudition, recoverCuttingDraft, restoredTimeText } from './cuttingDraft';
import type { RecoverableSource } from './cuttingDraft';
import type { WorkbenchPanel, WorkflowRoute } from './workflowHistory';
import { collectionDocumentLimit, isCollectionDocument, readCollectionDocument } from './collectionProject';
import type { CollectionProjectDocument } from './collectionProject';

const activeJob = (job: Job | null) => job?.status === 'queued' || job?.status === 'running' || job?.status === 'waiting_storage';
const stageNames: Record<string, string> = {
  waiting_storage: 'Ждём свободного места', queued: 'В очереди', preparing: 'Готовим обработку', resolving: 'Проверяем источник', resolve: 'Проверяем источник', fetching: 'Получаем видео', fetch: 'Получаем видео',
  downloading: 'Получаем видео', processing: 'Вырезаем фрагменты', process: 'Вырезаем фрагменты',
  verifying: 'Проверяем файлы', verify: 'Проверяем файлы', publish: 'Готовим скачивание',
  publishing: 'Сохраняем файл', finished: 'Обработка завершена', succeeded: 'Файлы готовы', failed: 'Не удалось создать файлы', cancelled: 'Обработка отменена',
};

function jobDescription(job: Job, t: (text: string, values?: Record<string, string | number>) => string): string {
  if (job.status === 'waiting_storage') return t('Задание сохранено и продолжится автоматически, когда освободится место.');
  if (job.status === 'queued') return t('Задание сохранено. Можно закрыть страницу и вернуться позже.');
  if (job.status === 'cancelled') return t(job.items.some(item => item.artifact) ? 'Новые фрагменты не создаются. Готовые файлы можно скачать.' : 'Обработка отменена. Можно изменить моменты или настройки и вырезать снова.');
  if (job.status === 'succeeded') return t('Все фрагменты готовы к скачиванию.');
  if (job.status === 'failed') return t(job.items.some(item => item.artifact)
    ? 'Часть фрагментов не удалось обработать. Готовые файлы уже можно скачать.'
    : 'Не удалось создать фрагменты. Причина указана ниже.');
  const position = job.items.findIndex(item => item.status === 'running');
  if (position >= 0) return t('Фрагмент {index} из {total}.', { index: position + 1, total: job.items.length });
  return t('Задание выполняется. Страница обновляется автоматически.');
}

function newRange(duration: number, start = 0, limits = defaultLimits): ClipRange {
  const begin = Math.max(0, Math.min(start, duration - 100));
  return { id: crypto.randomUUID(), label: '', start_ms: begin, end_ms: Math.min(duration, begin + 30000, begin + limits.max_range_ms, begin + limits.max_job_ms) };
}

function simpleRangeView(duration: number, range: ClipRange): [number, number] {
  return normalizeTimelineSection(duration, range, null);
}

interface EditorSnapshot { ranges: ClipRange[]; selectedId: string; selectedRangeIds: string[]; output: OutputSettings; simpleView: [number, number]; span: number; viewCenter: number; }

export default function App({ onCollectionOpen }: { onCollectionOpen?(document?: CollectionProjectDocument, source?: Source): void } = {}) {
  const { locale, t } = useLanguage();
  const [limits, setLimits] = useState<PublicLimits>(defaultLimits);
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const [step, setStep] = useState<WorkbenchStep>(1);
  const [panel, setPanel] = useState<WorkbenchPanel>(() => {
    const requested = new URLSearchParams(window.location.search).get('panel');
    return requested === 'examples' || requested === 'settings' || requested === 'support' ? requested : null;
  });
  const [source, setSource] = useState<Source | null>(null);
  const [recoverableSource, setRecoverableSource] = useState<RecoverableSource | null>(null);
  const [keepRecoveredCuts, setKeepRecoveredCuts] = useState(false);
  const currentSourceID = useRef<string | undefined>(undefined);
  currentSourceID.current = source?.id;
  const [url, setUrl] = useState('');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [deletingSource, setDeletingSource] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [sourceError, setSourceError] = useState('');
  const [ranges, setRanges] = useState<ClipRange[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedRangeIds, setSelectedRangeIds] = useState<string[]>([]);
  const [revealId, setRevealId] = useState('');
  const desktopWorkspace = useDesktopWorkspace();
  const [exportOpen, setExportOpen] = useState(false);
  const [timelineTools, setTimelineTools] = useState<HTMLDivElement | null>(null);
  const [precisionOpen, setPrecisionOpen] = useState(false);
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [position] = useState(createPlaybackPosition);
  const [playerAvailable, setPlayerAvailable] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sequenceIndex, setSequenceIndex] = useState<number | null>(null);
  const sequence = useRef<{ ranges: ClipRange[]; index: number; awaitingSeek: boolean } | null>(null);
  const pendingBoundary = useRef<number | null>(null);
  const [span, setSpan] = useState(preferences.timeline_span);
  const [viewCenter, setViewCenter] = useState(15000);
  const [simpleView, setSimpleView] = useState<[number, number]>([0, 60000]);
  const [output, setOutput] = useState<OutputSettings>(preferences.output);
  const [sourceTracks, setSourceTracks] = useState<{ sourceID: string; tracks: MediaTrack[] | null; loading: boolean; error: string }>({ sourceID: '', tracks: null, loading: false, error: '' });
  const [cropOpen, setCropOpen] = useState(false);
  const [cropContainer, setCropContainer] = useState<HTMLElement | null>(null);
  const [displayGeometry, setDisplayGeometry] = useState<{ id: string; width: number; height: number } | null>(null);
  const [trackRevision, setTrackRevision] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [joinedJob, setJoinedJob] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [jobRangeNumbers, setJobRangeNumbers] = useState<number[]>([]);
  const [jobCuts, setJobCuts] = useState<ClipRange[]>([]);
  const [priorJobs, setPriorJobs] = useState<{ job: Job; numbers: number[] }[]>([]);
  const priorJobLoadGeneration = useRef(0);
  const priorJobReferences = useRef<{ id: string; numbers: number[] }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const stopJobPolling = useRef<(() => void) | null>(null);
  const mutationPending = useRef(false);
  const deletionPending = useRef(false);
  const [jobError, setJobError] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [editorToolsOpen, setEditorToolsOpen] = useState(false);
  const [advancedOutputOpen, setAdvancedOutputOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [projects, setProjects] = useState(readProjects);
  const projectStore = useRef(projects);
  const activeProjectID = useRef<string | null>(projects.active_id);
  const projectRevisions = useRef(new Map(projects.projects.map(project => [project.id, (project as Partial<PersistedProject>).revision ?? null])));
  const projectSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [projectConflict, setProjectConflict] = useState<ProjectConflictError | null>(null);
  const histories = useRef<Record<string, EditHistory<EditorSnapshot>>>({});
  const pendingHistoryEnd = useRef<EditHistory<EditorSnapshot> | null>(null);
  const [, refreshHistory] = useState(0);
  const [projectError, setProjectErrorValue] = useState('');
  const projectErrorFromPersistence = useRef(false);
  function setProjectError(message: string, fromPersistence = false) { projectErrorFromPersistence.current = !!message && fromPersistence; setProjectErrorValue(message); }
  const [recoveringDraft, setRecoveringDraft] = useState<Record<string, unknown> | null>(null);
  const latestDraft = useRef<Record<string, unknown>>({});
  const player = useRef<PlayerControls>(null);
  const previewEnd = useRef<number | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const exportAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const exportAttemptNumbers = useRef<number[]>([]);
  const startField = useRef<HTMLInputElement>(null);
  const endField = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);
  const previousJobState = useRef<{ id: string; status: Job['status'] } | null>(null);
  const restoredPosition = useRef<number | null>(null);
  const draftWriter = useRef<ReturnType<typeof coalescedTask> | null>(null);
  latestDraft.current = draftSnapshot();
  const selected = ranges.find(range => range.id === selectedId) ?? ranges[0];
  const exportRanges = ranges.filter(range => selectedRangeIds.includes(range.id));
  const retryRequest = !source && recoverableSource ? recoverExportRequest(recoverableSource.id, ranges, output, exportAttempt.current) : null;
  const retryOutput = retryRequest?.output ?? null;
  const busy = activeJob(job) || submitting || deletingSource;
  const duration = source?.duration_ms ?? 0;
  const workspaceVisible = !!source && step !== 1;
  useWorkspaceViewport(workspaceVisible);
  const view = timelineView(simpleView, viewCenter, span);
  const zoomOptions = [duration, 300000, 60000, 10000, view[1] - view[0]].filter((value, index, all) => value > 0 && value <= duration && all.indexOf(value) === index);
  const totalDuration = exportRanges.reduce((sum, range) => sum + range.end_ms - range.start_ms, 0);
  const invalidDraft = !!selected && !!validateRange(parseTimecode(startText), parseTimecode(endText), duration, limits.max_range_ms);
  const exportLimitError = exportRanges.length > limits.max_ranges ? t('Можно экспортировать не больше {limit} фрагментов за один раз.', { limit: limits.max_ranges }) : exportRanges.some(range => range.end_ms - range.start_ms > limits.max_range_ms) ? t('Один фрагмент может длиться до {limit}.', { limit: durationLabel(limits.max_range_ms, locale) }) : totalDuration > limits.max_job_ms ? t('Общая длительность одного экспорта — до {limit}. Разделите фрагменты на несколько заданий.', { limit: durationLabel(limits.max_job_ms, locale) }) : '';
  const videoCopy = output.cut_mode === 'copy' && output.format !== 'mp3';
  const preserveLocalQuality = videoCopy && (source?.kind === 'upload' || source?.kind === 'direct');
  const tracks = sourceTracks.sourceID === source?.id ? sourceTracks.tracks : null;
  const tracksLoading = sourceTracks.sourceID !== source?.id || sourceTracks.loading;
  const tracksError = sourceTracks.sourceID === source?.id ? sourceTracks.error : '';
  const subtitleTracks = tracks?.filter(track => track.type === 'subtitle') ?? [];
  const canPreserveSubtitles = preserveLocalQuality && supportedSubtitles(tracks ?? []);
  const includedTracks = includedTrackIndices(tracks ?? [], output);
  const audioTracks = tracks?.filter(track => track.type === 'audio') ?? [];
  const selectedAudio = output.no_audio ? undefined : output.audio_track !== undefined ? audioTracks.find(track => track.index === output.audio_track) : defaultAudioTrack(tracks ?? []);
  // Multi-track browser defaults differ between engines; use the same inspected
  // default stream as the exporter when more than one audio track is available.
  const previewAudioTrack = output.audio_track ?? (audioTracks.length > 1 && !output.no_audio ? selectedAudio?.index : undefined);
  const invalidAudio = output.audio_track !== undefined && (tracks !== null && !selectedAudio || tracksError !== '');
  const incompatibleCrop = !!output.crop && (output.format !== 'mp4' || output.cut_mode !== 'accurate');
  const incompatibleOutput = incompatibleCrop || output.format === 'mkv' && !videoCopy || output.subtitle_mode === 'preserve' && !canPreserveSubtitles;
  const navigation = useWorkflowHistory({ ready: sessionReady, step, panel, onNavigate: navigateHistory });

  const playbackPosition = useCallback((ms: number, confirmed = true) => {
    if (confirmed && restoredPosition.current !== null && Math.abs(ms - restoredPosition.current) > 250) return;
    const active = sequence.current;
    if (active) {
      const range = active.ranges[active.index];
      // A seek publishes synchronously. Ignore clocks from the previous media
      // until the new target has been acknowledged, including backward cuts.
      if (active.awaitingSeek) {
        if (confirmed && ms >= range.start_ms - 100 && ms <= range.start_ms + 250) { active.awaitingSeek = false; position.set(Math.max(range.start_ms, ms)); }
        return;
      }
      if (ms >= range.end_ms) {
        const next = active.ranges[active.index + 1];
        if (next) {
          active.index++; active.awaitingSeek = true; setSequenceIndex(active.index);
          player.current?.pause(); player.current?.seek(next.start_ms); player.current?.play();
        } else {
          sequence.current = null; setSequenceIndex(null); setPreviewing(false);
          player.current?.pause(); player.current?.seek(range.end_ms); position.set(range.end_ms);
        }
        return;
      }
    }
    if (previewEnd.current !== null && ms >= previewEnd.current) {
      const end = previewEnd.current; previewEnd.current = null; setPreviewing(false);
      player.current?.pause(); player.current?.seek(end); position.set(end);
    } else position.set(Math.min(duration, ms));
  }, [duration, position]);

  function stopPreview() {
    sequence.current = null; setSequenceIndex(null);
    previewEnd.current = null; setPreviewing(false); player.current?.pause();
  }

  async function restorePriorJobs(saved: Record<string, unknown>) {
    const projectID = activeProjectID.current, generation = ++priorJobLoadGeneration.current;
    const length = typeof saved.source_duration_ms === 'number' ? saved.source_duration_ms : 366 * 24 * 60 * 60 * 1000;
    setJobCuts(restoreRanges(saved.job_ranges, length, maxClientRanges));
    exportAttemptNumbers.current = Array.isArray(saved.export_attempt_range_numbers) ? saved.export_attempt_range_numbers.filter(value => Number.isInteger(value) && value > 0 && value <= maxClientRanges).slice(0, maxClientRanges) as number[] : [];
    const ids = Array.isArray(saved.prior_job_ids) ? [...new Set(saved.prior_job_ids.filter(storedResourceId))].slice(-32) : [];
    const numbers = saved.prior_job_range_numbers && typeof saved.prior_job_range_numbers === 'object' ? saved.prior_job_range_numbers as Record<string, unknown> : {};
    // References are durable project content. Loading their current download
    // details must not temporarily turn them into an empty saved history.
    const references = ids.map(id => ({ id, numbers: Array.isArray(numbers[id]) ? (numbers[id] as unknown[]).slice(0, maxClientRanges).map((value, index) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maxClientRanges ? value : index + 1) : [] }));
    priorJobReferences.current = references;
    const expired = new Set<string>();
    const loaded = await Promise.all(references.map(async reference => {
      try { return { job: await api.job(reference.id), numbers: reference.numbers }; }
      catch (error) {
        if (error instanceof ApiError && (error.httpStatus === 404 || error.httpStatus === 410)) expired.add(reference.id);
        return null; // Network and server errors preserve the reference for reload.
      }
    }));
    if (activeProjectID.current !== projectID || generation !== priorJobLoadGeneration.current) return;
    priorJobReferences.current = priorJobReferences.current.filter(reference => !expired.has(reference.id));
    // A selective retry can add another completed job while these reads are
    // pending. Merge details in reference order instead of discarding that job.
    setPriorJobs(current => priorJobReferences.current.flatMap(reference => {
      const value = loaded.find(value => value?.job.id === reference.id) ?? current.find(value => value.job.id === reference.id);
      return value ? [{ ...value, numbers: reference.numbers }] : [];
    }));
  }

  const mediaGeometry = useCallback((width: number, height: number) => {
    if (!source || !Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || width * height > 33554432) return;
    setDisplayGeometry(previous => previous?.id === source.id && previous.width === width && previous.height === height ? previous : { id: source.id, width, height });
  }, [source?.id]);
  useEffect(() => { setCropOpen(false); setCropContainer(document.querySelector<HTMLElement>('.player-frame')); }, [source?.id]);

  const playerAvailability = useCallback((available: boolean) => {
    setPlayerAvailable(available);
    if (!available) { sequence.current = null; setSequenceIndex(null); previewEnd.current = null; setPreviewing(false); }
    if (available && restoredPosition.current !== null) { player.current?.seek(restoredPosition.current); restoredPosition.current = null; }
  }, []);

  const sourceUnavailable = useCallback(async (id: string, verify = false) => {
    if (!source || source.id !== id || currentSourceID.current !== id) return;
    if (verify) {
      try { const fresh = await api.source(id); if (!fresh.media_removed) return; }
      catch (error) { if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410 || ['not_found', 'expired', 'source_expired', 'source_unavailable'].includes(error.code))) return; }
      if (currentSourceID.current !== id) return;
    }
    stopPreview();
    setRecoveringDraft(latestDraft.current); setRecoverableSource({ id, title: source.title, duration_ms: source.duration_ms }); setKeepRecoveredCuts(false);
    setSource(null); setStep(1);
    setSourceError('Источник больше недоступен. Фрагменты сохранены. Загрузите ту же запись или откройте её ссылку, чтобы продолжить.');
  }, [source]);

  const setFields = useCallback((range: ClipRange) => {
    setStartText(formatTimecode(range.start_ms, true));
    setEndText(formatTimecode(range.end_ms, true));
    setRangeError('');
  }, []);

  useEffect(() => {
    if (!source) return;
    const sourceID = source.id;
    const controller = new AbortController();
    let disposed = false;
    setSourceTracks({ sourceID, tracks: null, loading: true, error: '' });
    void api.tracks(sourceID, controller.signal).then(value => {
      if (!disposed) { setSourceTracks({ sourceID, tracks: value.tracks, loading: false, error: '' });
        if (value.display_width && value.display_height) setDisplayGeometry({ id: sourceID, width: value.display_width, height: value.display_height }); }
    }).catch(error => {
      if (!disposed) setSourceTracks({ sourceID, tracks: null, loading: false, error: error instanceof ApiError && error.code === 'tracks_unavailable'
        ? 'Чтобы выбрать аудиодорожку площадки, загрузите исходный файл. Экспорт без звука доступен.' : errorMessage(error) });
    });
    return () => { disposed = true; controller.abort(); };
  }, [source?.id, trackRevision]);

  function changeAudio(selection: string) {
    stopPreview();
    setOutput(previous => withAudioSelection(previous, selection));
  }

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setSessionLoading(true);
    void (async () => {
      try {
        const session = await api.session();
        const currentLimits = readPublicLimits(session.limits);
        if (disposed) return;
        setLimits(currentLimits);
        if (!restored.current) {
          try { projectStore.current = await initializeProjects(); } catch { setProjectError('Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.', true); }
          if (disposed) return;
          setProjects(projectStore.current);
          projectRevisions.current = new Map(projectStore.current.projects.map(project => [project.id, (project as Partial<PersistedProject>).revision ?? null]));
          const saved = readInitialDraft(projectStore.current);
          activeProjectID.current = projectStore.current.active_id ?? (storedResourceId(saved.source_id) ? saved.source_id : null);
          void restorePriorJobs(saved);
          exportAttempt.current = restoredExportAttempt(saved);
          const savedStep = restoredStep(saved.step, saved.workflow_version);
          let sourceWasRestored = false;
          let sourceStep: WorkbenchStep | undefined;
          if (storedResourceId(saved.source_id)) {
            try {
              const original = await api.source(saved.source_id, controller.signal);
              if (disposed) return;
              if (original.media_removed) throw new ApiError('source_unavailable', 'Source media removed', 410);
              const valid = restoreRanges(saved.ranges, original.duration_ms, maxClientRanges);
              const restoredRanges = valid.length || Array.isArray(saved.ranges) && saved.ranges.length === 0 ? valid : [newRange(original.duration_ms, 0, currentLimits)];
              const active = restoredRanges.find(range => range.id === saved.selected_id) ?? restoredRanges[0];
              setSource(original); setRanges(restoredRanges); setSelectedId(active?.id ?? ''); if (active) { setFields(active); restoreTimeFields(saved, active); }
              setSelectedRangeIds(rangeSelection(restoredRanges, saved.selected_range_ids)); setRevealId(active?.id ?? '');
              setPrecisionOpen(saved.precision_open === true || original.preview_kind === 'none' || (!original.preview_url && !original.embed_url));
              sourceStep = !active && (savedStep === 2 || savedStep === undefined) ? 3 : savedStep ?? 2;
              sourceWasRestored = true; setStep(sourceStep);
              const savedPosition = typeof saved.current_ms === 'number' && Number.isFinite(saved.current_ms) ? Math.max(0, Math.min(original.duration_ms, saved.current_ms)) : 0;
              restoredPosition.current = savedPosition; position.set(savedPosition);
              setViewCenter(active ? (active.start_ms + active.end_ms) / 2 : 0);
              if (active) setSimpleView(simpleRangeView(original.duration_ms, active));
              restoreProjectView(saved, original.duration_ms, active);
              const restoredOutput = restoredProjectOutput(saved);
              if (restoredOutput) setOutput(restoredOutput);
            } catch (error) {
              if (disposed) return;
              if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410 || ['not_found', 'expired', 'source_unavailable', 'source_expired'].includes(error.code))) throw error;
              const recovered = recoverCuttingDraft(saved);
              if (recovered) {
                setRecoverableSource(recovered.source); setRecoveringDraft(saved); setKeepRecoveredCuts(false);
                setRanges(recovered.ranges); setSelectedId(recovered.selectedId); setSelectedRangeIds(recovered.selectedIds);
                const active = recovered.ranges.find(range => range.id === recovered.selectedId);
                if (active) { setFields(active); restoreTimeFields(saved, active); } else { setStartText(''); setEndText(''); }
                restoreProjectView(saved, recovered.source.duration_ms, active);
                const recoveredPosition = typeof saved.current_ms === 'number' && Number.isFinite(saved.current_ms) ? Math.max(0, Math.min(recovered.source.duration_ms, saved.current_ms)) : 0;
                position.set(recoveredPosition); restoredPosition.current = recoveredPosition;
                const restoredOutput = restoredProjectOutput(saved); if (restoredOutput) setOutput(restoredOutput);
                if (restoredOutput && recoverExportRequest(recovered.source.id, recovered.ranges, restoredOutput, exportAttempt.current)) setStep(4);
              }
              setSourceError(recovered ? 'Источник больше недоступен. Фрагменты сохранены. Загрузите ту же запись или откройте её ссылку, чтобы продолжить.' : 'Предыдущий источник больше недоступен. Откройте его заново.');
            }
          }
          if (disposed) return;
          if (storedResourceId(saved.job_id)) {
            try { const previous = await api.job(saved.job_id, controller.signal); if (!disposed) { setJob(previous); setJoinedJob(saved.job_output_mode === 'joined' || previous.items.some(item => item.artifact?.segments?.length)); setJobRangeNumbers(Array.isArray(saved.job_range_numbers) && saved.job_range_numbers.length === previous.items.length && saved.job_range_numbers.every(number => Number.isInteger(number) && number > 0 && number <= maxClientRanges) ? saved.job_range_numbers : previous.items.map((_, index) => index + 1)); setStep(sourceWasRestored ? sourceStep ?? 4 : 4); } } catch (error) { if (disposed) return; if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410 || ['not_found', 'expired'].includes(error.code))) throw error; }
          }
          if (disposed) return;
          restored.current = true;
        }
        if (!disposed) setSessionReady(true);
      } catch (error) { if (!disposed) { setSourceError(errorMessage(error)); setStep(1); } }
      finally { if (!disposed) setSessionLoading(false); }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [sessionAttempt, setFields]);

  async function persistCurrentProject(provided?: Record<string, unknown>): Promise<boolean> {
    const snapshot = provided ?? draftSnapshot(), id = activeProjectID.current;
    if (pendingHistoryEnd.current === currentHistory()) { finishGesture(currentHistory(), editSnapshot()); pendingHistoryEnd.current = null; }
    if (!id || !snapshot.source_id) return true;
    try { stageProjectSave(id, snapshot, projectRevisions.current.get(id) ?? null); }
    catch { setProjectError('Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.', true); return false; }
    const save = async () => {
      try {
        if (!hasMigratedProjects()) {
          const initialized = await initializeProjects();
          for (const project of initialized.projects) if (!projectRevisions.current.get(project.id)) projectRevisions.current.set(project.id, (project as PersistedProject).revision);
        }
        const saved = await saveProject(id, snapshot, projectRevisions.current.get(id) ?? null, true);
        projectRevisions.current.set(id, saved.revision);
        const next = { ...projectStore.current, projects: [saved, ...projectStore.current.projects.filter(project => project.id !== id)] };
        projectStore.current = next; setProjects(next);
        if (activeProjectID.current === id) setActiveProject(id);
        if (activeProjectID.current === id && projectErrorFromPersistence.current) setProjectError('');
        return true;
      } catch (error) {
        if (activeProjectID.current !== id) return false;
        if (error instanceof ProjectConflictError) { setProjectConflict(error); setProjectError(error.message, true); }
        else setProjectError(error instanceof ProjectStorageLimitError ? error.message : 'Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.', true);
        return false;
      }
    };
    const result = projectSaveQueue.current.then(save, save);
    projectSaveQueue.current = result;
    return result;
  }

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (!isProjectStorageEvent(event.key)) return;
      const fresh = readProjects(); projectStore.current = fresh; setProjects(fresh);
      const id = activeProjectID.current;
      if (!restored.current || !id || !projectRevisions.current.has(id)) return;
      const latest = fresh.projects.find(project => project.id === id) as PersistedProject | undefined;
      if (!latest || latest.revision !== projectRevisions.current.get(id)) {
        const conflict = new ProjectConflictError(id, !latest);
        setProjectConflict(conflict); setProjectError(conflict.message, true);
      }
    };
    window.addEventListener('storage', synchronize);
    return () => window.removeEventListener('storage', synchronize);
  }, []);

  async function saveProjectCopy() {
    const snapshot = draftSnapshot(), id = `project-${crypto.randomUUID()}`;
    if (!snapshot.source_id) return;
    try {
      await projectSaveQueue.current;
      const saved = await saveProject(id, snapshot, null);
      projectRevisions.current.set(id, saved.revision); activeProjectID.current = id; setActiveProject(id);
      const fresh = readProjects(); projectStore.current = fresh; setProjects(fresh);
      setProjectConflict(null); setProjectError(''); setNotice('Изменения сохранены как отдельный проект.');
      void restorePriorJobs(snapshot);
    } catch (error) { setProjectError(error instanceof ProjectStorageLimitError ? error.message : 'Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.', true); }
  }

  async function reloadProjectVersion() {
    const id = activeProjectID.current; if (!id) return;
    discardProjectView(id); const fresh = readProject(id); if (!fresh) return;
    await openProject(fresh, true);
  }

  function restoreProjectView(saved: Record<string, unknown>, length: number, range?: ClipRange) {
    const savedSpan = typeof saved.timeline_span === 'number' && Number.isFinite(saved.timeline_span) && saved.timeline_span > 0 ? saved.timeline_span : preferences.timeline_span;
    const center = typeof saved.view_center === 'number' && Number.isFinite(saved.view_center) ? saved.view_center : range ? (range.start_ms + range.end_ms) / 2 : 0;
    const section = range ? normalizeTimelineSection(length, range, saved.simple_view) : [0, length] as [number, number];
    const restoredView = timelineView(section, center, savedSpan);
    setSimpleView(section); setSpan(restoredView[1] - restoredView[0]); setViewCenter((restoredView[0] + restoredView[1]) / 2);
  }

  function editSnapshot(): EditorSnapshot { return { ranges, selectedId, selectedRangeIds, output, simpleView, span, viewCenter }; }
  function currentHistory() { const id = activeProjectID.current ?? 'new'; return histories.current[id] ??= emptyHistory<EditorSnapshot>(); }
  function rememberHistory() { rememberEdit(currentHistory(), editSnapshot()); refreshHistory(value => value + 1); }
  function beginHistory() { beginGesture(currentHistory(), editSnapshot()); refreshHistory(value => value + 1); }
  function finishHistory() { pendingHistoryEnd.current = currentHistory(); refreshHistory(value => value + 1); }
  // Some controls begin/change/end within one event; finalize after React applies
  // their state updates so a real change is not mistaken for a no-op gesture.
  useEffect(() => {
    const history = pendingHistoryEnd.current;
    if (!history) return;
    pendingHistoryEnd.current = null;
    if (history === currentHistory()) finishGesture(history, editSnapshot());
    refreshHistory(value => value + 1);
  });
  function applyEditSnapshot(snapshot: EditorSnapshot) {
    setRanges(snapshot.ranges); setSelectedId(snapshot.selectedId); setSelectedRangeIds(snapshot.selectedRangeIds); setOutput(snapshot.output); setRevealId(snapshot.selectedId);
    const range = snapshot.ranges.find(value => value.id === snapshot.selectedId) ?? snapshot.ranges[0];
    if (range) { setFields(range); setSelectedId(range.id); setViewCenter(snapshot.viewCenter); setSpan(snapshot.span); setSimpleView(normalizeTimelineSection(duration, range, snapshot.simpleView)); }
    else { setStartText(''); setEndText(''); setRangeError(''); if (step === 2) setStep(3); }
    stopPreview();
    if (range) seek(range.start_ms);
  }
  function historyAction(direction: 'undo' | 'redo') {
    if (busy || sourceBusy) return;
    const snapshot = direction === 'undo' ? undoEdit(currentHistory(), editSnapshot()) : redoEdit(currentHistory(), editSnapshot());
    if (snapshot) {
      // Export checkboxes are independent of content history. Keep the current
      // choices for surviving clips and restore saved choices for revived clips.
      const existingIDs = new Set(ranges.map(range => range.id));
      const selected = snapshot.ranges.filter(range => (existingIDs.has(range.id) ? selectedRangeIds : snapshot.selectedRangeIds).includes(range.id)).map(range => range.id);
      applyEditSnapshot({ ...snapshot, selectedRangeIds: selected }); refreshHistory(value => value + 1);
    }
  }
  function moveRange(id: string, direction: -1 | 1) {
    stopPreview();
    const index = ranges.findIndex(range => range.id === id), target = index + direction;
    if (index < 0 || target < 0 || target >= ranges.length) return;
    rememberHistory(); const next = [...ranges]; [next[index], next[target]] = [next[target], next[index]]; setRanges(next); setRevealId(id);
  }

  async function openProject(project: CuttingProject, discardLocal = false) {
    if (sourceBusy || submitting || deletingSource || cancelling || mutationPending.current || sourceController.current) return;
    draftWriter.current?.flush();
    if (!discardLocal && (source || recoverableSource) && !await persistCurrentProject()) return;
    setProjectError('');
    const stored = readProject(project.id);
    if (!stored) { setProjectError('Проект удалён в другой вкладке. Текущие изменения можно сохранить как копию.'); return; }
    const saved = stored.draft;
    const controller = new AbortController(); sourceController.current = controller;
    const current = () => !controller.signal.aborted && sourceController.current === controller;
    setSourceBusy(true); setSourceError(''); stopJobPolling.current?.(); player.current?.pause(); previewEnd.current = null; setPreviewing(false);
    try {
      let fresh: Source | null = null;
      if (!String(saved.source_id).startsWith('plan-')) {
        try { fresh = await api.source(String(saved.source_id), controller.signal); if (!current()) return; if (fresh.media_removed) fresh = null; }
        catch (error) { if (!current()) return; if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410 || ['not_found', 'expired', 'source_expired', 'source_unavailable'].includes(error.code))) throw error; }
      }
      if (!current()) return;
      activeProjectID.current = project.id; projectRevisions.current.set(project.id, stored.revision); setActiveProject(project.id); setProjectConflict(null);
      setJob(null); priorJobLoadGeneration.current++; priorJobReferences.current = []; setPriorJobs([]); setJobCuts([]); setJoinedJob(false); setJobRangeNumbers([]); setJobError('');
      restoreProject(saved, fresh);
      if (storedResourceId(saved.job_id)) {
        try { const previous = await api.job(saved.job_id, controller.signal); if (!current()) return; setJob(previous); setJoinedJob(saved.job_output_mode === 'joined'); setJobRangeNumbers(Array.isArray(saved.job_range_numbers) ? saved.job_range_numbers as number[] : previous.items.map((_, index) => index + 1)); if (!fresh || saved.step === 4) setStep(4); }
        catch (error) { if (!current()) return; if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410)) setJobError(errorMessage(error)); }
      }
      if (current()) setNotice('Проект открыт.');
    } catch (error) { if (current()) setSourceError(errorMessage(error)); }
    finally { if (sourceController.current === controller) { sourceController.current = null; setSourceBusy(false); } }
  }

  function restoreProject(saved: Record<string, unknown>, fresh: Source | null) {
    const length = fresh?.duration_ms ?? Number(saved.source_duration_ms);
    const nextRanges = restoreRanges(saved.ranges, length, maxClientRanges);
    const active = nextRanges.find(range => range.id === saved.selected_id) ?? nextRanges[0];
    setSource(fresh); setRanges(nextRanges); setSelectedId(active?.id ?? ''); setSelectedRangeIds(rangeSelection(nextRanges, saved.selected_range_ids)); setRevealId(active?.id ?? '');
    if (active) { setFields(active); restoreTimeFields(saved, active); } else { setStartText(''); setEndText(''); }
    const nextOutput = restoredProjectOutput(saved); if (nextOutput) setOutput(nextOutput);
    restoreProjectView(saved, length, active);
    const savedPosition = typeof saved.current_ms === 'number' && Number.isFinite(saved.current_ms) ? Math.max(0, Math.min(length, saved.current_ms)) : 0;
    position.set(savedPosition); restoredPosition.current = savedPosition;
    setPrecisionOpen(saved.precision_open === true);
    setPlayerAvailable(false); exportAttempt.current = restoredExportAttempt(saved); void restorePriorJobs(saved);
    if (fresh) { setRecoverableSource(null); setRecoveringDraft(null); setStep(active ? 2 : 3); }
    else { setRecoverableSource({ id: String(saved.source_id), title: String(saved.source_title ?? ''), duration_ms: length }); setRecoveringDraft(saved); setKeepRecoveredCuts(false); setStep(nextOutput && recoverExportRequest(String(saved.source_id), nextRanges, nextOutput, exportAttempt.current) ? 4 : 1); setSourceError('Источник больше недоступен. Фрагменты сохранены. Загрузите ту же запись или откройте её ссылку, чтобы продолжить.'); }
    refreshHistory(value => value + 1);
  }

  async function deleteProject(id: string) {
    if (!window.confirm(t('Удалить проект только из браузера? Видео и готовые файлы останутся на сервере.'))) return;
    try {
      await projectSaveQueue.current;
      const stored = readProject(id); if (!stored) return;
      await deleteStoredProject(id, stored.revision);
      const fresh = readProjects(); projectStore.current = fresh; setProjects(fresh); delete histories.current[id];
      if (activeProjectID.current === id) { activeProjectID.current = null; setActiveProject(null); setProjectConflict(null); setSource(null); setRecoverableSource(null); setRecoveringDraft(null); setRanges([]); setSelectedId(''); setSelectedRangeIds([]); setStep(1); }
      setProjectError('');
    } catch (error) { setProjectError(error instanceof ProjectConflictError ? error.message : 'Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.', true); }
  }

  function downloadPlan() {
    const included = ranges.filter(range => selectedRangeIds.includes(range.id));
    if (!included.length) return;
    const plan = exportCuttingPlan(source?.title ?? recoverableSource?.title ?? 'video.mp4', included, output);
    const blobURL = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = blobURL; link.download = 'cutmy-plan.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(blobURL), 1000);
  }

  async function loadPlan(file: File) {
    if (file.size > collectionDocumentLimit) { setProjectError('План слишком большой.'); return; }
    try {
      const raw = await file.text();
      const parsed: unknown = JSON.parse(raw);
      if (onCollectionOpen && isCollectionDocument(parsed)) {
        const document = readCollectionDocument(parsed);
        draftWriter.current?.flush(); if (!await persistCurrentProject()) return;
        // Imported source IDs are hints only. A portable plan must explicitly
        // bind its media or arrive through the backend's narrow project grant.
        onCollectionOpen(document); return;
      }
      if (file.size > 256 * 1024) { setProjectError('План слишком большой.'); return; }
      const result = importCuttingPlan(raw, source?.duration_ms ?? 366 * 24 * 60 * 60 * 1000, () => crypto.randomUUID());
      if (source && !window.confirm(t('Заменить фрагменты текущего проекта импортированным планом? Проверьте, что открыта нужная запись.'))) return;
      if (source) rememberHistory();
      else {
        draftWriter.current?.flush(); if (recoverableSource && !await persistCurrentProject()) return;
        const id = `plan-${crypto.randomUUID()}`, length = Math.max(...result.ranges.map(range => range.end_ms));
        const draft = { source_id: id, source_title: result.input.split(/[\\/]/).at(-1), source_duration_ms: length, plan_imported: true, ranges: result.ranges, output: result.output, selected_id: result.ranges[0].id, selected_range_ids: result.ranges.map(range => range.id) };
        const saved = await saveProject(id, draft, null); projectRevisions.current.set(id, saved.revision);
        activeProjectID.current = id; setActiveProject(id); projectStore.current = readProjects(); setProjects(projectStore.current);
        setProjectConflict(null); setRecoverableSource({ id, title: String(draft.source_title), duration_ms: length }); setRecoveringDraft(draft); setKeepRecoveredCuts(true);
      }
      setRanges(result.ranges); setSelectedId(result.ranges[0].id); setSelectedRangeIds(result.ranges.map(range => range.id)); setOutput(result.output); setFields(result.ranges[0]); setRevealId(result.ranges[0].id); setProjectError('');
      if (source) { const range = result.ranges[0]; setSimpleView(simpleRangeView(duration, range)); setViewCenter((range.start_ms + range.end_ms) / 2); setStep(3); setNotice('План открыт. Проверьте соответствие записи и границы.'); } else { setStep(1); setSourceError('План открыт. Загрузите указанную запись и проверьте границы.'); }
    } catch (error) { setProjectError(error instanceof Error ? error.message : 'Не удалось прочитать JSON-план.'); }
  }

  function restoreTimeFields(saved: Record<string, unknown>, range: ClipRange) {
    if (saved.selected_id !== range.id) return;
    setStartText(restoredTimeText(saved.start_text, range.start_ms));
    setEndText(restoredTimeText(saved.end_text, range.end_ms));
  }

  function draftSnapshot() {
    return { workflow_version: 2, plan_imported: !source && recoveringDraft?.plan_imported === true, source_fingerprint: source?.fingerprint ?? recoveringDraft?.source_fingerprint, source_width: source?.width ?? recoveringDraft?.source_width, source_height: source?.height ?? recoveringDraft?.source_height, source_provider_video_id: source?.provider_video_id ?? recoveringDraft?.source_provider_video_id, media_unavailable: !source, timeline_span: span, view_center: viewCenter, simple_view: simpleView, source_id: source?.id ?? recoverableSource?.id, source_title: source?.title ?? recoverableSource?.title, source_duration_ms: source?.duration_ms ?? recoverableSource?.duration_ms, start_text: startText, end_text: endText, ranges, selected_id: selectedId, selected_range_ids: selectedRangeIds, output, job_id: job?.id, job_output_mode: joinedJob ? 'joined' : 'separate', job_range_numbers: jobRangeNumbers, job_ranges: jobCuts, prior_job_ids: priorJobReferences.current.map(value => value.id), prior_job_range_numbers: Object.fromEntries(priorJobReferences.current.map(value => [value.id, value.numbers])), step, current_ms: position.getSnapshot(), precision_open: precisionOpen, export_attempt: exportAttempt.current, export_attempt_range_numbers: exportAttempt.current ? exportAttemptNumbers.current : [] };
  }

  const saveDraft = useEffectEvent(() => {
    if (!sessionReady) return;
    void persistCurrentProject();
  });

  useEffect(() => {
    const writer = coalescedTask(saveDraft);
    draftWriter.current = writer;
    const unsubscribe = position.subscribe(() => writer.schedule());
    const onHidden = () => { if (document.hidden) writer.flush(); };
    window.addEventListener('pagehide', writer.flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      unsubscribe(); writer.flush(); draftWriter.current = null;
      window.removeEventListener('pagehide', writer.flush);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [position]);

  useEffect(() => { draftWriter.current?.schedule(300); }, [source, ranges, selectedId, selectedRangeIds, output, job?.id, joinedJob, jobRangeNumbers, jobCuts, priorJobs, sessionReady, step, precisionOpen, startText, endText, recoverableSource, span, viewCenter, simpleView]);

  useEffect(() => {
    if (!job || !activeJob(job) || cancelling) return;
    const id = job.id;
    let snapshot = JSON.stringify(job);
    const stop = startVisiblePolling({
      read: signal => api.job(id, signal),
      onResult: fresh => {
        const nextSnapshot = JSON.stringify(fresh);
        if (nextSnapshot !== snapshot) { snapshot = nextSnapshot; setJob(fresh); }
        if (source && fresh.items.some(item => item.error_code === 'source_expired')) void sourceUnavailable(source.id);
        setJobError(''); return activeJob(fresh);
      },
      delay: fresh => fresh.status === 'waiting_storage' ? 10000 : fresh.status === 'queued' ? 5000 : 1500,
      onError: error => {
        setJobError(errorMessage(error));
        if (error instanceof ApiError && (error.httpStatus === 404 || error.httpStatus === 410 || ['not_found', 'expired', 'session_required'].includes(error.code))) { setJob(null); return false; }
        return true;
      },
    });
    stopJobPolling.current = stop;
    return () => { stop(); if (stopJobPolling.current === stop) stopJobPolling.current = null; };
  }, [job?.id, job?.status, cancelling, pollRevision]);

  useEffect(() => () => sourceController.current?.abort(), []);
  useEffect(() => {
    if (!workspaceVisible) { setExportOpen(false); setAdvancedOutputOpen(false); setEditorToolsOpen(false); }
  }, [workspaceVisible]);

  useEffect(() => { if (job) setExportOpen(false); }, [job?.id]);
  useEffect(() => { if (jobError && workspaceVisible) setExportOpen(true); }, [jobError, workspaceVisible]);

  useEffect(() => { document.title = `${workspaceVisible ? source?.title : t(step === 4 ? 'Сохраните фрагменты' : 'Откройте видео')} · cutmyvideo`; }, [workspaceVisible, source?.title, step, locale]);

  useEffect(() => {
    if (step === 1) stopPreview();
    if ((previousStep.current === 1) !== (step === 1)) { stageHeading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
    previousStep.current = step;
  }, [step]);

  function goToStep(next: WorkbenchStep) {
    if (!sessionReady || submitting || mutationPending.current) return;
    if (next > 1 && !source && !(next === 4 && (job || retryOutput))) return;
    if (next === 4 && !exportRanges.length && !job && !retryOutput) return;
    if (next === 2 && !selected) return;
    if (source && selected && (next === 3 || next === 4)) {
      const range = validateFields(true);
      if (!range) { setStep(2); return; }
      setRanges(previous => previous.map(item => item.id === range.id ? range : item));
    }
    if (next === 3 && selected) setRevealId(selected.id);
    setStep(next);
  }

  function navigateHistory(requested: WorkflowRoute): WorkflowRoute | null {
    let next = requested.step;
    if (next > 1 && !source && !(next === 4 && (job || retryOutput))) next = 1;
    if (next === 2 && !selected) next = source ? 3 : 1;
    if (next === 4 && !exportRanges.length && !job && !retryOutput) next = source ? 3 : 1;
    if (next !== step) {
      if (sourceBusy || deletingSource || submitting) return null;
      if (step === 2 && source && selected) {
        const range = validateFields(true);
        if (!range) return null;
        setRanges(previous => previous.map(item => item.id === range.id ? range : item));
      }
      if (next === 3 && selected) setRevealId(selected.id);
      setStep(next);
    }
    setPanel(requested.panel);
    return { step: next, panel: requested.panel };
  }

  function changeBounds(start: number, end: number) {
    if (!selected) return;
    const updated = { ...selected, start_ms: start, end_ms: end };
    if (start !== selected.start_ms || end !== selected.end_ms) { rememberHistory(); setRanges(previous => previous.map(range => range.id === selected.id ? updated : range)); }
    setFields(updated);
    pendingBoundary.current = start !== selected.start_ms ? start : end;
    stopPreview();
  }

  function finishBoundaryChange() {
    finishHistory();
    if (pendingBoundary.current !== null) { const target = pendingBoundary.current; pendingBoundary.current = null; seek(target); }
  }

  function revealBoundary(ms: number) {
    if (ms < simpleView[0] || ms > simpleView[1] || ms >= view[0] && ms <= view[1]) return;
    setViewCenter(ms);
  }

  function changeTimelineView(next: [number, number]) {
    setSpan(next[1] - next[0]); setViewCenter((next[0] + next[1]) / 2);
  }

  function changeTimelineSection(start: number) {
    const range = validateFields(true); if (!range) return;
    const previous = normalizeTimelineSection(duration, range, simpleView);
    const moved = moveTimelineSection(duration, range, previous, start);
    const delta = moved.section[0] - previous[0];
    const reframed = previous[0] !== simpleView[0] || previous[1] !== simpleView[1];
    if (!delta && !reframed && range.start_ms === selected?.start_ms && range.end_ms === selected?.end_ms) return;
    changeBounds(moved.range[0], moved.range[1]);
    setSimpleView(moved.section); setViewCenter((reframed ? (range.start_ms + range.end_ms) / 2 : viewCenter) + delta);
  }

  function chooseTimelineScale(nextSpan: number) {
    if (!selected) return;
    // Explicit wider scales also make longer clips editable. Wheel zoom only
    // changes the viewport inside this section.
    const scale = Math.max(Math.min(1000, duration), Math.min(duration, Math.round(nextSpan)));
    const width = Math.min(duration, Math.max(scale, selected.end_ms - selected.start_ms));
    const fitted = zoomWindow(duration, (selected.start_ms + selected.end_ms) / 2, width);
    const start = Math.round(fitted[0]);
    const section: [number, number] = [start, start + width];
    setSimpleView(section); setSpan(scale); setViewCenter((selected.start_ms + selected.end_ms) / 2);
    setPrecisionOpen(true);
  }

  function validateFields(focus = false): ClipRange | null {
    if (!selected) return null;
    const start = parseTimecode(startText);
    const end = parseTimecode(endText);
    const error = validateRange(start, end, duration, limits.max_range_ms);
    setRangeError(error ?? '');
    if (error) {
      setPrecisionOpen(true);
      if (focus) window.requestAnimationFrame(() => { if (start === null || start < 0 || start >= duration) startField.current?.focus(); else endField.current?.focus(); });
      return null;
    }
    return { ...selected, start_ms: start!, end_ms: end! };
  }

  function commitFields(): boolean {
    const range = validateFields();
    if (range) {
      if (range.start_ms !== selected?.start_ms || range.end_ms !== selected?.end_ms) rememberHistory();
      setRanges(previous => previous.map(item => item.id === range.id ? range : item));
      if (range.start_ms !== selected?.start_ms || range.end_ms !== selected?.end_ms) {
        setSimpleView(normalizeTimelineSection(duration, range, simpleView));
        setViewCenter((range.start_ms + range.end_ms) / 2);
        player.current?.pause(); seek(range.start_ms !== selected?.start_ms ? range.start_ms : range.end_ms);
      }
    }
    return !!range;
  }

  function seek(ms: number) {
    pendingBoundary.current = null;
    const value = Math.max(0, Math.min(duration, Math.round(ms)));
    restoredPosition.current = null;
    stopPreview();
    position.set(value); player.current?.seek(value);
  }

  function marker(which: 'start' | 'end') {
    if (!selected) return;
    const [start, end] = markBounds(selected, position.getSnapshot(), which, duration);
    const error = validateRange(start, end, duration, limits.max_range_ms);
    if (error) { setRangeError(error); return; }
    changeBounds(start, end); seek(which === 'start' ? start : end); setViewCenter((start + end) / 2); setSimpleView(normalizeTimelineSection(duration, { ...selected, start_ms: start, end_ms: end }, simpleView));
  }

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!event.defaultPrevented && !event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && !document.querySelector('dialog[open]') && (event.code === 'KeyZ' || event.ctrlKey && event.code === 'KeyY') && !(event.target as HTMLElement).closest('input, textarea, [contenteditable]') && source && step !== 1) { event.preventDefault(); historyAction(event.code === 'KeyY' || event.shiftKey ? 'redo' : 'undo'); return; }
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
    if ((event.target as HTMLElement).closest('input, textarea, select, button, summary, a, video, [role="slider"], [contenteditable], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"]')) return;
    if (!workspaceVisible || !selected) return;
    if (event.code === 'KeyI') { event.preventDefault(); marker('start'); }
    if (event.code === 'KeyO') { event.preventDefault(); marker('end'); }
    if ((event.code === 'ArrowLeft' || event.code === 'ArrowRight') && playerAvailable) { event.preventDefault(); player.current?.pause(); seek(position.getSnapshot() + (event.code === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 100)); }
    if (event.code === 'KeyN' && !busy) { event.preventDefault(); addRange(); }
    if ((event.code === 'BracketLeft' || event.code === 'BracketRight') && !busy) { event.preventDefault(); pickAdjacent(event.code === 'BracketLeft' ? -1 : 1); }
    if (event.code === 'Space' && playerAvailable) { event.preventDefault(); player.current?.toggle(); }
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  async function openSource(file?: File, providedUrl?: string) {
    if (!sessionReady || sourceBusy || submitting || deletingSource || cancelling || mutationPending.current || sourceController.current) return;
    if ((source || recoverableSource) && !await persistCurrentProject()) return;
    if (!(recoverableSource && keepRecoveredCuts) && projectStore.current.projects.length >= maxProjects) { setProjectError('Слишком много проектов. Сохраните планы и удалите ненужные проекты.'); return; }
    setProjectError('');
    const candidateUrl = canonicalSourceUrl(providedUrl ?? url);
    if (!file && !candidateUrl) {
      setStep(1); setSourceError('Вставьте ссылку на видео с поддерживаемого сайта или публичную HTTPS-ссылку на файл.');
      document.getElementById('source-url')?.focus(); return;
    }
    const controller = new AbortController(); sourceController.current = controller;
    setSourceBusy(true); setUploadProgress(file ? { loaded: 0, total: file.size } : null); setSourceError(''); setNotice('');
    try {
      if (file) {
        const fileError = await validateVideo(file, limits.max_source_bytes);
        if (controller.signal.aborted) return;
        if (fileError) { setSourceError(fileError); setStep(1); return; }
      }
      const opened = file ? await api.upload(file, controller.signal, progress => { if (sourceController.current === controller && !controller.signal.aborted) setUploadProgress(progress); }) : await api.open(candidateUrl!, controller.signal);
      if (controller.signal.aborted) return;
      if (file && (!opened.width || !opened.height)) { setSourceError('В файле не найдено видео. Выберите файл с видеодорожкой.'); setStep(1); return; }
      if (!await activateSource(opened)) return;
      if (!file) setUrl(candidateUrl!);
      setNotice('Источник открыт. Укажите границы фрагмента.');
    } catch (error) {
      if (!controller.signal.aborted) setSourceError(errorMessage(error, 'source-create'));
    } finally { if (sourceController.current === controller) { sourceController.current = null; setSourceBusy(false); setUploadProgress(null); } }
  }

  async function activateSource(opened: Source) {
    if (opened.media_removed) { setSourceError('Источник больше недоступен. Фрагменты сохранены. Загрузите ту же запись или откройте её ссылку, чтобы продолжить.'); setStep(1); return false; }
    const recovered = recoverableSource && keepRecoveredCuts;
    if (recovered && ranges.some(range => range.end_ms > opened.duration_ms)) { setSourceError('Эта запись короче сохранённых фрагментов. Откройте исходную запись или отключите восстановление фрагментов.'); setStep(1); return false; }
    if (recovered && recoveringDraft && sourceMismatch({ ...recoveringDraft, ...(recoveringDraft.plan_imported ? { source_duration_ms: undefined } : {}) }, opened) && !window.confirm(t('Запись отличается от сохранённого проекта. Применить интервалы? Проверьте границы перед экспортом.'))) { setStep(1); return false; }
    draftWriter.current?.flush(); if ((source || recoverableSource) && !await persistCurrentProject()) return false;
    const prior = !recovered && projectStore.current.projects.find(project => project.draft.source_id === opened.id);
    const targetID = recovered ? activeProjectID.current ?? opened.id : prior ? prior.id : freshProjectID(opened.id);
    try {
      const targetRanges = recovered ? ranges : prior && Array.isArray(prior.draft.ranges) ? prior.draft.ranges : [newRange(opened.duration_ms, 0, limits)];
      const base = recovered ? draftSnapshot() : prior ? prior.draft : { ...draftSnapshot(), job_id: undefined, job_ranges: [], prior_job_ids: [], prior_job_range_numbers: {}, export_attempt: null, selected_id: (targetRanges[0] as ClipRange)?.id, selected_range_ids: targetRanges.map(range => (range as ClipRange).id), current_ms: 0, step: 2 };
      const stored = await saveProject(targetID, { ...base, source_id: opened.id, source_title: opened.title, source_duration_ms: opened.duration_ms, media_unavailable: false, ranges: targetRanges, output: recovered ? output : prior ? prior.draft.output : withoutSourceAudio(preferences.output) }, projectRevisions.current.get(targetID) ?? (prior as PersistedProject | undefined)?.revision ?? null);
      projectRevisions.current.set(targetID, stored.revision);
      projectStore.current = readProjects(); setProjects(projectStore.current);
    } catch (error) { setProjectError(error instanceof Error ? error.message : 'Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.'); setStep(1); return false; }
    setProjectError('');
    stopJobPolling.current?.(); stopJobPolling.current = null; player.current?.pause(); previewEnd.current = null;
    setJob(null); priorJobLoadGeneration.current++; priorJobReferences.current = []; setPriorJobs([]); setJobCuts([]); setJoinedJob(false); setJobRangeNumbers([]); setJobError('');
    if (prior) { activeProjectID.current = prior.id; projectRevisions.current.set(prior.id, (prior as PersistedProject).revision); setActiveProject(prior.id); restoreProject(prior.draft, opened); }
    else {
      if (!recovered) activeProjectID.current = targetID;
      const nextRanges = recovered ? ranges : [newRange(opened.duration_ms, 0, limits)];
      const range = nextRanges.find(range => range.id === selectedId) ?? nextRanges[0];
      setSource(opened); setRanges(nextRanges); setSelectedId(range?.id ?? ''); if (range) setFields(range);
      setSelectedRangeIds(recovered ? selectedRangeIds : range ? [range.id] : []); setRevealId(range?.id ?? '');
      if (recovered && recoveringDraft) { restoreProjectView(recoveringDraft, opened.duration_ms, range); const savedPosition = Number(recoveringDraft.current_ms ?? 0); position.set(Math.max(0, Math.min(opened.duration_ms, savedPosition))); restoredPosition.current = position.getSnapshot(); }
      else { position.set(0); restoredPosition.current = null; if (range) { setSimpleView(simpleRangeView(opened.duration_ms, range)); setViewCenter((range.start_ms + range.end_ms) / 2); } setSpan(Math.min(opened.duration_ms, preferences.timeline_span)); setOutput(withoutSourceAudio(preferences.output)); }
      setPrecisionOpen(!!recovered || opened.preview_kind === 'none' || (!opened.preview_url && !opened.embed_url));
      setRecoverableSource(null); setRecoveringDraft(null); setStep(range ? 2 : 3);
    }
    if (!prior) exportAttempt.current = null; setProjectConflict(null); setPreviewing(false); setPlayerAvailable(false); setAdvancedOutputOpen(false); refreshHistory(value => value + 1);
    return true;
  }

  async function reopenSource(previous: Source) {
    if (sourceBusy || deletingSource || submitting || cancelling || mutationPending.current) return;
    if (previous.id === source?.id) { goToStep(selected ? 2 : 3); return; }
    const savedProject = projectStore.current.projects.find(project => project.draft.source_id === previous.id);
    if (savedProject) { await openProject(savedProject); return; }
    if (sourceController.current) return;
    const controller = new AbortController(); sourceController.current = controller;
    setSourceBusy(true); setSourceError('');
    try {
      const fresh = await api.source(previous.id, controller.signal);
      if (!controller.signal.aborted && await activateSource(fresh)) setNotice('Источник открыт. Укажите границы фрагмента.');
    } catch (error) {
      if (!controller.signal.aborted) {
        if (previous.id === currentSourceID.current && error instanceof ApiError && (error.httpStatus === 410 || ['not_found', 'expired', 'source_expired', 'source_unavailable'].includes(error.code))) void sourceUnavailable(previous.id);
        else setSourceError(errorMessage(error));
      }
    }
    finally { if (sourceController.current === controller) { sourceController.current = null; setSourceBusy(false); } }
  }

  function timeFieldKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); if (commitFields()) event.currentTarget.blur(); }
    if (event.key === 'Escape' && selected) { event.preventDefault(); setFields(selected); }
  }

  function editTime(which: 'start' | 'end') {
    setPrecisionOpen(true);
    window.requestAnimationFrame(() => { const field = which === 'start' ? startField.current : endField.current; field?.focus(); field?.select(); });
  }

  function pickRange(range: ClipRange) {
    const committed = selected ? validateFields(true) : null;
    if (selected && !committed) return;
    if (committed) setRanges(previous => previous.map(item => item.id === committed.id ? committed : item));
    stopPreview(); seek(range.start_ms);
    setSelectedId(range.id); setFields(range); setViewCenter((range.start_ms + range.end_ms) / 2); setSimpleView(simpleRangeView(duration, range));
    setStep(2); setRevealId(range.id);
  }

  function pickAdjacent(direction: -1 | 1) {
    const committed = validateFields(true); if (!committed) return;
    const index = ranges.findIndex(range => range.id === selected?.id), next = ranges[index + direction];
    if (!next) return;
    setRanges(previous => previous.map(range => range.id === committed.id ? committed : range));
    pickRange(next);
  }

  function fitSelection() {
    if (!selected) return;
    setViewCenter((selected.start_ms + selected.end_ms) / 2);
    setSpan(Math.min(simpleView[1] - simpleView[0], Math.max(1000, (selected.end_ms - selected.start_ms) * 1.5)));
  }

  function addRange() {
    appendRange(true);
  }

  function addLibraryRange() {
    appendRange(false);
  }

  function appendRange(continueCurrent: boolean) {
    if (!source || ranges.length >= limits.max_ranges) return;
    const committed = selected ? validateFields(true) : null;
    if (selected && !committed) { setStep(2); return; }
    const playhead = position.getSnapshot();
    // Save-next follows the cut being edited. Adding from the library starts
    // at the playhead, even when the current cut covers the whole recording.
    const defaultLength = Math.min(30000, duration, limits.max_range_ms, limits.max_job_ms);
    const libraryStart = playhead >= duration - 100 ? Math.max(0, duration - defaultLength) : playhead;
    const nextStart = continueCurrent
      ? committed && playhead >= committed.start_ms && playhead <= committed.end_ms ? committed.end_ms : playhead
      : libraryStart;
    if (nextStart >= duration) { setRangeError('Видео закончилось. Перейдите к другому моменту на шкале.'); return; }
    rememberHistory();
    const range = newRange(duration, nextStart, limits);
    stopPreview(); seek(range.start_ms);
    setRanges(previous => [...previous.map(item => item.id === committed?.id ? committed! : item), range]);
    setSelectedRangeIds(previous => [...new Set([...previous, range.id])]);
    setSelectedId(range.id); setFields(range); setViewCenter((range.start_ms + range.end_ms) / 2); setSimpleView(simpleRangeView(duration, range));
    setRevealId(range.id); setStep(2);
    setNotice('Фрагмент добавлен. Настройте его границы.');
  }

  function removeSelected(ids: string[]) {
    stopPreview();
    rememberHistory();
    const remaining = removeRanges(ranges, ids);
    setRanges(remaining);
    setSelectedRangeIds(previous => previous.filter(id => remaining.some(range => range.id === id)));
    if (!remaining.some(range => range.id === selectedId)) {
      const active = remaining[0]; setSelectedId(active?.id ?? ''); setRevealId(active?.id ?? '');
      if (active) { setFields(active); setViewCenter((active.start_ms + active.end_ms) / 2); setSimpleView(simpleRangeView(duration, active)); }
      else { setStartText(''); setEndText(''); setRangeError(''); }
    }
    setNotice(ids.length > 1 ? 'Выбранные фрагменты удалены.' : 'Фрагмент удалён.');
  }

  function duplicateSelected() {
    const result = duplicateRanges(ranges, selectedRangeIds, () => crypto.randomUUID(), limits.max_ranges);
    if (!result) return;
    rememberHistory();
    setRanges(result.ranges); setSelectedRangeIds(previous => [...previous, ...result.addedIds]);
    setRevealId(result.addedIds.at(-1)!); setNotice('Выбранные фрагменты продублированы.');
  }

  function nudgeBoundary(which: 'start' | 'end', delta: number) {
    const range = validateFields(true); if (!range) return;
    const [minimum, maximum] = trimBoundaryLimits(which, range, simpleView, limits.max_range_ms);
    const value = Math.max(minimum, Math.min(maximum, (which === 'start' ? range.start_ms : range.end_ms) + delta));
    const start = which === 'start' ? value : range.start_ms;
    const end = which === 'end' ? value : range.end_ms;
    const error = validateRange(start, end, duration, limits.max_range_ms);
    if (error) { setRangeError(error); return; }
    changeBounds(start, end); seek(which === 'start' ? start : end); revealBoundary(which === 'start' ? start : end);
  }

  function revealPlayer() {
    const element = document.querySelector<HTMLElement>('.player-frame');
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > window.innerHeight) element.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  function audition(which: 'start' | 'end') {
    const range = validateFields(true); if (!range || !playerAvailable) return;
    stopPreview(); commitFields(); revealPlayer();
    const [start, end] = boundaryAudition(which === 'start' ? range.start_ms : range.end_ms, duration);
    player.current?.pause(); player.current?.seek(start);
    previewEnd.current = end; setPreviewing(true); player.current?.play();
  }

  function preview() {
    if (previewing) { stopPreview(); return; }
    const range = validateFields(true);
    if (!range || !playerAvailable) return;
    stopPreview(); commitFields(); revealPlayer(); player.current?.seek(range.start_ms); previewEnd.current = range.end_ms;
    setPreviewing(true); player.current?.play();
  }

  function previewSequence() {
    if (sequence.current) { stopPreview(); return; }
    const committed = selected ? validateFields(true) : null;
    if (selected && !committed || !source || !playerAvailable || !exportRanges.length) return;
    const cuts = ranges.map(range => range.id === committed?.id ? committed! : range).filter(range => selectedRangeIds.includes(range.id));
    setRanges(previous => previous.map(range => range.id === committed?.id ? committed! : range));
    stopPreview(); setCropOpen(false); revealPlayer();
    sequence.current = { ranges: cuts, index: 0, awaitingSeek: true };
    setSequenceIndex(0); setPreviewing(true); player.current?.seek(cuts[0].start_ms); player.current?.play();
  }

  async function exportClips(event: FormEvent) {
    event.preventDefault();
    const range = selected ? validateFields(true) : null;
    if (selected && !range) { setStep(2); return; }
    const committed = ranges.map(item => item.id === range?.id ? range! : item);
    await submitExport(committed.filter(item => selectedRangeIds.includes(item.id)), committed);
  }

  function retryRanges() {
    const candidates = unfinishedJobRanges(job, jobCuts.length ? jobCuts : joinedJob ? exportRanges : ranges, joinedJob);
    const current = candidates.map(candidate => ranges.find(range => range.id === candidate.id));
    return current.every(range => !!range) ? current as ClipRange[] : [];
  }

  async function retryUnfinished() {
    const included = retryRanges();
    if (!included.length) return;
    await submitExport(included, ranges, true);
  }

  async function submitExport(included: ClipRange[], committed: ClipRange[], selective = false) {
    if (!sessionReady || !source || busy || sourceBusy || mutationPending.current || !included.length || invalidAudio || incompatibleOutput) return;
    const includedDuration = included.reduce((total, item) => total + item.end_ms - item.start_ms, 0);
    if (included.length > limits.max_ranges || included.some(item => item.end_ms - item.start_ms > limits.max_range_ms) || includedDuration > limits.max_job_ms) { setJobError(exportLimitError || t('Общая длительность одного экспорта — до {limit}. Разделите фрагменты на несколько заданий.', { limit: durationLabel(limits.max_job_ms, locale) })); return; }
    mutationPending.current = true;
    setRanges(committed); setSubmitting(true); setJobError('');
    let resumePreparation: (() => void) | undefined;
    try {
      resumePreparation = await player.current?.holdBackgroundPreparation?.();
      // Recover an uncertain accepted request before starting another one. A
      // terminal retry has no pending identity and therefore gets a fresh key.
      const pending = recoverExportRequest(source.id, committed, output, exportAttempt.current);
      const requestedRanges = pending?.ranges ?? included;
      const requestedOutput = pending?.output ?? (preserveLocalQuality ? { ...output, quality: 'best' as const } : output);
      const requestedNumbers = requestedOutput.output_mode === 'joined' ? [1]
        : pending && exportAttemptNumbers.current.length === requestedRanges.length ? exportAttemptNumbers.current
        : requestedRanges.map(range => {
          const original = selective ? jobCuts.findIndex(cut => cut.id === range.id) : -1;
          const legacy = selective && original < 0 ? job?.items.findIndex(item => item.start_ms === range.start_ms && item.end_ms === range.end_ms && item.label === range.label) ?? -1 : -1;
          return original >= 0 ? jobRangeNumbers[original] ?? original + 1 : legacy >= 0 ? jobRangeNumbers[legacy] ?? legacy + 1 : committed.findIndex(cut => cut.id === range.id) + 1;
        });
      exportAttemptNumbers.current = requestedNumbers;
      const fingerprint = jobRequestBody(source.id, requestedRanges, requestedOutput);
      if (exportAttempt.current?.fingerprint !== fingerprint) exportAttempt.current = { fingerprint, key: crypto.randomUUID() };
      const priorResults = selective || pending ? priorJobs : [];
      const preceding = selective && job && job.items.some(item => item.artifact) && !priorResults.some(value => value.job.id === job.id)
        ? [...priorResults, { job, numbers: jobRangeNumbers }].slice(-32) : priorResults;
      const references = selective || pending ? new Map(priorJobReferences.current.map(value => [value.id, value])) : new Map<string, { id: string; numbers: number[] }>();
      for (const value of preceding) references.set(value.job.id, { id: value.job.id, numbers: value.numbers });
      priorJobReferences.current = [...references.values()].slice(-32);
      const preflight = { ...draftSnapshot(), ranges: committed, job_ranges: requestedRanges };
      if (!await persistCurrentProject(preflight)) return;
      setPriorJobs(current => priorJobReferences.current.flatMap(reference => {
        const value = preceding.find(value => value.job.id === reference.id) ?? current.find(value => value.job.id === reference.id);
        return value ? [{ ...value, numbers: reference.numbers }] : [];
      }));
      const created = await api.createJob(source.id, requestedRanges, requestedOutput, exportAttempt.current.key);
      exportAttempt.current = null;
      setJobRangeNumbers(requestedNumbers);
      setJobCuts(requestedRanges); setJoinedJob(requestedOutput.output_mode === 'joined'); setJob(created);
    }
    catch (error) {
      if (error instanceof ApiError && (error.httpStatus === 404 || error.httpStatus === 410 || ['expired', 'source_expired', 'source_unavailable'].includes(error.code))) void sourceUnavailable(source.id);
      setJobError(errorMessage(error, 'export'));
    }
    finally { resumePreparation?.(); mutationPending.current = false; setSubmitting(false); }
  }

  async function recoverExport() {
    const id = recoverableSource?.id, attempt = exportAttempt.current;
    if (!id || !attempt || busy || sourceBusy || mutationPending.current) return;
    const recovered = recoverExportRequest(id, ranges, output, attempt);
    if (!recovered) return;
    const recoveredOutput = recovered.output;
    mutationPending.current = true; setSubmitting(true); setJobError('');
    try {
      const previous = await api.createJob(id, recovered.ranges, recoveredOutput, attempt.key);
      exportAttempt.current = null; setJobCuts(recovered.ranges); setJob(previous); setJoinedJob(recoveredOutput.output_mode === 'joined');
      setJobRangeNumbers(recoveredOutput.output_mode === 'joined' ? [1] : exportAttemptNumbers.current.length === recovered.ranges.length ? exportAttemptNumbers.current : recovered.ranges.map(range => ranges.findIndex(value => value.id === range.id) + 1));
    } catch (error) {
      setJobError(errorMessage(error, 'export'));
      if (error instanceof ApiError && (error.httpStatus === 404 || error.httpStatus === 410)) { exportAttempt.current = null; setStep(1); }
    } finally { mutationPending.current = false; setSubmitting(false); }
  }

  async function cancelJob() {
    if (!job || cancelling || mutationPending.current) return;
    const sourceID = currentSourceID.current;
    mutationPending.current = true; stopJobPolling.current?.();
    setCancelling(true); setJobError('');
    try { const cancelled = await api.cancel(job.id); if (currentSourceID.current === sourceID) setJob(cancelled); }
    catch (error) { setJobError(errorMessage(error)); }
    finally { mutationPending.current = false; setCancelling(false); setPollRevision(value => value + 1); }
  }

  function clearDeletedSource() {
    player.current?.pause(); previewEnd.current = null; restoredPosition.current = null;
    void persistCurrentProject(); activeProjectID.current = null; try { setActiveProject(null); } catch { /* Existing work remains in the project. */ }
    exportAttempt.current = null; setSource(null); setRecoverableSource(null); setRecoveringDraft(null); setRanges([]); setSelectedId(''); setSelectedRangeIds([]);
    setJob(null); priorJobLoadGeneration.current++; priorJobReferences.current = []; setPriorJobs([]); setJobCuts([]); setJoinedJob(false); setJobRangeNumbers([]); setJobError(''); setStartText(''); setEndText(''); setRangeError('');
    setPreviewing(false); setPlayerAvailable(false); position.set(0); setStep(1);
    // Persist immediately so closing the page cannot resurrect deleted IDs.
    try { localStorage.removeItem(storageKey); } catch { /* Optional persistence. */ }
    setNotice('Видео и связанные файлы удалены.');
    window.requestAnimationFrame(() => document.getElementById('source-url')?.focus());
  }

  async function deleteSource() {
    if (!source || busy || sourceBusy || deletionPending.current) return;
    if (!window.confirm(t('Удалить это видео, все его задания и готовые файлы? Восстановить их будет нельзя.'))) return;
    const id = source.id;
    deletionPending.current = true; setDeletingSource(true); setSourceError('');
    try {
      await api.deleteSource(id); clearDeletedSource();
    } catch (error) {
      // A missing source also means a lost successful DELETE response is safe to retry.
      if (error instanceof ApiError && error.code === 'not_found') clearDeletedSource();
      else { setSourceError(errorMessage(error)); setStep(1); }
    } finally { deletionPending.current = false; setDeletingSource(false); }
  }

  function applyPreferences(value: Preferences) {
    savePreferences(value); setPreferences({ ...value, output: withoutSourceAudio(value.output) }); setOutput(previous => ({ ...withoutSourceAudio(value.output), ...(previous.audio_track !== undefined ? { audio_track: previous.audio_track } : {}), ...(previous.no_audio && value.output.format !== 'mp3' ? { no_audio: true } : {}), ...(previous.crop ? { crop: previous.crop } : {}), ...(previous.cleanup_source !== undefined ? { cleanup_source: previous.cleanup_source } : {}) }));
    setSpan(source ? Math.min(source.duration_ms, value.timeline_span) : value.timeline_span);
    if (selected) setViewCenter((selected.start_ms + selected.end_ms) / 2);
    setNotice('Настройки сохранены.');
  }

  useEffect(() => { setResultsOpen(false); }, [source?.id]);
  useEffect(() => { if (job) setResultsOpen(true); }, [job?.id]);
  const files = job?.items.filter(item => item.artifact) ?? [];
  useEffect(() => {
    const previous = previousJobState.current;
    previousJobState.current = job ? { id: job.id, status: job.status } : null;
    if (!job || !previous || previous.id !== job.id || !['queued', 'running', 'waiting_storage'].includes(previous.status) || activeJob(job) || !files.length || !workspaceVisible && step !== 4 || document.hidden || document.querySelector('dialog[open]')) return;
    if (workspaceVisible && document.activeElement?.closest('input, textarea, select, [contenteditable], [role=slider]')) return;
    const frame = window.requestAnimationFrame(() => {
      const heading = document.getElementById('results-heading');
      if (!workspaceVisible) heading?.closest('.results-panel')?.scrollIntoView({ block: 'start', behavior: 'instant' });
      if (!workspaceVisible || resultsOpen) heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [job?.id, job?.status]);
  const failedItems = job?.items.filter(item => item.status === 'failed') ?? [];
  const repeatExport = repeatsFailedExport(job, exportRanges);
  const unfinished = retryRanges();
  const resultFiles = [...priorJobs.flatMap(value => value.job.items.map((item, index) => ({ item, number: value.numbers[index] ?? index + 1 }))), ...(job?.items.map((item, index) => ({ item, number: jobRangeNumbers[index] ?? index + 1 })) ?? [])]
    .filter(value => value.item.artifact).filter((value, index, all) => all.findIndex(other => other.item.artifact?.id === value.item.artifact?.id) === index).sort((a, b) => a.number - b.number);
  const archiveJobID = job?.id ?? priorJobs.at(-1)?.job.id;
  const archiveURL = archiveJobID ? `/api/v1/jobs/${encodeURIComponent(archiveJobID)}/download.zip${priorJobs.length ? '?' + resultFiles.map(value => `artifact_id=${encodeURIComponent(value.item.artifact!.id)}`).join('&') : ''}` : undefined;
  const jobHeading = job?.status === 'failed' && files.length > 0 ? 'Часть фрагментов готова' : stageNames[job?.status === 'running' ? job.stage : job?.status ?? ''] ?? 'Обрабатываем фрагменты';
  const sourceProvider = providerName(source?.provider);
  const qualityLabel = source?.width && source?.height ? `${source.width} × ${source.height}` : null;

  const jobProgress = job && <section className={`job-status ${job.status}`} aria-label={t("Состояние экспорта")} aria-live="polite"><p className="job-history-label">{t("Последний экспорт")}</p><div className="job-status-heading">{activeJob(job) ? <span className="spinner" /> : <Icon name={job.status === 'succeeded' ? 'check' : 'file'} size={20} />}<h3>{t(jobHeading)}</h3></div><p>{jobDescription(job, t)}</p>{job.status === 'waiting_storage' && <RetentionNotice expiresAt={job.storage_wait_until} kind="wait" />}<ExportProgress job={job} /><p className="job-file-count">{t('Готово: {count} из {total}', { count: files.length, total: job.items.length })}</p>{failedItems.length > 0 && <div className="failed-items"><ul>{failedItems.map(item => <li key={item.id}><strong>{joinedJob && item.label === 'Joined result' ? t('Объединённый результат') : item.label || `${t('Фрагмент')} ${jobRangeNumbers[job.items.indexOf(item)] ?? job.items.indexOf(item) + 1}`}</strong><span>{t(exportFailureReason(item, job.message))}</span></li>)}</ul>{source && <p className="job-recovery-note">{t('Выбранные моменты сохранены. Настройки можно изменить перед повтором.')}</p>}</div>}{source && unfinished.length > 0 && <button type="button" className="button secondary retry-unfinished" disabled={busy || sourceBusy || invalidAudio || incompatibleOutput} onClick={() => void retryUnfinished()}>{t(joinedJob ? 'Повторить объединение' : 'Повторить неудавшиеся')}</button>}{activeJob(job) && <button type="button" className="button secondary cancel-button" disabled={cancelling} onClick={() => void cancelJob()}>{cancelling ? t("Отменяем…") : t("Отменить обработку")}</button>}{activeJob(job) && <button type="button" className="text-button background-source" onClick={() => goToStep(1)}>{t('Пока обрабатывается — открыть другое видео')}</button>}</section>;

  const resultsPanel = resultFiles.length > 0 && <section className="results-panel" aria-labelledby="results-heading"><div className="results-heading"><div><h2 id="results-heading" tabIndex={-1}>{t("Файлы последнего экспорта")}</h2><p>{t(resultFiles.some(value => value.item.artifact?.segments?.length) ? 'Скачайте объединённый файл. Порядок и границы фрагментов указаны ниже.' : "Скачайте каждый фрагмент отдельно.")}</p></div><span className="result-count">{countLabel(resultFiles.length, 'file', locale)}</span></div>{archiveURL && resultFiles.length > 1 && <a className="button secondary download-all" href={archiveURL} download><Icon name="download" size={17} />{t('Скачать всё ZIP')}</a>}<ul className="file-list">{resultFiles.map(({ item, number: itemNumber }) => {
        const artifact = item.artifact!;
        const adjusted = !artifact.segments?.length && (Math.abs(artifact.actual_start_ms - item.start_ms) > 100 || Math.abs(artifact.actual_end_ms - item.end_ms) > 100);
        return <li key={artifact.id}><span className="file-icon"><Icon name="file" size={23} /></span><div className="file-description"><h3>{artifact.segments?.length && item.label === 'Joined result' ? t('Объединённый результат') : item.label || `${t('Фрагмент')} ${itemNumber}`}</h3><p>{artifact.filename}</p><span>{formatBytes(artifact.size_bytes, locale)}<span className="meta-separator"> / </span>{formatTimecode(artifact.actual_start_ms, true)} — {formatTimecode(artifact.actual_end_ms, true)}</span><RetentionNotice expiresAt={artifact.expires_at} kind="artifact" />{adjusted && <p className="adjusted-note">{t("Фактические границы отличаются от выбранных.")}</p>}<ArtifactDetails artifact={artifact} /></div><a className="button secondary download-button" href={artifact.download_url} download={artifact.filename}><Icon name="download" size={17} />{t("Скачать")}</a></li>;
      })}</ul></section>;

  const exportPanel = source && <section className="export-panel" aria-labelledby="export-heading"><form onSubmit={exportClips}><div className="export-scroll">
    <div className="export-heading"><h2 id="export-heading">{t('Экспорт')}</h2><button type="button" className="text-button export-options-toggle" onClick={() => setAdvancedOutputOpen(true)} aria-haspopup="dialog">{t('Настройки экспорта')}<Icon name="chevron" size={15} /></button></div>
    <fieldset disabled={submitting || activeJob(job)}><legend className="sr-only">{t('Формат файла')}</legend>
            <div className="format-picker" role="group" aria-label={t("Формат файла")}><button type="button" className={output.format !== 'mp3' ? 'active' : ''} onClick={() => setOutput(previous => ({ ...previous, format: previous.format === 'mkv' ? 'mkv' : 'mp4' }))} aria-pressed={output.format !== 'mp3'}><strong>{output.format === 'mkv' ? 'MKV' : 'MP4'}</strong><span>{t("Видео")}</span></button><button type="button" disabled={output.no_audio} className={output.format === 'mp3' ? 'active' : ''} onClick={() => setOutput(previous => ({ ...previous, format: 'mp3', cut_mode: 'accurate', subtitle_mode: 'omit' }))} aria-pressed={output.format === 'mp3'}><strong>MP3</strong><span>{t("Аудио")}</span></button></div>
    </fieldset>
    <WorkspaceDialog open={advancedOutputOpen} onClose={() => setAdvancedOutputOpen(false)} title={t('Настройки экспорта')} className="export-settings-dialog">
      <fieldset disabled={submitting || activeJob(job)}><legend className="sr-only">{t('Настройки экспорта')}</legend>
            <div className="export-primary-fields">
              <div className="export-field"><label htmlFor="output-mode">{t('Результат нарезки')}</label><SelectControl id="output-mode" value={output.output_mode ?? 'separate'} label={t('Результат нарезки')} describedBy="output-mode-hint" onChange={value => setOutput(previous => ({ ...previous, output_mode: value as OutputSettings['output_mode'] }))} options={[{ value: 'separate', label: t('Отдельные файлы') }, { value: 'joined', label: t('Один объединённый файл') }]} /><p id="output-mode-hint" className="field-hint">{t(output.output_mode === 'joined' ? 'Фрагменты соединятся в порядке выбранного списка, без промежутков между ними.' : 'Каждый выбранный фрагмент станет отдельным файлом.')}</p></div>
              <AudioTrackSelector id="audio-track-export" output={output} tracks={tracks} loading={tracksLoading} error={tracksError} onChange={changeAudio} onRetry={() => setTrackRevision(value => value + 1)} />
              {output.no_audio && <p className="field-hint">{t('Чтобы сохранить MP3, выберите аудиодорожку.')}</p>}
            </div>
            {output.format === 'mp4' && totalDuration >= 10 * 60 * 1000 && <div className="long-export-choice"><strong>{t(output.cut_mode === 'copy' ? 'Быстрый экспорт включён' : 'Длинную запись можно сохранить быстрее')}</strong><p>{t(output.cut_mode === 'copy' ? 'Сохраним видео без перекодирования. Начало может сдвинуться до ближайшего ключевого кадра.' : 'Без перекодирования сохраняется качество записи и сокращается время обработки. Для точных границ оставьте текущий режим.')}</p>{output.cut_mode === 'accurate' && <button type="button" className="button secondary" onClick={() => setOutput(previous => ({ ...previous, cut_mode: 'copy' }))}>{t('Ускорить без перекодирования')}</button>}</div>}
      <div className="export-option-fields">
            {output.format !== 'mp3' && <div className="export-field"><label htmlFor="quality">{t("Качество видео")}</label><SelectControl id="quality" value={output.quality} disabled={preserveLocalQuality} onChange={value => setOutput(previous => ({ ...previous, quality: value as OutputSettings['quality'] }))} options={preserveLocalQuality ? [{ value: output.quality, label: t('Исходное качество') }] : [{ value: '1080p', label: t('До 1080p') }, { value: '720p', label: t('До 720p') }, { value: 'best', label: t('Лучшее доступное') }]} /><p className="field-hint">{t(preserveLocalQuality ? 'Видео сохраняется без перекодирования, в качестве исходного файла.' : 'Качество выше исходного не создаётся.')}</p></div>}
            <div className="export-field"><label htmlFor="cut-mode">{t("Границы и качество")}</label><SelectControl id="cut-mode" value={output.cut_mode} disabled={output.format === 'mp3'} onChange={value => setOutput(previous => ({ ...previous, cut_mode: value as OutputSettings['cut_mode'], ...(value === 'accurate' ? { subtitle_mode: 'omit' as const } : {}) }))} options={[{ value: 'accurate', label: t('Точные границы'), disabled: output.format === 'mkv' }, { value: 'copy', label: t('Исходное качество') }]} /><p className="mode-hint">{output.format === 'mp3' ? t("Аудио будет преобразовано в MP3.") : output.cut_mode === 'accurate' ? t("Видео будет перекодировано. Начало и конец — по выбранным таймкодам.") : t(output.format === 'mkv' ? 'Без перекодирования. Границы могут сдвинуться; сохраняются совместимые потоки MKV.' : 'Без перекодирования. Границы могут сдвинуться; некоторые кодеки несовместимы с MP4.')}</p></div>
            {(videoCopy || output.format === 'mkv') && <div className="export-field"><label htmlFor="copy-container">{t('Контейнер исходного качества')}</label><SelectControl id="copy-container" value={output.format} label={t('Контейнер исходного качества')} onChange={value => setOutput(previous => ({ ...previous, format: value as OutputSettings['format'] }))} options={[{ value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV', disabled: !videoCopy }]} /><p className="field-hint">{t('MKV доступен при копировании. Чтобы выбрать точные границы, переключитесь на MP4.')}</p></div>}
            {(preserveLocalQuality && subtitleTracks.length > 0 || output.subtitle_mode === 'preserve') && <div className="export-field"><label htmlFor="subtitle-mode">{t('Субтитры')}</label><SelectControl id="subtitle-mode" value={output.subtitle_mode ?? 'omit'} label={t('Субтитры')} onChange={value => setOutput(previous => ({ ...previous, subtitle_mode: value as OutputSettings['subtitle_mode'] }))} options={[{ value: 'omit', label: t('Исключить субтитры') }, { value: 'preserve', label: t('Сохранить текстовые субтитры'), disabled: !canPreserveSubtitles }]} /><p className="field-hint">{t(canPreserveSubtitles ? 'Текстовые субтитры сохранятся со временем каждого фрагмента. Оформление будет упрощено.' : source.kind === 'platform' || source.kind === 'youtube' ? 'Для сохранения субтитров площадки загрузите исходный файл и выберите копирование.' : 'Есть неподдерживаемые субтитры. ASS, SSA и графические субтитры сохранить пока нельзя.')}</p></div>}
      </div>
          <div className="export-track-summary" aria-label={t('Дорожки результата')}>
            <p>{t(output.format === 'mp3' ? 'Видео будет исключено.' : 'Сохраним одну видеодорожку.')}{' '}{output.no_audio ? t('Звук будет исключён.') : selectedAudio ? trackLabel(selectedAudio, t) : tracks !== null && audioTracks.length === 0 ? t('В источнике нет звука.') : t('Сохраним аудиодорожку по умолчанию.')}</p>
            {audioTracks.length > 1 && <p>{t('Остальные аудиодорожки будут исключены.')}</p>}
            <p>{t(output.subtitle_mode === 'preserve' ? 'Сохраним совместимые текстовые субтитры; время будет сдвинуто к началу фрагмента.' : 'Субтитры, вложения и служебные дорожки будут исключены.')}</p>
            {tracks !== null && <details className="artifact-details"><summary>{t('Все дорожки источника')}</summary><ul>{tracks.map(track => <li key={track.index}><strong>{t(includedTracks.has(track.index) ? 'Включена' : 'Исключена')}</strong>{': '}{trackLabel(track, t)}</li>)}</ul></details>}
          </div>
          <label className="source-cleanup-choice"><input type="checkbox" checked={output.cleanup_source !== false} disabled={busy} onChange={event => setOutput(previous => ({ ...previous, cleanup_source: event.target.checked }))} />{t('Удалить исходник после экспорта')}</label>
          <p className="field-hint source-cleanup-hint">{t('Готовые клипы и проект сохранятся. Для новой нарезки удалённую запись понадобится открыть заново.')}</p>
          <p className="field-hint export-limits">{t('Один фрагмент — до {range}; весь экспорт — до {total}.', { range: durationLabel(limits.max_range_ms, locale), total: durationLabel(limits.max_job_ms, locale) })}</p>{limits.max_output_bytes && <p className="field-hint export-limits">{t('Готовый файл — до {limit}.', { limit: formatBytes(limits.max_output_bytes, locale) })}</p>}      </fieldset>
      <button type="button" className="button secondary" onClick={() => setAdvancedOutputOpen(false)}>{t('Готово')}</button>
    </WorkspaceDialog>
          {invalidAudio && <p className="error-message" role="alert">{t('Выбранная аудиодорожка недоступна. Выберите другую дорожку.')}</p>}
          {!incompatibleCrop && incompatibleOutput && <p className="error-message" role="alert">{t('Эти настройки требуют исходного файла и режима копирования. Выберите MP4 и исключите субтитры либо загрузите исходный файл.')}</p>}
          {incompatibleCrop && <div className="crop-export-conflict" role="alert"><p>{t('Выбранный кадр требует точного MP4. Выберите совместимый режим или сбросьте кадр.')}</p>
            <button type="button" className="text-button" onClick={() => { rememberHistory(); setOutput(previous => ({ ...previous, format: 'mp4', cut_mode: 'accurate', subtitle_mode: 'omit' })); }}>{t('Выбрать точный MP4')}</button>
            <button type="button" className="text-button" onClick={() => { rememberHistory(); setOutput(previous => ({ ...previous, crop: undefined })); }}>{t('Сбросить кадр')}</button></div>}
          {videoCopy && <p className="copy-boundary-warning" role="note">{t('Копирование сохраняет исходное качество. Начало может сдвинуться к ключевому кадру; фактические границы будут указаны у готового файла.')}</p>}
    {exportLimitError && <p className="error-message" role="alert">{exportLimitError}</p>}
    <dl className="export-settings-summary"><div><dt>{t(output.format === 'mp3' ? 'Формат файла' : 'Качество видео')}</dt><dd>{output.format === 'mp3' ? 'MP3' : t(preserveLocalQuality ? 'Исходное качество' : output.quality === 'best' ? 'Лучшее доступное' : output.quality === '720p' ? 'До 720p' : 'До 1080p')}</dd></div><div><dt>{t('Результат нарезки')}</dt><dd>{t(output.output_mode === 'joined' ? 'Один объединённый файл' : 'Отдельные файлы')}</dd></div></dl>
</div><div className="export-actions"><div className="export-summary"><span>{source ? countLabel(exportRanges.length, 'clip', locale) : t("Фрагменты не выбраны")}</span>{source && <strong>{durationLabel(totalDuration, locale)}</strong>}</div>
          <button className="button primary export-submit" type="submit" disabled={!sessionReady || !source || !exportRanges.length || busy || sourceBusy || invalidDraft || !!exportLimitError || invalidAudio || incompatibleOutput}>{submitting ? <><span className="spinner" />{t("Создаём задание…")}</> : activeJob(job) ? <><span className="spinner" />{t("Идёт обработка…")}</> : <><Icon name="cut" size={18} />{repeatExport ? t('Повторить экспорт') : exportRanges.length > 1 ? t("Вырезать фрагменты") : t("Вырезать фрагмент")}</>}</button>
    <p className="export-empty-hint">{output.output_mode === 'joined' || exportRanges.length === 1 ? t('один файл') : t('отдельные файлы')} {output.format.toUpperCase()}{output.no_audio ? ` · ${t('Без звука')}` : ''}{output.crop ? ` · ${t('Кадрирование')}` : ''}</p>
    {output.cleanup_source !== false && <p className="export-source-notice">{t('Исходник удалится после экспорта.')}</p>}
    {jobError && <p className="error-message" role="alert">{t(jobError)}</p>}
  </div></form></section>;

  return <div className={`app-shell${workspaceVisible ? ` workspace-shell${desktopWorkspace ? ' editor-docked' : ''}` : step === 1 ? ' source-shell' : ''}`}>
    <a className="skip-link" href="#editor">{t('К выбору фрагмента')}</a>
    <header className="site-header"><div className="header-inner">
      <a className="brand" href="/" aria-label={t('cutmyvideo — главная')}><span className="brand-symbol"><Icon name="cut" size={20} /></span><span>cutmy<span className="brand-suffix">video</span></span></a>
      <WorkspaceNav panel={panel} onOpen={setPanel} onClose={navigation.closePanel} collectionDisabled={sourceBusy || submitting || cancelling} onCollectionOpen={onCollectionOpen ? () => { draftWriter.current?.flush(); void persistCurrentProject().then(saved => { if (saved) onCollectionOpen(); }); } : undefined} preferences={preferences} onSave={applyPreferences} busy={!sessionReady || sourceBusy || busy} onExample={value => { setUrl(value); setStep(1); void openSource(undefined, value); }} />
      <div className="header-actions"><LanguageSwitch /><ThemeToggle /></div>
    </div></header>
    <main id="editor" data-bootstrap-state={sessionLoading ? 'loading' : sessionReady ? 'ready' : 'error'} aria-busy={sessionLoading} className={`stage-page stage-${step}${workspaceVisible ? ' workspace-page' : ''}`}>
      <div className="page-heading"><div><h1 ref={stageHeading} tabIndex={-1} className={workspaceVisible && desktopWorkspace ? 'source-title' : undefined} title={workspaceVisible ? [source?.title, qualityLabel, formatTimecode(duration)].filter(Boolean).join(' · ') : undefined}><span>{workspaceVisible ? source?.title : t(step === 4 ? 'Сохраните фрагменты' : 'Откройте видео')}</span></h1><p>{t(workspaceVisible ? 'Выберите нужный момент и сохраните его отдельным файлом.' : 'Ссылка на запись или видеофайл с вашего устройства.')}</p></div>
        {workspaceVisible ? <div className="workspace-heading-actions"><button type="button" className="button primary workspace-export-toggle" onClick={() => setExportOpen(true)} aria-haspopup="dialog"><Icon name="download" size={17} />{t('Экспорт')}</button><div className="edit-history-actions" role="group" aria-label={t('История изменений')}><button type="button" className="icon-button" aria-label={t('Отменить изменение')} title={t('Отменить изменение')} disabled={!currentHistory().past.length || busy || sourceBusy} onClick={() => historyAction('undo')}><Icon name="undo" size={19} /></button><button type="button" className="icon-button" aria-label={t('Повторить изменение')} title={t('Повторить изменение')} disabled={!currentHistory().future.length || busy || sourceBusy} onClick={() => historyAction('redo')}><Icon name="redo" size={19} /></button></div><button className="text-button change-source" type="button" disabled={!sessionReady || submitting} onClick={() => goToStep(1)}><Icon name="link" size={17} />{t('Другое видео')}</button></div>
          : source ? <button className="button secondary return-to-editor" type="button" disabled={!sessionReady} onClick={() => goToStep(selected ? 2 : 3)}>{t('Вернуться к редактированию')}</button> : (job || retryOutput) && <button className="button secondary return-to-results" type="button" disabled={!sessionReady} onClick={() => goToStep(4)}>{t('Вернуться к скачиванию')}</button>}
      </div>
      {recoverableSource && step === 1 && <section className="draft-recovery" aria-labelledby="draft-recovery-heading"><h2 id="draft-recovery-heading">{t('Фрагменты сохранены')}</h2>{recoverableSource.title && <p>{recoverableSource.title}</p>}<p>{t('Загрузите ту же запись или откройте её ссылку. Границы, названия и настройки экспорта восстановятся.')}</p><ol>{ranges.map(range => <li key={range.id}><strong>{range.label || t('Фрагмент')}</strong><span>{formatTimecode(range.start_ms, true)} — {formatTimecode(range.end_ms, true)}</span></li>)}</ol><label><input type="checkbox" checked={keepRecoveredCuts} onChange={event => setKeepRecoveredCuts(event.target.checked)} />{t('Восстановить фрагменты в открываемом видео')}</label></section>}
      {step === 1 && <SourceChooser url={url} onUrl={value => { setUrl(value); setSourceError(''); }} onOpen={() => void openSource()} onFile={file => void openSource(file)} busy={sourceBusy} progress={uploadProgress} maximumBytes={limits.max_source_bytes} blocked={deletingSource} processing={submitting || cancelling} ready={sessionReady} error={sourceError} onCancel={() => { sourceController.current?.abort(); sourceController.current = null; setSourceBusy(false); setUploadProgress(null); }} onReconnect={() => { setSourceError(''); setSessionAttempt(n => n + 1); }} />}
      {step === 1 && sessionReady && <ProjectLibrary projects={projectStore.current.projects} activeID={activeProjectID.current} disabled={sourceBusy || submitting || cancelling || deletingSource} canExport={exportRanges.length > 0} onOpen={value => void openProject(value)} onDelete={id => void deleteProject(id)} onExport={downloadPlan} onImport={file => void loadPlan(file)} />}
      {projectError && <div className="project-storage-message"><p className="error-message" role="alert">{t(projectError)}</p>{projectConflict && <div className="project-conflict-actions"><button type="button" className="button secondary" disabled={sourceBusy || submitting} onClick={() => void saveProjectCopy()}>{t('Сохранить мои изменения как копию')}</button>{!projectConflict.deleted && <button type="button" className="text-button" disabled={sourceBusy || submitting} onClick={() => void reloadProjectVersion()}>{t('Открыть сохранённую версию')}</button>}</div>}</div>}
      {step === 1 && sessionReady && <SourceLibrary currentID={source?.id} disabled={sourceBusy || submitting || cancelling || deletingSource} currentBusy={busy} onBusy={setDeletingSource} onOpen={value => void reopenSource(value)} onDeleted={id => { if (id === currentSourceID.current) clearDeletedSource(); else setNotice('Видео и связанные файлы удалены.'); }} />}
      {sessionReady && (step === 1 || step === 4 && !source) && <JobLibrary refreshKey={job?.id + ":" + job?.status} initiallyOpen={step === 1 && activeJob(job)} />}
      {source && step === 1 && <section className="source-retention" aria-label={t('Хранение видео')}><RetentionNotice expiresAt={source.expires_at} blocked={source.retention_blocked} kind="source" /><button type="button" className="text-button danger-button" disabled={busy || sourceBusy} onClick={() => void deleteSource()}>{deletingSource ? t('Удаляем…') : t('Удалить видео и файлы')}</button></section>}
      {source && <div className="editor-workspace" hidden={!workspaceVisible}><section className="moments-stage" aria-label={t('Выбор одного момента')}>
        <div className="editing-panel">
          {!desktopWorkspace && <div className="media-heading"><div className="source-title"><Icon name="file" size={18} /><span title={source.title}>{source.title}</span>{sourceProvider && <span className="source-provider">{t(sourceProvider)}</span>}</div><span className="source-meta">{qualityLabel && <>{qualityLabel}<span className="meta-separator"> / </span></>}{formatTimecode(duration)}</span></div>}
          <div className="moment-layout">
          <Player ref={player} source={source} initialPosition={position.getSnapshot()} audioTrack={previewAudioTrack} noAudio={output.no_audio} forceWindow={(cropOpen || !!output.crop) && !source.preview_url} onGeometry={mediaGeometry} active={workspaceVisible} onAvailable={playerAvailability} onTime={playbackPosition} onSourceUnavailable={sourceUnavailable} />
          {output.crop && !cropOpen && cropContainer && <CropPreview crop={output.crop} container={cropContainer} />}
          {selected && <div className="moment-controls">
            <div className="moment-mobile-markers">
              {(['start', 'end'] as const).map(which => <button key={which} className="marker-button" type="button" disabled={!playerAvailable} aria-label={t(which === 'start' ? 'Начало по позиции плеера' : 'Конец по позиции плеера')} onClick={() => marker(which)}><span className="marker-bracket">{which === 'start' ? '[' : ']'}</span><span className="marker-text">{t(which === 'start' ? 'Начало здесь' : 'Конец здесь')}</span><kbd>{which === 'start' ? 'I' : 'O'}</kbd></button>)}
            </div>
            <div className="trim-heading"><div><h2>{t('Обрезка фрагмента')}</h2><p>{selected.label || t('Фрагмент {index}', { index: ranges.findIndex(range => range.id === selected.id) + 1 })}</p></div><span className="trim-instruction">{t('Потяните за края выделения или задайте время.')}</span></div>
            <div className="moment-boundaries"><div><label htmlFor="range-start">{t('Начало')}</label><button type="button" className="time-value" hidden={precisionOpen} aria-label={t('Изменить время начала: {time}', { time: displayTimecode(selected.start_ms) })} onClick={() => editTime('start')}>{displayTimecode(selected.start_ms)}<Icon name="edit" size={14} /></button><input ref={startField} id="range-start" className="time-input" hidden={!precisionOpen} type="text" inputMode="text" enterKeyHint="done" autoComplete="off" autoCapitalize="none" value={startText} onChange={event => { setStartText(event.target.value); setRangeError(''); }} onBlur={commitFields} onKeyDown={timeFieldKey} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'range-error' : 'time-hint'} spellCheck={false} /><button className="marker-button" type="button" disabled={!playerAvailable} aria-label={t('Начало по позиции плеера')} onClick={() => marker('start')}><span className="marker-bracket">[</span><span className="marker-text">{t('Начало здесь')}</span><kbd>I</kbd></button></div><div><label htmlFor="range-end">{t('Конец')}</label><button type="button" className="time-value" hidden={precisionOpen} aria-label={t('Изменить время конца: {time}', { time: displayTimecode(selected.end_ms) })} onClick={() => editTime('end')}>{displayTimecode(selected.end_ms)}<Icon name="edit" size={14} /></button><input ref={endField} id="range-end" className="time-input" hidden={!precisionOpen} type="text" inputMode="text" enterKeyHint="done" autoComplete="off" autoCapitalize="none" value={endText} onChange={event => { setEndText(event.target.value); setRangeError(''); }} onBlur={commitFields} onKeyDown={timeFieldKey} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'range-error' : 'time-hint'} spellCheck={false} /><button className="marker-button" type="button" disabled={!playerAvailable} aria-label={t('Конец по позиции плеера')} onClick={() => marker('end')}><span className="marker-bracket">]</span><span className="marker-text">{t('Конец здесь')}</span><kbd>O</kbd></button></div><div className="moment-duration"><span>{t('Длительность')}</span><strong>{durationLabel(selected.end_ms - selected.start_ms, locale)}</strong></div></div>
            <Timeline compact toolsContainer={timelineTools} duration={duration} position={position} ranges={ranges} selected={selected} section={simpleView} view={view} maximumRange={limits.max_range_ms} showOverview={precisionOpen} onSection={changeTimelineSection} onView={changeTimelineView} onSeek={seek} onRange={changeBounds} onReveal={ms => { revealBoundary(ms); seek(ms); }} onBeginChange={beginHistory} onEndChange={finishBoundaryChange} audioTrack={previewAudioTrack} noAudio={output.no_audio} sourceID={source.id} active={workspaceVisible} />
            <div className="workspace-toolstrip"><div className="timeline-tools" ref={setTimelineTools} /><div className="moment-preview"><button className="button secondary" type="button" disabled={!playerAvailable} aria-label={t(previewing ? 'Остановить просмотр' : 'Посмотреть фрагмент')} title={t(previewing ? 'Остановить просмотр' : 'Посмотреть фрагмент')} onClick={preview}><Icon name={previewing ? 'pause' : 'play'} size={17} /><span className="preview-button-label">{previewing ? t('Остановить просмотр') : t('Посмотреть фрагмент')}</span></button><button className="text-button precision-toggle" type="button" aria-expanded={precisionOpen} aria-controls="range-start range-end precision-controls" onClick={() => { if (precisionOpen && invalidDraft) { validateFields(true); return; } setPrecisionOpen(!precisionOpen); }}>{t('Точное время и шкала')}<Icon name="chevron" size={15} style={{ transform: precisionOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }} /></button></div>
            <CropEditor key={source.id} value={output.crop} onChange={crop => setOutput(previous => ({ ...previous, crop }))}
              displayWidth={displayGeometry?.id === source.id ? displayGeometry.width : 0} displayHeight={displayGeometry?.id === source.id ? displayGeometry.height : 0}
              locale={locale} disabled={busy || output.format !== 'mp4' || output.cut_mode !== 'accurate'} previewContainer={cropContainer}
              onBeginChange={beginHistory} onEndChange={finishHistory} onOpenChange={setCropOpen} />
            <button type="button" className="text-button editor-tools-toggle" onClick={() => setEditorToolsOpen(true)} aria-haspopup="dialog">{t('Инструменты')}<Icon name="chevron" size={15} /></button>
            {(exportRanges.length > 1 || sequenceIndex !== null) && <div className="sequence-preview"><button className="text-button" type="button" disabled={!playerAvailable || invalidDraft} onClick={previewSequence} aria-label={t(sequenceIndex !== null ? 'Остановить подборку' : 'Посмотреть подборку')} title={t(sequenceIndex !== null ? 'Остановить подборку' : 'Посмотреть подборку')}><Icon name={sequenceIndex !== null ? 'pause' : 'play'} size={16} /><span className="sequence-label">{t(sequenceIndex !== null ? 'Остановить подборку' : 'Посмотреть подборку')}</span></button>{sequenceIndex !== null && <span role="status">{t('Сейчас: {name}', { name: sequence.current?.ranges[sequenceIndex]?.label || t('Фрагмент {index}', { index: ranges.findIndex(range => range.id === sequence.current?.ranges[sequenceIndex]?.id) + 1 }) })}</span>}</div>}</div>
            <WorkspaceDialog open={editorToolsOpen} onClose={() => setEditorToolsOpen(false)} title={t('Инструменты')}>
            {videoCopy && <p className="field-hint">{t('Проверяем выбранные моменты. При копировании фактические границы могут сдвинуться к ключевым кадрам.')}</p>}
            <div className="moment-selection-tools"><span>{t('Фрагмент до {limit}', { limit: durationLabel(limits.max_range_ms, locale) })}</span>{duration <= Math.min(limits.max_range_ms, limits.max_job_ms) && <button type="button" className="text-button" disabled={busy} onClick={() => { changeBounds(0, duration); setSimpleView([0, duration]); setSpan(duration); setViewCenter(duration / 2); }}>{t('Выбрать всё видео')}</button>}</div>
            <div className="boundary-audition" role="group" aria-label={t('Проверить границы')}><button type="button" className="text-button" disabled={!playerAvailable} onClick={() => { setEditorToolsOpen(false); audition('start'); }}><Icon name="play" size={13} />{t('Проверить начало')}</button><button type="button" className="text-button" disabled={!playerAvailable} onClick={() => { setEditorToolsOpen(false); audition('end'); }}><Icon name="play" size={13} />{t('Проверить конец')}</button><span>{t('По 1,5 с до и после границы')}</span></div>
            <div id="precision-controls" className="precision-controls">
              <p id="time-hint" className="field-hint">{t('Часы:минуты:секунды. Можно ввести 83:10 или 01:23:10.250.')}</p>
              <div className="boundary-steps">{(['start', 'end'] as const).map(which => <div key={which} role="group" aria-label={t(which === 'start' ? 'Сдвиг начала' : 'Сдвиг конца')}><span>{t(which === 'start' ? 'Начало' : 'Конец')}</span><button type="button" aria-label={t(which === 'start' ? 'Начало на 0,1 с раньше' : 'Конец на 0,1 с раньше')} onClick={() => nudgeBoundary(which, -100)}>{locale === 'en' ? '−0.1' : '−0,1'} {t('с')}</button><button type="button" aria-label={t(which === 'start' ? 'Начало на 0,1 с позже' : 'Конец на 0,1 с позже')} onClick={() => nudgeBoundary(which, 100)}>{locale === 'en' ? '+0.1' : '+0,1'} {t('с')}</button></div>)}</div><div className="precision-zoom"><label htmlFor="zoom">{t('Масштаб шкалы')}</label><div className="zoom-controls"><button type="button" className="icon-button" aria-label={t('Предыдущий участок шкалы')} disabled={view[0] <= simpleView[0]} onClick={() => setViewCenter(viewCenter - (view[1] - view[0]) / 2)}><Icon name="chevron" size={16} style={{ transform: 'rotate(180deg)' }} /></button><SelectControl id="zoom" value={String(view[1] - view[0])} label={t('Масштаб шкалы')} onChange={value => chooseTimelineScale(Number(value))} options={zoomOptions.map(value => ({ value: String(value), label: value === duration ? t('Всё видео') : value === 300000 ? t('5 минут') : value === 60000 ? t('1 минута') : value === 10000 ? t('10 секунд') : durationLabel(value, locale) }))} /><button type="button" className="icon-button" aria-label={t('Следующий участок шкалы')} disabled={view[1] >= simpleView[1]} onClick={() => setViewCenter(viewCenter + (view[1] - view[0]) / 2)}><Icon name="chevron" size={16} /></button></div><button className="text-button" type="button" onClick={fitSelection}>{t('Показать границы')}</button></div>
            </div>
              <button className="text-button" type="button" onClick={() => setShowShortcuts(!showShortcuts)} aria-expanded={showShortcuts}>{t('Горячие клавиши')}</button>
              {showShortcuts && <div className="shortcut-guide"><span><kbd>I</kbd>{t('начало по позиции плеера')}</span><span><kbd>O</kbd>{t('конец')}</span><span><kbd>N</kbd>{t('сохранить и добавить следующий')}</span><span><kbd>[</kbd><kbd>]</kbd>{t('предыдущий / следующий фрагмент')}</span><span><kbd>{t('Пробел')}</kbd>{t('пауза / воспроизведение')}</span><p>{t('Клавиши I, O и пробел работают вне полей ввода. В плеере действуют его собственные клавиши.')}</p></div>}
            </WorkspaceDialog>
            {rangeError && <p id="range-error" className="error-message" role="alert">{rangeError === 'Фрагмент превышает лимит сервиса. Сократите его.' ? t('Один фрагмент может длиться до {limit}.', { limit: durationLabel(limits.max_range_ms, locale) }) : t(rangeError)}</p>}
          </div>}
          </div>
        </div>
        {!selected && <div className="workspace-empty-editor"><p>{t('Добавьте момент, который хотите сохранить.')}</p></div>}
      </section><aside className="workspace-sidebar" aria-label={t('Фрагменты и экспорт')}>
        {(job || resultFiles.length > 0) && <div className="workspace-collection-tabs" role="tablist" aria-label={t('Фрагменты и файлы')}><button id="clips-tab" type="button" role="tab" aria-selected={!resultsOpen} aria-controls="workspace-clips" tabIndex={resultsOpen ? -1 : 0} onClick={() => setResultsOpen(false)} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'End') { event.preventDefault(); setResultsOpen(true); document.getElementById('results-tab')?.focus(); } }}>{t('Фрагменты')}</button><button id="results-tab" type="button" role="tab" aria-label={t('Готовые файлы')} aria-selected={resultsOpen} aria-controls="workspace-results" tabIndex={resultsOpen ? 0 : -1} onClick={() => setResultsOpen(true)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'Home') { event.preventDefault(); setResultsOpen(false); document.getElementById('clips-tab')?.focus(); } }}>{t('Готовые файлы')}{resultFiles.length > 0 && <span aria-hidden="true">{resultFiles.length}</span>}</button></div>}
        <div id="workspace-clips" className="workspace-clips" hidden={resultsOpen && !!job} role={job ? 'tabpanel' : undefined} aria-labelledby={job ? 'clips-tab' : undefined}>
<ClipLibrary compact disabled={busy || sourceBusy} limit={limits.max_ranges} ranges={ranges} selectedIds={selectedRangeIds} editedId={selectedId} revealId={revealId} onSelect={id => { stopPreview(); setSelectedRangeIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]); setRevealId(id); }} onSelectAll={() => { stopPreview(); setSelectedRangeIds(exportRanges.length === ranges.length ? [] : ranges.map(range => range.id)); }} onEdit={pickRange} onAdd={addLibraryRange} onBeginChange={beginHistory} onEndChange={finishHistory} onMove={moveRange} onLabel={(id, label) => { rememberHistory(); setRanges(previous => previous.map(range => range.id === id ? { ...range, label } : range)); }} onDuplicate={duplicateSelected} onDelete={() => removeSelected(selectedRangeIds)} onDeleteOne={id => removeSelected([id])}  canPreview={playerAvailable && !invalidDraft} onExport={() => goToStep(4)} />
        </div>
        {(job || resultFiles.length > 0) && <div id="workspace-results" className="workspace-results" role="tabpanel" aria-labelledby="results-tab" hidden={!resultsOpen}>{jobProgress}{resultsPanel}</div>}
        {desktopWorkspace ? <WorkspaceDialog modal={false} open={exportOpen && workspaceVisible} onClose={() => setExportOpen(false)} title={t('Экспорт')} className="workspace-export-dialog">{exportPanel}</WorkspaceDialog> : exportPanel}
      </aside></div>}
      {step === 4 && !source && (job || retryOutput) && <div className="output-stage">{resultsPanel}
        {!source && <section className="export-panel orphan-results"><p className="field-hint">{t(files.length > 0 ? 'Видео больше недоступно, но результат экспорта сохранился. Чтобы вырезать новые моменты, откройте видео заново.' : 'Задание экспорта сохранилось, но видео больше недоступно. Чтобы вырезать новые моменты, откройте его заново.')}</p><button className="text-button" type="button" onClick={() => goToStep(1)}>{t('Открыть другое видео')}</button>{retryOutput && <div className="orphan-retry"><p>{t('Запрос экспорта сохранён. Повторите его, чтобы получить уже принятое задание; новое видео не создаётся.')}</p><button type="button" className="button primary" disabled={busy || sourceBusy} onClick={() => void recoverExport()}>{submitting ? t('Создаём задание…') : t('Повторить экспорт')}</button></div>}{jobProgress}{jobError && <p className="error-message" role="alert">{t(jobError)}</p>}</section>}

      </div>}
      <footer className="page-footer"><span>cutmyvideo <span className="footer-dot">·</span> {t('Ссылки и видеофайлы')}</span><a href="https://github.com/Kay0k1/cutmyvideo-core" target="_blank" rel="noreferrer">{t('Открытое ядро на GitHub')}</a></footer>
      <div className="sr-only" role="status" aria-live="polite">{t(notice)}</div>
    </main>
  </div>;
}
