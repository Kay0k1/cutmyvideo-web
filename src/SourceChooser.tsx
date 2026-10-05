import { useRef, useState } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import { videoProvider, videoProviders } from './sourceInput';
import './SourceChooser.css';

export function SourceChooser({ url, onUrl, onOpen, onFile, busy, processing, ready, error, onCancel, onReconnect }: {
  url: string;
  onUrl(value: string): void;
  onOpen(): void;
  onFile(file: File): void;
  busy: boolean;
  processing: boolean;
  ready: boolean;
  error: string;
  onCancel(): void;
  onReconnect(): void;
}) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<'link' | 'file'>('link');
  const [showProviders, setShowProviders] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const disabled = !ready || busy || processing;
  const detected = videoProvider(url);

  return <section className="source-chooser" aria-labelledby="source-heading">
    <h2 id="source-heading" className="sr-only">{t('Открыть источник')}</h2>
    <div className="source-choice" role="group" aria-label={t('Откуда взять видео')}>
      <button type="button" aria-pressed={mode === 'link'} disabled={busy || processing} onClick={() => { setMode('link'); onUrl(url); }}><Icon name="link" size={20} />{t('Ссылка')}</button>
      <button type="button" aria-pressed={mode === 'file'} disabled={busy || processing} onClick={() => { setMode('file'); onUrl(url); }}><Icon name="file" size={19} />{t('MP4 файл')}</button>
    </div>
    {mode === 'link' ? <form className="source-form" noValidate onSubmit={event => { event.preventDefault(); onOpen(); }}>
      <label htmlFor="source-url">{t('Ссылка на видео')}</label>
      <div className="source-input-wrap"><Icon name="link" size={20} /><input id="source-url" type="text" inputMode="url" placeholder={t('Вставьте ссылку «Поделиться»')} value={url} onChange={event => onUrl(event.target.value)} disabled={busy || processing} aria-invalid={!!error} aria-describedby={error ? 'source-error source-hint' : 'source-hint'} autoComplete="off" spellCheck={false} /></div>
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
    </form> : <div className={`file-dropzone${dragging ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!disabled) { const file = event.dataTransfer.files[0]; if (file) onFile(file); } }}>
      <div className="upload-symbol"><Icon name="upload" size={27} /></div>
      <p className="drop-label">{t('Перетащите видео сюда')}</p><p id="source-file-hint" className="field-hint">{t('MP4 до 1 ГБ. Файл останется доступен на время работы.')}</p>
      <input ref={fileInput} type="file" id="source-file" hidden tabIndex={-1} aria-label={t('Выбрать MP4')} accept="video/mp4,.mp4" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} />
      <button type="button" className="button primary upload-button" aria-describedby={error ? 'source-file-hint source-error' : 'source-file-hint'} disabled={disabled} onClick={() => fileInput.current?.click()}>{busy ? <><span className="spinner" />{t('Загружаем видео…')}</> : t('Выбрать MP4')}</button>
    </div>}
    {busy && <div className="source-progress" role="status"><p>{t('Проверяем видео. Это может занять немного времени.')}</p><button type="button" className="text-button" onClick={onCancel}>{t('Отменить')}</button></div>}
    {processing && <p className="source-lock-hint">{t('Сейчас идёт экспорт. Дождитесь его или отмените на последнем шаге.')}</p>}
    {error && <div id="source-error" className="error-message" role="alert">{t(error)}{!ready && <button type="button" className="text-button" onClick={onReconnect}>{t('Повторить подключение')}</button>}</div>}
  </section>;
}
