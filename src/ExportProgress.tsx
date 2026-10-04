import { useLanguage } from './Language';
import { encodingProgress } from './encodingProgress';
import type { Job } from './types';

export function ExportProgress({ job }: { job: Job }) {
  const { t } = useLanguage();
  const progress = encodingProgress(job);
  if (!progress) return null;
  const label = t('Обработка фрагментов');
  const percent = `${progress.percent}%`;
  return <div className="export-encoding-progress" aria-live="off">
    <div className="export-encoding-progress-label"><span>{label}</span><span>{percent}</span></div>
    <progress max={progress.totalMS} value={progress.processedMS} aria-label={label} aria-valuetext={percent}>{percent}</progress>
  </div>;
}
