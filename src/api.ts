import type { Job, Source, ClipRange, OutputSettings } from './types';

const base = '/api/v1';

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(base + path, { credentials: 'same-origin', ...options });
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApiError('connection', 'Сервер не ответил. Попробуйте ещё раз.'); }
  if (!response.ok) {
    const error = body as { error?: { code?: string; message?: string } };
    throw new ApiError(error.error?.code ?? 'server', error.error?.message ?? 'Не удалось выполнить запрос. Попробуйте ещё раз.');
  }
  return body as T;
}

export const api = {
  session: () => request<{ ok: boolean }>('/session'),
  source: (id: string) => request<Source>(`/sources/${encodeURIComponent(id)}`),
  open: (url: string, signal: AbortSignal) => request<Source>('/sources', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal,
  }),
  upload: (file: File, signal: AbortSignal) => {
    const body = new FormData(); body.append('file', file);
    return request<Source>('/uploads', { method: 'POST', body, signal });
  },
  createJob: (source_id: string, ranges: ClipRange[], output: OutputSettings, key: string) => request<Job>('/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ source_id, ranges: ranges.map(({ start_ms, end_ms, label }) => ({ start_ms, end_ms, label })), ...output }),
  }),
  job: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}`),
  cancel: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
};

export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.';
  const messages: Record<string, string> = {
    connection: 'Сервер не ответил. Попробуйте ещё раз.',
    not_ready: 'Сервис запускается. Попробуйте подключиться через минуту.',
    origin_rejected: 'Откройте инструмент на cutmy.video и повторите действие.',
    rate_limit: 'Слишком много запросов. Подождите минуту и попробуйте ещё раз.',
    session_required: 'Сессия закончилась. Обновите страницу и откройте видео заново.',
    invalid_url: 'Используйте публичную HTTPS-ссылку без логина, пароля и нестандартного порта.',
    source_limit: 'Достигнут лимит источников. Дождитесь текущей обработки и попробуйте позже.',
    source_unavailable: 'Видео недоступно или требует входа. Проверьте ссылку либо загрузите файл.',
    source_too_large: 'Файл превышает лимит сервиса. Выберите файл меньшего размера.',
    unsupported_media: 'В файле не найдено поддерживаемое видео или аудио. Выберите другой файл.',
    source_timeout: 'Видео слишком долго отвечает. Попробуйте ещё раз или загрузите MP4.',
    unsupported_source: 'Этот источник не поддерживает обработку. Загрузите видео файлом.',
    invalid_upload: 'Не удалось загрузить файл. Выберите одно видео MP4 и попробуйте ещё раз.',
    preview_unavailable: 'Предпросмотр недоступен. Используйте поля начала и конца.',
    invalid_export: 'Проверьте интервалы и настройки экспорта. Границы должны находиться внутри видео.',
    job_limit: 'Дождитесь текущего экспорта или отмените его.',
    expired: 'Срок хранения файла закончился. Вырежьте фрагмент заново.',
    not_found: 'Источник или результат больше недоступен. Откройте видео заново.',
    invalid_request: 'Не удалось отправить настройки. Обновите страницу и попробуйте ещё раз.',
    internal: 'Не удалось выполнить действие. Попробуйте ещё раз через минуту.',
  };
  return messages[error.code] ?? 'Не удалось выполнить действие. Попробуйте ещё раз или загрузите видео файлом.';
}
