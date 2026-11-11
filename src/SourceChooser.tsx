import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import type { UploadProgress } from './types';
import { durationLabel, formatBytes } from './timecode';
import { looksLikeLink, videoProvider, videoProviders } from './sourceInput';
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
  const [showProviders, setShowProviders] = useState(false);
  const [dragging, setDragging] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const disabled = !ready || busy || processing || blocked;
  const locked = busy || processing || blocked;
  const detected = videoProvider(url);
  const current = useRef({ disabled, locked, onFile, onUrl });
  current.current = { disabled, locked, onFile, onUrl };

  useEffect(() => { dragDepth.current = 0; setDragging(false); }, [disabled]);
  // The whole window accepts a dropped file while this screen is shown, and a
  // copied link can be pasted without first focusing the field.
  useEffect(() => {
    const files = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    const enter = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault(); dragDepth.current++;
      if (!current.current.disabled) setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = current.current.disabled ? 'none' : 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!files(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault(); dragDepth.current = 0; setDragging(false);
      const file = event.dataTransfer!.files[0];
      if (file && !current.current.disabled) current.current.onFile(file);
    };
    const paste = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (current.current.locked || document.querySelector('dialog[open]') || target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!looksLikeLink(text)) return;
      event.preventDefault();
      current.current.onUrl(text.trim());
      urlInput.current?.focus();
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    document.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      document.removeEventListener('paste', paste);
    };
  }, []);

  const uploading = !!progress?.total && progress.loaded < progress.total;
  const stage = !progress ? 'Открываем видео…' : !progress.total ? 'Передаём файл на сервер…' : uploading ? 'Передаём файл на сервер…' : 'Проверяем видео…';
  const percent = uploading ? new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { style: 'percent', maximumFractionDigits: 0 }).format(Math.floor(progress.loaded / progress.total! * 100) / 100) : '';
  const fileLine = t('или {button}, его можно перетащить в окно').split('{button}');
  const describedBy = ['source-hint', error && 'source-error'].filter(Boolean).join(' ');

  return <section className="source-chooser" aria-labelledby="source-heading">
    <h2 id="source-heading" className="sr-only">{t('Открыть источник')}</h2>
    <form className={`source-form${busy ? ' busy' : ''}`} noValidate aria-busy={busy} onSubmit={event => { event.preventDefault(); if (!disabled) onOpen(); }}>
      <label htmlFor="source-url" className="sr-only">{t('Ссылка на видео')}</label>
      <div className={`source-field${error ? ' invalid' : ''}`}>
        <input ref={urlInput} id="source-url" type="text" inputMode="url" enterKeyHint="go" autoCapitalize="none" autoCorrect="off" placeholder={t('Вставьте ссылку на видео')} value={url} onChange={event => onUrl(event.target.value)} disabled={locked} aria-invalid={!!error} aria-describedby={describedBy} autoComplete="off" spellCheck={false} />
        {detected && <span className="source-provider-tag" role="status">{t(detected.name)}</span>}
        <button className="button primary source-open" type="submit" aria-label={t('Открыть видео')} disabled={disabled}>{t('Открыть')}</button>
        {busy && <div className="source-progress">
          <p className="sr-only" role="status">{t(stage)}</p>
          {uploading ? <div className="upload-progress" aria-live="off">
            <span className="source-progress-label">{t('Передано {loaded} из {total}', { loaded: formatBytes(progress.loaded, locale), total: formatBytes(progress.total!, locale) })}</span>
            <span className="source-progress-percent">{percent}</span>
            <progress max={progress.total!} value={progress.loaded} aria-label={t('Загрузка видео')} />
          </div> : <>
            <span className="source-progress-label" aria-hidden="true">{t(stage)}</span>
            <span className="source-progress-bar" aria-hidden="true" />
          </>}
          <button type="button" className="button secondary source-cancel" onClick={onCancel}>{t('Отменить')}</button>
        </div>}
      </div>
    </form>
    <p id="source-hint" className="sr-only">{t('YouTube, Twitch, Rutube, TikTok и другие сервисы.')}</p>
    <div className="source-file-line">
      {uploading && progress.bytesPerSecond ? <p className="source-upload-speed">{t('{speed}/с · осталось примерно {time}', { speed: formatBytes(progress.bytesPerSecond, locale), time: durationLabel(Math.ceil((progress.total! - progress.loaded) / progress.bytesPerSecond) * 1000, locale) })}</p>
        : <p>{fileLine[0]}<button type="button" className="upload-button" aria-describedby={error ? 'source-file-hint source-error' : 'source-file-hint'} disabled={disabled} onClick={() => fileInput.current?.click()}>{t('выберите файл')}</button>{fileLine[1]}<span className="source-file-separator" aria-hidden="true"> · </span><span id="source-file-hint">{t('MP4, MOV, MKV или WebM до {limit}.', { limit: formatBytes(maximumBytes, locale) })}</span></p>}
      <input ref={fileInput} type="file" id="source-file" hidden tabIndex={-1} aria-label={t('Выбрать видео')} accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} />
    </div>
    {processing && <p className="source-lock-hint">{t('Сейчас идёт экспорт. Дождитесь его или отмените на последнем шаге.')}</p>}
    {error && <div id="source-error" className="error-message" role="alert">{t(error)}{!ready && <button type="button" className="text-button" onClick={onReconnect}>{t('Повторить подключение')}</button>}</div>}
    <div className="provider-disclosure">
      <button type="button" className="text-button" aria-expanded={showProviders} aria-controls="source-providers" onClick={() => setShowProviders(!showProviders)}>{t('Какие ссылки подойдут')}<Icon name="chevron" size={14} /></button>
      {showProviders && <div id="source-providers" className="source-provider-details">
        <ul aria-label={t('Видеосервисы')}>{videoProviders.map(provider => <li key={provider.id}>{t(provider.name)}</li>)}</ul>
        <p>{t('Shorts, Reels, отдельные видео, записи стримов и клипы. Также можно вставить публичную HTTPS-ссылку на видеофайл.')}</p>
        <p>{t('Видео должно открываться без входа. Ссылки на каналы, плейлисты и прямые эфиры пока не подойдут.')}</p>
      </div>}
    </div>
    {dragging && <div className="source-drop-overlay" aria-hidden="true"><p>{t('Отпустите файл, чтобы открыть')}</p></div>}
  </section>;
}
