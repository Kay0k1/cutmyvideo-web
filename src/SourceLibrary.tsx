import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import { useLanguage } from './Language';
import { RetentionNotice } from './RetentionNotice';
import { Icon } from './Icons';
import { formatTimecode } from './timecode';
import type { Source } from './types';

/** Fetch only on disclosure; retained sources remain manageable after replacement. */
export function SourceLibrary({ currentID, disabled, currentBusy, onDeleted, onBusy }: {
  currentID?: string; disabled: boolean; currentBusy: boolean; onDeleted(id: string): void; onBusy(busy: boolean): void;
}) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const disposed = useRef(false);
  const heading = useRef<HTMLButtonElement>(null);
  useEffect(() => { disposed.current = false; return () => { disposed.current = true; }; }, []);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void api.sources(controller.signal).then(value => {
      if (!controller.signal.aborted) setSources(value.sources.slice(0, 20));
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [expanded, revision, currentID]);

  async function remove(id: string) {
    if (pending.current || disabled || id === currentID && currentBusy) return;
    if (!window.confirm(t('Удалить это видео, все его задания и готовые файлы? Восстановить их будет нельзя.'))) return;
    pending.current = true; onBusy(true); setDeleting(id); setError('');
    try {
      await api.deleteSource(id);
      // The mutation survives closing this step; its owner must still clear a deleted draft.
      onDeleted(id);
      if (disposed.current) return;
      setSources(previous => previous.filter(source => source.id !== id)); setRevision(value => value + 1);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_found') { onDeleted(id); if (!disposed.current) setSources(previous => previous.filter(source => source.id !== id)); }
      else if (!disposed.current) setError(errorMessage(error));
    } finally { pending.current = false; onBusy(false); if (!disposed.current) { setDeleting(null); window.requestAnimationFrame(() => heading.current?.focus()); } }
  }

  return <section className="source-library" aria-label={t('Сохранённые видео')}>
    <button ref={heading} type="button" className="text-button source-library-toggle" aria-expanded={expanded} aria-controls="saved-sources" disabled={disabled} onClick={() => setExpanded(value => !value)}>{t('Мои видео на сервере')}<Icon name="chevron" size={15} /></button>
    {expanded && <div id="saved-sources"><p className="field-hint">{t('Здесь можно удалить прежние видео и их результаты, чтобы освободить место.')}</p>
      {loading ? <p role="status">{t('Загружаем список…')}</p> : sources.length === 0 ? <p className="field-hint">{t('Сохранённых видео нет.')}</p> : <ul>{sources.map(source => <li key={source.id}><div><h3>{source.title}</h3><span>{formatTimecode(source.duration_ms)}</span><RetentionNotice expiresAt={source.expires_at} blocked={source.retention_blocked} kind="source" /></div><button type="button" className="text-button danger-button" aria-label={t('Удалить видео «{title}» и файлы', { title: source.title })} disabled={disabled || deleting !== null || source.id === currentID && currentBusy} onClick={() => void remove(source.id)}>{deleting === source.id ? t('Удаляем…') : t('Удалить')}</button></li>)}</ul>}
      {error && <p className="error-message" role="alert">{t(error)}<button type="button" className="text-button" disabled={disabled || deleting !== null} onClick={() => setRevision(value => value + 1)}>{t('Повторить')}</button></p>}
    </div>}
  </section>;
}
