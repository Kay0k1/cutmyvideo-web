import type { Job, Source, ClipRange, OutputSettings, UploadProgress, SessionResponse } from './types';

const base = '/api/v1';

export class ApiError extends Error {
  constructor(public code: string, message: string, public httpStatus?: number) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}, timeoutMS = 30000): Promise<T> {
  const controller = new AbortController();
  const upstream = options.signal;
  const abort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) abort();
  else upstream?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMS);
  try {
    const response = await fetch(base + path, { credentials: 'same-origin', ...options, signal: controller.signal });
    if (response.status === 204 && response.ok) return undefined as T;
    let body: unknown;
    try { body = await response.json(); } catch { throw new ApiError('connection', 'Invalid server response', response.status); }
    if (!response.ok) {
      const error = typeof body === 'object' && body !== null ? (body as { error?: { code?: string; message?: string } }).error : undefined;
      throw new ApiError(typeof error?.code === 'string' ? error.code : 'server', typeof error?.message === 'string' ? error.message : 'Request failed', response.status);
    }
    return body as T;
  } catch (error) {
    if (timedOut) throw new ApiError('connection', 'Request timed out');
    throw error;
  } finally {
    clearTimeout(timer); upstream?.removeEventListener('abort', abort);
  }
}

let sessionRequest: Promise<SessionResponse> | null = null;

function upload(file: File, signal: AbortSignal, onProgress?: (progress: UploadProgress) => void): Promise<Source> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const xhr = new XMLHttpRequest();
    let settled = false;
    let lastPercent = -1;
    const finish = (error?: unknown, value?: Source) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort);
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null;
      xhr.upload.onprogress = null;
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => { xhr.abort(); finish(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    xhr.open('POST', `${base}/uploads`);
    xhr.responseType = 'json';
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = event => {
      if (settled || signal.aborted || !Number.isFinite(event.loaded)) return;
      const total = event.lengthComputable && event.total > 0 ? event.total : null;
      const loaded = Math.max(0, total === null ? event.loaded : Math.min(total, event.loaded));
      const percent = total === null ? Math.floor(loaded / (1024 * 1024)) : Math.floor(loaded * 100 / total);
      if (percent === lastPercent) return;
      lastPercent = percent; onProgress?.({ loaded, total });
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = xhr.response?.error;
        finish(new ApiError(error?.code ?? 'server', error?.message ?? 'Upload failed', xhr.status));
      } else if (!xhr.response || typeof xhr.response !== 'object') finish(new ApiError('connection', 'Invalid server response'));
      else finish(undefined, xhr.response as Source);
    };
    xhr.onerror = () => finish(new ApiError('connection', 'Upload connection failed'));
    xhr.ontimeout = () => finish(new ApiError('source_timeout', 'Upload timed out'));
    xhr.onabort = () => finish(new DOMException('Aborted', 'AbortError'));
    const body = new FormData(); body.append('file', file);
    try { xhr.send(body); } catch (error) { finish(error); }
  });
}

function session(): Promise<SessionResponse> {
  if (!sessionRequest) {
    // Concurrent callers must use the same cookie handshake, including effect replays.
    sessionRequest = request<SessionResponse>('/session').finally(() => { sessionRequest = null; });
  }
  return sessionRequest;
}

export const api = {
  session,
  sources: (signal?: AbortSignal) => request<{ sources: Source[] }>('/sources', { signal }),
  source: (id: string, signal?: AbortSignal) => request<Source>(`/sources/${encodeURIComponent(id)}`, { signal }),
  open: (url: string, signal: AbortSignal) => request<Source>('/sources', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal,
  }, 150000),
  upload,
  deleteSource: (id: string) => request<void>(`/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createJob: (source_id: string, ranges: ClipRange[], output: OutputSettings, key: string) => request<Job>('/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ source_id, ranges: ranges.map(({ start_ms, end_ms, label }) => ({ start_ms, end_ms, label })), format: output.format, quality: output.quality, cut_mode: output.cut_mode }),
  }),
  job: (id: string, signal?: AbortSignal) => request<Job>(`/jobs/${encodeURIComponent(id)}`, { signal }),
  cancel: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
};

export function errorMessage(error: unknown, action: 'source' | 'export' = 'source'): string {
  if (!(error instanceof ApiError)) return 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.';
  if (action === 'export' && error.code === 'storage_limit') return 'Этот экспорт превышает бюджет хранилища сервера. Выберите меньше фрагментов и попробуйте снова.';
  const messages: Record<string, string> = {
    connection: 'Сервер не ответил. Попробуйте ещё раз.',
    not_ready: 'Сервис запускается. Попробуйте подключиться через минуту.',
    origin_rejected: 'Откройте инструмент на cutmy.video и повторите действие.',
    rate_limit: 'Слишком много запросов. Подождите минуту и попробуйте ещё раз.',
    session_required: 'Сессия закончилась. Обновите страницу и откройте видео заново.',
    invalid_url: 'Используйте публичную HTTPS-ссылку без логина, пароля и нестандартного порта.',
    invalid_youtube_url: 'Вставьте ссылку на одно видео YouTube: обычное видео, Shorts или запись эфира.',
    invalid_source_url: 'Вставьте ссылку на отдельное видео, запись стрима или клип. Ссылка на канал или плейлист не подойдёт.',
    unsupported_collection: 'Вставьте ссылку на отдельное видео, запись стрима или клип. Ссылка на канал или плейлист не подойдёт.',
    live_not_supported: 'Вставьте ссылку на запись стрима или готовый клип. Прямые эфиры пока не обрабатываются.',
    platform_access_required: 'Видео требует входа, подписки или разрешения владельца. Выберите публичное видео либо загрузите MP4.',
    platform_unavailable: 'Сервис не отдал видео. Проверьте ссылку и доступность ролика либо загрузите MP4.',
    unsupported_stream: 'Этот поток пока нельзя обработать. Загрузите доступное видео файлом MP4.',
    source_limit: 'Достигнут лимит источников. Удалите ненужные видео в списке «Мои видео на сервере» и попробуйте снова.',
    source_busy: 'Дождитесь открытия текущего видео или отмените его перед загрузкой другого.',
    source_in_use: 'Видео используется активным заданием. Дождитесь завершения или отмените обработку перед удалением.',
    server_busy: 'Сервис открывает другие видео. Попробуйте ещё раз через минуту.',
    storage_limit: 'Недостаточно места для видео. Выберите файл меньшего размера или дождитесь удаления старых файлов.',
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
    request_timeout: 'Не удалось передать настройки вовремя. Проверьте соединение и повторите действие.',
    internal: 'Не удалось выполнить действие. Попробуйте ещё раз через минуту.',
  };
  return Object.hasOwn(messages, error.code) ? messages[error.code] : 'Не удалось выполнить действие. Попробуйте ещё раз или загрузите видео файлом.';
}
