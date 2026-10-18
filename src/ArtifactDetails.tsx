import { useLanguage } from './Language';
import { trackLabel } from './mediaTracks';
import { formatTimecode } from './timecode';
import type { Artifact } from './types';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';

export function ArtifactDetails({ artifact }: { artifact: Artifact }) {
  const { t } = useLanguage();
  const [chapterBusy, setChapterBusy] = useState(false);
  const [chapterError, setChapterError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => { setChapterBusy(false); setChapterError(''); return () => { pending.current?.abort(); pending.current = null; }; }, [artifact.id]);
  async function downloadChapters() {
    if (!artifact.segments?.length || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setChapterBusy(true); setChapterError('');
    try {
      const result = await api.exportChapters(artifact.segments, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([result.text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `${artifact.filename.replace(/\.[^.]+$/, '')}.chapters.ffmeta`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { if (!controller.signal.aborted) setChapterError(errorMessage(error)); }
    finally { if (pending.current === controller) { pending.current = null; setChapterBusy(false); } }
  }
  const reasons: Record<string, string> = { audio_replaced: 'Звук заменён подключённой записью', audio_disabled: 'Экспорт без звука', audio_not_selected: 'Выбрана другая аудиодорожка', subtitles_omitted: 'Субтитры исключены в настройках', video_not_selected: 'Видеодорожка не выбрана', unsupported_stream: 'Дорожка не поддерживается' };
  if (!artifact.segments?.length && !artifact.track_manifest?.length) return null;
  return <details className="artifact-details"><summary>{t('Границы и дорожки результата')}</summary>
    {!!artifact.track_manifest?.length && <p className="field-hint">{t('Указаны дорожки исходного файла; формат текстовых субтитров может измениться.')}</p>}
    {!!artifact.segments?.length && <ol>{artifact.segments.map(segment => <li key={segment.index}>
      <strong>{segment.label || `${t('Фрагмент')} ${segment.index + 1}`}</strong>{' '}
      {formatTimecode(segment.source_start_ms, true)} — {formatTimecode(segment.source_end_ms, true)}
      <span>{t('В результате:')} {formatTimecode(segment.output_start_ms, true)} — {formatTimecode(segment.output_end_ms, true)}</span>
    </li>)}</ol>}
    {!!artifact.segments?.length && <div className="result-chapters"><button type="button" className="text-button" disabled={chapterBusy} onClick={() => void downloadChapters()}>{t(chapterBusy ? 'Готовим главы…' : 'Скачать главы результата')}</button><p className="field-hint">{t('FFmetadata с таймкодами готового файла, а не исходной записи.')}</p>{chapterError && <p className="error-message" role="alert">{t(chapterError)}</p>}</div>}
    {!!artifact.track_manifest?.length && <ul>{artifact.track_manifest.map(track => <li key={track.index}>
      <strong>{t(track.included ? 'Включена' : 'Исключена')}</strong>{': '}{trackLabel(track, t)}
      {!track.included && track.reason && reasons[track.reason] && <span>{t(reasons[track.reason])}</span>}
    </li>)}</ul>}
  </details>;
}
