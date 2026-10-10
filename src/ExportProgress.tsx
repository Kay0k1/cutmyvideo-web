import { useLanguage } from './Language';
import { encodingProgress } from './encodingProgress';
import type { Job } from './types';

export function ExportProgress({ job }: { job: Job }) {
  const { t } = useLanguage();
  const progress = encodingProgress(job);
  const download = job.status === 'running' && job.stage === 'fetching' ? /^Preparing fragment (\d+) of (\d+): (\d+)% downloaded$/.exec(job.message) : null;
  if (download) {
    const percent = Math.min(100, Number(download[3]));
    const label = t('Получаем фрагмент {index} из {total}', { index: download[1], total: download[2] });
    return <div className="export-encoding-progress" aria-live="off"><div className="export-encoding-progress-label"><span>{label}</span><span>{percent}%</span></div><progress max={100} value={percent} aria-label={label} /></div>;
  }
  if (!progress) return null;
  const label = t('Обработка фрагментов');
  const percent = `${progress.percent}%`;
  return <div className="export-encoding-progress" aria-live="off">
    <div className="export-encoding-progress-label"><span>{label}</span><span>{percent}</span></div>
    <progress max={progress.totalMS} value={progress.processedMS} aria-label={label} aria-valuetext={percent}>{percent}</progress>
  </div>;
}
