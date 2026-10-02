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
import { readPreferences, savePreferences } from './preferences';
import type { Preferences } from './preferences';

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
  if (job.status === 'cancelled') return t('Новые фрагменты не создаются. Готовые файлы можно скачать.');
  if (job.status === 'succeeded') return t('Все фрагменты готовы к скачиванию.');
  if (job.status === 'failed') return t('Часть фрагментов не удалось обработать. Готовые файлы доступны ниже.');
  const position = job.items.findIndex(item => item.status === 'running');
  if (position >= 0) return t('Фрагмент {index} из {total}.', { index: position + 1, total: job.items.length });
  return t('Задание выполняется. Страница обновляется автоматически.');
}

function newRange(duration: number, start = 0): ClipRange {
  const begin = Math.max(0, Math.min(start, duration - 100));
  return { id: crypto.randomUUID(), label: '', start_ms: begin, end_ms: Math.min(duration, begin + 30000) };
}

function rememberedDraft(): { source_id?: string; ranges?: ClipRange[]; selected_id?: string; output?: OutputSettings; job_id?: string } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (typeof value !== 'object' || value === null) return {};
    return value;
  } catch { return {}; }
}

export default function App() {
  const { locale, t } = useLanguage();
  const [preferences, setPreferences] = useState<Preferences>(readPreferences);
  const [source, setSource] = useState<Source | null>(null);
  const [url, setUrl] = useState('');
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [sourceError, setSourceError] = useState('');
  const [ranges, setRanges] = useState<ClipRange[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [current, setCurrent] = useState(0);
  const [playerAvailable, setPlayerAvailable] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [span, setSpan] = useState(preferences.timeline_span);
  const [viewCenter, setViewCenter] = useState(15000);
  const [output, setOutput] = useState<OutputSettings>(preferences.output);
  const [job, setJob] = useState<Job | null>(null);
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
  const fileInput = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  const sourceInput = useRef<HTMLInputElement>(null);
  const selected = ranges.find(range => range.id === selectedId) ?? ranges[0];
  const busy = activeJob(job) || submitting;
  const duration = source?.duration_ms ?? 0;
  const view = zoomWindow(duration, viewCenter, span);
  const zoomOptions = [duration, 300000, 60000, 10000].filter((value, index, all) => value > 0 && value <= duration && all.indexOf(value) === index);
  const totalDuration = ranges.reduce((sum, range) => sum + range.end_ms - range.start_ms, 0);
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
          if (typeof saved.source_id === 'string') {
            try {
              const original = await api.source(saved.source_id);
              if (disposed) return;
              const valid = Array.isArray(saved.ranges) ? saved.ranges.filter(range => typeof range.id === 'string' && typeof range.label === 'string' && Number.isFinite(range.start_ms) && Number.isFinite(range.end_ms) && !validateRange(range.start_ms, range.end_ms, original.duration_ms)) : [];
              const restoredRanges = valid.length ? valid : [newRange(original.duration_ms)];
              const active = restoredRanges.find(range => range.id === saved.selected_id) ?? restoredRanges[0];
              setSource(original); setRanges(restoredRanges); setSelectedId(active.id); setFields(active);
              setViewCenter((active.start_ms + active.end_ms) / 2);
              setSpan(Math.min(original.duration_ms, preferences.timeline_span));
              if (saved.output && ['mp4', 'mp3'].includes(saved.output.format) && ['best', '1080p', '720p'].includes(saved.output.quality) && ['copy', 'accurate'].includes(saved.output.cut_mode)) setOutput(saved.output);
            } catch { if (!disposed) setSourceError('Предыдущий источник больше недоступен. Откройте его заново.'); }
          }
          if (typeof saved.job_id === 'string') {
            try { const previous = await api.job(saved.job_id); if (!disposed) setJob(previous); } catch { /* Old job may have expired. */ }
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
    try { localStorage.setItem(storageKey, JSON.stringify({ source_id: source.id, ranges, selected_id: selectedId, output, job_id: job?.id })); }
    catch { /* Editing remains available without browser storage. */ }
  }, [source, ranges, selectedId, output, job?.id, sessionReady]);

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
    if (error) { if (focus) { if (start === null || start! < 0 || start! >= duration) startField.current?.focus(); else endField.current?.focus(); } return null; }
    return { ...selected, start_ms: start!, end_ms: end! };
  }

  function commitFields() {
    const range = validateFields();
    if (range) {
      setRanges(previous => previous.map(item => item.id === range.id ? range : item));
      setViewCenter((range.start_ms + range.end_ms) / 2);
    }
  }

  function seek(ms: number) {
    const value = Math.max(0, Math.min(duration, ms));
    previewEnd.current = null; setPreviewing(false);
    setCurrent(value); player.current?.seek(value);
  }

  function marker(which: 'start' | 'end') {
    if (!selected) return;
    const start = which === 'start' ? current : selected.start_ms;
    const end = which === 'end' ? current : selected.end_ms;
    const error = validateRange(start, end, duration);
    if (error) { setRangeError(error); return; }
    changeBounds(start, end); setViewCenter((start + end) / 2);
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input, textarea, select, button, a, [contenteditable]')) return;
      if (!source || !selected) return;
      if (event.code === 'KeyI') { event.preventDefault(); marker('start'); }
      if (event.code === 'KeyO') { event.preventDefault(); marker('end'); }
      if (event.code === 'Space' && playerAvailable) { event.preventDefault(); player.current?.toggle(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  async function openSource(file?: File, providedUrl?: string) {
    if (!sessionReady || sourceBusy || busy) return;
    const candidateUrl = providedUrl ?? url;
    if (!file) {
      try {
        const parsed = new URL(candidateUrl.trim());
        if (parsed.protocol !== 'https:') throw new Error();
      } catch { setSourceError('Вставьте полную публичную ссылку, которая начинается с https://.'); sourceInput.current?.focus(); return; }
    }
    sourceController.current?.abort();
    const controller = new AbortController(); sourceController.current = controller;
    setSourceBusy(true); setSourceError(''); setNotice('');
    try {
      const opened = file ? await api.upload(file, controller.signal) : await api.open(candidateUrl.trim(), controller.signal);
      if (controller.signal.aborted) return;
      const range = newRange(opened.duration_ms);
      player.current?.pause(); previewEnd.current = null;
      setSource(opened); setRanges([range]); setSelectedId(range.id); setFields(range);
      setCurrent(0); setViewCenter((range.start_ms + range.end_ms) / 2); setSpan(Math.min(opened.duration_ms, preferences.timeline_span)); setOutput(preferences.output);
      setJob(null); setJobError(''); setPreviewing(false); setPlayerAvailable(false);
      setNotice('Источник открыт. Укажите границы фрагмента.');
    } catch (error) {
      if (!controller.signal.aborted) setSourceError(errorMessage(error));
    } finally { if (sourceController.current === controller) setSourceBusy(false); }
  }

  function pickRange(range: ClipRange) {
    previewEnd.current = null; setPreviewing(false); player.current?.pause();
    setSelectedId(range.id); setFields(range); setViewCenter((range.start_ms + range.end_ms) / 2);
  }

  function fitSelection() {
    if (!selected) return;
    setViewCenter((selected.start_ms + selected.end_ms) / 2);
    const needed = Math.min(duration, (selected.end_ms - selected.start_ms) * 1.2);
    if (needed > span) setSpan([...zoomOptions].sort((a, b) => a - b).find(value => value >= needed) ?? duration);
  }

  function addRange() {
    const committed = validateFields(true);
    if (!committed) return;
    const range = newRange(duration, current);
    setRanges(previous => [...previous.map(item => item.id === committed.id ? committed : item), range]);
    setSelectedId(range.id); setFields(range); setViewCenter((range.start_ms + range.end_ms) / 2);
    setNotice('Фрагмент добавлен. Настройте его границы.');
  }

  function removeRange(id: string) {
    if (ranges.length === 1) return;
    const remaining = ranges.filter(range => range.id !== id);
    setRanges(remaining);
    if (selectedId === id) pickRange(remaining[0]);
    setNotice('Фрагмент удалён.');
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
    if (!source || busy || sourceBusy) return;
    const range = validateFields(true);
    if (!range) return;
    const committed = ranges.map(item => item.id === range.id ? range : item);
    setRanges(committed); setSubmitting(true); setJobError('');
    try { const created = await api.createJob(source.id, committed, output, crypto.randomUUID()); setJob(created); }
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
  const qualityLabel = source?.width && source?.height ? `${source.width} × ${source.height}` : null;

  return <>
    <a className="skip-link" href="#editor">{t("К выбору фрагмента")}</a>
    <header className="site-header"><div className="header-inner">
      <a className="brand" href="/" aria-label={t("cutmyvideo — главная")}><span className="brand-symbol"><Icon name="cut" size={21} /></span><span>cutmy<span className="brand-suffix">video</span></span></a>
      <WorkspaceNav preferences={preferences} onSave={applyPreferences} busy={!sessionReady || sourceBusy || busy} onExample={value => { setUrl(value); void openSource(undefined, value); }} />
      <div className="header-actions"><LanguageSwitch /><button className="shortcut-toggle" type="button" onClick={() => setShowShortcuts(!showShortcuts)} aria-expanded={showShortcuts} aria-label={t('Горячие клавиши')}><span className="keycap">?</span><span className="shortcut-text">{t("Горячие клавиши")}</span></button></div>
    </div></header>
    <main>
      <div className="page-heading"><div><h1>{t("Вырезать фрагмент")}</h1><p>{t("Выберите моменты. Скачайте видео или аудио.")}</p></div><span className="version-tag">{t("Ранняя версия")}</span></div>
      {showShortcuts && <div className="shortcut-guide"><span><kbd>I</kbd>{t("начало по позиции плеера")}</span><span><kbd>O</kbd>{t("конец")}</span><span><kbd>{t("Пробел")}</kbd>{t("пауза / воспроизведение")}</span><span><kbd>←</kbd><kbd>→</kbd>{t("на ручке: 0,1 с;")}<kbd>Shift</kbd>{t(": 1 с")}</span><p>{t("Клавиши I, O и пробел работают вне полей ввода. В плеере действуют его собственные клавиши.")}</p></div>}

      <section className="source-panel" aria-labelledby="source-heading">
        <h2 id="source-heading" className="sr-only">{t("Открыть источник")}</h2>
        <form className="source-form" noValidate onSubmit={event => { event.preventDefault(); void openSource(); }}>
          <div className="source-field"><label htmlFor="source-url">{t("Ссылка на видео")}</label><div className="source-input-wrap"><Icon name="link" size={19} /><input ref={sourceInput} id="source-url" type="url" placeholder="https://…" value={url} onChange={event => { setUrl(event.target.value); setSourceError(''); }} disabled={sourceBusy || busy} aria-invalid={!!sourceError} aria-describedby={sourceError ? 'source-error' : 'source-hint'} autoComplete="off" spellCheck={false} /></div></div>
          <button className="button primary source-open" type="submit" disabled={!sessionReady || sourceBusy || busy}>{sourceBusy ? <><span className="spinner" />{t("Открываем…")}</> : t("Открыть видео")}</button>
          <span className="source-or">{t("или")}</span>
          <input ref={fileInput} type="file" id="source-file" hidden tabIndex={-1} aria-label={t('Загрузить файл')} accept="video/*,audio/*,.mkv,.mov,.webm,.mp4,.mp3,.m4a" disabled={!sessionReady || sourceBusy || busy} onChange={event => { const file = event.target.files?.[0]; if (file) void openSource(file); event.target.value = ''; }} />
          <button type="button" className="button secondary upload-button" disabled={!sessionReady || sourceBusy || busy} onClick={() => fileInput.current?.click()}><Icon name="upload" size={18} />{t("Загрузить файл")}</button>
        </form>
        <div className="source-hints"><p id="source-hint">{t("YouTube, прямая ссылка на видео или файл с устройства.")}</p>{sourceBusy && <button type="button" className="text-button" onClick={() => { sourceController.current?.abort(); setSourceBusy(false); }}>{t("Отменить открытие")}</button>}{busy && <span>{t("Дождитесь экспорта или отмените его перед сменой видео.")}</span>}</div>
        {sourceError && <div id="source-error" className="error-message" role="alert">{t(sourceError)}{!sessionReady && <button type="button" className="text-button" onClick={() => { setSourceError(''); setSessionAttempt(n => n + 1); }}>{t("Повторить подключение")}</button>}</div>}
      </section>

      <div className="workbench" id="editor">
        <section className="editing-panel" aria-label={t("Выбор фрагментов")}>
          <div className="media-heading"><div className="source-title"><Icon name="file" size={18} /><span>{source?.title ?? t("Видео не выбрано")}</span></div>{source && <span className="source-meta">{qualityLabel && <>{qualityLabel}<span className="meta-separator"> / </span></>}{formatTimecode(duration)}</span>}</div>
          <Player ref={player} source={source} onAvailable={setPlayerAvailable} onTime={ms => {
            setCurrent(Math.min(duration, ms));
            if (previewEnd.current !== null && ms >= previewEnd.current) { player.current?.pause(); previewEnd.current = null; setPreviewing(false); }
          }} />

          {source && selected ? <div className="selection-editor">
            <div className="timeline-toolbar"><h2>{t("Границы фрагмента")}</h2><div className="zoom-controls"><button type="button" className="icon-button" aria-label={t("Предыдущий участок шкалы")} disabled={view[0] <= 0} onClick={() => setViewCenter(Math.max(0, viewCenter - span / 2))}><Icon name="chevron" size={16} style={{ transform: 'rotate(180deg)' }} /></button><label htmlFor="zoom" className="sr-only">{t("Масштаб шкалы")}</label><select id="zoom" value={span} onChange={event => { setSpan(Number(event.target.value)); setViewCenter((selected.start_ms + selected.end_ms) / 2); }}>{zoomOptions.map(value => <option key={value} value={value}>{value === duration ? t("Всё видео") : value === 300000 ? t("5 минут") : value === 60000 ? t("1 минута") : t("10 секунд")}</option>)}</select><button type="button" className="icon-button" aria-label={t("Следующий участок шкалы")} disabled={view[1] >= duration} onClick={() => setViewCenter(Math.min(duration, viewCenter + span / 2))}><Icon name="chevron" size={16} /></button></div></div>
            <Timeline duration={duration} current={current} ranges={ranges} selected={selected} view={view} onSeek={seek} onRange={changeBounds} />
            <div className="time-fields">
              <div><label htmlFor="range-start">{t("Начало")}</label><input ref={startField} id="range-start" className="time-input" type="text" inputMode="text" value={startText} onChange={event => { setStartText(event.target.value); setRangeError(''); }} onBlur={commitFields} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitFields(); } }} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'range-error' : 'time-hint'} spellCheck={false} /><button className="marker-button" type="button" onClick={() => marker('start')}><span className="marker-bracket">[</span>{t("По позиции плеера")}<kbd>I</kbd></button></div>
              <span className="range-dash" aria-hidden="true">—</span>
              <div><label htmlFor="range-end">{t("Конец")}</label><input ref={endField} id="range-end" className="time-input" type="text" inputMode="text" value={endText} onChange={event => { setEndText(event.target.value); setRangeError(''); }} onBlur={commitFields} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitFields(); } }} aria-invalid={!!rangeError} aria-describedby={rangeError ? 'range-error' : 'time-hint'} spellCheck={false} /><button className="marker-button" type="button" onClick={() => marker('end')}><span className="marker-bracket">]</span>{t("По позиции плеера")}<kbd>O</kbd></button></div>
              <div className="selection-duration"><span>{t("Длительность")}</span><strong>{durationLabel(selected.end_ms - selected.start_ms, locale)}</strong></div>
            </div>
            <p id="time-hint" className="field-hint">{t("Часы:минуты:секунды. Можно ввести 83:10 или 01:23:10.250.")}</p>
            {rangeError && <p id="range-error" className="error-message" role="alert">{t(rangeError)}</p>}
            <div className="selection-actions"><button className="button secondary" type="button" disabled={!playerAvailable} onClick={preview}><Icon name={previewing ? 'pause' : 'play'} size={17} />{previewing ? t("Остановить просмотр") : t("Посмотреть фрагмент")}</button><button className="text-button center-selection" type="button" onClick={fitSelection}>{t("Показать границы на шкале")}</button></div>
            <div className="ranges-heading"><h2>{t("Фрагменты")}<span className="count">{ranges.length}</span></h2><button className="text-button" type="button" onClick={addRange} disabled={ranges.length >= 10}><Icon name="plus" size={16} />{t("Добавить фрагмент")}</button></div>
            <ol className="range-list">{ranges.map((range, index) => <li key={range.id} className={range.id === selectedId ? 'selected' : ''}><button className="range-select" type="button" onClick={() => pickRange(range)} aria-pressed={range.id === selectedId}><span className="range-index">{index + 1}</span><span className="range-description"><strong>{range.label || `${t('Фрагмент')} ${index + 1}`}</strong><span>{displayTimecode(range.start_ms)} — {displayTimecode(range.end_ms)}</span></span><span className="range-length">{durationLabel(range.end_ms - range.start_ms, locale)}</span></button><button className="icon-button delete-range" type="button" aria-label={`${t('Удалить фрагмент')} ${index + 1}`} onClick={() => removeRange(range.id)} disabled={ranges.length === 1}><Icon name="trash" size={17} /></button></li>)}</ol>
            <label className="clip-name-label" htmlFor="clip-name">{t("Название выбранного фрагмента")}<span>{t("необязательно")}</span></label><input id="clip-name" className="clip-name" type="text" maxLength={50} placeholder={`${t('Фрагмент')} ${ranges.findIndex(range => range.id === selected.id) + 1}`} value={selected.label} onChange={event => setRanges(previous => previous.map(range => range.id === selected.id ? { ...range, label: event.target.value } : range))} />
          </div> : <div className="empty-selection"><span className="trim-example" aria-hidden="true">[&nbsp;&nbsp;]</span><div><h2>{t("Один момент или несколько")}</h2><p>{t("Выбирайте границы на шкале или вводите точное время.")}<br className="desktop-break" />{t("Каждый фрагмент сохранится отдельным файлом.")}</p></div></div>}
        </section>

        <aside className="export-panel" aria-labelledby="export-heading"><form onSubmit={exportClips}>
          <div className="export-heading"><Icon name="download" size={20} /><h2 id="export-heading">{t("Экспорт")}</h2></div>
          <fieldset disabled={!source || submitting}><legend className="sr-only">{t("Настройки экспорта")}</legend>
            <div className="format-picker" role="group" aria-label={t("Формат файла")}><button type="button" className={output.format === 'mp4' ? 'active' : ''} onClick={() => setOutput(previous => ({ ...previous, format: 'mp4' }))} aria-pressed={output.format === 'mp4'}><strong>MP4</strong><span>{t("Видео")}</span></button><button type="button" className={output.format === 'mp3' ? 'active' : ''} onClick={() => setOutput(previous => ({ ...previous, format: 'mp3', cut_mode: 'accurate' }))} aria-pressed={output.format === 'mp3'}><strong>MP3</strong><span>{t("Аудио")}</span></button></div>
            {output.format === 'mp4' && <div className="export-field"><label htmlFor="quality">{t("Качество видео")}</label><select id="quality" value={output.quality} disabled={preserveLocalQuality} onChange={event => setOutput(previous => ({ ...previous, quality: event.target.value as OutputSettings['quality'] }))}>{preserveLocalQuality ? <option value={output.quality}>{t('Исходное качество')}</option> : <><option value="1080p">{t("До 1080p")}</option><option value="720p">{t("До 720p")}</option><option value="best">{t("Лучшее доступное")}</option></>}</select><p className="field-hint">{t(preserveLocalQuality ? 'В режиме сохранения потоков используется качество исходного файла.' : 'Качество выше исходного не создаётся.')}</p></div>}
            <div className="export-field"><label htmlFor="cut-mode">{t("Границы и качество")}</label><select id="cut-mode" value={output.cut_mode} disabled={output.format === 'mp3'} onChange={event => setOutput(previous => ({ ...previous, cut_mode: event.target.value as OutputSettings['cut_mode'] }))}><option value="accurate">{t("Точные границы")}</option><option value="copy">{t("Сохранить потоки")}</option></select><p className="mode-hint">{output.format === 'mp3' ? t("Аудио будет преобразовано в MP3.") : output.cut_mode === 'accurate' ? t("Видео будет перекодировано. Начало и конец — по выбранным таймкодам.") : t("Без перекодирования. Границы могут сдвинуться; некоторые кодеки несовместимы с MP4.")}</p></div>
          </fieldset>
          <div className="export-summary"><span>{source ? countLabel(ranges.length, 'clip', locale) : t("Фрагменты не выбраны")}</span>{source && <strong>{durationLabel(totalDuration, locale)}</strong>}</div>
          <button className="button primary export-submit" type="submit" disabled={!source || busy || sourceBusy || invalidDraft}>{submitting ? <><span className="spinner" />{t("Создаём задание…")}</> : activeJob(job) ? <><span className="spinner" />{t("Идёт обработка…")}</> : <><Icon name="cut" size={18} />{ranges.length > 1 ? t("Вырезать фрагменты") : t("Вырезать фрагмент")}</>}</button>
          {!source && <p className="export-empty-hint">{t("Сначала откройте видео.")}</p>}
          {source && <p className="export-empty-hint">{t("Результат:")}{' '}{ranges.length > 1 ? t("отдельные файлы") : t("один файл")} {output.format.toUpperCase()}.</p>}
        </form>
        {job && <section className={`job-status ${job.status}`} aria-label={t("Состояние экспорта")} aria-live="polite"><div className="job-status-heading">{activeJob(job) ? <span className="spinner" /> : <Icon name={job.status === 'succeeded' ? 'check' : 'file'} size={20} />}<h3>{t(stageNames[job.status === 'running' ? job.stage : job.status] ?? 'Обрабатываем фрагменты')}</h3></div><p>{jobDescription(job, t)}</p><p className="job-file-count">{t('Готово: {count} из {total}', { count: files.length, total: job.items.length })}</p>{job.items.some(item => item.status === 'failed') && <div className="failed-items"><p>{t("Не удалось создать:")}</p><ul>{job.items.filter(item => item.status === 'failed').map(item => <li key={item.id}>{item.label || `${t('Фрагмент')} ${job.items.indexOf(item) + 1}`}</li>)}</ul><p>{t("Попробуйте точные границы, другое качество или загрузите видео файлом.")}</p></div>}{activeJob(job) && <button type="button" className="button secondary cancel-button" disabled={cancelling} onClick={() => void cancelJob()}>{cancelling ? t("Отменяем…") : t("Отменить обработку")}</button>}</section>}
        {jobError && <p className="error-message" role="alert">{t(jobError)}</p>}
        </aside>
      </div>

      {files.length > 0 && <section className="results-panel" aria-labelledby="results-heading"><div className="results-heading"><div><h2 id="results-heading">{t("Готовые файлы")}</h2><p>{t("Скачайте каждый фрагмент отдельно.")}</p></div><span className="result-count">{countLabel(files.length, 'file', locale)}</span></div><ul className="file-list">{files.map((item, index) => {
        const artifact = item.artifact!;
        const adjusted = Math.abs(artifact.actual_start_ms - item.start_ms) > 100 || Math.abs(artifact.actual_end_ms - item.end_ms) > 100;
        return <li key={artifact.id}><span className="file-icon"><Icon name="file" size={23} /></span><div className="file-description"><h3>{item.label || `${t('Фрагмент')} ${index + 1}`}</h3><p>{artifact.filename}</p><span>{formatBytes(artifact.size_bytes, locale)}<span className="meta-separator"> / </span>{formatTimecode(artifact.actual_start_ms, true)} — {formatTimecode(artifact.actual_end_ms, true)}</span>{adjusted && <p className="adjusted-note">{t("Фактические границы отличаются от выбранных.")}</p>}</div><a className="button secondary download-button" href={artifact.download_url} download={artifact.filename}><Icon name="download" size={17} />{t("Скачать")}</a></li>;
      })}</ul></section>}
      <footer className="page-footer"><span>cutmyvideo</span><a href="https://github.com/Kay0k1/cutmyvideo-core" target="_blank" rel="noreferrer">{t("Открытое ядро на GitHub")}</a></footer>
      <div className="sr-only" role="status" aria-live="polite">{t(notice)}</div>
    </main>
  </>;
}
