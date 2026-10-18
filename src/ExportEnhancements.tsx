import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import { Icon } from './Icons';
import { useLanguage } from './Language';
import { defaultAudioTrack, trackLabel } from './mediaTracks';
import { SelectControl } from './SelectControl';
import { formatBytes, formatTimecode } from './timecode';
import { activeEnhancementLabels, audioOffsetFromText, canvasPicturePercent, compatibleEnhancementSettings, DEFAULT_CANVAS, DEFAULT_NORMALIZATION, enhancementConflict, loudnessWindow, replacementFileError, replacementSourceAvailable, replacementTracks, replacementTrackState } from './exportEnhancementModel';
import type { AnalysisWindow, LoudnessAnalysis, MediaTrack, OutputSettings, Source, UploadProgress } from './types';
import './ExportEnhancements.css';

interface Props {
  source: Source;
  output: OutputSettings;
  tracks: MediaTrack[] | null;
  analysisRange?: AnalysisWindow;
  maximumBytes: number;
  disabled?: boolean;
  active?: boolean;
  onChange(update: (previous: OutputSettings) => OutputSettings): void;
  onBlockingChange(blocked: boolean): void;
  onSessionError?(): void;
}

function NumberField({ id, label, value, minimum, maximum, integer = false, even = false, disabled, onChange, onValidityChange }: {
  id: string; label: string; value: number; minimum: number; maximum: number; integer?: boolean; even?: boolean; disabled?: boolean;
  onChange(value: number): void; onValidityChange(invalid: boolean): void;
}) {
  const { t } = useLanguage();
  const [text, setText] = useState(String(value));
  const validityCallback = useRef(onValidityChange); validityCallback.current = onValidityChange;
  useEffect(() => { setText(String(value)); }, [value]);
  const parsed = integer ? audioOffsetFromText(text) : text.trim() === '' ? null : Number(text.replace(',', '.'));
  const valid = parsed !== null && Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum && (!even || parsed % 2 === 0);
  useEffect(() => { validityCallback.current(!valid); return () => validityCallback.current(false); }, [valid]);
  return <div className="enhancement-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="text" inputMode={integer && minimum >= 0 ? 'numeric' : 'decimal'} value={text} disabled={disabled}
      aria-invalid={!valid} aria-describedby={!valid ? `${id}-error` : undefined} autoComplete="off"
      onChange={event => {
        const next = event.target.value; setText(next);
        const number = integer ? audioOffsetFromText(next) : next.trim() === '' ? null : Number(next.replace(',', '.'));
        if (number !== null && Number.isFinite(number) && number >= minimum && number <= maximum && (!even || number % 2 === 0)) onChange(number);
      }} />
    {!valid && <p id={`${id}-error`} className="enhancement-field-error">{t(even ? 'Введите чётное число от {min} до {max}.' : integer ? 'Введите целое число от {min} до {max}.' : 'Введите число от {min} до {max}.', { min: minimum, max: maximum })}</p>}
  </div>;
}

function analysisFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'local_source_required') return 'Измерение доступно для загруженного файла. Загрузите исходную запись.';
    if (error.code === 'source_timeout') return 'Измерение заняло слишком много времени. Выберите более короткий фрагмент.';
    if (error.code === 'invalid_analysis' || error.code === 'output_limit') return 'Не удалось измерить этот интервал. Выберите более короткий фрагмент.';
    if (error.code === 'server_busy') return 'Сервер занят. Подождите немного и повторите измерение.';
  }
  return errorMessage(error);
}

/** These optional effects affect the exported file; the editor continues to show the original source. */
export function ExportEnhancements({ source, output, tracks, analysisRange, maximumBytes, disabled = false, active = true, onChange, onBlockingChange, onSessionError }: Props) {
  const { t, locale } = useLanguage();
  const instanceID = useId();
  const [expanded, setExpanded] = useState(false);
  const [audioExpanded, setAudioExpanded] = useState(false);
  const [compatibilityLocation, setCompatibilityLocation] = useState<'root' | 'loudness' | 'canvas' | 'audio'>('root');
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>({});
  const [customCanvas, setCustomCanvas] = useState(false);
  const [measurement, setMeasurement] = useState<{ identity: string; result: LoudnessAnalysis } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [measurementError, setMeasurementError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [ownedSources, setOwnedSources] = useState<Source[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState('');
  const [sourcesRevision, setSourcesRevision] = useState(0);
  const [bindingRevision, setBindingRevision] = useState(0);
  const [binding, setBinding] = useState<{ id: string; source?: Source; tracks: MediaTrack[]; defaultIndex?: number; loading: boolean; error: string }>({ id: '', tracks: [], loading: false, error: '' });
  const primaryID = useRef(source.id); primaryID.current = source.id;
  const measureController = useRef<AbortController | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const compatibilityNoticeRef = useRef<HTMLDivElement>(null);
  const compatibilityRevealFrame = useRef<number | null>(null);
  const replacementGroupRef = useRef<HTMLDetailsElement>(null);
  const blockingCallback = useRef(onBlockingChange); blockingCallback.current = onBlockingChange;
  const sessionCallback = useRef(onSessionError); sessionCallback.current = onSessionError;
  const sourceID = output.audio_replace?.source_id ?? '';
  const selectedReplacement = output.audio_replace?.audio_track;
  const chosenReplacementTrack = binding.tracks.find(track => track.index === (selectedReplacement ?? binding.defaultIndex));
  const originalAudio = output.audio_track === undefined ? defaultAudioTrack(tracks ?? []) : tracks?.find(track => track.type === 'audio' && track.index === output.audio_track);
  const replacementInvalid = !!sourceID && (binding.id !== sourceID || binding.loading || !!binding.error || !chosenReplacementTrack);
  const conflict = enhancementConflict(output);
  const invalidDraft = Object.entries(invalidFields).some(([key, invalid]) => invalid && (key.startsWith('normalize') ? !!output.audio_normalize : key.startsWith('canvas') ? !!output.canvas : !!output.audio_replace));
  const noNormalizableAudio = !!output.audio_normalize && !output.audio_replace && tracks !== null && !originalAudio;
  const blocked = uploading || replacementInvalid || invalidDraft || noNormalizableAudio;
  useEffect(() => { onBlockingChange(blocked); }, [blocked, onBlockingChange]);
  useEffect(() => () => { blockingCallback.current(false); }, []);
  function noteSession(error: unknown) {
    if (error instanceof ApiError && (error.httpStatus === 401 || error.code === 'session_required')) sessionCallback.current?.();
  }
  function fieldValidity(field: string, invalid: boolean) {
    setInvalidFields(previous => previous[field] === invalid ? previous : { ...previous, [field]: invalid });
  }
  useEffect(() => {
    return () => {
      measureController.current?.abort(); uploadController.current?.abort();
      if (compatibilityRevealFrame.current !== null) globalThis.cancelAnimationFrame(compatibilityRevealFrame.current);
    };
  }, [source.id]);
  function revealCompatibility(requireGroupFocus = false) {
    if (compatibilityRevealFrame.current !== null) globalThis.cancelAnimationFrame(compatibilityRevealFrame.current);
    compatibilityRevealFrame.current = globalThis.requestAnimationFrame(() => {
      compatibilityRevealFrame.current = null;
      const notice = compatibilityNoticeRef.current;
      const dialog = notice?.closest<HTMLDialogElement>('dialog[open]');
      const group = notice?.closest('.enhancement-group');
      // A completed upload must not pull a user back from a different tool.
      if (!notice || !dialog || requireGroupFocus && (!group || !group.contains(document.activeElement))) return;
      const bounds = notice.getBoundingClientRect(), viewport = dialog.getBoundingClientRect();
      const header = dialog.querySelector(':scope > .dialog-header')?.getBoundingClientRect();
      const top = Math.max(viewport.top, header?.bottom ?? viewport.top) + 12;
      const bottom = viewport.bottom - 12;
      const delta = bounds.bottom > bottom ? bounds.bottom - bottom : bounds.top < top ? bounds.top - top : 0;
      if (delta) dialog.scrollBy({ top: delta, behavior: 'auto' });
    });
  }
  useEffect(() => {
    if (active && !disabled) return;
    if (compatibilityRevealFrame.current !== null) {
      globalThis.cancelAnimationFrame(compatibilityRevealFrame.current); compatibilityRevealFrame.current = null;
    }
    measureController.current?.abort(); measureController.current = null; setMeasuring(false);
    if (uploadController.current) {
      uploadController.current.abort(); uploadController.current = null;
      setUploadError('Загрузка остановлена. Если файл успел сохраниться, он останется в списке файлов на сервере.');
    }
    setUploading(false); setUploadProgress(null);
  }, [active, disabled]);

  // A persisted server ID is never trusted merely because it appeared in a local draft.
  // This check deliberately also runs while the settings dialog is closed.
  useEffect(() => {
    if (!sourceID) { setBinding({ id: '', tracks: [], loading: false, error: '' }); return; }
    if (disabled) return;
    const controller = new AbortController(), ownerSource = source.id;
    setBinding({ id: sourceID, tracks: [], loading: true, error: '' });
    void Promise.all([api.source(sourceID, controller.signal), api.tracks(sourceID, controller.signal)]).then(([replacement, inspected]) => {
      if (controller.signal.aborted || primaryID.current !== ownerSource) return;
      const audio = replacementTrackState(inspected.tracks);
      const error = !replacementSourceAvailable(replacement, ownerSource) ? 'Выберите другую аудиозапись, загруженную в этой сессии.'
        : !audio.tracks.length ? 'В файле нет поддерживаемой аудиодорожки с 1–8 каналами.' : '';
      setBinding({ id: sourceID, source: replacement, ...audio, loading: false, error });
    }).catch(error => {
      if (controller.signal.aborted || primaryID.current !== ownerSource) return;
      noteSession(error);
      setBinding({ id: sourceID, tracks: [], loading: false, error: error instanceof ApiError && ['not_found', 'source_removed', 'expired'].includes(error.code)
        ? 'Аудиофайл замены недоступен. Выберите или загрузите его заново.' : errorMessage(error) });
    });
    return () => controller.abort();
  }, [source.id, sourceID, bindingRevision, disabled]);

  useEffect(() => {
    if (!active || !expanded || !audioExpanded || disabled) return;
    const controller = new AbortController(), ownerSource = source.id;
    setSourcesLoading(true); setSourcesError('');
    void api.sources(controller.signal).then(result => {
      if (controller.signal.aborted || primaryID.current !== ownerSource) return;
      setOwnedSources(result.sources.filter(candidate => replacementSourceAvailable(candidate, ownerSource)));
    }).catch(error => {
      if (controller.signal.aborted || primaryID.current !== ownerSource) return;
      noteSession(error); setSourcesError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted && primaryID.current === ownerSource) setSourcesLoading(false); });
    return () => { controller.abort(); setSourcesLoading(false); };
  }, [source.id, active, expanded, audioExpanded, disabled, sourcesRevision]);

  const window = loudnessWindow(source, analysisRange);
  const measurementIdentity = JSON.stringify([source.id, window?.start_ms, window?.end_ms, originalAudio?.index, output.audio_replace?.source_id]);
  const shownMeasurement = measurement?.identity === measurementIdentity ? measurement.result : null;
  const analysisUnavailable = source.kind !== 'upload' ? 'Измерение доступно для загруженного файла. Загрузите исходную запись.'
    : !window ? 'Выберите фрагмент не длиннее 30 минут для измерения громкости.'
      : output.audio_replace ? output.audio_normalize ? 'Внешний звук будет измерен при экспорте. Измерение здесь относится только к исходной записи.' : 'Здесь можно измерить только исходную запись. Чтобы выровнять новый звук, включите выравнивание громкости.'
        : tracks !== null && !originalAudio ? 'В источнике нет доступной аудиодорожки.' : '';
  useEffect(() => {
    measureController.current?.abort(); measureController.current = null; setMeasuring(false); setMeasurementError('');
  }, [measurementIdentity]);
  async function measure() {
    if (!window || analysisUnavailable || disabled || !active || measuring) return;
    const controller = new AbortController(), ownerSource = source.id, identity = measurementIdentity;
    measureController.current?.abort(); measureController.current = controller;
    setMeasuring(true); setMeasurementError(''); setMeasurement(null);
    try {
      const result = await api.analyzeLoudness(ownerSource, { ...window, ...(originalAudio ? { audio_track: originalAudio.index } : {}) }, controller.signal);
      if (controller.signal.aborted || primaryID.current !== ownerSource || measureController.current !== controller) return;
      setMeasurement({ identity, result });
    } catch (error) {
      if (controller.signal.aborted || primaryID.current !== ownerSource) return;
      noteSession(error); setMeasurementError(analysisFailure(error));
    } finally {
      if (measureController.current === controller) { measureController.current = null; setMeasuring(false); }
    }
  }
  async function uploadAudio(file: File) {
    if (disabled || !active || uploading) return;
    const invalid = replacementFileError(file, maximumBytes);
    if (invalid) { setUploadError(invalid); return; }
    const controller = new AbortController(), ownerSource = source.id;
    uploadController.current?.abort(); uploadController.current = controller;
    setUploading(true); setUploadProgress(null); setUploadError('');
    let uploaded = false;
    try {
      const replacement = await api.upload(file, controller.signal, progress => {
        if (!controller.signal.aborted && primaryID.current === ownerSource) setUploadProgress(progress);
      });
      uploaded = true;
      if (controller.signal.aborted || primaryID.current !== ownerSource) return;
      const inspected = await api.tracks(replacement.id, controller.signal);
      if (controller.signal.aborted || primaryID.current !== ownerSource) return;
      const audio = replacementTracks(inspected.tracks);
      if (!replacementSourceAvailable(replacement, ownerSource) || !audio.length) {
        setUploadError('Файл загружен, но в нём нет поддерживаемой аудиодорожки с 1–8 каналами. Выберите другую запись.');
        setSourcesRevision(value => value + 1); return;
      }
      setOwnedSources(previous => [replacement, ...previous.filter(candidate => candidate.id !== replacement.id)]);
      setCompatibilityLocation(replacementGroupRef.current?.open ? 'audio' : 'root');
      onChange(previous => ({ ...previous, audio_replace: { source_id: replacement.id, offset_ms: 0 } }));
      revealCompatibility(true);
    } catch (error) {
      if (controller.signal.aborted || primaryID.current !== ownerSource) return;
      noteSession(error);
      setUploadError(uploaded ? 'Файл загружен, но проверить его дорожки не удалось. Обновите список файлов и выберите запись ещё раз.' : errorMessage(error, 'source-create'));
    } finally {
      if (uploadController.current === controller) { uploadController.current = null; setUploading(false); setUploadProgress(null); }
    }
  }
  function cancelUpload() {
    uploadController.current?.abort(); uploadController.current = null; setUploading(false); setUploadProgress(null);
    setUploadError('Загрузка остановлена. Если файл успел сохраниться, он останется в списке файлов на сервере.');
    setSourcesRevision(value => value + 1);
  }
  const activeLabels = activeEnhancementLabels(output);
  const canvas = output.canvas;
  const canvasPreset = customCanvas ? 'custom' : canvas?.width === 1080 && canvas.height === 1920 ? 'portrait' : canvas?.width === 1080 && canvas.height === 1080 ? 'square' : canvas?.width === 1920 && canvas.height === 1080 ? 'landscape' : 'custom';
  const picture = canvas ? canvasPicturePercent(source, canvas, output.crop) : null;
  function toggleCompatibilityGroup(group: 'loudness' | 'canvas' | 'audio', open: boolean) {
    setCompatibilityLocation(previous => open ? group : previous === group ? 'root' : previous);
    if (open) revealCompatibility();
  }
  const compatibilityNotice = conflict && <div ref={compatibilityNoticeRef} className="enhancement-conflict" role="alert"><p>{t(conflict)}</p><button type="button" className="text-button" disabled={disabled || uploading} onClick={() => onChange(compatibleEnhancementSettings)}>{t('Использовать совместимые настройки')}</button></div>;
  const sourceChoices = [{ value: 'none', label: t('Оставить исходный звук') },
    ...ownedSources.map(candidate => ({ value: candidate.id, label: candidate.title || t('Аудиозапись') })),
    ...(sourceID && !ownedSources.some(candidate => candidate.id === sourceID) ? [{ value: sourceID, label: binding.source?.title || t('Выбранная аудиозапись') }] : [])];
  return <details className="export-enhancements" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span>{t('Дополнительно: звук и размер')}{activeLabels.length > 0 && <small>{t('Включено: {count}', { count: activeLabels.length })}</small>}</span><Icon name="chevron" size={16} /></summary>
    <div className="export-enhancements-content">
      <p className="enhancement-hint">{t('Необязательная обработка готового файла. Предпросмотр и волна показывают исходную запись.')}</p>
      {compatibilityLocation === 'root' && compatibilityNotice}
      <details className="enhancement-group" onToggle={event => { if (event.target === event.currentTarget) toggleCompatibilityGroup('loudness', event.currentTarget.open); }}>
        <summary><span>{t('Громкость')}{output.audio_normalize && <small>{t('Включено')}</small>}</span><Icon name="chevron" size={15} /></summary>
        <div className="enhancement-body">
          <label className="enhancement-choice"><input type="checkbox" checked={!!output.audio_normalize} disabled={disabled} onChange={event => { const enabled = event.target.checked; setCompatibilityLocation('loudness'); onChange(previous => ({ ...previous, audio_normalize: enabled ? { ...DEFAULT_NORMALIZATION } : undefined })); if (enabled) revealCompatibility(); }} />{t('Выровнять громкость')}</label>
          {compatibilityLocation === 'loudness' && compatibilityNotice}
          <p className="enhancement-hint">{t('По умолчанию −16 LUFS: удобный уровень для речи и веб-видео. Громкость выравнивается в итоговых выбранных фрагментах.')}</p>
          {noNormalizableAudio && <p className="enhancement-field-error" role="alert">{t('В источнике нет доступной аудиодорожки. Отключите выравнивание или выберите звук для замены.')}</p>}
          {output.audio_normalize && <details className="enhancement-targets"><summary>{t('Настроить целевой уровень')}</summary><div className="enhancement-number-grid">
            {([{ key: 'integrated_lufs', label: 'Громкость, LUFS', min: -70, max: -5 }, { key: 'true_peak_dbtp', label: 'Максимальный пик, dBTP', min: -9, max: 0 }, { key: 'loudness_range_lu', label: 'Диапазон громкости, LU', min: 1, max: 50 }] as const).map(field => <NumberField key={field.key} id={`${instanceID}-${field.key}`} label={t(field.label)} value={output.audio_normalize![field.key]} minimum={field.min} maximum={field.max} disabled={disabled}
              onChange={value => onChange(previous => previous.audio_normalize ? { ...previous, audio_normalize: { ...previous.audio_normalize, [field.key]: value } } : previous)} onValidityChange={invalid => fieldValidity(`normalize-${field.key}`, invalid)} />)}
          </div><p className="enhancement-hint">{t('После кодирования пик может немного измениться. Это цели обработки, а не проверка требований площадки.')}</p></details>}
          <div className="enhancement-measurement">
            <p className="enhancement-hint">{window ? t('Измерить исходный звук: {start} — {end}.', { start: formatTimecode(window.start_ms, true), end: formatTimecode(window.end_ms, true) }) : t('Измерение исходного звука')}</p>
            {analysisUnavailable && <p className="enhancement-hint">{t(analysisUnavailable)}</p>}
            <div className="enhancement-inline-actions"><button type="button" className="text-button" disabled={disabled || !!analysisUnavailable || measuring || !active} onClick={() => void measure()}>{measuring ? t('Измеряем громкость…') : t('Измерить громкость')}</button>{measuring && <button type="button" className="text-button" onClick={() => { measureController.current?.abort(); measureController.current = null; setMeasuring(false); }}>{t('Отменить измерение')}</button>}</div>
            {measurementError && <p className="enhancement-field-error" role="alert">{t(measurementError)}</p>}
            {shownMeasurement && <div className="loudness-result" role="status"><dl>{([{ key: 'integrated_lufs', label: 'Громкость', unit: 'LUFS' }, { key: 'true_peak_dbtp', label: 'Пик', unit: 'dBTP' }, { key: 'loudness_range_lu', label: 'Диапазон', unit: 'LU' }] as const).map(metric => <div key={metric.key}><dt>{t(metric.label)}</dt><dd>{shownMeasurement[metric.key] === null ? '—' : `${shownMeasurement[metric.key]!.toLocaleString(locale, { maximumFractionDigits: 1 })} ${metric.unit}`}</dd></div>)}</dl>{shownMeasurement.integrated_lufs === null && <p className="enhancement-hint">{t('В этом интервале нет измеримого звука.')}</p>}{window && shownMeasurement.analyzed_end_ms < window.end_ms && <p className="enhancement-field-error">{t('Измерена только часть интервала: до {end}.', { end: formatTimecode(shownMeasurement.analyzed_end_ms, true) })}</p>}</div>}
          </div>
        </div>
      </details>
      <details className="enhancement-group" onToggle={event => { if (event.target === event.currentTarget) toggleCompatibilityGroup('canvas', event.currentTarget.open); }}>
        <summary><span>{t('Размер кадра и фон')}{canvas && <small>{canvas.width} × {canvas.height}</small>}</span><Icon name="chevron" size={15} /></summary>
        <div className="enhancement-body">
          <label className="enhancement-choice"><input type="checkbox" checked={!!canvas} disabled={disabled} onChange={event => { const enabled = event.target.checked; setCompatibilityLocation('canvas'); if (enabled) setCustomCanvas(false); onChange(previous => ({ ...previous, canvas: enabled ? { ...DEFAULT_CANVAS } : undefined })); if (enabled) revealCompatibility(); }} />{t('Добавить поля к видео')}</label>
          {compatibilityLocation === 'canvas' && compatibilityNotice}
          <p className="enhancement-hint">{t('Изображение целиком впишется в выбранный размер, без растяжения. Свободное место заполнится цветом.')}</p>
          {canvas && <>
            <div className="enhancement-field"><label htmlFor="canvas-size">{t('Размер видео')}</label><SelectControl id="canvas-size" label={t('Размер видео')} value={canvasPreset} disabled={disabled} options={[{ value: 'portrait', label: t('Вертикальный · 1080 × 1920') }, { value: 'square', label: t('Квадратный · 1080 × 1080') }, { value: 'landscape', label: t('Горизонтальный · 1920 × 1080') }, { value: 'custom', label: t('Свой размер') }]} onChange={value => {
              setCustomCanvas(value === 'custom');
              const size = value === 'portrait' ? [1080, 1920] : value === 'square' ? [1080, 1080] : value === 'landscape' ? [1920, 1080] : null;
              if (size) onChange(previous => previous.canvas ? { ...previous, canvas: { ...previous.canvas, width: size[0], height: size[1] } } : previous);
            }} /></div>
            {canvasPreset === 'custom' && <div className="enhancement-number-grid two-columns">
              <NumberField id="canvas-width" label={t('Ширина, пикс.')} value={canvas.width} minimum={2} maximum={4096} integer even disabled={disabled} onChange={width => onChange(previous => previous.canvas ? { ...previous, canvas: { ...previous.canvas, width } } : previous)} onValidityChange={invalid => fieldValidity('canvas-width', invalid)} />
              <NumberField id="canvas-height" label={t('Высота, пикс.')} value={canvas.height} minimum={2} maximum={4096} integer even disabled={disabled} onChange={height => onChange(previous => previous.canvas ? { ...previous, canvas: { ...previous.canvas, height } } : previous)} onValidityChange={invalid => fieldValidity('canvas-height', invalid)} />
            </div>}
            <div className="enhancement-canvas-row"><div className="enhancement-field"><label htmlFor="canvas-background">{t('Цвет фона')}</label><div className="enhancement-color"><input id="canvas-background" type="color" value={/^#[0-9a-f]{6}$/i.test(canvas.background) ? canvas.background : '#000000'} disabled={disabled} onChange={event => { const background = event.target.value; onChange(previous => previous.canvas ? { ...previous, canvas: { ...previous.canvas, background } } : previous); }} /><span>{canvas.background.toUpperCase()}</span></div></div>
              <div className="canvas-diagram" role="img" aria-label={t('Схема полей готового видео')} style={{ width: Math.min(160, 96 * canvas.width / canvas.height), height: Math.min(96, 160 * canvas.height / canvas.width), background: canvas.background }}>{picture && <span style={{ width: `${picture.width}%`, height: `${picture.height}%` }}>{t('Видео')}</span>}</div>
            </div>
          </>}
        </div>
      </details>
      <details ref={replacementGroupRef} className="enhancement-group" onToggle={event => { if (event.target === event.currentTarget) { setAudioExpanded(event.currentTarget.open); toggleCompatibilityGroup('audio', event.currentTarget.open); } }}>
        <summary><span>{t('Заменить звук')}{sourceID && <small>{t('Включено')}</small>}</span><Icon name="chevron" size={15} /></summary>
        <div className="enhancement-body">
          <p className="enhancement-hint">{t('Другой звук заменит исходную дорожку при экспорте. Это не наложение музыки. Предпросмотр остаётся с исходным звуком.')}</p>
          <div className="enhancement-field"><label htmlFor="replacement-audio-source">{t('Аудиофайл на сервере')}</label><SelectControl id="replacement-audio-source" label={t('Аудиофайл на сервере')} value={sourceID || 'none'} disabled={disabled || uploading} options={sourceChoices} onChange={value => { setUploadError(''); setCompatibilityLocation('audio'); onChange(previous => ({ ...previous, audio_replace: value === 'none' ? undefined : { source_id: value, offset_ms: 0 } })); if (value !== 'none') revealCompatibility(); }} /></div>
          {sourcesLoading && <p className="enhancement-hint" role="status">{t('Обновляем список файлов…')}</p>}
          {sourcesError && <p className="enhancement-field-error" role="alert">{t(sourcesError)}</p>}
          <button type="button" className="text-button enhancement-refresh" disabled={disabled || uploading || sourcesLoading} onClick={() => setSourcesRevision(value => value + 1)}>{t('Обновить список файлов')}</button>
          <div className="enhancement-upload"><label className={`button secondary enhancement-file-label${disabled || uploading ? ' is-disabled' : ''}`} htmlFor="replacement-audio-file"><Icon name="upload" size={16} />{t('Загрузить другой звук')}</label><input id="replacement-audio-file" className="enhancement-file-input" type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.mp4,.mov,.mkv,.webm" disabled={disabled || uploading} aria-label={t('Загрузить другой звук')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadAudio(file); }} /><p className="enhancement-hint">{t('Аудиозапись или видео со звуком, до {limit}.', { limit: formatBytes(maximumBytes, locale) })}</p></div>
          {uploading && <div className="enhancement-upload-status" role="status"><p>{uploadProgress?.total ? t('Загружаем звук: {percent}%', { percent: Math.floor(uploadProgress.loaded * 100 / uploadProgress.total) }) : t('Загружаем и проверяем звук…')}</p>{uploadProgress?.total && <progress max={uploadProgress.total} value={uploadProgress.loaded} aria-label={t('Загрузка звука')} />}<button type="button" className="text-button" onClick={cancelUpload}>{t('Отменить загрузку')}</button></div>}
          {uploadError && <p className="enhancement-field-error" role="alert">{t(uploadError)}</p>}
          {compatibilityLocation === 'audio' && compatibilityNotice}
          {sourceID && <div className="enhancement-replacement-options">
            {binding.loading && <p className="enhancement-hint" role="status">{t('Проверяем аудиофайл замены…')}</p>}
            {binding.source && chosenReplacementTrack && !binding.loading && !binding.error && <p className="enhancement-hint" role="status">{t('Звук для экспорта: {name}', { name: binding.source.title || t('Аудиозапись') })}</p>}
            {binding.error && <div className="enhancement-field-error" role="alert"><p>{t(binding.error)}</p><button type="button" className="text-button" disabled={disabled || binding.loading} onClick={() => setBindingRevision(value => value + 1)}>{t('Проверить аудиофайл снова')}</button></div>}
            {!binding.loading && !binding.error && !chosenReplacementTrack && <p className="enhancement-field-error" role="alert">{t('Выбранная дорожка замены недоступна. Выберите другую дорожку.')}</p>}
            {binding.tracks.length > 0 && <div className="enhancement-field"><label htmlFor="replacement-audio-track">{t('Дорожка замены')}</label><SelectControl id="replacement-audio-track" label={t('Дорожка замены')} disabled={disabled || uploading} value={selectedReplacement === undefined ? 'default' : String(selectedReplacement)} options={[{ value: 'default', label: t('По умолчанию в файле замены'), disabled: !binding.tracks.some(track => track.index === binding.defaultIndex) }, ...binding.tracks.map(track => ({ value: String(track.index), label: trackLabel(track, t) })), ...(selectedReplacement !== undefined && !binding.tracks.some(track => track.index === selectedReplacement) ? [{ value: String(selectedReplacement), label: t('Дорожка #{index} — проверьте доступность', { index: selectedReplacement }) }] : [])]} onChange={value => onChange(previous => {
              if (!previous.audio_replace) return previous;
              const { audio_track: _track, ...replacement } = previous.audio_replace;
              return { ...previous, audio_replace: { ...replacement, ...(value === 'default' ? {} : { audio_track: Number(value) }) } };
            })} /></div>}
            <NumberField id="replacement-audio-offset" label={t('Сдвиг звука, мс')} value={output.audio_replace?.offset_ms ?? 0} minimum={-86400000} maximum={86400000} integer disabled={disabled || uploading} onChange={offset_ms => onChange(previous => previous.audio_replace ? { ...previous, audio_replace: { ...previous.audio_replace, offset_ms } } : previous)} onValidityChange={invalid => fieldValidity('replacement-offset', invalid)} />
            <p className="enhancement-hint">{t('Плюс задерживает начало записи, минус запускает её раньше. Например, +500: новый звук начинается на 0,5 секунды исходного видео. Сдвиг относится к исходной записи, до нарезки.')}</p>
            <p className="enhancement-hint">{t('Если звука не хватает, оставшаяся часть будет тишиной. Длина видео сохранится.')}</p>
            <button type="button" className="text-button" disabled={disabled || uploading} onClick={() => onChange(previous => ({ ...previous, audio_replace: undefined }))}>{t('Вернуть исходный звук')}</button>
            <p className="enhancement-hint">{t('Аудиофайл останется на сервере. Эта кнопка только отменяет замену звука.')}</p>
          </div>}
        </div>
      </details>
    </div>
  </details>;
}
