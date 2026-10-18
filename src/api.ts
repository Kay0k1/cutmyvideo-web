import type { Job, Source, ClipRange, OutputSettings, UploadProgress, SessionResponse, JobSummary, MediaTrack, AnalysisOptions, SilenceOptions, VideoAnalysisOptions, SilenceAnalysis, VideoAnalysis, LoudnessAnalysis, CutList, CutListFormat, CutListText, Artifact } from './types';

const base = '/api/v1';

export class ApiError extends Error {
  constructor(public code: string, message: string, public httpStatus?: number, public retryAfterSeconds?: number) { super(message); }
}

// The core sends Retry-After as delta-seconds. Unusable values keep the generic
// retry guidance instead of displaying an invented or unbounded wait.
function retryAfterSeconds(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value || !/^\d{1,5}$/.test(value)) return undefined;
  const seconds = Number(value);
  return seconds <= 86400 ? seconds : undefined;
}

export async function request<T>(path: string, options: RequestInit = {}, timeoutMS = 30000): Promise<T> {
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
      throw new ApiError(typeof error?.code === 'string' ? error.code : 'server', typeof error?.message === 'string' ? error.message : 'Request failed', response.status, retryAfterSeconds(response.headers.get('Retry-After')));
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
    let lastUpdate = 0;
    const startedAt = performance.now();
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
    xhr.timeout = 123 * 60 * 1000;
    xhr.upload.onprogress = event => {
      if (settled || signal.aborted || !Number.isFinite(event.loaded)) return;
      const total = event.lengthComputable && event.total > 0 ? event.total : null;
      const loaded = Math.max(0, total === null ? event.loaded : Math.min(total, event.loaded));
      const percent = total === null ? Math.floor(loaded / (1024 * 1024)) : Math.floor(loaded * 100 / total);
      const now = performance.now();
      if (percent === lastPercent && now - lastUpdate < 500) return;
      lastPercent = percent; lastUpdate = now;
      const elapsed = (now - startedAt) / 1000;
      onProgress?.({ loaded, total, ...(elapsed >= 2 && loaded > 0 ? { bytesPerSecond: loaded / elapsed } : {}) });
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = xhr.response?.error;
        finish(new ApiError(error?.code ?? 'server', error?.message ?? 'Upload failed', xhr.status, retryAfterSeconds(xhr.getResponseHeader('Retry-After'))));
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

// Use the same stable payload for transport and retry identity. Draft restoration
// can reorder optional settings; explicitly selected defaults are equivalent to
// omitted defaults on the server.
export function jobRequestBody(source_id: string, ranges: ClipRange[], output: OutputSettings): string {
  return JSON.stringify({ source_id, ranges: ranges.map(({ start_ms, end_ms, label }) => ({ start_ms, end_ms, label })),
    format: output.format, quality: output.quality, cut_mode: output.cut_mode,
    ...(output.output_mode === 'joined' ? { output_mode: 'joined' } : {}),
    ...(output.audio_track !== undefined ? { audio_track: output.audio_track } : {}),
    ...(output.no_audio ? { no_audio: true } : {}),
    ...(output.subtitle_mode === 'preserve' ? { subtitle_mode: 'preserve' } : {}),
    ...(output.crop ? { crop: { x: output.crop.x, y: output.crop.y, width: output.crop.width, height: output.crop.height } } : {}),
    ...(output.audio_normalize ? { audio_normalize: { integrated_lufs: output.audio_normalize.integrated_lufs, true_peak_dbtp: output.audio_normalize.true_peak_dbtp, loudness_range_lu: output.audio_normalize.loudness_range_lu } } : {}),
    ...(output.canvas ? { canvas: { width: output.canvas.width, height: output.canvas.height, fit: output.canvas.fit, background: output.canvas.background } } : {}),
    ...(output.audio_replace ? { audio_replace: { source_id: output.audio_replace.source_id, ...(output.audio_replace.audio_track !== undefined ? { audio_track: output.audio_replace.audio_track } : {}), ...(output.audio_replace.offset_ms !== undefined ? { offset_ms: output.audio_replace.offset_ms } : {}) } } : {}),
    ...(output.cleanup_source !== false ? { cleanup_source: true } : {}) });
}

export const api = {
  session,
  jobs: (signal?: AbortSignal) => request<{ jobs: JobSummary[] }>('/jobs', { signal }),
  sources: (signal?: AbortSignal) => request<{ sources: Source[] }>('/sources', { signal }),
  source: (id: string, signal?: AbortSignal) => request<Source>(`/sources/${encodeURIComponent(id)}`, { signal }),
  tracks: (id: string, signal?: AbortSignal) => request<{ tracks: MediaTrack[]; display_width?: number; display_height?: number }>(`/sources/${encodeURIComponent(id)}/tracks`, { signal }),
  open: (url: string, signal: AbortSignal) => request<Source>('/sources', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal,
  }, 123 * 60 * 1000),
  upload,
  deleteSource: (id: string) => request<void>(`/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  analyzeSilence: (id: string, options: SilenceOptions, signal?: AbortSignal) => request<SilenceAnalysis>(`/sources/${encodeURIComponent(id)}/analysis/silence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options), signal }, 125000),
  analyzeVideo: (id: string, options: VideoAnalysisOptions, signal?: AbortSignal) => request<VideoAnalysis>(`/sources/${encodeURIComponent(id)}/analysis/video`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options), signal }, 125000),
  analyzeLoudness: (id: string, options: AnalysisOptions, signal?: AbortSignal) => request<LoudnessAnalysis>(`/sources/${encodeURIComponent(id)}/analysis/loudness`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options), signal }, 125000),
  importCutList: (format: CutListFormat, text: string, signal?: AbortSignal) => request<CutList>('/cut-lists/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, text }), signal }),
  exportCutList: (format: CutListFormat, cut_list: CutList, signal?: AbortSignal) => request<CutListText>('/cut-lists/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, cut_list }), signal }),
  exportChapters: (segments: NonNullable<Artifact['segments']>, signal?: AbortSignal) => request<CutListText>('/cut-lists/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'ffmetadata', segments }), signal }),
  createJob: async (source_id: string, ranges: ClipRange[], output: OutputSettings, key: string): Promise<Job> => {
    const options = {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: jobRequestBody(source_id, ranges, output),
    };
    for (let attempt = 0; ; attempt++) {
      try { return await request<Job>('/jobs', options); }
      catch (error) {
        // Only an explicit refused decoder admission is safe to retry here.
        // Playback continues; uncertain mutations retain the existing recovery.
        if (!key || !(error instanceof ApiError) || error.code !== 'server_busy' || ![429, 503].includes(error.httpStatus ?? 0) || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
  },
  job: (id: string, signal?: AbortSignal) => request<Job>(`/jobs/${encodeURIComponent(id)}`, { signal }),
  cancel: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
};

function uncertainSourceMessage(error: unknown): string {
  const message = 'Не удалось подтвердить сохранение видео. Оно могло уже сохраниться. Проверьте «Мои видео на сервере» перед повторной отправкой.';
  const seconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
  return seconds !== undefined && Number.isInteger(seconds) && seconds >= 0 && seconds <= 86400
    ? `${message} Повторите действие не раньше чем через ${seconds} с.` : message;
}

export function errorMessage(error: unknown, action: 'source' | 'source-create' | 'export' = 'source'): string {
  if (action === 'source-create' && (!(error instanceof ApiError)
    || ['connection', 'database_unavailable', 'source_timeout', 'request_timeout', 'internal', 'server'].includes(error.code))) {
    return uncertainSourceMessage(error);
  }
  if (!(error instanceof ApiError)) return 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.';
  if (action === 'export' && error.code === 'storage_limit') return 'Этот экспорт превышает бюджет хранилища сервера. Выберите меньше фрагментов и попробуйте снова.';
  if (error.code === 'storage_initializing' || error.code === 'database_unavailable') {
    const message = error.code === 'storage_initializing' ? 'Сервис готовится к работе.'
      : action === 'export' ? 'Сервис временно недоступен. Экспорт мог быть принят. Проверьте «Экспорты и файлы» перед повторной отправкой.'
        : 'Сервис временно недоступен.';
    const seconds = error.retryAfterSeconds;
    const retry = seconds !== undefined && Number.isInteger(seconds) && seconds >= 0 && seconds <= 86400
      ? `Повторите действие не раньше чем через ${seconds} с.` : 'Подождите немного и повторите действие.';
    return `${message} ${retry}`;
  }
  const messages: Record<string, string> = {
    local_source_required: 'Для анализа загрузите запись файлом. Ссылки на площадки не анализируются.',
    invalid_analysis: 'Выберите участок внутри записи длительностью до 30 минут.',
    invalid_cut_list: 'Не удалось преобразовать список фрагментов. Проверьте формат и границы.',
    output_limit: 'Анализ достиг ограничения. Выберите более короткий участок.',
    tool_unavailable: 'Инструмент обработки временно недоступен. Попробуйте позже.',
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
    source_removed: 'Исходник удалён после экспорта. Проект и готовые клипы сохранены. Откройте запись заново для новой нарезки.',
    crop_invalid: 'Область кадра слишком мала или выходит за изображение. Измените кадр или сбросьте его.',
    source_unavailable: 'Видео недоступно или требует входа. Проверьте ссылку либо загрузите файл.',
    source_too_large: 'Файл превышает лимит сервиса. Выберите файл меньшего размера.',
    unsupported_media: 'В файле не найдено поддерживаемое видео или аудио. Выберите другой файл.',
    source_timeout: 'Видео слишком долго отвечает. Попробуйте ещё раз или загрузите MP4.',
    unsupported_source: 'Этот источник не поддерживает обработку. Загрузите видео файлом.',
    invalid_upload: 'Не удалось загрузить файл. Выберите один видеофайл и попробуйте ещё раз.',
    preview_unavailable: 'Предпросмотр недоступен. Используйте поля начала и конца.',
    tracks_unavailable: 'Чтобы выбрать аудиодорожку площадки, загрузите исходный файл. Экспорт без звука доступен.',
    audio_track_unavailable: 'Выбранная аудиодорожка недоступна. Выберите другую дорожку.',
    audio_track_invalid: 'Выбранная аудиодорожка недоступна. Выберите другую дорожку.',
    subtitle_unavailable: 'Эти настройки требуют исходного файла и режима копирования. Выберите MP4 и исключите субтитры либо загрузите исходный файл.',
    subtitle_unsupported: 'Субтитры нельзя сохранить с этими настройками. Исключите субтитры или загрузите файл с текстовыми субтитрами.',
    copy_incompatible: 'Эти потоки несовместимы с выбранным контейнером. Выберите MKV либо MP4 с точными границами.',
    join_incompatible: 'Эти фрагменты нельзя объединить копированием. Выберите MP4 с точными границами.',
    invalid_export: 'Проверьте интервалы и настройки экспорта. Границы должны находиться внутри видео.',
    job_limit: 'Очередь экспорта заполнена. Дождитесь завершения одного задания или отмените его в списке «Экспорты и файлы».',
    expired: 'Срок хранения файла закончился. Вырежьте фрагмент заново.',
    not_found: 'Источник или результат больше недоступен. Откройте видео заново.',
    invalid_request: 'Не удалось отправить настройки. Обновите страницу и попробуйте ещё раз.',
    request_timeout: 'Не удалось передать настройки вовремя. Проверьте соединение и повторите действие.',
    internal: 'Не удалось выполнить действие. Попробуйте ещё раз через минуту.',
  };
  if (Object.hasOwn(messages, error.code)) return messages[error.code];
  return action === 'source-create' ? uncertainSourceMessage(error) : 'Не удалось выполнить действие. Попробуйте ещё раз или загрузите видео файлом.';
}
