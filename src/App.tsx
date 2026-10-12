import { ProjectLibrary } from './ProjectLibrary';
import { exportCuttingPlan, importCuttingPlan, readProjects, sourceMismatch, upsertProject, projectsStorageKey } from './cuttingProjects';
import type { CuttingProject } from './cuttingProjects';
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
import { CropEditor } from './CropEditor';
import { displayTimecode, durationLabel, formatBytes, formatTimecode, parseTimecode, validateRange, zoomWindow } from './timecode';
import type { ClipRange, Job, OutputSettings, Source, UploadProgress, PublicLimits, MediaTrack } from './types';
import { countLabel } from './locales';
import { LanguageSwitch, WorkspaceNav } from './WorkspaceNav';
import { SourceChooser } from './SourceChooser';
import { ThemeToggle } from './Theme';
import { canonicalSourceUrl, providerName, validateVideo } from './sourceInput';
import { readOutputSettings, readPreferences, savePreferences, withoutSourceAudio } from './preferences';
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
import { createPlaybackPosition } from './playbackPosition';
import { coalescedTask } from './coalescedTask';
import { draftStorageKey as storageKey, readStoredRecord, storedResourceId } from './browserStorage';
import { startVisiblePolling } from './visiblePolling';
import { defaultLimits, maxClientRanges, readPublicLimits } from './limits';
import { SourceLibrary } from './SourceLibrary';
import { JobLibrary } from './JobLibrary';
import { RetentionNotice } from './RetentionNotice';
import { useWorkflowHistory } from './workflowHistory';
import { boundaryAudition, recoverCuttingDraft, restoredTimeText } from './cuttingDraft';
import type { RecoverableSource } from './cuttingDraft';
import type { WorkbenchPanel, WorkflowRoute } from './workflowHistory';

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
  return zoomWindow(duration, (range.start_ms + range.end_ms) / 2, Math.min(duration, Math.max(60000, (range.end_ms - range.start_ms) * 2)));
}

interface EditorSnapshot { ranges: ClipRange[]; selectedId: string; selectedRangeIds: string[]; output: OutputSettings; }

export default function App() {
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
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [sourceError, setSourceError] = useState('');
  const [ranges, setRanges] = useState<ClipRange[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedRangeIds, setSelectedRangeIds] = useState<string[]>([]);
  const [revealId, setRevealId] = useState('');
  const [precisionOpen, setPrecisionOpen] = useState(false);
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [position] = useState(createPlaybackPosition);
  const [playerAvailable, setPlayerAvailable] = useState(false);
  const [previewing, setPreviewing] = useState(false);
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
  const [jobRangeNumbers, setJobRangeNumbers] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const stopJobPolling = useRef<(() => void) | null>(null);
  const mutationPending = useRef(false);
  const deletionPending = useRef(false);
  const [jobError, setJobError] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [advancedOutputOpen, setAdvancedOutputOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [projects, setProjects] = useState(readProjects);
  const projectStore = useRef(projects);
  const activeProjectID = useRef<string | null>(projects.active_id);
  const histories = useRef<Record<string, EditHistory<EditorSnapshot>>>({});
  const pendingHistoryEnd = useRef<EditHistory<EditorSnapshot> | null>(null);
  const [, refreshHistory] = useState(0);
  const [projectError, setProjectError] = useState('');
  const [recoveringDraft, setRecoveringDraft] = useState<Record<string, unknown> | null>(null);
  const latestDraft = useRef<Record<string, unknown>>({});
  const player = useRef<PlayerControls>(null);
  const previewEnd = useRef<number | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const exportAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
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
  const busy = activeJob(job) || submitting || deletingSource;
  const duration = source?.duration_ms ?? 0;
  const view = zoomWindow(duration, viewCenter, span);
  const zoomOptions = [duration, 300000, 60000, 10000].filter((value, index, all) => value > 0 && value <= duration && all.indexOf(value) === index);
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

  const playbackPosition = useCallback((ms: number) => {
    if (previewEnd.current !== null && ms >= previewEnd.current) {
      const end = previewEnd.current; previewEnd.current = null; setPreviewing(false);
      player.current?.pause(); player.current?.seek(end); position.set(end);
    } else position.set(Math.min(duration, ms));
  }, [duration, position]);

  const mediaGeometry = useCallback((width: number, height: number) => {
    if (!source || !Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || width * height > 33554432) return;
    setDisplayGeometry(previous => previous?.id === source.id && previous.width === width && previous.height === height ? previous : { id: source.id, width, height });
  }, [source?.id]);
  useEffect(() => { setCropOpen(false); setCropContainer(document.querySelector<HTMLElement>('.player-frame')); }, [source?.id]);

  const playerAvailability = useCallback((available: boolean) => {
    setPlayerAvailable(available);
    if (!available) { previewEnd.current = null; setPreviewing(false); }
    if (available && restoredPosition.current !== null) { player.current?.seek(restoredPosition.current); restoredPosition.current = null; }
  }, []);

  const sourceUnavailable = useCallback(async (id: string, verify = false) => {
    if (!source || source.id !== id || currentSourceID.current !== id) return;
    if (verify) {
      try { const fresh = await api.source(id); if (!fresh.media_removed) return; }
      catch (error) { if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410 || ['not_found', 'expired', 'source_expired', 'source_unavailable'].includes(error.code))) return; }
      if (currentSourceID.current !== id) return;
    }
    player.current?.pause(); previewEnd.current = null; setPreviewing(false);
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
    player.current?.pause(); previewEnd.current = null; setPreviewing(false);
    setOutput(previous => withAudioSelection(previous, selection));
  }

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await api.session();
        const currentLimits = readPublicLimits(session.limits);
        if (disposed) return;
        setLimits(currentLimits);
        if (!restored.current) {
          const saved = projectStore.current.projects.find(project => project.id === projectStore.current.active_id)?.draft ?? readStoredRecord(storageKey);
          activeProjectID.current = projectStore.current.active_id ?? (storedResourceId(saved.source_id) ? saved.source_id : null);
          const attempt = saved.export_attempt;
          if (typeof attempt === 'object' && attempt !== null) {
            const { fingerprint, key } = attempt as Record<string, unknown>;
            if (typeof fingerprint === 'string' && fingerprint.length <= 128 * 1024 && storedResourceId(key)) exportAttempt.current = { fingerprint, key };
          }
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
              const restoredOutput = readOutputSettings(saved.output);
              if (restoredOutput) setOutput(restoredOutput);
            } catch (error) {
              if (disposed) return;
              if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410 || ['not_found', 'expired', 'source_unavailable', 'source_expired'].includes(error.code))) throw error;
              const recovered = recoverCuttingDraft(saved);
              if (recovered) {
                setRecoverableSource(recovered.source); setRecoveringDraft(saved); setKeepRecoveredCuts(false);
                setRanges(recovered.ranges); setSelectedId(recovered.selectedId); setSelectedRangeIds(recovered.selectedIds);
                const active = recovered.ranges.find(range => range.id === recovered.selectedId)!;
                setFields(active); restoreTimeFields(saved, active);
                const restoredOutput = readOutputSettings(saved.output); if (restoredOutput) setOutput(restoredOutput);
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
      } catch (error) { if (!disposed) setSourceError(errorMessage(error)); }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [sessionAttempt, setFields]);

  function persistCurrentProject() {
    const snapshot = draftSnapshot();
    if (pendingHistoryEnd.current === currentHistory()) { finishGesture(currentHistory(), editSnapshot()); pendingHistoryEnd.current = null; }
    try {
      if (activeProjectID.current && snapshot.source_id) {
        const next = upsertProject(projectStore.current, activeProjectID.current, snapshot);
        projectStore.current = next; if (step === 1) setProjects(next);
        localStorage.setItem(projectsStorageKey, JSON.stringify(next));
      }
      localStorage.setItem(storageKey, JSON.stringify(snapshot));
      setProjectError('');
    } catch { setProjectError('Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.'); }
  }

  function restoreProjectView(saved: Record<string, unknown>, length: number, range?: ClipRange) {
    const savedSpan = typeof saved.timeline_span === 'number' && Number.isFinite(saved.timeline_span) && saved.timeline_span > 0 ? saved.timeline_span : preferences.timeline_span;
    setSpan(Math.min(length, savedSpan));
    const center = typeof saved.view_center === 'number' && Number.isFinite(saved.view_center) ? saved.view_center : range ? (range.start_ms + range.end_ms) / 2 : 0;
    setViewCenter(Math.max(0, Math.min(length, center)));
    if (Array.isArray(saved.simple_view) && saved.simple_view.length === 2 && saved.simple_view.every(value => typeof value === 'number' && Number.isFinite(value)) && saved.simple_view[0] >= 0 && saved.simple_view[1] <= length && saved.simple_view[1] > saved.simple_view[0]) setSimpleView(saved.simple_view as [number, number]);
    else if (range) setSimpleView(simpleRangeView(length, range));
  }

  function editSnapshot(): EditorSnapshot { return { ranges, selectedId, selectedRangeIds, output }; }
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
    if (range) { setFields(range); setSelectedId(range.id); setViewCenter((range.start_ms + range.end_ms) / 2); setSimpleView(simpleRangeView(duration, range)); }
    else { setStartText(''); setEndText(''); setRangeError(''); if (step === 2) setStep(3); }
    previewEnd.current = null; setPreviewing(false); player.current?.pause();
  }
  function historyAction(direction: 'undo' | 'redo') {
    const snapshot = direction === 'undo' ? undoEdit(currentHistory(), editSnapshot()) : redoEdit(currentHistory(), editSnapshot());
    if (snapshot) { applyEditSnapshot(snapshot); refreshHistory(value => value + 1); }
  }
  function moveRange(id: string, direction: -1 | 1) {
    const index = ranges.findIndex(range => range.id === id), target = index + direction;
    if (index < 0 || target < 0 || target >= ranges.length) return;
    rememberHistory(); const next = [...ranges]; [next[index], next[target]] = [next[target], next[index]]; setRanges(next); setRevealId(id);
  }

  async function openProject(project: CuttingProject) {
    if (sourceBusy || submitting || deletingSource || cancelling) return;
    draftWriter.current?.flush(); persistCurrentProject();
    const saved = projectStore.current.projects.find(value => value.id === project.id)?.draft ?? project.draft;
    setSourceBusy(true); setSourceError(''); stopJobPolling.current?.(); player.current?.pause(); previewEnd.current = null; setPreviewing(false);
    try {
      let fresh: Source | null = null;
      if (!String(saved.source_id).startsWith('plan-')) {
        try { fresh = await api.source(String(saved.source_id)); if (fresh.media_removed) fresh = null; }
        catch (error) { if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410 || ['not_found', 'expired', 'source_expired', 'source_unavailable'].includes(error.code))) throw error; }
      }
      activeProjectID.current = project.id; restoreProject(saved, fresh);
      setJob(null); setJoinedJob(false); setJobRangeNumbers([]); setJobError('');
      if (storedResourceId(saved.job_id)) {
        try { const previous = await api.job(saved.job_id); setJob(previous); setJoinedJob(saved.job_output_mode === 'joined'); setJobRangeNumbers(Array.isArray(saved.job_range_numbers) ? saved.job_range_numbers as number[] : previous.items.map((_, index) => index + 1)); }
        catch (error) { if (!(error instanceof ApiError) || !(error.httpStatus === 404 || error.httpStatus === 410)) setJobError(errorMessage(error)); }
      }
      setNotice('Проект открыт.');
    } catch (error) { setSourceError(errorMessage(error)); }
    finally { setSourceBusy(false); }
  }

  function restoreProject(saved: Record<string, unknown>, fresh: Source | null) {
    const length = fresh?.duration_ms ?? Number(saved.source_duration_ms);
    const nextRanges = restoreRanges(saved.ranges, length, maxClientRanges);
    const active = nextRanges.find(range => range.id === saved.selected_id) ?? nextRanges[0];
    setSource(fresh); setRanges(nextRanges); setSelectedId(active?.id ?? ''); setSelectedRangeIds(rangeSelection(nextRanges, saved.selected_range_ids)); setRevealId(active?.id ?? '');
    if (active) { setFields(active); restoreTimeFields(saved, active); } else { setStartText(''); setEndText(''); }
    const nextOutput = readOutputSettings(saved.output); if (nextOutput) setOutput(nextOutput);
    restoreProjectView(saved, length, active);
    const savedPosition = typeof saved.current_ms === 'number' && Number.isFinite(saved.current_ms) ? Math.max(0, Math.min(length, saved.current_ms)) : 0;
    position.set(savedPosition); restoredPosition.current = savedPosition;
    setPrecisionOpen(saved.precision_open === true);
    setPlayerAvailable(false); exportAttempt.current = null;
    if (fresh) { setRecoverableSource(null); setRecoveringDraft(null); setStep(active ? 2 : 3); }
    else { setRecoverableSource({ id: String(saved.source_id), title: String(saved.source_title ?? ''), duration_ms: length }); setRecoveringDraft(saved); setKeepRecoveredCuts(false); setStep(1); setSourceError('Источник больше недоступен. Фрагменты сохранены. Загрузите ту же запись или откройте её ссылку, чтобы продолжить.'); }
    refreshHistory(value => value + 1);
  }

  function deleteProject(id: string) {
    if (!window.confirm(t('Удалить проект только из браузера? Видео и готовые файлы останутся на сервере.'))) return;
    const next = { ...projectStore.current, active_id: projectStore.current.active_id === id ? null : projectStore.current.active_id, projects: projectStore.current.projects.filter(project => project.id !== id) };
    projectStore.current = next; setProjects(next); delete histories.current[id];
    if (activeProjectID.current === id) { activeProjectID.current = null; setSource(null); setRecoverableSource(null); setRecoveringDraft(null); setRanges([]); setSelectedId(''); setSelectedRangeIds([]); setStep(1); try { localStorage.removeItem(storageKey); } catch { /* Optional persistence. */ } }
    try { localStorage.setItem(projectsStorageKey, JSON.stringify(next)); } catch { setProjectError('Не удалось сохранить проект в браузере. Скачайте план, чтобы не потерять работу.'); }
  }

  function downloadPlan() {
    const included = ranges.filter(range => selectedRangeIds.includes(range.id));
    if (!included.length) return;
    const plan = exportCuttingPlan(source?.title ?? recoverableSource?.title ?? 'video.mp4', included, output);
    const blobURL = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = blobURL; link.download = 'cutmy-plan.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(blobURL), 1000);
  }

  async function loadPlan(file: File) {
    if (file.size > 256 * 1024) { setProjectError('План слишком большой.'); return; }
    try {
      const raw = await file.text();
      const result = importCuttingPlan(raw, source?.duration_ms ?? 366 * 24 * 60 * 60 * 1000, () => crypto.randomUUID());
      if (source && !window.confirm(t('Заменить фрагменты текущего проекта импортированным планом? Проверьте, что открыта нужная запись.'))) return;
      if (source) rememberHistory();
      else { draftWriter.current?.flush(); persistCurrentProject(); const id = `plan-${crypto.randomUUID()}`; activeProjectID.current = id; const length = Math.max(...result.ranges.map(range => range.end_ms)); const draft = { source_id: id, source_title: result.input.split(/[\\/]/).at(-1), source_duration_ms: length, plan_imported: true }; setRecoverableSource({ id, title: String(draft.source_title), duration_ms: length }); setRecoveringDraft(draft); setKeepRecoveredCuts(true); }
      setRanges(result.ranges); setSelectedId(result.ranges[0].id); setSelectedRangeIds(result.ranges.map(range => range.id)); setOutput(result.output); setFields(result.ranges[0]); setRevealId(result.ranges[0].id); setProjectError('');
      if (source) { setStep(3); setNotice('План открыт. Проверьте соответствие записи и границы.'); } else { setStep(1); setSourceError('План открыт. Загрузите указанную запись и проверьте границы.'); }
    } catch (error) { setProjectError(error instanceof Error ? error.message : 'Не удалось прочитать JSON-план.'); }
  }

  function restoreTimeFields(saved: Record<string, unknown>, range: ClipRange) {
    if (saved.selected_id !== range.id) return;
    setStartText(restoredTimeText(saved.start_text, range.start_ms));
    setEndText(restoredTimeText(saved.end_text, range.end_ms));
  }

  function draftSnapshot() {
    return { workflow_version: 2, plan_imported: !source && recoveringDraft?.plan_imported === true, source_width: source?.width ?? recoveringDraft?.source_width, source_height: source?.height ?? recoveringDraft?.source_height, source_provider_video_id: source?.provider_video_id ?? recoveringDraft?.source_provider_video_id, media_unavailable: !source, timeline_span: span, view_center: viewCenter, simple_view: simpleView, source_id: source?.id ?? recoverableSource?.id, source_title: source?.title ?? recoverableSource?.title, source_duration_ms: source?.duration_ms ?? recoverableSource?.duration_ms, start_text: startText, end_text: endText, ranges, selected_id: selectedId, selected_range_ids: selectedRangeIds, output, job_id: job?.id, job_output_mode: joinedJob ? 'joined' : 'separate', job_range_numbers: jobRangeNumbers, step, current_ms: position.getSnapshot(), precision_open: precisionOpen, export_attempt: exportAttempt.current };
  }

  const saveDraft = useEffectEvent(() => {
    if (!sessionReady) return;
    persistCurrentProject();
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

  useEffect(() => { draftWriter.current?.schedule(300); }, [source, ranges, selectedId, selectedRangeIds, output, job?.id, joinedJob, jobRangeNumbers, sessionReady, step, precisionOpen, startText, endText, recoverableSource, span, viewCenter, simpleView]);

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

  useEffect(() => { document.title = `${t('Шаг {current} из 4', { current: step })} · ${t(['Откройте видео', 'Выберите один момент', 'Соберите фрагменты', 'Сохраните фрагменты'][step - 1])} · cutmyvideo`; }, [step, locale]);

  useEffect(() => {
    if (step !== 2) { player.current?.pause(); previewEnd.current = null; setPreviewing(false); }
    if (previousStep.current !== step) { stageHeading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
    previousStep.current = step;
  }, [step]);

  function goToStep(next: WorkbenchStep) {
    if (next > 1 && !source && !(next === 4 && job)) return;
    if (next === 4 && !exportRanges.length && !job) return;
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
    if (next > 1 && !source && !(next === 4 && job)) next = 1;
    if (next === 2 && !selected) next = source ? 3 : 1;
    if (next === 4 && !exportRanges.length && !job) next = source ? 3 : 1;
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
    previewEnd.current = null; setPreviewing(false);
  }

  function revealBoundary(ms: number) {
    const visible = precisionOpen ? view : simpleView;
    if (ms >= visible[0] && ms <= visible[1]) return;
    if (precisionOpen) setViewCenter(ms);
    else setSimpleView(zoomWindow(duration, ms, visible[1] - visible[0]));
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
      setViewCenter((range.start_ms + range.end_ms) / 2);
      setSimpleView(simpleRangeView(duration, range));
    }
    return !!range;
  }

  function seek(ms: number) {
    const value = Math.max(0, Math.min(duration, ms));
    restoredPosition.current = null;
    previewEnd.current = null; setPreviewing(false);
    position.set(value); player.current?.seek(value);
  }

  function marker(which: 'start' | 'end') {
    if (!selected) return;
    const [start, end] = markBounds(selected, position.getSnapshot(), which, duration);
    const error = validateRange(start, end, duration, limits.max_range_ms);
    if (error) { setRangeError(error); return; }
    changeBounds(start, end); setViewCenter((start + end) / 2); setSimpleView(simpleRangeView(duration, { ...selected, start_ms: start, end_ms: end }));
  }

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!event.defaultPrevented && !event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && !document.querySelector('dialog[open]') && (event.code === 'KeyZ' || event.ctrlKey && event.code === 'KeyY') && !(event.target as HTMLElement).closest('input, textarea, [contenteditable]') && source && (step === 2 || step === 3)) { event.preventDefault(); historyAction(event.code === 'KeyY' || event.shiftKey ? 'redo' : 'undo'); return; }
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
    if ((event.target as HTMLElement).closest('input, textarea, select, button, a, video, [role="slider"], [contenteditable], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"]')) return;
    if (step !== 2 || !source || !selected) return;
    if (event.code === 'KeyI') { event.preventDefault(); marker('start'); }
    if (event.code === 'KeyO') { event.preventDefault(); marker('end'); }
    if ((event.code === 'ArrowLeft' || event.code === 'ArrowRight') && playerAvailable) { event.preventDefault(); player.current?.pause(); seek(position.getSnapshot() + (event.code === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 100)); }
    if (event.code === 'Space' && playerAvailable) { event.preventDefault(); player.current?.toggle(); }
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  async function openSource(file?: File, providedUrl?: string) {
    if (!sessionReady || sourceBusy || submitting || deletingSource || cancelling || mutationPending.current || sourceController.current) return;
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
      if (!activateSource(opened)) return;
      if (!file) setUrl(candidateUrl!);
      setNotice('Источник открыт. Укажите границы фрагмента.');
    } catch (error) {
      if (!controller.signal.aborted) setSourceError(errorMessage(error, 'source-create'));
    } finally { if (sourceController.current === controller) { sourceController.current = null; setSourceBusy(false); setUploadProgress(null); } }
  }

  function activateSource(opened: Source) {
    if (opened.media_removed) { setSourceError('Источник больше недоступен. Фрагменты сохранены. Загрузите ту же запись или откройте её ссылку, чтобы продолжить.'); setStep(1); return false; }
    const recovered = recoverableSource && keepRecoveredCuts;
    if (recovered && ranges.some(range => range.end_ms > opened.duration_ms)) { setSourceError('Эта запись короче сохранённых фрагментов. Откройте исходную запись или отключите восстановление фрагментов.'); setStep(1); return false; }
    if (recovered && recoveringDraft && sourceMismatch({ ...recoveringDraft, ...(recoveringDraft.plan_imported ? { source_duration_ms: undefined } : {}) }, opened) && !window.confirm(t('Запись отличается от сохранённого проекта. Применить интервалы? Проверьте границы перед экспортом.'))) { setStep(1); return false; }
    draftWriter.current?.flush(); persistCurrentProject();
    stopJobPolling.current?.(); stopJobPolling.current = null; player.current?.pause(); previewEnd.current = null;
    const prior = !recovered && projectStore.current.projects.find(project => project.draft.source_id === opened.id);
    if (prior) { activeProjectID.current = prior.id; restoreProject(prior.draft, opened); }
    else {
      if (!recovered) activeProjectID.current = opened.id;
      const nextRanges = recovered ? ranges : [newRange(opened.duration_ms, 0, limits)];
      const range = nextRanges.find(range => range.id === selectedId) ?? nextRanges[0];
      setSource(opened); setRanges(nextRanges); setSelectedId(range?.id ?? ''); if (range) setFields(range);
      setSelectedRangeIds(recovered ? selectedRangeIds : range ? [range.id] : []); setRevealId(range?.id ?? '');
      if (recovered && recoveringDraft) { restoreProjectView(recoveringDraft, opened.duration_ms, range); const savedPosition = Number(recoveringDraft.current_ms ?? 0); position.set(Math.max(0, Math.min(opened.duration_ms, savedPosition))); restoredPosition.current = position.getSnapshot(); }
      else { position.set(0); restoredPosition.current = null; if (range) { setSimpleView(simpleRangeView(opened.duration_ms, range)); setViewCenter((range.start_ms + range.end_ms) / 2); } setSpan(Math.min(opened.duration_ms, preferences.timeline_span)); setOutput(withoutSourceAudio(preferences.output)); }
      setPrecisionOpen(!!recovered || opened.preview_kind === 'none' || (!opened.preview_url && !opened.embed_url));
      setRecoverableSource(null); setRecoveringDraft(null); setStep(range ? 2 : 3);
    }
    exportAttempt.current = null; setJob(null); setJoinedJob(false); setJobRangeNumbers([]); setJobError(''); setPreviewing(false); setPlayerAvailable(false); setAdvancedOutputOpen(false); refreshHistory(value => value + 1);
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
      if (!controller.signal.aborted && activateSource(fresh)) setNotice('Источник открыт. Укажите границы фрагмента.');
    } catch (error) {
      if (!controller.signal.aborted) {
        if (previous.id === currentSourceID.current && error instanceof ApiError && (error.httpStatus === 410 || ['not_found', 'expired', 'source_expired', 'source_unavailable'].includes(error.code))) void sourceUnavailable(previous.id);
        else setSourceError(errorMessage(error));
      }
    }
    finally { if (sourceController.current === controller) { sourceController.current = null; setSourceBusy(false); } }
  }

  function finishMoment(next: 3 | 4) {
    const range = validateFields(true);
    if (!range) return;
    setRanges(previous => previous.map(item => item.id === range.id ? range : item));
    if (next === 4) setSelectedRangeIds(previous => previous.includes(range.id) ? previous : [...previous, range.id]);
    setRevealId(range.id); setStep(next);
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
    previewEnd.current = null; setPreviewing(false); player.current?.pause();
    setSelectedId(range.id); setFields(range); setViewCenter((range.start_ms + range.end_ms) / 2); setSimpleView(simpleRangeView(duration, range));
    setStep(2); setRevealId(range.id);
  }

  function fitSelection() {
    if (!selected) return;
    setViewCenter((selected.start_ms + selected.end_ms) / 2);
    const needed = Math.min(duration, (selected.end_ms - selected.start_ms) * 1.2);
    if (needed > span) setSpan([...zoomOptions].sort((a, b) => a - b).find(value => value >= needed) ?? duration);
  }

  function addRange() {
    if (!source || ranges.length >= limits.max_ranges) return;
    const committed = selected ? validateFields(true) : null;
    if (selected && !committed) { setStep(2); return; }
    rememberHistory();
    const range = newRange(duration, position.getSnapshot(), limits);
    setRanges(previous => [...previous.map(item => item.id === committed?.id ? committed! : item), range]);
    setSelectedRangeIds(previous => [...previous, range.id]);
    setSelectedId(range.id); setFields(range); setViewCenter((range.start_ms + range.end_ms) / 2); setSimpleView(simpleRangeView(duration, range));
    setRevealId(range.id); setStep(2);
    setNotice('Фрагмент добавлен. Настройте его границы.');
  }

  function removeSelected(ids: string[]) {
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
    const start = which === 'start' ? Math.max(0, Math.min(range.end_ms - 100, range.start_ms + delta)) : range.start_ms;
    const end = which === 'end' ? Math.min(duration, Math.max(range.start_ms + 100, range.end_ms + delta)) : range.end_ms;
    const error = validateRange(start, end, duration, limits.max_range_ms);
    if (error) { setRangeError(error); return; }
    changeBounds(start, end); revealBoundary(which === 'start' ? start : end);
  }

  function revealPlayer() {
    const element = document.querySelector<HTMLElement>('.player-frame');
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > window.innerHeight) element.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  function audition(which: 'start' | 'end') {
    const range = validateFields(true); if (!range || !playerAvailable) return;
    commitFields(); revealPlayer();
    const [start, end] = boundaryAudition(which === 'start' ? range.start_ms : range.end_ms, duration);
    player.current?.pause(); player.current?.seek(start);
    previewEnd.current = end; setPreviewing(true); player.current?.play();
  }

  function preview() {
    if (previewing) { player.current?.pause(); previewEnd.current = null; setPreviewing(false); return; }
    const range = validateFields(true);
    if (!range || !playerAvailable) return;
    commitFields(); revealPlayer(); player.current?.seek(range.start_ms); previewEnd.current = range.end_ms;
    setPreviewing(true); player.current?.play();
  }

  async function exportClips(event: FormEvent) {
    event.preventDefault();
    if (!source || busy || sourceBusy || mutationPending.current || !exportRanges.length || invalidAudio || incompatibleOutput) return;
    if (exportLimitError) { setJobError(exportLimitError); return; }
    const range = selected ? validateFields(true) : null;
    if (selected && !range) { setStep(2); return; }
    const committed = ranges.map(item => item.id === range?.id ? range! : item);
    const includedDuration = committed.filter(item => selectedRangeIds.includes(item.id)).reduce((total, item) => total + item.end_ms - item.start_ms, 0);
    if (exportRanges.length > limits.max_ranges || includedDuration > limits.max_job_ms) { setJobError(exportLimitError || t('Общая длительность одного экспорта — до {limit}. Разделите фрагменты на несколько заданий.', { limit: durationLabel(limits.max_job_ms, locale) })); return; }
    mutationPending.current = true;
    setRanges(committed); setSubmitting(true); setJobError('');
    try {
      const included = committed.filter(item => selectedRangeIds.includes(item.id));
      const requestedOutput = preserveLocalQuality ? { ...output, quality: 'best' as const } : output;
      const fingerprint = jobRequestBody(source.id, included, requestedOutput);
      if (exportAttempt.current?.fingerprint !== fingerprint) exportAttempt.current = { fingerprint, key: crypto.randomUUID() };
      try { localStorage.setItem(storageKey, JSON.stringify({ ...draftSnapshot(), ranges: committed })); }
      catch { /* The retry key remains available in memory when storage is unavailable. */ }
      const created = await api.createJob(source.id, included, requestedOutput, exportAttempt.current.key);
      exportAttempt.current = null;
      setJobRangeNumbers(requestedOutput.output_mode === 'joined' ? [1] : included.map(item => committed.findIndex(original => original.id === item.id) + 1)); setJoinedJob(requestedOutput.output_mode === 'joined'); setJob(created);
    }
    catch (error) {
      if (error instanceof ApiError && (error.httpStatus === 404 || error.httpStatus === 410 || ['expired', 'source_expired', 'source_unavailable'].includes(error.code))) void sourceUnavailable(source.id);
      setJobError(errorMessage(error, 'export'));
    }
    finally { mutationPending.current = false; setSubmitting(false); }
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
    persistCurrentProject(); activeProjectID.current = null;
    exportAttempt.current = null; setSource(null); setRecoverableSource(null); setRecoveringDraft(null); setRanges([]); setSelectedId(''); setSelectedRangeIds([]);
    setJob(null); setJoinedJob(false); setJobRangeNumbers([]); setJobError(''); setStartText(''); setEndText(''); setRangeError('');
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
    savePreferences(value); setPreferences({ ...value, output: withoutSourceAudio(value.output) }); setOutput(previous => ({ ...withoutSourceAudio(value.output), ...(previous.audio_track !== undefined ? { audio_track: previous.audio_track } : {}), ...(previous.no_audio && value.output.format !== 'mp3' ? { no_audio: true } : {}) }));
    setSpan(source ? Math.min(source.duration_ms, value.timeline_span) : value.timeline_span);
    if (selected) setViewCenter((selected.start_ms + selected.end_ms) / 2);
    setNotice('Настройки сохранены.');
  }

  const files = job?.items.filter(item => item.artifact) ?? [];
  useEffect(() => {
    const previous = previousJobState.current;
    previousJobState.current = job ? { id: job.id, status: job.status } : null;
    if (!job || !previous || previous.id !== job.id || !['queued', 'running', 'waiting_storage'].includes(previous.status) || activeJob(job) || !files.length || step !== 4 || document.hidden || document.querySelector('dialog[open]')) return;
    const frame = window.requestAnimationFrame(() => {
      const heading = document.getElementById('results-heading');
      heading?.closest('.results-panel')?.scrollIntoView({ block: 'start', behavior: 'instant' });
      heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [job?.id, job?.status]);
  const failedItems = job?.items.filter(item => item.status === 'failed') ?? [];
  const repeatExport = repeatsFailedExport(job, exportRanges);
  const jobHeading = job?.status === 'failed' && files.length > 0 ? 'Часть фрагментов готова' : stageNames[job?.status === 'running' ? job.stage : job?.status ?? ''] ?? 'Обрабатываем фрагменты';
  const sourceProvider = providerName(source?.provider);
  const qualityLabel = source?.width && source?.height ? `${source.width} × ${source.height}` : null;

  const jobProgress = job && <section className={`job-status ${job.status}`} aria-label={t("Состояние экспорта")} aria-live="polite"><p className="job-history-label">{t("Последний экспорт")}</p><div className="job-status-heading">{activeJob(job) ? <span className="spinner" /> : <Icon name={job.status === 'succeeded' ? 'check' : 'file'} size={20} />}<h3>{t(jobHeading)}</h3></div><p>{jobDescription(job, t)}</p>{job.status === 'waiting_storage' && <RetentionNotice expiresAt={job.storage_wait_until} kind="wait" />}<ExportProgress job={job} /><p className="job-file-count">{t('Готово: {count} из {total}', { count: files.length, total: job.items.length })}</p>{failedItems.length > 0 && <div className="failed-items"><ul>{failedItems.map(item => <li key={item.id}><strong>{joinedJob && item.label === 'Joined result' ? t('Объединённый результат') : item.label || `${t('Фрагмент')} ${jobRangeNumbers[job.items.indexOf(item)] ?? job.items.indexOf(item) + 1}`}</strong><span>{t(exportFailureReason(item, job.message))}</span></li>)}</ul>{source && <p className="job-recovery-note">{t('Выбранные моменты сохранены. Настройки можно изменить перед повтором.')}</p>}</div>}{activeJob(job) && <button type="button" className="button secondary cancel-button" disabled={cancelling} onClick={() => void cancelJob()}>{cancelling ? t("Отменяем…") : t("Отменить обработку")}</button>}{activeJob(job) && <button type="button" className="text-button background-source" onClick={() => goToStep(1)}>{t('Пока обрабатывается — открыть другое видео')}</button>}</section>;

  const resultsPanel = files.length > 0 && <section className="results-panel" aria-labelledby="results-heading"><div className="results-heading"><div><h2 id="results-heading" tabIndex={-1}>{t("Файлы последнего экспорта")}</h2><p>{t(files.some(item => item.artifact?.segments?.length) ? 'Скачайте объединённый файл. Порядок и границы фрагментов указаны ниже.' : "Скачайте каждый фрагмент отдельно.")}</p></div><span className="result-count">{countLabel(files.length, 'file', locale)}</span></div><ul className="file-list">{files.map((item, index) => {
        const artifact = item.artifact!;
        const itemNumber = jobRangeNumbers[job?.items.indexOf(item) ?? index] ?? (job?.items.indexOf(item) ?? index) + 1;
        const adjusted = !artifact.segments?.length && (Math.abs(artifact.actual_start_ms - item.start_ms) > 100 || Math.abs(artifact.actual_end_ms - item.end_ms) > 100);
        return <li key={artifact.id}><span className="file-icon"><Icon name="file" size={23} /></span><div className="file-description"><h3>{artifact.segments?.length && item.label === 'Joined result' ? t('Объединённый результат') : item.label || `${t('Фрагмент')} ${itemNumber}`}</h3><p>{artifact.filename}</p><span>{formatBytes(artifact.size_bytes, locale)}<span className="meta-separator"> / </span>{formatTimecode(artifact.actual_start_ms, true)} — {formatTimecode(artifact.actual_end_ms, true)}</span><RetentionNotice expiresAt={artifact.expires_at} kind="artifact" />{adjusted && <p className="adjusted-note">{t("Фактические границы отличаются от выбранных.")}</p>}<ArtifactDetails artifact={artifact} /></div><a className="button secondary download-button" href={artifact.download_url} download={artifact.filename}><Icon name="download" size={17} />{t("Скачать")}</a></li>;
      })}</ul></section>;

  const stageTitles = ['Откройте видео', 'Выберите один момент', 'Соберите фрагменты', 'Сохраните фрагменты'];
  const stageDescriptions = ['Ссылка на запись или видеофайл с вашего устройства.', 'Отметьте начало и конец одного фрагмента.', 'Отметьте, что вырезать. Здесь же можно добавить или изменить моменты.', 'Выберите видео или аудио и скачайте результат.'];

  return <>
    <a className="skip-link" href="#editor">{t('К выбору фрагмента')}</a>
    <header className="site-header"><div className="header-inner">
      <a className="brand" href="/" aria-label={t('cutmyvideo — главная')}><span className="brand-symbol"><Icon name="cut" size={20} /></span><span>cutmy<span className="brand-suffix">video</span></span></a>
      <WorkspaceNav panel={panel} onOpen={setPanel} onClose={navigation.closePanel} preferences={preferences} onSave={applyPreferences} busy={!sessionReady || sourceBusy || busy} onExample={value => { setUrl(value); setStep(1); void openSource(undefined, value); }} />
      <div className="header-actions"><LanguageSwitch /><ThemeToggle /></div>
    </div></header>
    <main id="editor" className={`stage-page stage-${step}`}>
      <nav className="steps-nav" aria-label={t('Шаги работы')}><ol>{(['Видео', 'Момент', 'Фрагменты', 'Экспорт'] as const).map((label, index) => <li key={label}><button type="button" disabled={sourceBusy || (index > 0 && !source && !(index === 3 && job)) || (index === 3 && !exportRanges.length && !job) || (index === 1 && !ranges.length)} aria-current={step === index + 1 ? 'step' : undefined} onClick={() => goToStep((index + 1) as WorkbenchStep)}><span className="step-number">{index + 1}</span><span>{t(label)}</span></button>{index < 3 && <span className="step-connector" aria-hidden="true" />}</li>)}</ol></nav>
      <div className="page-heading"><div><p className="step-caption">{t('Шаг {current} из 4', { current: step })}</p><h1 ref={stageHeading} tabIndex={-1}>{t(stageTitles[step - 1])}</h1><p>{t(stageDescriptions[step - 1])}</p></div>{step > 2 && <button className="text-button change-source" type="button" onClick={() => goToStep(1)}><Icon name="link" size={17} />{t('Другое видео')}</button>}</div>
      {recoverableSource && step === 1 && <section className="draft-recovery" aria-labelledby="draft-recovery-heading"><h2 id="draft-recovery-heading">{t('Фрагменты сохранены')}</h2>{recoverableSource.title && <p>{recoverableSource.title}</p>}<p>{t('Загрузите ту же запись или откройте её ссылку. Границы, названия и настройки экспорта восстановятся.')}</p><ol>{ranges.map(range => <li key={range.id}><strong>{range.label || t('Фрагмент')}</strong><span>{formatTimecode(range.start_ms, true)} — {formatTimecode(range.end_ms, true)}</span></li>)}</ol><label><input type="checkbox" checked={keepRecoveredCuts} onChange={event => setKeepRecoveredCuts(event.target.checked)} />{t('Восстановить фрагменты в открываемом видео')}</label></section>}
      {step === 1 && <SourceChooser url={url} onUrl={value => { setUrl(value); setSourceError(''); }} onOpen={() => void openSource()} onFile={file => void openSource(file)} busy={sourceBusy} progress={uploadProgress} maximumBytes={limits.max_source_bytes} blocked={deletingSource} processing={submitting || cancelling} ready={sessionReady} error={sourceError} onCancel={() => { sourceController.current?.abort(); sourceController.current = null; setSourceBusy(false); setUploadProgress(null); }} onReconnect={() => { setSourceError(''); setSessionAttempt(n => n + 1); }} />}
      {step === 1 && sessionReady && <ProjectLibrary projects={projectStore.current.projects} activeID={activeProjectID.current} disabled={sourceBusy || submitting || cancelling || deletingSource} canExport={exportRanges.length > 0} onOpen={value => void openProject(value)} onDelete={deleteProject} onExport={downloadPlan} onImport={file => void loadPlan(file)} />}
      {projectError && <p className="error-message" role="alert">{t(projectError)}</p>}
      {source && (step === 2 || step === 3) && <div className="edit-history-actions" role="group" aria-label={t('История изменений')}><button type="button" className="text-button" disabled={!currentHistory().past.length || busy} onClick={() => historyAction('undo')}>{t('Отменить изменение')}</button><button type="button" className="text-button" disabled={!currentHistory().future.length || busy} onClick={() => historyAction('redo')}>{t('Повторить изменение')}</button></div>}
      {step === 1 && sessionReady && <SourceLibrary currentID={source?.id} disabled={sourceBusy || submitting || cancelling || deletingSource} currentBusy={busy} onBusy={setDeletingSource} onOpen={value => void reopenSource(value)} onDeleted={id => { if (id === currentSourceID.current) clearDeletedSource(); else setNotice('Видео и связанные файлы удалены.'); }} />}
      {sessionReady && (step === 1 || step === 4) && <JobLibrary refreshKey={job?.id + ":" + job?.status} initiallyOpen={step === 1 && activeJob(job)} />}
      {source && step === 1 && <section className="source-retention" aria-label={t('Хранение видео')}><RetentionNotice expiresAt={source.expires_at} blocked={source.retention_blocked} kind="source" /><button type="button" className="text-button danger-button" disabled={busy || sourceBusy} onClick={() => void deleteSource()}>{deletingSource ? t('Удаляем…') : t('Удалить видео и файлы')}</button></section>}
      {source && <section className="moments-stage" hidden={step !== 2} aria-label={t('Выбор одного момента')}>
        <div className="editing-panel">
          <div className="media-heading"><div className="source-title"><Icon name="file" size={18} /><span title={source.title}>{source.title}</span>{sourceProvider && <span className="source-provider">{t(sourceProvider)}</span>}</div><span className="source-meta">{qualityLabel && <>{qualityLabel}<span className="meta-separator"> / </span></>}{formatTimecode(duration)}</span></div>
          <div className="moment-layout">
          <Player ref={player} source={source} audioTrack={previewAudioTrack} noAudio={output.no_audio} forceWindow={cropOpen && !source.preview_url} onGeometry={mediaGeometry} active={step === 2} onAvailable={playerAvailability} onTime={playbackPosition} onSourceUnavailable={sourceUnavailable} />
          {selected && <div className="moment-controls">
            <AudioTrackSelector id="audio-track-preview" output={output} tracks={tracks} loading={tracksLoading} error={tracksError} disabled={busy} onChange={changeAudio} onRetry={() => setTrackRevision(value => value + 1)} />
            <div className="moment-boundaries"><div><label htmlFor="range-start">{t('Начало')}</label><button type="button" className="time-value" hidden={precisionOpen} aria-label={t('Изменить время начала: {time}', { time: displayTimecode(selected.start_ms) })} onClick={() => editTime('start')}>{displayTimecode(selected.start_ms)}<Icon name="edit" size={14} /></button><input ref={startField} id="range-start" className="time-input" hidden={!precisionOpen} type="text" inputMode="text" enterKeyHint="done" autoComplete="off" autoCapitalize="none" value={startText} onChange={event => { setStartText(event.target.value); setRangeError(''); }} onBlur={commitFields} onKeyDown={timeFieldKey} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'range-error' : 'time-hint'} spellCheck={false} /><button className="marker-button" type="button" disabled={!playerAvailable} aria-label={t('Начало по позиции плеера')} onClick={() => marker('start')}><span className="marker-bracket">[</span>{t('Начало здесь')}<kbd>I</kbd></button></div><div><label htmlFor="range-end">{t('Конец')}</label><button type="button" className="time-value" hidden={precisionOpen} aria-label={t('Изменить время конца: {time}', { time: displayTimecode(selected.end_ms) })} onClick={() => editTime('end')}>{displayTimecode(selected.end_ms)}<Icon name="edit" size={14} /></button><input ref={endField} id="range-end" className="time-input" hidden={!precisionOpen} type="text" inputMode="text" enterKeyHint="done" autoComplete="off" autoCapitalize="none" value={endText} onChange={event => { setEndText(event.target.value); setRangeError(''); }} onBlur={commitFields} onKeyDown={timeFieldKey} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'range-error' : 'time-hint'} spellCheck={false} /><button className="marker-button" type="button" disabled={!playerAvailable} aria-label={t('Конец по позиции плеера')} onClick={() => marker('end')}><span className="marker-bracket">]</span>{t('Конец здесь')}<kbd>O</kbd></button></div><div className="moment-duration"><span>{t('Длительность')}</span><strong>{durationLabel(selected.end_ms - selected.start_ms, locale)}</strong></div></div>
            <Timeline duration={duration} position={position} ranges={ranges} selected={selected} view={precisionOpen ? view : simpleView} showOverview={precisionOpen} onSeek={seek} onRange={changeBounds} onReveal={revealBoundary} onBeginChange={beginHistory} onEndChange={finishHistory} audioTrack={previewAudioTrack} noAudio={output.no_audio} sourceID={source.id} active={step === 2} />
            <CropEditor key={source.id} value={output.crop} onChange={crop => setOutput(previous => ({ ...previous, crop }))}
              displayWidth={displayGeometry?.id === source.id ? displayGeometry.width : 0} displayHeight={displayGeometry?.id === source.id ? displayGeometry.height : 0}
              locale={locale} disabled={busy || output.format !== 'mp4' || output.cut_mode !== 'accurate'} previewContainer={cropContainer}
              onBeginChange={beginHistory} onEndChange={finishHistory} onOpenChange={setCropOpen} />
            <div className="moment-selection-tools"><span>{t('Фрагмент до {limit}', { limit: durationLabel(limits.max_range_ms, locale) })}</span>{duration <= Math.min(limits.max_range_ms, limits.max_job_ms) && <button type="button" className="text-button" disabled={busy} onClick={() => { changeBounds(0, duration); setSimpleView([0, duration]); setViewCenter(duration / 2); }}>{t('Выбрать всё видео')}</button>}</div>
            <div className="moment-preview"><button className="button secondary" type="button" disabled={!playerAvailable} onClick={preview}><Icon name={previewing ? 'pause' : 'play'} size={17} />{previewing ? t('Остановить просмотр') : t('Посмотреть фрагмент')}</button><button className="text-button precision-toggle" type="button" aria-expanded={precisionOpen} aria-controls="range-start range-end precision-controls" onClick={() => { if (precisionOpen && invalidDraft) { validateFields(true); return; } if (precisionOpen) setSimpleView(simpleRangeView(duration, selected)); setPrecisionOpen(!precisionOpen); setViewCenter((selected.start_ms + selected.end_ms) / 2); }}>{t('Точное время и шкала')}<Icon name="chevron" size={15} style={{ transform: precisionOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }} /></button></div>
            <div className="boundary-audition" role="group" aria-label={t('Проверить границы')}><button type="button" className="text-button" disabled={!playerAvailable} onClick={() => audition('start')}><Icon name="play" size={13} />{t('Проверить начало')}</button><button type="button" className="text-button" disabled={!playerAvailable} onClick={() => audition('end')}><Icon name="play" size={13} />{t('Проверить конец')}</button><span>{t('По 1,5 с до и после границы')}</span></div>
            <div id="precision-controls" className="precision-controls" hidden={!precisionOpen}>
              <p id="time-hint" className="field-hint">{t('Часы:минуты:секунды. Можно ввести 83:10 или 01:23:10.250.')}</p>
              <div className="boundary-steps">{(['start', 'end'] as const).map(which => <div key={which} role="group" aria-label={t(which === 'start' ? 'Сдвиг начала' : 'Сдвиг конца')}><span>{t(which === 'start' ? 'Начало' : 'Конец')}</span><button type="button" aria-label={t(which === 'start' ? 'Начало на 0,1 с раньше' : 'Конец на 0,1 с раньше')} onClick={() => nudgeBoundary(which, -100)}>{locale === 'en' ? '−0.1' : '−0,1'} {t('с')}</button><button type="button" aria-label={t(which === 'start' ? 'Начало на 0,1 с позже' : 'Конец на 0,1 с позже')} onClick={() => nudgeBoundary(which, 100)}>{locale === 'en' ? '+0.1' : '+0,1'} {t('с')}</button></div>)}</div><div className="precision-zoom"><label htmlFor="zoom">{t('Масштаб шкалы')}</label><div className="zoom-controls"><button type="button" className="icon-button" aria-label={t('Предыдущий участок шкалы')} disabled={view[0] <= 0} onClick={() => setViewCenter(Math.max(0, viewCenter - span / 2))}><Icon name="chevron" size={16} style={{ transform: 'rotate(180deg)' }} /></button><SelectControl id="zoom" value={String(span)} label={t('Масштаб шкалы')} onChange={value => { setSpan(Number(value)); setViewCenter((selected.start_ms + selected.end_ms) / 2); }} options={zoomOptions.map(value => ({ value: String(value), label: value === duration ? t('Всё видео') : value === 300000 ? t('5 минут') : value === 60000 ? t('1 минута') : t('10 секунд') }))} /><button type="button" className="icon-button" aria-label={t('Следующий участок шкалы')} disabled={view[1] >= duration} onClick={() => setViewCenter(Math.min(duration, viewCenter + span / 2))}><Icon name="chevron" size={16} /></button></div><button className="text-button" type="button" onClick={fitSelection}>{t('Показать границы')}</button></div>
            </div>
            {rangeError && <p id="range-error" className="error-message" role="alert">{rangeError === 'Фрагмент превышает лимит сервиса. Сократите его.' ? t('Один фрагмент может длиться до {limit}.', { limit: durationLabel(limits.max_range_ms, locale) }) : t(rangeError)}</p>}
          </div>}
          </div>
        </div>
        <div className="stage-actions"><div className="moment-secondary-actions"><button className="text-button change-source" type="button" onClick={() => goToStep(1)}><Icon name="link" size={17} />{t('Другое видео')}</button><button className="text-button" type="button" onClick={() => setShowShortcuts(!showShortcuts)} aria-expanded={showShortcuts}><span className="keycap">?</span>{t('Горячие клавиши')}</button></div><div className="moment-next-actions"><button className="button primary" type="button" onClick={() => finishMoment(4)} disabled={sourceBusy || !selected}>{t('К скачиванию')}<Icon name="download" size={17} /></button><button className="button secondary" type="button" onClick={() => finishMoment(3)} disabled={sourceBusy || !selected}>{t('Список фрагментов')}</button></div></div>
        {showShortcuts && <div className="shortcut-guide"><span><kbd>I</kbd>{t('начало по позиции плеера')}</span><span><kbd>O</kbd>{t('конец')}</span><span><kbd>{t('Пробел')}</kbd>{t('пауза / воспроизведение')}</span><span><kbd>←</kbd><kbd>→</kbd>{t('перемотка или ручка: 0,1 с;')}<kbd>Shift</kbd>{t(': 1 с')}</span><p>{t('Клавиши I, O и пробел работают вне полей ввода. В плеере действуют его собственные клавиши.')}</p></div>}
      </section>}
      {step === 3 && source && <ClipLibrary limit={limits.max_ranges} ranges={ranges} selectedIds={selectedRangeIds} editedId={selectedId} revealId={revealId} onSelect={id => { setSelectedRangeIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]); setRevealId(id); }} onSelectAll={() => setSelectedRangeIds(exportRanges.length === ranges.length ? [] : ranges.map(range => range.id))} onEdit={pickRange} onAdd={addRange} onBeginChange={beginHistory} onEndChange={finishHistory} onMove={moveRange} onLabel={(id, label) => { rememberHistory(); setRanges(previous => previous.map(range => range.id === id ? { ...range, label } : range)); }} onDuplicate={duplicateSelected} onDelete={() => removeSelected(selectedRangeIds)} onDeleteOne={id => removeSelected([id])} onExport={() => goToStep(4)} />}
      {step === 4 && (source || job) && <div className="output-stage">
        {resultsPanel}
        {source && <div className="output-grid"><div className="output-overview"><section className="output-selection" aria-labelledby="output-selection-heading"><div className="output-source"><Icon name="file" size={20} /><span>{source.title}</span></div><h2 id="output-selection-heading">{t('Выбранные фрагменты')}</h2>{!exportRanges.length && <p className="field-hint">{t('Выберите хотя бы один фрагмент для экспорта.')}</p>}<ol>{exportRanges.map((range, index) => <li key={range.id}><span className="range-index">{index + 1}</span><div><strong>{range.label || `${t('Фрагмент')} ${ranges.findIndex(original => original.id === range.id) + 1}`}</strong><span>{displayTimecode(range.start_ms)} — {displayTimecode(range.end_ms)}</span></div><span>{durationLabel(range.end_ms - range.start_ms, locale)}</span></li>)}</ol><button className="text-button" type="button" onClick={() => goToStep(3)}><Icon name="chevron" size={17} style={{ transform: 'rotate(180deg)' }} />{t('К списку фрагментов')}</button></section></div>
        <section className="export-panel" aria-labelledby="export-heading"><form onSubmit={exportClips}>
          <div className="export-heading"><Icon name="download" size={20} /><h2 id="export-heading">{t("Экспорт")}</h2></div>
          <fieldset disabled={!source || submitting || activeJob(job)}><legend className="sr-only">{t("Настройки экспорта")}</legend>
            <div className="format-picker" role="group" aria-label={t("Формат файла")}><button type="button" className={output.format !== 'mp3' ? 'active' : ''} onClick={() => setOutput(previous => ({ ...previous, format: previous.format === 'mkv' ? 'mkv' : 'mp4' }))} aria-pressed={output.format !== 'mp3'}><strong>{output.format === 'mkv' ? 'MKV' : 'MP4'}</strong><span>{t("Видео")}</span></button><button type="button" disabled={output.no_audio} className={output.format === 'mp3' ? 'active' : ''} onClick={() => setOutput(previous => ({ ...previous, format: 'mp3', cut_mode: 'accurate', subtitle_mode: 'omit' }))} aria-pressed={output.format === 'mp3'}><strong>MP3</strong><span>{t("Аудио")}</span></button></div>
            <div className="export-primary-fields">
              <div className="export-field"><label htmlFor="output-mode">{t('Результат нарезки')}</label><SelectControl id="output-mode" value={output.output_mode ?? 'separate'} label={t('Результат нарезки')} describedBy="output-mode-hint" onChange={value => setOutput(previous => ({ ...previous, output_mode: value as OutputSettings['output_mode'] }))} options={[{ value: 'separate', label: t('Отдельные файлы') }, { value: 'joined', label: t('Один объединённый файл') }]} /><p id="output-mode-hint" className="field-hint">{t(output.output_mode === 'joined' ? 'Фрагменты соединятся в порядке выбранного списка, без промежутков между ними.' : 'Каждый выбранный фрагмент станет отдельным файлом.')}</p></div>
              <AudioTrackSelector id="audio-track-export" output={output} tracks={tracks} loading={tracksLoading} error={tracksError} onChange={changeAudio} onRetry={() => setTrackRevision(value => value + 1)} />
              {output.no_audio && <p className="field-hint">{t('Чтобы сохранить MP3, выберите аудиодорожку.')}</p>}
            </div>
            {output.format === 'mp4' && totalDuration >= 10 * 60 * 1000 && <div className="long-export-choice"><strong>{t(output.cut_mode === 'copy' ? 'Быстрый экспорт включён' : 'Длинную запись можно сохранить быстрее')}</strong><p>{t(output.cut_mode === 'copy' ? 'Сохраним видео без перекодирования. Начало может сдвинуться до ближайшего ключевого кадра.' : 'Без перекодирования сохраняется качество записи и сокращается время обработки. Для точных границ оставьте текущий режим.')}</p>{output.cut_mode === 'accurate' && <button type="button" className="button secondary" onClick={() => setOutput(previous => ({ ...previous, cut_mode: 'copy' }))}>{t('Ускорить без перекодирования')}</button>}</div>}
            <details className="export-options" open={advancedOutputOpen} onToggle={event => setAdvancedOutputOpen(event.currentTarget.open)}><summary>{t('Качество и точность')}<Icon name="chevron" size={15} /></summary><div className="export-option-fields">
            {output.format !== 'mp3' && <div className="export-field"><label htmlFor="quality">{t("Качество видео")}</label><SelectControl id="quality" value={output.quality} disabled={preserveLocalQuality} onChange={value => setOutput(previous => ({ ...previous, quality: value as OutputSettings['quality'] }))} options={preserveLocalQuality ? [{ value: output.quality, label: t('Исходное качество') }] : [{ value: '1080p', label: t('До 1080p') }, { value: '720p', label: t('До 720p') }, { value: 'best', label: t('Лучшее доступное') }]} /><p className="field-hint">{t(preserveLocalQuality ? 'Видео сохраняется без перекодирования, в качестве исходного файла.' : 'Качество выше исходного не создаётся.')}</p></div>}
            <div className="export-field"><label htmlFor="cut-mode">{t("Границы и качество")}</label><SelectControl id="cut-mode" value={output.cut_mode} disabled={output.format === 'mp3'} onChange={value => setOutput(previous => ({ ...previous, cut_mode: value as OutputSettings['cut_mode'], ...(value === 'accurate' ? { subtitle_mode: 'omit' as const } : {}) }))} options={[{ value: 'accurate', label: t('Точные границы'), disabled: output.format === 'mkv' }, { value: 'copy', label: t('Исходное качество') }]} /><p className="mode-hint">{output.format === 'mp3' ? t("Аудио будет преобразовано в MP3.") : output.cut_mode === 'accurate' ? t("Видео будет перекодировано. Начало и конец — по выбранным таймкодам.") : t(output.format === 'mkv' ? 'Без перекодирования. Границы могут сдвинуться; сохраняются совместимые потоки MKV.' : 'Без перекодирования. Границы могут сдвинуться; некоторые кодеки несовместимы с MP4.')}</p></div>
            {(videoCopy || output.format === 'mkv') && <div className="export-field"><label htmlFor="copy-container">{t('Контейнер исходного качества')}</label><SelectControl id="copy-container" value={output.format} label={t('Контейнер исходного качества')} onChange={value => setOutput(previous => ({ ...previous, format: value as OutputSettings['format'] }))} options={[{ value: 'mp4', label: 'MP4' }, { value: 'mkv', label: 'MKV', disabled: !videoCopy }]} /><p className="field-hint">{t('MKV доступен при копировании. Чтобы выбрать точные границы, переключитесь на MP4.')}</p></div>}
            {(preserveLocalQuality && subtitleTracks.length > 0 || output.subtitle_mode === 'preserve') && <div className="export-field"><label htmlFor="subtitle-mode">{t('Субтитры')}</label><SelectControl id="subtitle-mode" value={output.subtitle_mode ?? 'omit'} label={t('Субтитры')} onChange={value => setOutput(previous => ({ ...previous, subtitle_mode: value as OutputSettings['subtitle_mode'] }))} options={[{ value: 'omit', label: t('Исключить субтитры') }, { value: 'preserve', label: t('Сохранить текстовые субтитры'), disabled: !canPreserveSubtitles }]} /><p className="field-hint">{t(canPreserveSubtitles ? 'Текстовые субтитры сохранятся со временем каждого фрагмента. Оформление будет упрощено.' : source.kind === 'platform' || source.kind === 'youtube' ? 'Для сохранения субтитров площадки загрузите исходный файл и выберите копирование.' : 'Есть неподдерживаемые субтитры. ASS, SSA и графические субтитры сохранить пока нельзя.')}</p></div>}
            </div></details>
          </fieldset>
          <div className="export-track-summary" aria-label={t('Дорожки результата')}>
            <p>{t(output.format === 'mp3' ? 'Видео будет исключено.' : 'Сохраним одну видеодорожку.')}{' '}{output.no_audio ? t('Звук будет исключён.') : selectedAudio ? trackLabel(selectedAudio, t) : tracks !== null && audioTracks.length === 0 ? t('В источнике нет звука.') : t('Сохраним аудиодорожку по умолчанию.')}</p>
            {audioTracks.length > 1 && <p>{t('Остальные аудиодорожки будут исключены.')}</p>}
            <p>{t(output.subtitle_mode === 'preserve' ? 'Сохраним совместимые текстовые субтитры; время будет сдвинуто к началу фрагмента.' : 'Субтитры, вложения и служебные дорожки будут исключены.')}</p>
            {tracks !== null && <details className="artifact-details"><summary>{t('Все дорожки источника')}</summary><ul>{tracks.map(track => <li key={track.index}><strong>{t(includedTracks.has(track.index) ? 'Включена' : 'Исключена')}</strong>{': '}{trackLabel(track, t)}</li>)}</ul></details>}
          </div>
          {invalidAudio && <p className="error-message" role="alert">{t('Выбранная аудиодорожка недоступна. Выберите другую дорожку.')}</p>}
          {!incompatibleCrop && incompatibleOutput && <p className="error-message" role="alert">{t('Эти настройки требуют исходного файла и режима копирования. Выберите MP4 и исключите субтитры либо загрузите исходный файл.')}</p>}
          {incompatibleCrop && <div className="crop-export-conflict" role="alert"><p>{t('Выбранный кадр требует точного MP4. Выберите совместимый режим или сбросьте кадр.')}</p>
            <button type="button" className="text-button" onClick={() => { rememberHistory(); setOutput(previous => ({ ...previous, format: 'mp4', cut_mode: 'accurate', subtitle_mode: 'omit' })); }}>{t('Выбрать точный MP4')}</button>
            <button type="button" className="text-button" onClick={() => { rememberHistory(); setOutput(previous => ({ ...previous, crop: undefined })); }}>{t('Сбросить кадр')}</button></div>}
          <label className="source-cleanup-choice"><input type="checkbox" checked={output.cleanup_source !== false} disabled={busy} onChange={event => setOutput(previous => ({ ...previous, cleanup_source: event.target.checked }))} />{t('Удалить исходник после экспорта')}</label>
          <p className="field-hint source-cleanup-hint">{t('Готовые клипы и проект сохранятся. Для новой нарезки удалённую запись понадобится открыть заново.')}</p>
          {videoCopy && <p className="copy-boundary-warning" role="note">{t('Копирование сохраняет исходное качество. Начало может сдвинуться к ключевому кадру; фактические границы будут указаны у готового файла.')}</p>}
          <p className="field-hint export-limits">{t('Один фрагмент — до {range}; весь экспорт — до {total}.', { range: durationLabel(limits.max_range_ms, locale), total: durationLabel(limits.max_job_ms, locale) })}</p>{limits.max_output_bytes && <p className="field-hint export-limits">{t('Готовый файл — до {limit}.', { limit: formatBytes(limits.max_output_bytes, locale) })}</p>}{exportLimitError && <p className="error-message" role="alert">{exportLimitError}</p>}<div className="export-summary"><span>{source ? countLabel(exportRanges.length, 'clip', locale) : t("Фрагменты не выбраны")}</span>{source && <strong>{durationLabel(totalDuration, locale)}</strong>}</div>
          <button className="button primary export-submit" type="submit" disabled={!source || !exportRanges.length || busy || sourceBusy || invalidDraft || !!exportLimitError || invalidAudio || incompatibleOutput}>{submitting ? <><span className="spinner" />{t("Создаём задание…")}</> : activeJob(job) ? <><span className="spinner" />{t("Идёт обработка…")}</> : <><Icon name="cut" size={18} />{repeatExport ? t('Повторить экспорт') : exportRanges.length > 1 ? t("Вырезать фрагменты") : t("Вырезать фрагмент")}</>}</button>
          {!source && <p className="export-empty-hint">{t("Сначала откройте видео.")}</p>}
          {source && <p className="export-empty-hint">{t("Результат:")}{' '}{output.output_mode === 'joined' || exportRanges.length === 1 ? t("один файл") : t("отдельные файлы")} {output.format.toUpperCase()}.</p>}
        </form>
        {jobProgress}
        {jobError && <p className="error-message" role="alert">{t(jobError)}</p>}
        </section>
        </div>}
        {!source && <section className="export-panel orphan-results"><p className="field-hint">{t(files.length > 0 ? 'Видео больше недоступно, но результат экспорта сохранился. Чтобы вырезать новые моменты, откройте видео заново.' : 'Задание экспорта сохранилось, но видео больше недоступно. Чтобы вырезать новые моменты, откройте его заново.')}</p><button className="text-button" type="button" onClick={() => goToStep(1)}>{t('Открыть другое видео')}</button>{jobProgress}{jobError && <p className="error-message" role="alert">{t(jobError)}</p>}</section>}

      </div>}
      <footer className="page-footer"><span>cutmyvideo <span className="footer-dot">·</span> {t('Ссылки и видеофайлы')}</span><a href="https://github.com/Kay0k1/cutmyvideo-core" target="_blank" rel="noreferrer">{t('Открытое ядро на GitHub')}</a></footer>
      <div className="sr-only" role="status" aria-live="polite">{t(notice)}</div>
    </main>
  </>;
}
