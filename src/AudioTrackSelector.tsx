import { SelectControl } from './SelectControl';
import { useLanguage } from './Language';
import { audioSelection, defaultAudioTrack, trackLabel } from './mediaTracks';
import type { MediaTrack, OutputSettings } from './types';

export function AudioTrackSelector({ id, output, tracks, loading, error, disabled, onChange, onRetry }: {
  id: string; output: OutputSettings; tracks: MediaTrack[] | null; loading: boolean; error: string;
  disabled?: boolean; onChange(selection: string): void; onRetry(): void;
}) {
  const { t } = useLanguage();
  const audio = tracks?.filter(track => track.type === 'audio') ?? [];
  const selected = audioSelection(output);
  const defaultTrack = defaultAudioTrack(tracks ?? []);
  const options = [{ value: 'default', label: t('По умолчанию в источнике') },
    ...audio.map(track => ({ value: String(track.index), label: trackLabel(track, t) })),
    ...(output.audio_track !== undefined && !audio.some(track => track.index === output.audio_track)
      ? [{ value: String(output.audio_track), label: t('Дорожка #{index} — проверьте доступность', { index: output.audio_track }) }] : []),
    { value: 'none', label: t('Без звука'), disabled: output.format === 'mp3' }];
  return <div className="export-field audio-track-field">
    <label htmlFor={id}>{t('Аудиодорожка')}</label>
    <SelectControl id={id} label={t('Аудиодорожка')} describedBy={`${id}-hint`} value={selected} disabled={disabled} options={options} onChange={onChange} />
    <p id={`${id}-hint`} className="field-hint">{loading ? t('Проверяем дорожки…') : error ? t(error) : tracks && !audio.length ? t('В источнике нет звука.') : selected === 'default' && defaultTrack ? trackLabel(defaultTrack, t) : t('Выбор применяется к предпросмотру и экспорту.')}</p>
    {error && error !== 'Чтобы выбрать аудиодорожку площадки, загрузите исходный файл. Экспорт без звука доступен.' && <button type="button" className="text-button" disabled={disabled || loading} onClick={onRetry}>{t('Проверить дорожки снова')}</button>}
  </div>;
}
