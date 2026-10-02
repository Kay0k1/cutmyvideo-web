import { useRef, useState } from 'react';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import type { Source } from './types';

export function SourceChooser({ url, onUrl, onOpen, onFile, source, busy, processing, ready, error, onCancel, onReconnect, onResume }: {
  url: string;
  onUrl(value: string): void;
  onOpen(): void;
  onFile(file: File): void;
  source: Source | null;
  busy: boolean;
  processing: boolean;
  ready: boolean;
  error: string;
  onCancel(): void;
  onReconnect(): void;
  onResume(): void;
}) {
  const { t } = useLanguage();
  const [mode, setMode] = useState<'youtube' | 'file'>('youtube');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const disabled = !ready || busy || processing;

  return <section className="source-chooser" aria-labelledby="source-heading">
    <h2 id="source-heading" className="sr-only">{t('Открыть источник')}</h2>
    <div className="source-choice" role="group" aria-label={t('Откуда взять видео')}>
      <button type="button" aria-pressed={mode === 'youtube'} onClick={() => { setMode('youtube'); onUrl(url); }}><Icon name="youtube" size={20} />YouTube</button>
      <button type="button" aria-pressed={mode === 'file'} onClick={() => { setMode('file'); onUrl(url); }}><Icon name="file" size={19} />{t('MP4 файл')}</button>
    </div>
    {mode === 'youtube' ? <form className="source-form" noValidate onSubmit={event => { event.preventDefault(); onOpen(); }}>
      <label htmlFor="source-url">{t('Ссылка на YouTube')}</label>
      <div className="source-input-wrap"><Icon name="link" size={20} /><input id="source-url" type="text" inputMode="url" placeholder="youtube.com/watch?v=…" value={url} onChange={event => onUrl(event.target.value)} disabled={busy || processing} aria-invalid={!!error} aria-describedby={error ? 'source-error' : 'source-hint'} autoComplete="off" spellCheck={false} /></div>
      <p id="source-hint" className="field-hint">{t('Подойдёт обычная ссылка, Shorts или ссылка «Поделиться».')}</p>
      <button className="button primary source-open" type="submit" disabled={disabled}>{busy ? <><span className="spinner" />{t('Открываем видео…')}</> : t('Открыть видео')}<Icon name="chevron" size={17} /></button>
    </form> : <div className={`file-dropzone${dragging ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!disabled) { const file = event.dataTransfer.files[0]; if (file) onFile(file); } }}>
      <div className="upload-symbol"><Icon name="upload" size={27} /></div>
      <p className="drop-label">{t('Перетащите видео сюда')}</p><p className="field-hint">{t('MP4 до 1 ГБ. Файл останется доступен на время работы.')}</p>
      <input ref={fileInput} type="file" id="source-file" hidden tabIndex={-1} aria-label={t('Выбрать MP4')} accept="video/mp4,.mp4" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} />
      <button type="button" className="button primary upload-button" disabled={disabled} onClick={() => fileInput.current?.click()}>{busy ? <><span className="spinner" />{t('Загружаем видео…')}</> : t('Выбрать MP4')}</button>
    </div>}
    {busy && <div className="source-progress" role="status"><p>{t('Проверяем видео. Это может занять немного времени.')}</p><button type="button" className="text-button" onClick={onCancel}>{t('Отменить')}</button></div>}
    {processing && <p className="source-lock-hint">{t('Сейчас идёт экспорт. Дождитесь его или отмените на последнем шаге.')}</p>}
    {error && <div id="source-error" className="error-message" role="alert">{t(error)}{!ready && <button type="button" className="text-button" onClick={onReconnect}>{t('Повторить подключение')}</button>}</div>}
    {source && <div className="resume-source"><div><span>{t('Текущее видео')}</span><strong>{source.title}</strong></div><button type="button" className="text-button" onClick={onResume}>{t('Вернуться к моментам')}</button></div>}
  </section>;
}
