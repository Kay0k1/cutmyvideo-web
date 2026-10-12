import { useLanguage } from './Language';
import { trackLabel } from './mediaTracks';
import { formatTimecode } from './timecode';
import type { Artifact } from './types';

export function ArtifactDetails({ artifact }: { artifact: Artifact }) {
  const { t } = useLanguage();
  const reasons: Record<string, string> = { audio_disabled: 'Экспорт без звука', audio_not_selected: 'Выбрана другая аудиодорожка', subtitles_omitted: 'Субтитры исключены в настройках', video_not_selected: 'Видеодорожка не выбрана', unsupported_stream: 'Дорожка не поддерживается' };
  if (!artifact.segments?.length && !artifact.track_manifest?.length) return null;
  return <details className="artifact-details"><summary>{t('Границы и дорожки результата')}</summary>
    {!!artifact.track_manifest?.length && <p className="field-hint">{t('Указаны дорожки исходного файла; формат текстовых субтитров может измениться.')}</p>}
    {!!artifact.segments?.length && <ol>{artifact.segments.map(segment => <li key={segment.index}>
      <strong>{segment.label || `${t('Фрагмент')} ${segment.index + 1}`}</strong>{' '}
      {formatTimecode(segment.source_start_ms, true)} — {formatTimecode(segment.source_end_ms, true)}
      <span>{t('В результате:')} {formatTimecode(segment.output_start_ms, true)} — {formatTimecode(segment.output_end_ms, true)}</span>
    </li>)}</ol>}
    {!!artifact.track_manifest?.length && <ul>{artifact.track_manifest.map(track => <li key={track.index}>
      <strong>{t(track.included ? 'Включена' : 'Исключена')}</strong>{': '}{trackLabel(track, t)}
      {!track.included && track.reason && reasons[track.reason] && <span>{t(reasons[track.reason])}</span>}
    </li>)}</ul>}
  </details>;
}
