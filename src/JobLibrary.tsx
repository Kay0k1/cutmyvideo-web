import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';
import { useLanguage } from './Language';
import { Icon } from './Icons';
import { RetentionNotice } from './RetentionNotice';
import { formatBytes } from './timecode';
import { startVisiblePolling } from './visiblePolling';
import type { JobSummary } from './types';

const active = (job: JobSummary) => ['queued', 'running', 'waiting_storage'].includes(job.status);
const statusLabels = { queued: 'В очереди', running: 'Обрабатываем видео', waiting_storage: 'Ждём свободного места', succeeded: 'Файлы готовы', failed: 'Не удалось создать все файлы', cancelled: 'Обработка отменена' };

export function JobLibrary({ refreshKey, initiallyOpen = false }: { refreshKey?: string; initiallyOpen?: boolean }) {
  const { t, locale } = useLanguage();
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => { if (initiallyOpen) setExpanded(true); }, [initiallyOpen]);
  useEffect(() => {
    if (!expanded) return;
    return startVisiblePolling({
      read: signal => api.jobs(signal),
      onResult: value => { setJobs(value.jobs); setLoading(false); setError(''); return true; },
      onError: error => { setError(errorMessage(error)); setLoading(false); return true; },
      delay: value => value.jobs.some(active) ? 5000 : 30000,
    });
  }, [expanded, revision, refreshKey]);
  async function cancel(id: string) {
    if (pending.current) return;
    pending.current = true; setCancelling(id);
    try { const result = await api.cancel(id); setJobs(previous => previous.map(job => job.id === id ? { ...job, status: result.status } : job)); setRevision(value => value + 1); }
    catch (error) { setError(errorMessage(error)); }
    finally { pending.current = false; setCancelling(null); }
  }
  return <section className="job-library" aria-label={t('Экспорты и файлы')}>
    <button type="button" className="text-button" aria-expanded={expanded} aria-controls="saved-exports" onClick={() => setExpanded(value => !value)}>{t('Экспорты и файлы')}<Icon name="chevron" size={15} /></button>
    {expanded && <div id="saved-exports"><p className="field-hint">{t('Обработка продолжается, пока вы работаете с другим видео. Здесь остаются задания и готовые файлы.')}</p>
      {loading && <p role="status">{t('Загружаем список…')}</p>}
      {!loading && !error && !jobs.length && <p className="field-hint">{t('Пока нет экспортов.')}</p>}
      <ul className="job-library-list">{jobs.map(job => <li key={job.id}>
        <div className="job-library-heading"><div><h3>{job.title}</h3><p><span className={active(job) ? 'job-active-label' : ''}>{t(statusLabels[job.status])}</span>{' — '}{t('Готово: {count} из {total}', { count: job.files.length, total: job.total })}</p></div>{active(job) && <button type="button" className="text-button" disabled={cancelling !== null} onClick={() => void cancel(job.id)}>{t(cancelling === job.id ? 'Отменяем…' : 'Отменить обработку')}</button>}</div>
        {job.files.length > 0 && <ul className="job-library-files">{job.files.map(file => <li key={file.id}><div><a href={file.download_url} download={file.filename}><Icon name="download" size={16} />{file.filename}</a><RetentionNotice expiresAt={file.expires_at} kind="artifact" /></div><span>{formatBytes(file.size_bytes, locale)}</span></li>)}</ul>}
      </li>)}</ul>
      {error && <p className="error-message" role="alert">{t(error)}<button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>{t('Повторить')}</button></p>}
    </div>}
  </section>;
}
