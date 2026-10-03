import { useLanguage } from './Language';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage } from './api';
import { Icon } from './Icons';
import { Player } from './Player';
import type { PlayerControls } from './Player';
import { Timeline } from './Timeline';
import { displayTimecode, durationLabel, formatBytes, formatTimecode, parseTimecode, validateRange, zoomWindow } from './timecode';
import type { ClipRange, Job, OutputSettings, Source } from './types';
import { countLabel } from './locales';
import { LanguageSwitch, WorkspaceNav } from './WorkspaceNav';
import { SourceChooser } from './SourceChooser';
import { ThemeToggle } from './Theme';
import { canonicalSourceUrl, providerName, validateMP4 } from './sourceInput';
import { readPreferences, savePreferences } from './preferences';
import type { Preferences } from './preferences';
import { SelectControl } from './SelectControl';
import { ClipLibrary } from './ClipLibrary';
import { duplicateRanges, markBounds, maxClips, rangeSelection, removeRanges, restoredStep } from './clipCollection';
import type { WorkbenchStep } from './clipCollection';

const storageKey = 'cutmy.workbench.v1';
const activeJob = (job: Job | null) => job?.status === 'queued' || job?.status === 'running';
const stageNames: Record<string, string> = {
  queued: 'В очереди', preparing: 'Готовим обработку', resolving: 'Проверяем источник', resolve: 'Проверяем источник', fetching: 'Получаем видео', fetch: 'Получаем видео',
  downloading: 'Получаем видео', processing: 'Вырезаем фрагменты', process: 'Вырезаем фрагменты',
  verifying: 'Проверяем файлы', verify: 'Проверяем файлы', publish: 'Готовим скачивание',
  publishing: 'Сохраняем файл', finished: 'Обработка завершена', succeeded: 'Файлы готовы', failed: 'Обработка остановлена', cancelled: 'Обработка отменена',
};

function jobDescription(job: Job, t: (text: string, values?: Record<string, string | number>) => string): string {
  if (job.status === 'queued') return t('Задание сохранено. Можно закрыть страницу и вернуться позже.');
  if (job.status === 'cancelled') return t(job.items.some(item => item.artifact) ? 'Новые фрагменты не создаются. Готовые файлы можно скачать.' : 'Обработка отменена. Можно изменить моменты или настройки и вырезать снова.');
  if (job.status === 'succeeded') return t('Все фрагменты готовы к скачиванию.');
  if (job.status === 'failed') return t(job.items.some(item => item.artifact)
    ? 'Часть фрагментов не удалось обработать. Готовые файлы доступны ниже.'
    : 'Не удалось создать фрагменты. Измените настройки экспорта или попробуйте другой источник.');
  const position = job.items.findIndex(item => item.status === 'running');
  if (position >= 0) return t('Фрагмент {index} из {total}.', { index: position + 1, total: job.items.length });
  return t('Задание выполняется. Страница обновляется автоматически.');
}

function newRange(duration: number, start = 0): ClipRange {
  const begin = Math.max(0, Math.min(start, duration - 100));
  return { id: crypto.randomUUID(), label: '', start_ms: begin, end_ms: Math.min(duration, begin + 30000) };
}

function simpleRangeView(duration: number, range: ClipRange): [number, number] {
  return zoomWindow(duration, (range.start_ms + range.end_ms) / 2, Math.min(duration, Math.max(60000, (range.end_ms - range.start_ms) * 2)));
}

function rememberedDraft(): { source_id?: string; ranges?: ClipRange[]; selected_id?: string; selected_range_ids?: unknown; output?: OutputSettings; job_id?: string; job_range_numbers?: number[]; step?: number; current_ms?: number; workflow_version?: number; precision_open?: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (typeof value !== 'object' || value === null) return {};
    return value;
  } catch { return {}; }
}

export default function App() {
  const { locale, t } = useLanguage();
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const [step, setStep] = useState<WorkbenchStep>(1);
  const [source, setSource] = useState<Source | null>(null);
  const [url, setUrl] = useState('');
  const [sourceBusy, setSourceBusy] = useState(false);
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
  const [current, setCurrent] = useState(0);
  const [playerAvailable, setPlayerAvailable] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [span, setSpan] = useState(preferences.timeline_span);
  const [viewCenter, setViewCenter] = useState(15000);
  const [simpleView, setSimpleView] = useState<[number, number]>([0, 60000]);
  const [output, setOutput] = useState<OutputSettings>(preferences.output);
  const [job, setJob] = useState<Job | null>(null);
  const [jobRangeNumbers, setJobRangeNumbers] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [jobError, setJobError] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [notice, setNotice] = useState('');
  const player = useRef<PlayerControls>(null);
  const previewEnd = useRef<number | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const startField = useRef<HTMLInputElement>(null);
  const endField = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);
  const restoredPosition = useRef<number | null>(null);
  const selected = ranges.find(range => range.id === selectedId) ?? ranges[0];
  const exportRanges = ranges.filter(range => selectedRangeIds.includes(range.id));
  const busy = activeJob(job) || submitting;
  const duration = source?.duration_ms ?? 0;
  const view = zoomWindow(duration, viewCenter, span);
  const zoomOptions = [duration, 300000, 60000, 10000].filter((value, index, all) => value > 0 && value <= duration && all.indexOf(value) === index);
  const totalDuration = exportRanges.reduce((sum, range) => sum + range.end_ms - range.start_ms, 0);
  const invalidDraft = !!selected && !!validateRange(parseTimecode(startText), parseTimecode(endText), duration);
  const preserveLocalQuality = output.cut_mode === 'copy' && (source?.kind === 'upload' || source?.kind === 'direct');

  const setFields = useCallback((range: ClipRange) => {
    setStartText(formatTimecode(range.start_ms, true));
    setEndText(formatTimecode(range.end_ms, true));
    setRangeError('');
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        await api.session();
        if (disposed) return;
        if (!restored.current) {
          const saved = rememberedDraft();
          const savedStep = restoredStep(saved.step, saved.workflow_version);
          let sourceWasRestored = false;
          let sourceStep: WorkbenchStep | undefined;
          if (typeof saved.source_id === 'string') {
            try {
              const original = await api.source(saved.source_id);
              if (disposed) return;
              const valid = Array.isArray(saved.ranges) ? saved.ranges.filter(range => typeof range.id === 'string' && typeof range.label === 'string' && Number.isFinite(range.start_ms) && Number.isFinite(range.end_ms) && !validateRange(range.start_ms, range.end_ms, original.duration_ms)).slice(0, maxClips) : [];
              const restoredRanges = valid.length || saved.ranges?.length === 0 ? valid : [newRange(original.duration_ms)];
              const active = restoredRanges.find(range => range.id === saved.selected_id) ?? restoredRanges[0];
              setSource(original); setRanges(restoredRanges); setSelectedId(active?.id ?? ''); if (active) setFields(active);
              setSelectedRangeIds(rangeSelection(restoredRanges, saved.selected_range_ids)); setRevealId(active?.id ?? '');
              setPrecisionOpen(saved.precision_open === true || original.preview_kind === 'none' || (!original.preview_url && !original.embed_url));
              sourceStep = !active && (savedStep === 2 || savedStep === undefined) ? 3 : savedStep ?? 2;
              sourceWasRestored = true; setStep(sourceStep);
              const position = typeof saved.current_ms === 'number' && Number.isFinite(saved.current_ms) ? Math.max(0, Math.min(original.duration_ms, saved.current_ms)) : 0;
              restoredPosition.current = position; setCurrent(position);
              setViewCenter(active ? (active.start_ms + active.end_ms) / 2 : 0);
              if (active) setSimpleView(simpleRangeView(original.duration_ms, active));
              setSpan(Math.min(original.duration_ms, preferences.timeline_span));
              if (saved.output && ['mp4', 'mp3'].includes(saved.output.format) && ['best', '1080p', '720p'].includes(saved.output.quality) && ['copy', 'accurate'].includes(saved.output.cut_mode)) setOutput(saved.output);
            } catch { if (!disposed) setSourceError('Предыдущий источник больше недоступен. Откройте его заново.'); }
          }
          if (typeof saved.job_id === 'string') {
            try { const previous = await api.job(saved.job_id); if (!disposed) { setJob(previous); setJobRangeNumbers(Array.isArray(saved.job_range_numbers) && saved.job_range_numbers.length === previous.items.length && saved.job_range_numbers.every(number => Number.isInteger(number) && number > 0 && number <= maxClips) ? saved.job_range_numbers : previous.items.map((_, index) => index + 1)); setStep(sourceWasRestored ? sourceStep ?? 4 : 4); } } catch { /* Old job may have expired. */ }
          }
          restored.current = true;
        }
        if (!disposed) setSessionReady(true);
      } catch (error) { if (!disposed) setSourceError(errorMessage(error)); }
    })();
    return () => { disposed = true; };
  }, [sessionAttempt, setFields]);

  useEffect(() => {
    if (!sessionReady || !source) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ workflow_version: 2, source_id: source.id, ranges, selected_id: selectedId, selected_range_ids: selectedRangeIds, output, job_id: job?.id, job_range_numbers: jobRangeNumbers, step, current_ms: current, precision_open: precisionOpen })); }
    catch { /* Editing remains available without browser storage. */ }
  }, [source, ranges, selectedId, selectedRangeIds, output, job?.id, jobRangeNumbers, sessionReady, step, current, precisionOpen]);

  useEffect(() => {
    if (!job || !activeJob(job)) return;
    let disposed = false;
    let timer: number;
    const poll = async () => {
      try {
        const fresh = await api.job(job.id);
        if (disposed) return;
        setJob(fresh); setJobError('');
        if (activeJob(fresh)) timer = window.setTimeout(poll, 1500);
      } catch (error) {
        if (!disposed) { setJobError(errorMessage(error)); timer = window.setTimeout(poll, 3000); }
      }
    };
    timer = window.setTimeout(poll, 500);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [job?.id, job?.status]);

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

  function changeBounds(start: number, end: number) {
    if (!selected) return;
    const updated = { ...selected, start_ms: start, end_ms: end };
    setRanges(previous => previous.map(range => range.id === selected.id ? updated : range));
    setFields(updated);
    previewEnd.current = null; setPreviewing(false);
  }

  function validateFields(focus = false): ClipRange | null {
    if (!selected) return null;
    const start = parseTimecode(startText);
    const end = parseTimecode(endText);
    const error = validateRange(start, end, duration);
    setRangeError(error ?? '');
    if (error) {
      setPrecisionOpen(true);
      if (focus) window.requestAnimationFrame(() => { if (start === null || start < 0 || start >= duration) startField.current?.focus(); else endField.current?.focus(); });
      return null;
    }
    return { ...selected, start_ms: start!, end_ms: end! };
  }

  function commitFields() {
    const range = validateFields();
    if (range) {
      setRanges(previous => previous.map(item => item.id === range.id ? range : item));
      setViewCenter((range.start_ms + range.end_ms) / 2);
      setSimpleView(simpleRangeView(duration, range));
    }
  }

  function seek(ms: number) {
    const value = Math.max(0, Math.min(duration, ms));
    previewEnd.current = null; setPreviewing(false);
    setCurrent(value); player.current?.seek(value);
  }

  function marker(which: 'start' | 'end') {
    if (!selected) return;
    const [start, end] = markBounds(selected, current, which, duration);
    const error = validateRange(start, end, duration);
    if (error) { setRangeError(error); return; }
    changeBounds(start, end); setViewCenter((start + end) / 2); setSimpleView(simpleRangeView(duration, { ...selected, start_ms: start, end_ms: end }));
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]')) return;
      if ((event.target as HTMLElement).closest('input, textarea, select, button, a, [contenteditable], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"]')) return;
      if (step !== 2 || !source || !selected) return;
      if (event.code === 'KeyI') { event.preventDefault(); marker('start'); }
      if (event.code === 'KeyO') { event.preventDefault(); marker('end'); }
      if (event.code === 'Space' && playerAvailable) { event.preventDefault(); player.current?.toggle(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  async function openSource(file?: File, providedUrl?: string) {
    if (!sessionReady || sourceBusy || busy) return;
    const candidateUrl = canonicalSourceUrl(providedUrl ?? url);
    if (!file && !candidateUrl) {
      setStep(1); setSourceError('Вставьте ссылку на видео с поддерживаемого сайта или публичную HTTPS-ссылку на файл.');
      document.getElementById('source-url')?.focus(); return;
    }
    sourceController.current?.abort();
    const controller = new AbortController(); sourceController.current = controller;
    setSourceBusy(true); setSourceError(''); setNotice('');
    try {
      if (file) {
        const fileError = await validateMP4(file);
        if (controller.signal.aborted) return;
        if (fileError) { setSourceError(fileError); setStep(1); return; }
      }
      const opened = file ? await api.upload(file, controller.signal) : await api.open(candidateUrl!, controller.signal);
      if (controller.signal.aborted) return;
      if (file && (!opened.width || !opened.height)) { setSourceError('В MP4 не найдено видео. Выберите файл с видеодорожкой.'); setStep(1); return; }
      const range = newRange(opened.duration_ms);
      player.current?.pause(); previewEnd.current = null; restoredPosition.current = null;
      setSource(opened); setRanges([range]); setSelectedId(range.id); setFields(range);
      setSelectedRangeIds([range.id]); setRevealId(range.id); setSimpleView(simpleRangeView(opened.duration_ms, range)); setPrecisionOpen(opened.preview_kind === 'none' || (!opened.preview_url && !opened.embed_url));
      setCurrent(0); setViewCenter((range.start_ms + range.end_ms) / 2); setSpan(Math.min(opened.duration_ms, preferences.timeline_span)); setOutput(preferences.output);
      setJob(null); setJobRangeNumbers([]); setJobError(''); setPreviewing(false); setPlayerAvailable(false); setStep(2);
      if (!file) setUrl(candidateUrl!);
      setNotice('Источник открыт. Укажите границы фрагмента.');
    } catch (error) {
      if (!controller.signal.aborted) setSourceError(errorMessage(error));
    } finally { if (sourceController.current === controller) setSourceBusy(false); }
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
    if (!source || ranges.length >= maxClips) return;
    const committed = selected ? validateFields(true) : null;
    if (selected && !committed) { setStep(2); return; }
    const range = newRange(duration, current);
    setRanges(previous => [...previous.map(item => item.id === committed?.id ? committed! : item), range]);
    setSelectedRangeIds(previous => [...previous, range.id]);
    setSelectedId(range.id); setFields(range); setViewCenter((range.start_ms + range.end_ms) / 2); setSimpleView(simpleRangeView(duration, range));
    setRevealId(range.id); setStep(2);
    setNotice('Фрагмент добавлен. Настройте его границы.');
  }

  function removeSelected(ids: string[]) {
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
    const result = duplicateRanges(ranges, selectedRangeIds, () => crypto.randomUUID());
    if (!result) return;
    setRanges(result.ranges); setSelectedRangeIds(previous => [...previous, ...result.addedIds]);
    setRevealId(result.addedIds.at(-1)!); setNotice('Выбранные фрагменты продублированы.');
  }

  function preview() {
    if (previewing) { player.current?.pause(); previewEnd.current = null; setPreviewing(false); return; }
    const range = validateFields(true);
    if (!range || !playerAvailable) return;
    commitFields(); player.current?.seek(range.start_ms); previewEnd.current = range.end_ms;
    setPreviewing(true); player.current?.play();
  }

  async function exportClips(event: FormEvent) {
    event.preventDefault();
    if (!source || busy || sourceBusy || !exportRanges.length) return;
    const range = selected ? validateFields(true) : null;
    if (selected && !range) { setStep(2); return; }
    const committed = ranges.map(item => item.id === range?.id ? range! : item);
    setRanges(committed); setSubmitting(true); setJobError('');
    try { const included = committed.filter(item => selectedRangeIds.includes(item.id)); const created = await api.createJob(source.id, included, output, crypto.randomUUID()); setJobRangeNumbers(included.map(item => committed.findIndex(original => original.id === item.id) + 1)); setJob(created); }
    catch (error) { setJobError(errorMessage(error)); }
    finally { setSubmitting(false); }
  }

  async function cancelJob() {
    if (!job || cancelling) return;
    setCancelling(true); setJobError('');
    try { setJob(await api.cancel(job.id)); }
    catch (error) { setJobError(errorMessage(error)); }
    finally { setCancelling(false); }
  }

  function applyPreferences(value: Preferences) {
    savePreferences(value); setPreferences(value); setOutput(value.output);
    setSpan(source ? Math.min(source.duration_ms, value.timeline_span) : value.timeline_span);
    if (selected) setViewCenter((selected.start_ms + selected.end_ms) / 2);
    setNotice('Настройки сохранены.');
  }

  const files = job?.items.filter(item => item.artifact) ?? [];
  const sourceProvider = providerName(source?.provider);
  const qualityLabel = source?.width && source?.height ? `${source.width} × ${source.height}` : null;

  const jobProgress = job && <section className={`job-status ${job.status}`} aria-label={t("Состояние экспорта")} aria-live="polite"><p className="job-history-label">{t("Последний экспорт")}</p><div className="job-status-heading">{activeJob(job) ? <span className="spinner" /> : <Icon name={job.status === 'succeeded' ? 'check' : 'file'} size={20} />}<h3>{t(stageNames[job.status === 'running' ? job.stage : job.status] ?? 'Обрабатываем фрагменты')}</h3></div><p>{jobDescription(job, t)}</p><p className="job-file-count">{t('Готово: {count} из {total}', { count: files.length, total: job.items.length })}</p>{job.items.some(item => item.status === 'failed') && <div className="failed-items"><p>{t("Не удалось создать:")}</p><ul>{job.items.filter(item => item.status === 'failed').map(item => <li key={item.id}>{item.label || `${t('Фрагмент')} ${jobRangeNumbers[job.items.indexOf(item)] ?? job.items.indexOf(item) + 1}`}</li>)}</ul><p>{t("Попробуйте точные границы, другое качество или загрузите видео файлом.")}</p></div>}{activeJob(job) && <button type="button" className="button secondary cancel-button" disabled={cancelling} onClick={() => void cancelJob()}>{cancelling ? t("Отменяем…") : t("Отменить обработку")}</button>}</section>;

  const resultsPanel = files.length > 0 && <section className="results-panel" aria-labelledby="results-heading"><div className="results-heading"><div><h2 id="results-heading">{t("Файлы последнего экспорта")}</h2><p>{t("Скачайте каждый фрагмент отдельно.")}</p></div><span className="result-count">{countLabel(files.length, 'file', locale)}</span></div><ul className="file-list">{files.map((item, index) => {
        const artifact = item.artifact!;
        const itemNumber = jobRangeNumbers[job?.items.indexOf(item) ?? index] ?? (job?.items.indexOf(item) ?? index) + 1;
        const adjusted = Math.abs(artifact.actual_start_ms - item.start_ms) > 100 || Math.abs(artifact.actual_end_ms - item.end_ms) > 100;
        return <li key={artifact.id}><span className="file-icon"><Icon name="file" size={23} /></span><div className="file-description"><h3>{item.label || `${t('Фрагмент')} ${itemNumber}`}</h3><p>{artifact.filename}</p><span>{formatBytes(artifact.size_bytes, locale)}<span className="meta-separator"> / </span>{formatTimecode(artifact.actual_start_ms, true)} — {formatTimecode(artifact.actual_end_ms, true)}</span>{adjusted && <p className="adjusted-note">{t("Фактические границы отличаются от выбранных.")}</p>}</div><a className="button secondary download-button" href={artifact.download_url} download={artifact.filename}><Icon name="download" size={17} />{t("Скачать")}</a></li>;
      })}</ul></section>;

  const stageTitles = ['Откройте видео', 'Выберите один момент', 'Соберите фрагменты', 'Сохраните фрагменты'];
  const stageDescriptions = ['Ссылка на видео или MP4 с вашего устройства.', 'Отметьте начало и конец одного фрагмента.', 'Отметьте, что вырезать. Здесь же можно добавить или изменить моменты.', 'Выберите видео или аудио и скачайте результат.'];

  return <>
    <a className="skip-link" href="#editor">{t('К выбору фрагмента')}</a>
    <header className="site-header"><div className="header-inner">
      <a className="brand" href="/" aria-label={t('cutmyvideo — главная')}><span className="brand-symbol"><Icon name="cut" size={20} /></span><span>cutmy<span className="brand-suffix">video</span></span></a>
      <WorkspaceNav preferences={preferences} onSave={applyPreferences} busy={!sessionReady || sourceBusy || busy} onExample={value => { setUrl(value); setStep(1); void openSource(undefined, value); }} />
      <div className="header-actions"><LanguageSwitch /><ThemeToggle /></div>
    </div></header>
    <main id="editor" className={`stage-page stage-${step}`}>
      <nav className="steps-nav" aria-label={t('Шаги работы')}><ol>{(['Видео', 'Момент', 'Фрагменты', 'Экспорт'] as const).map((label, index) => <li key={label}><button type="button" disabled={sourceBusy || (index > 0 && !source && !(index === 3 && job)) || (index === 3 && !exportRanges.length && !job) || (index === 1 && !ranges.length)} aria-current={step === index + 1 ? 'step' : undefined} onClick={() => goToStep((index + 1) as WorkbenchStep)}><span className="step-number">{index + 1}</span><span>{t(label)}</span></button>{index < 3 && <span className="step-connector" aria-hidden="true" />}</li>)}</ol></nav>
      <div className="page-heading"><div><p className="step-caption">{t('Шаг {current} из 4', { current: step })}</p><h1 ref={stageHeading} tabIndex={-1}>{t(stageTitles[step - 1])}</h1><p>{t(stageDescriptions[step - 1])}</p></div>{step > 2 && <button className="text-button change-source" type="button" onClick={() => goToStep(1)}><Icon name="link" size={17} />{t('Другое видео')}</button>}</div>
      {step === 1 && <SourceChooser url={url} onUrl={value => { setUrl(value); setSourceError(''); }} onOpen={() => void openSource()} onFile={file => void openSource(file)} busy={sourceBusy} processing={busy} ready={sessionReady} error={sourceError} onCancel={() => { sourceController.current?.abort(); setSourceBusy(false); }} onReconnect={() => { setSourceError(''); setSessionAttempt(n => n + 1); }} />}
      {source && <section className="moments-stage" hidden={step !== 2} aria-label={t('Выбор одного момента')}>
        <div className="editing-panel">
          <div className="media-heading"><div className="source-title"><Icon name="file" size={18} /><span>{source.title}</span>{sourceProvider && <span className="source-provider">{t(sourceProvider)}</span>}</div><span className="source-meta">{qualityLabel && <>{qualityLabel}<span className="meta-separator"> / </span></>}{formatTimecode(duration)}</span></div>
          <div className="moment-layout">
          <Player ref={player} source={source} onAvailable={available => { setPlayerAvailable(available); if (available && restoredPosition.current !== null) { player.current?.seek(restoredPosition.current); restoredPosition.current = null; } }} onTime={ms => {
            setCurrent(Math.min(duration, ms));
            if (previewEnd.current !== null && ms >= previewEnd.current) { player.current?.pause(); previewEnd.current = null; setPreviewing(false); }
          }} />
          {selected && <div className="moment-controls">
            <div className="moment-boundaries"><div><label htmlFor="range-start">{t('Начало')}</label><strong hidden={precisionOpen}>{displayTimecode(selected.start_ms)}</strong><input ref={startField} id="range-start" className="time-input" hidden={!precisionOpen} type="text" inputMode="text" value={startText} onChange={event => { setStartText(event.target.value); setRangeError(''); }} onBlur={commitFields} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitFields(); } }} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'range-error' : 'time-hint'} spellCheck={false} /><button className="marker-button" type="button" disabled={!playerAvailable} aria-label={t('Начало по позиции плеера')} onClick={() => marker('start')}><span className="marker-bracket">[</span>{t('Начало здесь')}<kbd>I</kbd></button></div><div><label htmlFor="range-end">{t('Конец')}</label><strong hidden={precisionOpen}>{displayTimecode(selected.end_ms)}</strong><input ref={endField} id="range-end" className="time-input" hidden={!precisionOpen} type="text" inputMode="text" value={endText} onChange={event => { setEndText(event.target.value); setRangeError(''); }} onBlur={commitFields} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitFields(); } }} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'range-error' : 'time-hint'} spellCheck={false} /><button className="marker-button" type="button" disabled={!playerAvailable} aria-label={t('Конец по позиции плеера')} onClick={() => marker('end')}><span className="marker-bracket">]</span>{t('Конец здесь')}<kbd>O</kbd></button></div><div className="moment-duration"><span>{t('Длительность')}</span><strong>{durationLabel(selected.end_ms - selected.start_ms, locale)}</strong></div></div>
            <Timeline duration={duration} current={current} ranges={ranges} selected={selected} view={precisionOpen ? view : simpleView} showOverview={precisionOpen} onSeek={seek} onRange={changeBounds} />
            <div className="moment-preview"><button className="button secondary" type="button" disabled={!playerAvailable} onClick={preview}><Icon name={previewing ? 'pause' : 'play'} size={17} />{previewing ? t('Остановить просмотр') : t('Посмотреть фрагмент')}</button><button className="text-button precision-toggle" type="button" aria-expanded={precisionOpen} aria-controls="range-start range-end precision-controls" onClick={() => { if (precisionOpen && invalidDraft) { validateFields(true); return; } if (precisionOpen) setSimpleView(simpleRangeView(duration, selected)); setPrecisionOpen(!precisionOpen); setViewCenter((selected.start_ms + selected.end_ms) / 2); }}>{t('Точное время и шкала')}<Icon name="chevron" size={15} style={{ transform: precisionOpen ? 'rotate(-90deg)' : 'rotate(90deg)' }} /></button></div>
            <div id="precision-controls" className="precision-controls" hidden={!precisionOpen}>
              <p id="time-hint" className="field-hint">{t('Часы:минуты:секунды. Можно ввести 83:10 или 01:23:10.250.')}</p>
              <div className="precision-zoom"><label htmlFor="zoom">{t('Масштаб шкалы')}</label><div className="zoom-controls"><button type="button" className="icon-button" aria-label={t('Предыдущий участок шкалы')} disabled={view[0] <= 0} onClick={() => setViewCenter(Math.max(0, viewCenter - span / 2))}><Icon name="chevron" size={16} style={{ transform: 'rotate(180deg)' }} /></button><SelectControl id="zoom" value={String(span)} label={t('Масштаб шкалы')} onChange={value => { setSpan(Number(value)); setViewCenter((selected.start_ms + selected.end_ms) / 2); }} options={zoomOptions.map(value => ({ value: String(value), label: value === duration ? t('Всё видео') : value === 300000 ? t('5 минут') : value === 60000 ? t('1 минута') : t('10 секунд') }))} /><button type="button" className="icon-button" aria-label={t('Следующий участок шкалы')} disabled={view[1] >= duration} onClick={() => setViewCenter(Math.min(duration, viewCenter + span / 2))}><Icon name="chevron" size={16} /></button></div><button className="text-button" type="button" onClick={fitSelection}>{t('Показать границы')}</button></div>
            </div>
            {rangeError && <p id="range-error" className="error-message" role="alert">{t(rangeError)}</p>}
          </div>}
          </div>
        </div>
        <div className="stage-actions"><div className="moment-secondary-actions"><button className="text-button change-source" type="button" onClick={() => goToStep(1)}><Icon name="link" size={17} />{t('Другое видео')}</button><button className="text-button" type="button" onClick={() => setShowShortcuts(!showShortcuts)} aria-expanded={showShortcuts}><span className="keycap">?</span>{t('Горячие клавиши')}</button></div><button className="button primary" type="button" onClick={() => goToStep(3)} disabled={sourceBusy || !selected}>{t('Сохранить фрагмент')}<Icon name="check" size={17} /></button></div>
        {showShortcuts && <div className="shortcut-guide"><span><kbd>I</kbd>{t('начало по позиции плеера')}</span><span><kbd>O</kbd>{t('конец')}</span><span><kbd>{t('Пробел')}</kbd>{t('пауза / воспроизведение')}</span><span><kbd>←</kbd><kbd>→</kbd>{t('на ручке: 0,1 с;')}<kbd>Shift</kbd>{t(': 1 с')}</span><p>{t('Клавиши I, O и пробел работают вне полей ввода. В плеере действуют его собственные клавиши.')}</p></div>}
      </section>}
      {step === 3 && source && <ClipLibrary ranges={ranges} selectedIds={selectedRangeIds} editedId={selectedId} revealId={revealId} onSelect={id => { setSelectedRangeIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]); setRevealId(id); }} onSelectAll={() => setSelectedRangeIds(exportRanges.length === ranges.length ? [] : ranges.map(range => range.id))} onEdit={pickRange} onAdd={addRange} onLabel={(id, label) => setRanges(previous => previous.map(range => range.id === id ? { ...range, label } : range))} onDuplicate={duplicateSelected} onDelete={() => removeSelected(selectedRangeIds)} onDeleteOne={id => removeSelected([id])} onExport={() => goToStep(4)} />}
      {step === 4 && (source || job) && <div className="output-stage">
        {source && <div className="output-grid"><div className="output-overview"><section className="output-selection" aria-labelledby="output-selection-heading"><div className="output-source"><Icon name="file" size={20} /><span>{source.title}</span></div><h2 id="output-selection-heading">{t('Выбранные фрагменты')}</h2>{!exportRanges.length && <p className="field-hint">{t('Выберите хотя бы один фрагмент для экспорта.')}</p>}<ol>{exportRanges.map((range, index) => <li key={range.id}><span className="range-index">{index + 1}</span><div><strong>{range.label || `${t('Фрагмент')} ${ranges.findIndex(original => original.id === range.id) + 1}`}</strong><span>{displayTimecode(range.start_ms)} — {displayTimecode(range.end_ms)}</span></div><span>{durationLabel(range.end_ms - range.start_ms, locale)}</span></li>)}</ol><button className="text-button" type="button" onClick={() => goToStep(3)}><Icon name="chevron" size={17} style={{ transform: 'rotate(180deg)' }} />{t('К списку фрагментов')}</button></section>{resultsPanel}</div>
        <section className="export-panel" aria-labelledby="export-heading"><form onSubmit={exportClips}>
          <div className="export-heading"><Icon name="download" size={20} /><h2 id="export-heading">{t("Экспорт")}</h2></div>
          <fieldset disabled={!source || submitting}><legend className="sr-only">{t("Настройки экспорта")}</legend>
            <div className="format-picker" role="group" aria-label={t("Формат файла")}><button type="button" className={output.format === 'mp4' ? 'active' : ''} onClick={() => setOutput(previous => ({ ...previous, format: 'mp4' }))} aria-pressed={output.format === 'mp4'}><strong>MP4</strong><span>{t("Видео")}</span></button><button type="button" className={output.format === 'mp3' ? 'active' : ''} onClick={() => setOutput(previous => ({ ...previous, format: 'mp3', cut_mode: 'accurate' }))} aria-pressed={output.format === 'mp3'}><strong>MP3</strong><span>{t("Аудио")}</span></button></div>
            {output.format === 'mp4' && <div className="export-field"><label htmlFor="quality">{t("Качество видео")}</label><SelectControl id="quality" value={output.quality} disabled={preserveLocalQuality} onChange={value => setOutput(previous => ({ ...previous, quality: value as OutputSettings['quality'] }))} options={preserveLocalQuality ? [{ value: output.quality, label: t('Исходное качество') }] : [{ value: '1080p', label: t('До 1080p') }, { value: '720p', label: t('До 720p') }, { value: 'best', label: t('Лучшее доступное') }]} /><p className="field-hint">{t(preserveLocalQuality ? 'Видео сохраняется без перекодирования, в качестве исходного файла.' : 'Качество выше исходного не создаётся.')}</p></div>}
            <div className="export-field"><label htmlFor="cut-mode">{t("Границы и качество")}</label><SelectControl id="cut-mode" value={output.cut_mode} disabled={output.format === 'mp3'} onChange={value => setOutput(previous => ({ ...previous, cut_mode: value as OutputSettings['cut_mode'] }))} options={[{ value: 'accurate', label: t('Точные границы') }, { value: 'copy', label: t('Исходное качество') }]} /><p className="mode-hint">{output.format === 'mp3' ? t("Аудио будет преобразовано в MP3.") : output.cut_mode === 'accurate' ? t("Видео будет перекодировано. Начало и конец — по выбранным таймкодам.") : t("Без перекодирования. Границы могут сдвинуться; некоторые кодеки несовместимы с MP4.")}</p></div>
          </fieldset>
          <div className="export-summary"><span>{source ? countLabel(exportRanges.length, 'clip', locale) : t("Фрагменты не выбраны")}</span>{source && <strong>{durationLabel(totalDuration, locale)}</strong>}</div>
          <button className="button primary export-submit" type="submit" disabled={!source || !exportRanges.length || busy || sourceBusy || invalidDraft}>{submitting ? <><span className="spinner" />{t("Создаём задание…")}</> : activeJob(job) ? <><span className="spinner" />{t("Идёт обработка…")}</> : <><Icon name="cut" size={18} />{exportRanges.length > 1 ? t("Вырезать фрагменты") : t("Вырезать фрагмент")}</>}</button>
          {!source && <p className="export-empty-hint">{t("Сначала откройте видео.")}</p>}
          {source && <p className="export-empty-hint">{t("Результат:")}{' '}{exportRanges.length > 1 ? t("отдельные файлы") : t("один файл")} {output.format.toUpperCase()}.</p>}
        </form>
        {jobProgress}
        {jobError && <p className="error-message" role="alert">{t(jobError)}</p>}
        </section>
        </div>}
        {!source && <section className="export-panel orphan-results"><p className="field-hint">{t(files.length > 0 ? 'Видео больше недоступно, но результат экспорта сохранился. Чтобы вырезать новые моменты, откройте видео заново.' : 'Задание экспорта сохранилось, но видео больше недоступно. Чтобы вырезать новые моменты, откройте его заново.')}</p><button className="text-button" type="button" onClick={() => goToStep(1)}>{t('Открыть другое видео')}</button>{jobProgress}{jobError && <p className="error-message" role="alert">{t(jobError)}</p>}</section>}
      {!source && resultsPanel}

      </div>}
      <footer className="page-footer"><span>cutmyvideo <span className="footer-dot">·</span> {t('Ссылки на видео и MP4')}</span><a href="https://github.com/Kay0k1/cutmyvideo-core" target="_blank" rel="noreferrer">{t('Открытое ядро на GitHub')}</a></footer>
      <div className="sr-only" role="status" aria-live="polite">{t(notice)}</div>
    </main>
  </>;
}
