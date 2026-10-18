import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import { useLanguage } from './Language';
import { displayTimecode, durationLabel, formatTimecode, parseTimecode } from './timecode';
import type { ClipRange, Source, VideoAnalysis } from './types';
import { analysisWindowIssue, chaptersIssue, decisionIssue, draftDecisions, MAX_CUT_LIST_BYTES, MAX_CUT_LIST_ENTRIES, resolveCutList, sceneDecisions } from './analysisToolModel';
import type { CutDecision, SuggestionDraft, ToolIssue } from './analysisToolModel';
import './AnalysisTools.css';

type Tool = 'silence' | 'video' | 'list';
type Task = Tool | 'csv' | 'ffmetadata' | 'file';

export interface AnalysisToolsProps {
  active: boolean;
  source: Source;
  selectedRange: ClipRange | null;
  ranges: ClipRange[];
  audioTrack?: number;
  disabled?: boolean;
  maxRanges: number;
  maxRangeMS: number;
  maxJobMS: number;
  onSeek(ms: number): void;
  onApplyRanges(ranges: CutDecision[], mode: 'append' | 'replace'): boolean;
  onApplied?(): void;
}

/** Read-only tools prepare a draft. Only an explicit apply changes the editor. */
export function AnalysisTools({ active, source, selectedRange, ranges, audioTrack, disabled = false, maxRanges, maxRangeMS, maxJobMS, onSeek, onApplyRanges, onApplied }: AnalysisToolsProps) {
  const { t, locale } = useLanguage();
  const prefix = useId();
  const pending = useRef<{ id: number; controller: AbortController; task: Task; context: string } | null>(null);
  const generation = useRef(0);
  const [task, setTask] = useState<Task | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [feedbackTool, setFeedbackTool] = useState<Tool | null>(null);
  const [threshold, setThreshold] = useState('-35');
  const [minimumPause, setMinimumPause] = useState('500');
  const [video, setVideo] = useState<VideoAnalysis | null>(null);
  const [eventLimit, setEventLimit] = useState(40);
  const [format, setFormat] = useState<'csv' | 'ffmetadata'>('csv');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [draft, setDraft] = useState<SuggestionDraft[]>([]);
  const [draftTool, setDraftTool] = useState<Tool | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const sourceKey = `${source.id}:${source.duration_ms}:${source.kind}:${Boolean(source.media_removed)}`;
  const windowKey = `${sourceKey}:${selectedRange?.id}:${selectedRange?.start_ms}:${selectedRange?.end_ms}:${audioTrack ?? 'default'}`;
  const context = useRef({ source: sourceKey, window: windowKey, active, disabled });
  context.current = { source: sourceKey, window: windowKey, active, disabled };
  const local = source.kind === 'upload' && !source.media_removed;
  const windowIssue = analysisWindowIssue(selectedRange?.start_ms, selectedRange?.end_ms, source.duration_ms);
  const canAnalyze = active && !disabled && local && !windowIssue && task === null;
  const issueText = (issue: ToolIssue | null) => issue ? t(issue.key, issue.values) : '';
  const limits = { duration: source.duration_ms, maxRanges, maxRangeMS, maxJobMS };

  function cancel(announce = false) {
    generation.current++;
    pending.current?.controller.abort();
    pending.current = null;
    setTask(null);
    if (announce) { setError(''); setNotice(t('Анализ отменён. Фрагменты не изменены.')); }
  }

  useEffect(() => {
    cancel(); setVideo(null); setEventLimit(40); setError(''); setNotice(''); setConfirmReplace(false);
    if (draftTool === 'silence' || draftTool === 'video') { setDraft([]); setDraftTool(null); }
    // Results describe an exact source interval and selected absolute audio track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey]);
  useEffect(() => {
    cancel(); setDraft([]); setDraftTool(null); setText(''); setFileName(''); setError(''); setNotice(''); setConfirmReplace(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);
  useEffect(() => { if (!active || disabled) cancel(); }, [active, disabled]);
  useEffect(() => { cancel(); setNotice(''); setError(''); }, [locale]);
  useEffect(() => () => { generation.current++; pending.current?.controller.abort(); pending.current = null; }, []);

  function begin(next: Task) {
    cancel(); setError(''); setNotice(''); setConfirmReplace(false);
    setFeedbackTool(next === 'silence' || next === 'video' ? next : 'list');
    const ticket = { id: ++generation.current, controller: new AbortController(), task: next, context: next === 'silence' || next === 'video' ? windowKey : sourceKey };
    pending.current = ticket; setTask(next);
    return ticket;
  }
  function current(ticket: NonNullable<typeof pending.current>) {
    const now = context.current;
    return pending.current?.id === ticket.id && !ticket.controller.signal.aborted && now.active && !now.disabled
      && ticket.context === (ticket.task === 'silence' || ticket.task === 'video' ? now.window : now.source);
  }
  function finish(ticket: NonNullable<typeof pending.current>) {
    if (pending.current?.id === ticket.id) { pending.current = null; setTask(null); }
  }
  function fail(cause: unknown, ticket: NonNullable<typeof pending.current>) {
    if (!current(ticket)) return;
    const codes: Record<string, string> = {
      local_source_required: 'Для анализа загрузите видео файлом. Видео по ссылке не поддерживается.',
      invalid_analysis: 'Не удалось проанализировать этот участок. Проверьте настройки и сократите фрагмент.',
      invalid_cut_list: 'Не удалось прочитать список. Проверьте формат, границы и названия фрагментов.',
      output_limit: 'Слишком много результатов. Выберите более короткий участок или увеличьте минимальную паузу.',
      source_timeout: 'Анализ занял слишком много времени. Выберите более короткий участок.',
      no_audio: 'В выбранном источнике нет доступной звуковой дорожки.',
      no_video: 'В выбранном источнике нет доступной видеодорожки.',
      unsupported_media: 'Этот источник не удалось проанализировать. Попробуйте другой файл.',
      unsupported_stream: 'Этот источник не удалось проанализировать. Попробуйте другой файл.',
    };
    setError(t(cause instanceof ApiError && codes[cause.code] ? codes[cause.code] : errorMessage(cause)));
  }

  function prepare(values: CutDecision[], tool: Tool) {
    setDraft(values.map((range, index) => ({ id: `${tool}-${generation.current}-${index}`, included: true, label: range.label, start: formatTimecode(range.start_ms, true), end: formatTimecode(range.end_ms, true) })));
    setDraftTool(tool); setFeedbackTool(tool); setConfirmReplace(false); setNotice(''); setError('');
  }

  async function silence() {
    if (!canAnalyze || !selectedRange) return;
    setFeedbackTool('silence');
    const db = Number(threshold), pause = Number(minimumPause);
    if (!threshold.trim() || !minimumPause.trim() || !Number.isFinite(db) || db < -90 || db > -1 || !Number.isInteger(pause) || pause < 10 || pause > 60000) { setError(t('Укажите порог от −90 до −1 дБ и паузу от 10 до 60000 мс.')); return; }
    const ticket = begin('silence');
    try {
      const result = await api.analyzeSilence(source.id, { start_ms: selectedRange.start_ms, end_ms: selectedRange.end_ms, ...(audioTrack !== undefined ? { audio_track: audioTrack } : {}), threshold_db: db, min_silence_ms: pause, keep_before_ms: 100, keep_after_ms: 150, min_clip_ms: 100 }, ticket.controller.signal);
      if (!current(ticket)) return;
      if (result.version !== 1 || result.start_ms !== selectedRange.start_ms || result.end_ms !== selectedRange.end_ms || !Array.isArray(result.keep) || !Array.isArray(result.silence) || !Number.isSafeInteger(result.analyzed_end_ms) || result.analyzed_end_ms < result.start_ms || result.analyzed_end_ms > result.end_ms) { setError(t('Сервер вернул некорректный результат анализа.')); return; }
      if (result.analyzed_end_ms < result.end_ms) { setDraft([]); setDraftTool(null); setError(t('Звук проанализирован только до {time}. Сократите фрагмент до этой границы и повторите анализ.', { time: displayTimecode(result.analyzed_end_ms) })); return; }
      if (result.keep.length > MAX_CUT_LIST_ENTRIES) { setDraft([]); setDraftTool(null); setError(t('Получилось больше 128 предложений. Сократите участок или увеличьте минимальную паузу.')); return; }
      const decisions = result.keep.map(range => ({ label: range.label ?? '', start_ms: range.start_ms, end_ms: range.end_ms }));
      if (decisions.some(range => range.start_ms < result.start_ms || range.end_ms > result.end_ms) || decisions.some(range => !Number.isSafeInteger(range.start_ms) || !Number.isSafeInteger(range.end_ms) || range.end_ms <= range.start_ms)) { setError(t('Сервер вернул некорректный результат анализа.')); return; }
      prepare(decisions, 'silence');
      setNotice(result.silence.length === 0 ? t('Пауз с такими настройками не найдено. Предложен весь выбранный фрагмент.') : decisions.length ? t('Предложения готовы. Проверьте речь и границы перед добавлением.') : t('Весь выбранный участок распознан как пауза. Попробуйте снизить порог.'));
    } catch (cause) { fail(cause, ticket); } finally { finish(ticket); }
  }

  async function inspectVideo() {
    if (!canAnalyze || !selectedRange) return;
    const ticket = begin('video');
    try {
      const result = await api.analyzeVideo(source.id, { start_ms: selectedRange.start_ms, end_ms: selectedRange.end_ms, scene_threshold: 0.3, min_black_ms: 500 }, ticket.controller.signal);
      if (!current(ticket)) return;
      if (result.version !== 1 || result.start_ms !== selectedRange.start_ms || result.end_ms !== selectedRange.end_ms || !Number.isSafeInteger(result.analyzed_end_ms) || result.analyzed_end_ms < result.start_ms || result.analyzed_end_ms > result.end_ms || !Array.isArray(result.scenes) || !Array.isArray(result.black) || result.scenes.length + result.black.length > 8192 || result.scenes.some(scene => !Number.isSafeInteger(scene.at_ms) || scene.at_ms < result.start_ms || scene.at_ms > result.end_ms || !Number.isFinite(scene.score)) || result.black.some(interval => !Number.isSafeInteger(interval.start_ms) || !Number.isSafeInteger(interval.end_ms) || interval.start_ms < result.start_ms || interval.end_ms > result.end_ms || interval.end_ms <= interval.start_ms)) { setError(t('Сервер вернул некорректный результат анализа.')); return; }
      setVideo(result); setEventLimit(40);
      if (draftTool === 'video') { setDraft([]); setDraftTool(null); }
      if (!result.scenes.length && !result.black.length) setNotice(t('Смен сцен и чёрных интервалов не найдено. Фрагменты не изменены.'));
    } catch (cause) { fail(cause, ticket); } finally { finish(ticket); }
  }

  async function readFile(file: File | undefined) {
    if (!file || !active || disabled || task !== null) return;
    setFeedbackTool('list');
    if (file.size > MAX_CUT_LIST_BYTES) { setError(t('Файл списка должен быть не больше 1 МиБ.')); return; }
    const ticket = begin('file');
    try {
      const contents = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (!current(ticket)) return;
      setText(contents); setFileName(file.name); setDraft([]); setDraftTool(null);
      if (/\.(ffmeta|ffmetadata|metadata|txt)$/i.test(file.name) && contents.trimStart().startsWith(';FFMETADATA1')) setFormat('ffmetadata');
      else if (/\.csv$/i.test(file.name)) setFormat('csv');
    } catch { if (current(ticket)) setError(t('Не удалось прочитать файл UTF-8. Сохраните список в UTF-8 и повторите.')); } finally { finish(ticket); }
  }

  async function importList() {
    if (!active || disabled || task !== null) return;
    setFeedbackTool('list');
    if (!text.trim() || new TextEncoder().encode(text).byteLength > MAX_CUT_LIST_BYTES || text.includes('\0')) { setError(t('Вставьте список UTF-8 без нулевых символов, не больше 1 МиБ.')); return; }
    const ticket = begin('list');
    try {
      const result = await api.importCutList(format, text, ticket.controller.signal);
      if (!current(ticket)) return;
      const resolved = resolveCutList(result, source.duration_ms);
      if (resolved.issue) { setError(issueText(resolved.issue)); return; }
      prepare(resolved.ranges, 'list');
      setNotice(result.entries.some(entry => entry.end_ms == null) ? t('Маркеры развёрнуты до следующей границы, последний — до конца видео. Проверьте предложения.') : t('Список прочитан. Проверьте предложения перед добавлением.'));
    } catch (cause) { fail(cause, ticket); } finally { finish(ticket); }
  }

  async function download(nextFormat: 'csv' | 'ffmetadata') {
    if (!active || disabled || task !== null || !ranges.length) return;
    setFeedbackTool('list');
    const requested = ranges.map(({ label, start_ms, end_ms }) => ({ label, start_ms, end_ms }));
    const issue = nextFormat === 'ffmetadata' ? chaptersIssue(requested) : null;
    if (issue) { setError(issueText(issue)); return; }
    const ticket = begin(nextFormat);
    try {
      const result = await api.exportCutList(nextFormat, { version: 1, entries: requested }, ticket.controller.signal);
      if (!current(ticket)) return;
      if (result.version !== 1 || result.format !== nextFormat || typeof result.text !== 'string' || new TextEncoder().encode(result.text).byteLength > MAX_CUT_LIST_BYTES) { setError(t('Сервер вернул некорректный список фрагментов.')); return; }
      const url = URL.createObjectURL(new Blob([result.text], { type: nextFormat === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `cutmy-fragments.${nextFormat === 'csv' ? 'csv' : 'ffmeta'}`; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(t('Список скачан. Время указано относительно исходного видео.'));
    } catch (cause) { fail(cause, ticket); } finally { finish(ticket); }
  }

  function updateDraft(id: string, update: Partial<SuggestionDraft>) { setDraft(previous => previous.map(row => row.id === id ? { ...row, ...update } : row)); setConfirmReplace(false); setError(''); }
  const parsed = draftDecisions(draft);
  const rowNumbers = draft.flatMap((row, index) => row.included ? [index + 1] : []);
  const baseIssue = parsed.issue ?? decisionIssue(parsed.ranges, limits, 0, rowNumbers);
  const appendIssue = baseIssue ?? decisionIssue(parsed.ranges, limits, ranges.length, rowNumbers);
  const selectedCount = draft.filter(row => row.included).length;

  function apply(mode: 'append' | 'replace') {
    if (!active || disabled || task !== null || (mode === 'append' ? appendIssue : baseIssue) || mode === 'replace' && !confirmReplace) return;
    if (onApplyRanges(parsed.ranges, mode)) { setDraft([]); setDraftTool(null); setConfirmReplace(false); setNotice(t('Фрагменты добавлены. Изменение можно отменить в редакторе.')); onApplied?.(); }
    else setError(t('Не удалось применить предложения. Проверьте общую длительность выбранного экспорта и повторите.'));
  }

  function feedback(tool: Tool) {
    if (feedbackTool !== tool) return null;
    return <>{task && <p className="field-hint" role="status">{t(task === 'file' ? 'Читаем файл…' : 'Обрабатываем запрос. Можно продолжать после отмены.')}</p>}{notice && <p className="field-hint analysis-notice" role="status">{notice}</p>}{error && <p className="error-message analysis-error" role="alert">{error}</p>}</>;
  }

  function preview(tool: Tool) {
    if (draftTool !== tool || !draft.length) return null;
    return <section className="analysis-preview" aria-label={t('Предложения фрагментов')}>
      <div className="analysis-preview-heading"><h4>{t('Предложения фрагментов')}</h4><span>{t('Выбрано: {count} из {total}', { count: selectedCount, total: draft.length })}</span></div>
      <p className="field-hint">{t('Время исходного видео. Измените границы и снимите лишние отметки. Добавление сохраняет текущие фрагменты.')}</p>
      <div className="analysis-selection-actions"><button type="button" className="text-button" disabled={disabled || task !== null} onClick={() => { setDraft(previous => previous.map(row => ({ ...row, included: selectedCount !== draft.length }))); setConfirmReplace(false); }}>{t(selectedCount === draft.length ? 'Снять все отметки' : 'Выбрать все предложения')}</button></div>
      <ol className="analysis-draft-list">{draft.map((row, index) => <li key={row.id} className="analysis-draft-row" data-included={row.included || undefined}>
        <label className="analysis-draft-check"><input type="checkbox" checked={row.included} disabled={disabled || task !== null} aria-label={t('Выбрать предложение {index}', { index: index + 1 })} onChange={event => updateDraft(row.id, { included: event.target.checked })} /></label>
        <div className="analysis-draft-fields"><label className="analysis-draft-name"><span className="sr-only">{t('Название предложения {index}', { index: index + 1 })}</span><input type="text" value={row.label} placeholder={t('Фрагмент {index}', { index: index + 1 })} disabled={disabled || task !== null} onChange={event => updateDraft(row.id, { label: event.target.value })} /></label>
          <div className="analysis-draft-times"><label><span>{t('Начало')}</span><input type="text" inputMode="text" autoComplete="off" spellCheck={false} value={row.start} disabled={disabled || task !== null} aria-invalid={row.included && (parseTimecode(row.start) === null || (parseTimecode(row.start) ?? Infinity) >= (parseTimecode(row.end) ?? -1)) || undefined} aria-label={t('Начало предложения {index}', { index: index + 1 })} onChange={event => updateDraft(row.id, { start: event.target.value })} /></label><label><span>{t('Конец')}</span><input type="text" inputMode="text" autoComplete="off" spellCheck={false} value={row.end} disabled={disabled || task !== null} aria-invalid={row.included && (parseTimecode(row.end) === null || (parseTimecode(row.end) ?? Infinity) > source.duration_ms || (parseTimecode(row.end) ?? -1) <= (parseTimecode(row.start) ?? Infinity)) || undefined} aria-label={t('Конец предложения {index}', { index: index + 1 })} onChange={event => updateDraft(row.id, { end: event.target.value })} /></label></div>
        </div><button type="button" className="text-button analysis-draft-seek" disabled={disabled || parseTimecode(row.start) === null || (parseTimecode(row.start) ?? Infinity) > source.duration_ms} onClick={() => { const start = parseTimecode(row.start); if (start !== null && start <= source.duration_ms) onSeek(start); }} aria-label={t('Перейти к предложению {index}', { index: index + 1 })}>{t('Посмотреть')}</button>
      </li>)}</ol>
      {baseIssue && <p className="field-hint analysis-validation" role="status">{issueText(baseIssue)}</p>}
      {!baseIssue && appendIssue && <p className="field-hint analysis-validation" role="status">{issueText(appendIssue)}</p>}
      <div className="analysis-apply-actions"><button type="button" className="button primary" disabled={disabled || task !== null || Boolean(appendIssue)} onClick={() => apply('append')}>{t('Добавить выбранные')}</button><button type="button" className="text-button" disabled={disabled || task !== null || Boolean(baseIssue)} aria-expanded={confirmReplace} onClick={() => setConfirmReplace(value => !value)}>{t('Заменить список…')}</button></div>
      {confirmReplace && <div className="analysis-replace-confirm" role="group" aria-label={t('Подтвердить замену списка')}><p>{t('Все текущие фрагменты будут заменены выбранными предложениями. Это изменение можно отменить.')}</p><div className="analysis-apply-actions"><button type="button" className="button secondary" disabled={disabled || task !== null || Boolean(baseIssue)} onClick={() => apply('replace')}>{t('Заменить фрагменты')}</button><button type="button" className="text-button" onClick={() => setConfirmReplace(false)}>{t('Назад')}</button></div></div>}
    </section>;
  }

  const events = video ? [...video.scenes.map(scene => ({ type: 'scene' as const, start: scene.at_ms, end: scene.at_ms })), ...video.black.map(interval => ({ type: 'black' as const, start: interval.start_ms, end: interval.end_ms }))].sort((a, b) => a.start - b.start) : [];
  return <div className="media-analysis-tools">
    <p className="analysis-tools-intro">{t('Необязательные помощники. Сначала проверьте предложения — видео и фрагменты не меняются автоматически.')}</p>
    <details className="analysis-tool" onToggle={event => { if (!event.currentTarget.open && task === 'silence') cancel(); }}><summary>{t('Паузы')}</summary><div className="analysis-tool-body">
      <p className="field-hint">{t('Предложить фрагменты без длинных пауз. Тихая речь тоже может попасть в паузы — прослушайте результат.')}</p>
      <AnalysisWindow source={source} selectedRange={selectedRange} issue={issueText(windowIssue)} local={local} />
      <details className="analysis-options"><summary>{t('Настроить поиск пауз')}</summary><div className="analysis-options-fields"><label htmlFor={`${prefix}-threshold`}>{t('Порог тишины, дБ')}<input id={`${prefix}-threshold`} type="number" min={-90} max={-1} step={1} value={threshold} disabled={disabled || task !== null} onChange={event => { setThreshold(event.target.value); if (draftTool === 'silence') { setDraft([]); setDraftTool(null); } }} /></label><label htmlFor={`${prefix}-pause`}>{t('Минимальная пауза, мс')}<input id={`${prefix}-pause`} type="number" min={10} max={60000} step={10} value={minimumPause} disabled={disabled || task !== null} onChange={event => { setMinimumPause(event.target.value); if (draftTool === 'silence') { setDraft([]); setDraftTool(null); } }} /></label></div><p className="field-hint">{t('Оставляем 100 мс перед речью и 150 мс после неё, чтобы не обрезать слова.')}</p></details>
      <div className="analysis-run-actions"><button type="button" className="button secondary" disabled={!canAnalyze} onClick={() => void silence()}>{t(task === 'silence' ? 'Ищем паузы…' : 'Найти паузы')}</button>{task === 'silence' && <button type="button" className="text-button" onClick={() => cancel(true)}>{t('Отменить анализ')}</button>}</div>
      {feedback('silence')}
      {preview('silence')}
    </div></details>
    <details className="analysis-tool" onToggle={event => { if (!event.currentTarget.open && task === 'video') cancel(); }}><summary>{t('Сцены и чёрные кадры')}</summary><div className="analysis-tool-body">
      <p className="field-hint">{t('Найти визуальные переходы и чёрные интервалы от 0,5 секунды. Это ориентиры для просмотра, а не готовый монтаж.')}</p>
      <AnalysisWindow source={source} selectedRange={selectedRange} issue={issueText(windowIssue)} local={local} />
      <div className="analysis-run-actions"><button type="button" className="button secondary" disabled={!canAnalyze} onClick={() => void inspectVideo()}>{t(task === 'video' ? 'Ищем сцены…' : 'Найти сцены и чёрные кадры')}</button>{task === 'video' && <button type="button" className="text-button" onClick={() => cancel(true)}>{t('Отменить анализ')}</button>}</div>
      {feedback('video')}
      {video && events.length > 0 && <section className="analysis-events" aria-label={t('Найденные переходы')}><p className="field-hint">{t('Смен сцен: {scenes}. Чёрных интервалов: {black}.', { scenes: video.scenes.length, black: video.black.length })}</p><ul>{events.slice(0, eventLimit).map((event, index) => <li key={`${event.type}-${event.start}-${index}`}><span>{t(event.type === 'scene' ? 'Смена сцены' : 'Чёрный интервал')}</span><button type="button" className="text-button" disabled={disabled} aria-label={t('Перейти к {time}', { time: displayTimecode(event.start) })} onClick={() => onSeek(event.start)}>{displayTimecode(event.start)}{event.type === 'black' && ` – ${displayTimecode(event.end)}`}</button></li>)}</ul>{events.length > eventLimit && <button type="button" className="text-button" onClick={() => setEventLimit(value => value + 40)}>{t('Показать ещё переходы')}</button>}{video.scenes.length > 0 && <button type="button" className="text-button" disabled={disabled || task !== null} onClick={() => { setFeedbackTool('video'); const decisions = sceneDecisions(video.start_ms, video.end_ms, video.scenes); if (decisions.length > MAX_CUT_LIST_ENTRIES) { setError(t('Получилось больше 128 предложений. Выберите более короткий участок.')); return; } prepare(decisions, 'video'); }}>{t('Подготовить фрагменты по сценам')}</button>}<p className="field-hint">{t('Чёрные интервалы не удаляются автоматически.')}</p></section>}
      {preview('video')}
    </div></details>
    <details className="analysis-tool" onToggle={event => { if (!event.currentTarget.open && task !== null && ['list', 'csv', 'ffmetadata', 'file'].includes(task)) cancel(); }}><summary>{t('Списки фрагментов')}</summary><div className="analysis-tool-body">
      <p className="field-hint">{t('Импортируйте CSV или главы FFmetadata. Время относится к исходному видео. Порядок и повторы сохраняются.')}</p>
      <div className="analysis-list-fields"><div className="analysis-list-format"><label htmlFor={`${prefix}-format`}>{t('Формат списка')}</label><select id={`${prefix}-format`} value={format} disabled={disabled || task !== null} onChange={event => { setFormat(event.target.value as 'csv' | 'ffmetadata'); setDraft([]); setDraftTool(null); setError(''); }}><option value="csv">CSV</option><option value="ffmetadata">{t('Главы FFmetadata')}</option></select></div><label className="analysis-list-file" htmlFor={`${prefix}-file`}><span>{t('Открыть файл списка')}</span><input id={`${prefix}-file`} type="file" accept=".csv,.ffmeta,.ffmetadata,.txt,text/csv,text/plain" disabled={disabled || task !== null} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void readFile(file); }} /></label></div>
      {fileName && <p className="field-hint analysis-file-name">{fileName}</p>}
      <div className="analysis-list-text"><label htmlFor={`${prefix}-text`}>{t('Текст списка')}</label><textarea id={`${prefix}-text`} value={text} rows={5} maxLength={MAX_CUT_LIST_BYTES} spellCheck={false} disabled={disabled || task !== null} placeholder={format === 'csv' ? '0,3,Opening\n5,8,Ending' : ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=Opening'} onChange={event => { setText(event.target.value); setFileName(''); if (draftTool === 'list') { setDraft([]); setDraftTool(null); } setError(''); }} /></div>
      <p className="field-hint">{format === 'csv' ? t('CSV без заголовка: начало в секундах, конец, название. Пустой конец — маркер до следующей строки или конца видео.') : t('Файл глав FFmpeg с TIMEBASE, START и END. Названия глав станут названиями фрагментов.')}</p>
      <button type="button" className="button secondary" disabled={disabled || task !== null || !text.trim()} onClick={() => void importList()}>{t(task === 'list' ? 'Проверяем список…' : 'Проверить список')}</button>
      {feedback('list')}
      {preview('list')}
      <div className="analysis-list-download"><h4>{t('Скачать текущий список')}</h4><p className="field-hint">{t('Все фрагменты в текущем порядке. Это отдельный файл с исходными метками времени, без изменения видео.')}</p><div className="analysis-apply-actions"><button type="button" className="text-button" disabled={disabled || task !== null || !ranges.length} onClick={() => void download('csv')}>{t('Скачать CSV')}</button><button type="button" className="text-button" disabled={disabled || task !== null || !ranges.length} onClick={() => void download('ffmetadata')}>{t('Скачать главы')}</button></div>{chaptersIssue(ranges) && <p className="field-hint">{issueText(chaptersIssue(ranges))}</p>}</div>
    </div></details>
  </div>;
}

function AnalysisWindow({ source, selectedRange, issue, local }: { source: Source; selectedRange: ClipRange | null; issue: string; local: boolean }) {
  const { t, locale } = useLanguage();
  return <div className="analysis-window"><span>{t('Выбранный фрагмент')}</span>{selectedRange && <strong>{displayTimecode(selectedRange.start_ms)} – {displayTimecode(selectedRange.end_ms)} <span>({durationLabel(selectedRange.end_ms - selectedRange.start_ms, locale)})</span></strong>}<p className="field-hint">{source.media_removed ? t('Исходный файл удалён. Загрузите его заново для анализа.') : !local ? t('Для анализа загрузите видео файлом. Видео по ссылке не поддерживается.') : issue || t('Анализируется только этот фрагмент исходного видео, до 30 минут.')}</p></div>;
}
