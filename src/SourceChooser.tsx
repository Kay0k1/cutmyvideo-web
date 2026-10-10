import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import type { UploadProgress } from './types';
import { durationLabel, formatBytes } from './timecode';
import { videoProvider, videoProviders } from './sourceInput';
import './SourceChooser.css';

export function SourceChooser({ url, onUrl, onOpen, onFile, busy, progress, maximumBytes, blocked, processing, ready, error, onCancel, onReconnect }: {
  url: string;
  onUrl(value: string): void;
  onOpen(): void;
  onFile(file: File): void;
  busy: boolean;
  progress: UploadProgress | null;
  maximumBytes: number;
  blocked: boolean;
  processing: boolean;
  ready: boolean;
  error: string;
  onCancel(): void;
  onReconnect(): void;
}) {
  const { t, locale } = useLanguage();
  const [mode, setMode] = useState<'link' | 'file'>('link');
  const [showProviders, setShowProviders] = useState(false);
  const [dragging, setDragging] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const focusMode = useRef<'link' | 'file' | null>(null);
  const dragDepth = useRef(0);
  const disabled = !ready || busy || processing || blocked;
  const detected = videoProvider(url);

  function focusChoice(next: 'link' | 'file') {
    if (next === 'link') urlInput.current?.focus();
    else uploadButton.current?.focus();
  }
  function chooseMode(next: 'link' | 'file') {
    onUrl(url);
    if (next === mode) { focusChoice(next); return; }
    focusMode.current = next; setMode(next);
  }
  useLayoutEffect(() => {
    if (focusMode.current !== mode) return;
    focusMode.current = null; focusChoice(mode);
  }, [mode]);
  useEffect(() => { dragDepth.current = 0; setDragging(false); }, [mode, disabled]);

  return <section className="source-chooser" aria-labelledby="source-heading">
    <h2 id="source-heading" className="sr-only">{t('Открыть источник')}</h2>
    <div className="source-choice" role="group" aria-label={t('Откуда взять видео')}>
      <button type="button" aria-pressed={mode === 'link'} disabled={busy || processing || blocked} onClick={() => chooseMode('link')}><Icon name="link" size={20} />{t('Ссылка')}</button>
      <button type="button" aria-pressed={mode === 'file'} disabled={busy || processing || blocked} onClick={() => chooseMode('file')}><Icon name="file" size={19} />{t('Файл')}</button>
    </div>
    {mode === 'link' ? <form className="source-form" noValidate aria-busy={busy} onSubmit={event => { event.preventDefault(); if (!disabled) onOpen(); }}>
      <label htmlFor="source-url">{t('Ссылка на видео')}</label>
      <div className="source-input-wrap"><Icon name="link" size={20} /><input ref={urlInput} id="source-url" type="text" inputMode="url" enterKeyHint="go" autoCapitalize="none" autoCorrect="off" placeholder={t('Вставьте ссылку «Поделиться»')} value={url} onChange={event => onUrl(event.target.value)} disabled={busy || processing || blocked} aria-invalid={!!error} aria-describedby={error ? 'source-error source-hint' : 'source-hint'} autoComplete="off" spellCheck={false} /></div>
      <div className="source-link-context">
        <p id="source-hint" className="field-hint">{t('YouTube, Twitch, Rutube, TikTok и другие сервисы.')}</p>
        {detected && <span className="source-provider-tag" role="status">{t(detected.name)}</span>}
      </div>
      <button className="button primary source-open" type="submit" disabled={disabled}>{busy ? <><span className="spinner" />{t('Открываем видео…')}</> : t('Открыть видео')}<Icon name="chevron" size={17} /></button>
      <div className="provider-disclosure">
        <button type="button" className="text-button" aria-expanded={showProviders} aria-controls="source-providers" onClick={() => setShowProviders(!showProviders)}>{t('Какие ссылки подойдут')}<Icon name="chevron" size={14} /></button>
        {showProviders && <div id="source-providers" className="source-provider-details">
          <ul aria-label={t('Видеосервисы')}>{videoProviders.map(provider => <li key={provider.id}>{t(provider.name)}</li>)}</ul>
          <p>{t('Shorts, Reels, отдельные видео, записи стримов и клипы. Также можно вставить публичную HTTPS-ссылку на видеофайл.')}</p>
          <p>{t('Видео должно открываться без входа. Ссылки на каналы, плейлисты и прямые эфиры пока не подойдут.')}</p>
        </div>}
      </div>
    </form> : <div className={`file-dropzone${dragging ? ' dragging' : ''}`} aria-busy={busy}
      onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; if (!disabled) setDragging(true); } }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = disabled || !event.dataTransfer.types.includes('Files') ? 'none' : 'copy'; }}
      onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (!disabled) { const file = event.dataTransfer.files[0]; if (file) onFile(file); } }}>
      <div className="upload-symbol"><Icon name="upload" size={27} /></div>
      <p className="drop-label">{t('Выберите видео с устройства')}</p><p id="source-file-hint" className="field-hint">{t('MP4, MOV, MKV или WebM до {limit}.', { limit: formatBytes(maximumBytes, locale) })}</p>
      <input ref={fileInput} type="file" id="source-file" hidden tabIndex={-1} aria-label={t('Выбрать видео')} accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} />
      <button ref={uploadButton} type="button" className="button primary upload-button" aria-describedby={error ? 'source-file-hint source-error' : 'source-file-hint'} disabled={disabled} onClick={() => fileInput.current?.click()}>{busy ? <><span className="spinner" />{t('Загружаем видео…')}</> : t('Выбрать видео')}</button>
    </div>}
    {busy && <div className="source-progress" role="status">{progress && <div className="upload-progress" aria-live="off"><progress max={progress.total ?? undefined} value={progress.total ? progress.loaded : undefined} aria-label={t('Загрузка видео')} />{progress.total && <p>{t('Передано {loaded} из {total}', { loaded: formatBytes(progress.loaded, locale), total: formatBytes(progress.total, locale) })}</p>}{progress.bytesPerSecond && progress.total && progress.loaded < progress.total && <p>{t('{speed}/с · осталось примерно {time}', { speed: formatBytes(progress.bytesPerSecond, locale), time: durationLabel(Math.ceil((progress.total - progress.loaded) / progress.bytesPerSecond) * 1000, locale) })}</p>}</div>}<p>{t(progress && (!progress.total || progress.loaded < progress.total) ? 'Передаём файл на сервер…' : 'Проверяем видео. Это может занять немного времени.')}</p><button type="button" className="text-button" onClick={onCancel}>{t('Отменить')}</button></div>}
    {processing && <p className="source-lock-hint">{t('Сейчас идёт экспорт. Дождитесь его или отмените на последнем шаге.')}</p>}
    {error && <div id="source-error" className="error-message" role="alert">{t(error)}{!ready && <button type="button" className="text-button" onClick={onReconnect}>{t('Повторить подключение')}</button>}</div>}
  </section>;
}
