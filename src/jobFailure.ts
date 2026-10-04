import type { ClipRange, Job } from './types';

const fallbackMessage = 'Не удалось обработать видео. Повторите экспорт; если ошибка повторится, загрузите MP4.';

export const exportFailureMessages: Record<string, string> = {
  platform_access_required: 'Для нарезки этого видео нужен вход или разрешение владельца. Загрузите доступное видео файлом MP4.',
  platform_unavailable: 'Площадка не отдала видео для нарезки. Повторите экспорт позже или загрузите MP4.',
  unsupported_stream: 'У видео пока нет поддерживаемого потока для нарезки. Загрузите доступное видео файлом MP4.',
  source_changed: 'Видео изменилось после открытия. Откройте ссылку заново и проверьте выбранные моменты.',
  source_timeline_changed: 'Запись ещё меняется или её шкала времени неполная. Откройте завершённую запись.',
  source_expired: 'Срок хранения исходного видео закончился. Откройте его заново.',
  source_timeout: 'Не удалось получить видео вовремя. Повторите экспорт или загрузите MP4.',
  job_timeout: 'Обработка не завершилась за отведённое время. Сократите фрагмент и повторите экспорт.',
  storage_full: 'На сервере временно нет места для результата. Повторите экспорт позже.',
  media_network_timeout: 'Площадка слишком долго передавала видео. Повторите экспорт или загрузите MP4.',
  media_network_reset: 'Соединение с площадкой прервалось. Повторите экспорт или загрузите MP4.',
  media_upstream_denied: 'Площадка ограничила доступ к видео. Повторите экспорт позже или загрузите MP4.',
  media_upstream_unavailable: 'Видеопоток временно недоступен. Повторите экспорт позже или загрузите MP4.',
  audio_missing: 'В видео нет аудиодорожки. Выберите MP4, чтобы сохранить видео.',
  output_limit: 'Готовый файл превышает лимит размера. Сократите фрагмент и повторите экспорт.',
  copy_incompatible: 'Исходный кодек не удалось сохранить в MP4. Выберите «Точные границы» и повторите экспорт.',
  copy_quality_unsupported: 'Без перекодирования нельзя уменьшить разрешение. Выберите «Лучшее доступное» или «Точные границы».',
  media_processing_failed: fallbackMessage,
  server_error: 'На сервере произошла ошибка обработки. Повторите экспорт позже.',
  cancelled: 'Обработка отменена. Можно повторить экспорт с теми же моментами.',
};

// Older jobs contain only fixed, public-safe worker messages. Exact matching
// preserves useful recovery without displaying arbitrary diagnostics or URLs.
const legacyCodes: Record<string, string> = {
  'Live broadcasts are not supported yet. Paste a recording or clip link instead': 'source_timeline_changed',
  'This video requires login, membership, or permission. Use an accessible recording or upload your file': 'platform_access_required',
  'The platform did not provide an accessible recording. Check the link, regional availability, or upload your file': 'platform_unavailable',
  'This video uses unsupported encryption or media streams. Upload an accessible file instead': 'unsupported_stream',
  'No supported seekable streams match these settings; upload the source instead': 'unsupported_stream',
  'A source stream uses an unsupported address': 'unsupported_stream',
  'Source is unavailable or has expired': 'source_expired',
  'The source has changed; open it again before exporting': 'source_changed',
  'The recording is incomplete or its timeline changed; open a completed recording instead': 'source_timeline_changed',
  'Processing stopped or exceeded the time limit': 'job_timeout',
  'Server storage is full; try again after older files expire': 'storage_full',
  'Could not create a temporary workspace': 'server_error',
  'Could not prepare source access': 'server_error',
  'Could not save the result': 'server_error',
  'Could not verify the result': 'server_error',
  'Could not register the result': 'server_error',
  'Worker recovery limit reached': 'server_error',
  'Cancelled': 'cancelled',
};

export function exportFailureReason(item: { error_code?: string; message?: string }, jobMessage?: string): string {
  const legacyCode = (message?: string) => message && Object.hasOwn(legacyCodes, message) ? legacyCodes[message] : undefined;
  const code = item.error_code ?? legacyCode(item.message) ?? legacyCode(jobMessage);
  return code && Object.hasOwn(exportFailureMessages, code) ? exportFailureMessages[code] : fallbackMessage;
}

export function repeatsFailedExport(job: Job | null, ranges: ClipRange[]): boolean {
  return !!job && job.status === 'failed' && ranges.length > 0 && ranges.length === job.items.length && ranges.every((range, index) => {
    const item = job.items[index];
    return range.start_ms === item.start_ms && range.end_ms === item.end_ms && range.label === item.label;
  });
}
