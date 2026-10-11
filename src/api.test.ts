import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorMessage, jobRequestBody } from './api';
import { translate } from './locales';

afterEach(() => { vi.unstubAllGlobals(); });

describe('batch and track API contracts', () => {
  it('keeps retry identity stable across optional property order and explicit defaults', () => {
    const ranges = [{ id: 'range_retry', label: 'Opening', start_ms: 1000, end_ms: 2500 }];
    const baseline = { format: 'mp4', quality: 'best', cut_mode: 'copy' } as const;
    expect(jobRequestBody('src_retry', ranges, { ...baseline, subtitle_mode: 'preserve', audio_track: 2, output_mode: 'joined' }))
      .toBe(jobRequestBody('src_retry', ranges, { output_mode: 'joined', audio_track: 2, subtitle_mode: 'preserve', ...baseline }));
    expect(jobRequestBody('src_retry', ranges, { ...baseline, output_mode: 'separate', no_audio: false, subtitle_mode: 'omit' }))
      .toBe(jobRequestBody('src_retry', ranges, baseline));
  });
  it('sends explicit selections unchanged while leaving older requests unchanged', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ id: 'job_contract', items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const ranges = [{ id: 'range_a', label: 'Opening', start_ms: 1000, end_ms: 2500 }, { id: 'range_b', label: 'End', start_ms: 4000, end_ms: 6000 }];
    await api.createJob('src_contract', ranges, { format: 'mkv', quality: 'best', cut_mode: 'copy', output_mode: 'joined', audio_track: 2, subtitle_mode: 'preserve' }, 'key_contract');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/jobs');
    expect(options.headers['Idempotency-Key']).toBe('key_contract');
    expect(JSON.parse(options.body)).toEqual({ source_id: 'src_contract', ranges: ranges.map(({ label, start_ms, end_ms }) => ({ label, start_ms, end_ms })), format: 'mkv', quality: 'best', cut_mode: 'copy', output_mode: 'joined', audio_track: 2, subtitle_mode: 'preserve' });
    await api.createJob('src_contract', ranges, { format: 'mp4', quality: '1080p', cut_mode: 'accurate' }, 'key_legacy');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('audio_track');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('output_mode');
  });
  it('reads owner-protected source tracks with an escaped identifier and cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ tracks: [{ index: 2, type: 'audio', codec: 'aac', language: 'eng', title: 'Commentary' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(api.tracks('source/special', controller.signal)).resolves.toHaveProperty('tracks.0.index', 2);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/sources/source%2Fspecial/tracks');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('same-origin');
  });
});

describe('safe API error messages', () => {
  it.each(['future_source_error', 'constructor', 'toString', '__proto__'])('uses localized fallback copy for an unknown %s code', code => {
    const message = errorMessage(new ApiError(code, 'https://cdn.example/private?token=secret stderr=extractor'));
    expect(message).toBe('Не удалось выполнить действие. Попробуйте ещё раз или загрузите видео файлом.');
    expect(translate(message, 'en')).toBe('The action failed. Try again or upload the video file.');
    expect(message).not.toMatch(/https|secret|stderr|extractor/);
  });

  it.each([
    ['platform_access_required', 'Видео требует входа, подписки или разрешения владельца. Выберите публичное видео либо загрузите MP4.'],
    ['platform_unavailable', 'Сервис не отдал видео. Проверьте ссылку и доступность ролика либо загрузите MP4.'],
    ['live_not_supported', 'Вставьте ссылку на запись стрима или готовый клип. Прямые эфиры пока не обрабатываются.'],
    ['unsupported_collection', 'Вставьте ссылку на отдельное видео, запись стрима или клип. Ссылка на канал или плейлист не подойдёт.'],
    ['unsupported_stream', 'Этот поток пока нельзя обработать. Загрузите доступное видео файлом MP4.'],
    ['source_timeout', 'Видео слишком долго отвечает. Попробуйте ещё раз или загрузите MP4.'],
    ['source_busy', 'Дождитесь открытия текущего видео или отмените его перед загрузкой другого.'],
    ['server_busy', 'Сервис открывает другие видео. Попробуйте ещё раз через минуту.'],
    ['storage_limit', 'Недостаточно места для видео. Выберите файл меньшего размера или дождитесь удаления старых файлов.'],
  ])('retains the actionable message for %s without displaying provider diagnostics', (code, expected) => {
    const message = errorMessage(new ApiError(code, 'Raw provider diagnostic must not appear.'));
    expect(message).toBe(expected);
    expect(translate(message, 'en')).not.toMatch(/[А-Яа-яЁё]/);
    expect(message).not.toContain('Raw provider diagnostic');
  });

  it.each([
    ['storage_initializing', 'source', undefined, 'The service is getting ready. Wait a little and try again.'],
    ['storage_initializing', 'source', 2, 'The service is getting ready. Try again in at least 2 s.'],
    ['database_unavailable', 'source', undefined, 'The service is temporarily unavailable. Wait a little and try again.'],
    ['database_unavailable', 'export', undefined, 'The service is temporarily unavailable. The export may have been accepted. Check Exports and files before submitting it again. Wait a little and try again.'],
    ['database_unavailable', 'export', 3, 'The service is temporarily unavailable. The export may have been accepted. Check Exports and files before submitting it again. Try again in at least 3 s.'],
  ] as const)('explains %s safely for %s and remains translatable after a language change', (code, action, seconds, expected) => {
    const message = errorMessage(new ApiError(code, 'https://private.example/?token=secret', 503, seconds), action);
    expect(translate(message, 'en')).toBe(expected);
    expect(translate(message, 'ru')).toBe(message);
    expect(message).not.toMatch(/https|secret|файлом|MP4/);
  });
});

describe('uncertain source creation recovery', () => {
  const message = 'Не удалось подтвердить сохранение видео. Оно могло уже сохраниться. Проверьте «Мои видео на сервере» перед повторной отправкой.';
  const english = 'Could not confirm that the video was saved. It may already be on the server. Check My videos on the server before submitting it again.';
  const privateDiagnostic = 'https://private.example/?token=secret password=hidden /private/recording.mp4';

  it.each([
    ['connection', undefined], ['database_unavailable', 503], ['request_timeout', 408],
    ['source_timeout', 504], ['internal', 500], ['server', 502],
    ['future_source_error', 503], ['constructor', 500], ['toString', 500], ['__proto__', 500],
  ] as const)('checks saved videos before retrying a source POST after %s', (code, status) => {
    const localized = errorMessage(new ApiError(code, privateDiagnostic, status), 'source-create');
    expect(localized).toBe(message);
    expect(translate(localized, 'en')).toBe(english);
    expect(translate(localized, 'ru')).toBe(message);
    expect(localized).not.toMatch(/https|secret|password|private|MP4|файлом/);
  });

  it('keeps a network TypeError private and warns that the mutation may already have succeeded', () => {
    const error = new TypeError(privateDiagnostic);
    expect(errorMessage(error, 'source-create')).toBe(message);
    expect(errorMessage(error)).toBe('Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.');
  });

  it.each([0, 2, 86400])('keeps the check-before-repeat guidance before the bounded %s second wait', seconds => {
    const localized = errorMessage(new ApiError('database_unavailable', privateDiagnostic, 503, seconds), 'source-create');
    expect(localized).toBe(`${message} Повторите действие не раньше чем через ${seconds} с.`);
    expect(translate(localized, 'en')).toBe(`${english} Try again in at least ${seconds} s.`);
    expect(translate(localized, 'ru')).toBe(localized);
  });

  it.each([-1, 1.5, 86401, NaN, Infinity])('does not invent a wait from unusable Retry-After %s', seconds => {
    expect(errorMessage(new ApiError('database_unavailable', privateDiagnostic, 503, seconds), 'source-create')).toBe(message);
  });

  it.each([
    'storage_initializing', 'not_ready', 'rate_limit', 'session_required', 'invalid_url',
    'invalid_upload', 'unsupported_media', 'source_limit', 'source_busy', 'server_busy', 'storage_limit',
  ])('retains the definite admission or input message for %s', code => {
    const error = new ApiError(code, privateDiagnostic, 503, 2);
    expect(errorMessage(error, 'source-create')).toBe(errorMessage(error));
    expect(errorMessage(error, 'source-create')).not.toContain('Оно могло уже сохраниться.');
  });

  it('keeps source reads and export error guidance scoped to their existing actions', () => {
    const error = new ApiError('database_unavailable', privateDiagnostic, 503);
    expect(errorMessage(error)).toBe('Сервис временно недоступен. Подождите немного и повторите действие.');
    expect(errorMessage(error, 'export')).toContain('Экспорт мог быть принят.');
    expect(errorMessage(error, 'export')).not.toContain('Мои видео на сервере');
  });

  it('recovers a saved source through reads without repeating an uncertain mutation', async () => {
    const source = { id: 'src_saved_after_uncertain_response', title: 'Saved video', duration_ms: 12000 };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 'database_unavailable', message: privateDiagnostic } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ sources: [source] })).mockResolvedValueOnce(Response.json(source));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.open('https://video.example/recording.mp4', new AbortController().signal)).rejects.toMatchObject({ code: 'database_unavailable', httpStatus: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const retained = await api.sources();
    await expect(api.source(retained.sources[0].id)).resolves.toMatchObject(source);
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options.method ?? 'GET'])).toEqual([
      ['/api/v1/sources', 'POST'], ['/api/v1/sources', 'GET'], ['/api/v1/sources/src_saved_after_uncertain_response', 'GET'],
    ]);
  });
});

describe('server retry guidance', () => {
  it.each([
    ['2', 2], ['0', 0], [' 5 ', 5], ['86400', 86400],
    [null, undefined], ['-1', undefined], ['1.5', undefined], ['later', undefined],
    ['86401', undefined], ['999999999999999999', undefined],
  ])('preserves usable delta-seconds %s without automatically repeating a mutation', async (header, expected) => {
    const headers = header === null ? undefined : { 'Retry-After': header };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { code: 'storage_initializing', message: 'Preparing storage' } }, { status: 503, headers }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.open('https://video.example/recording.mp4', new AbortController().signal)).rejects.toMatchObject({ code: 'storage_initializing', httpStatus: 503, retryAfterSeconds: expected });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps an uncertain export as an error and lets a deliberate retry reuse its idempotency key', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 'database_unavailable', message: 'Unavailable' } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: 'job_existing', status: 'queued' }));
    vi.stubGlobal('fetch', fetchMock);
    const create = () => api.createJob('src_a', [{ id: 'clip_a', start_ms: 0, end_ms: 1000, label: '' }], { format: 'mp4', quality: '720p', cut_mode: 'accurate' }, 'original-attempt');
    await expect(create()).rejects.toMatchObject({ code: 'database_unavailable', httpStatus: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(create()).resolves.toMatchObject({ id: 'job_existing' });
    for (const [, options] of fetchMock.mock.calls) expect(options.headers['Idempotency-Key']).toBe('original-attempt');
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
  });
});

describe('session initialization', () => {
  it('uses one cookie handshake for concurrent callers and revalidates after it completes', async () => {
    let respond!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { respond = resolve; }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const initial = api.session();
    const repeatedSetup = api.session();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respond(Response.json({ ok: true }));
    await expect(Promise.all([initial, repeatedSetup])).resolves.toEqual([{ ok: true }, { ok: true }]);

    await expect(api.session()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a shared failure to all callers and allows a fresh retry', async () => {
    let respond!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { respond = resolve; }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const initial = api.session();
    const repeatedSetup = api.session();
    const failures = Promise.allSettled([initial, repeatedSetup]);
    respond(Response.json({ error: { code: 'rate_limit', message: 'Too many requests' } }, { status: 429 }));

    const results = await failures;
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'rate_limit' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(api.session()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('read cancellation', () => {
  it('passes an abort signal to in-flight polling and restoration reads', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const results = Promise.allSettled([api.job('active_job', controller.signal), api.source('source', controller.signal)]);
    controller.abort();
    for (const result of await results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason.name).toBe('AbortError');
    }
    expect(fetchMock.mock.calls.every(([, options]) => options.signal?.aborted === true)).toBe(true);
  });
});

describe('empty deletion responses', () => {
  it('accepts a successful DELETE 204 without parsing JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.deleteSource('src_a')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/sources/src_a', expect.objectContaining({ method: 'DELETE' }));
  });
  it('turns a malformed error body into safe fallback copy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(null, { status: 500 })));
    await expect(api.deleteSource('src_a')).rejects.toMatchObject({ code: 'server' });
  });
});

class UploadXHR {
  static current: UploadXHR;
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; ontimeout: (() => void) | null = null;
  status = 201; response: unknown = { id: 'src_uploaded' }; responseType = ''; timeout = 0;
  retryAfter: string | null = null;
  getResponseHeader = vi.fn(() => this.retryAfter);
  open = vi.fn(); send = vi.fn(); abort = vi.fn(() => this.onabort?.());
  constructor() { UploadXHR.current = this; }
}

describe('native uploads with bounded progress work', () => {
  it('retains upload Retry-After and retries the same File only when the caller requests it', async () => {
    vi.stubGlobal('XMLHttpRequest', UploadXHR);
    const file = new File(['media'], 'kept.mp4', { type: 'video/mp4' });
    const first = api.upload(file, new AbortController().signal);
    const rejected = expect(first).rejects.toMatchObject({ code: 'storage_initializing', httpStatus: 503, retryAfterSeconds: 2 });
    const failed = UploadXHR.current;
    failed.status = 503; failed.response = { error: { code: 'storage_initializing', message: 'Preparing storage' } }; failed.retryAfter = '2';
    failed.onload?.(); await rejected;
    expect(failed.getResponseHeader).toHaveBeenCalledWith('Retry-After');
    expect(failed.send).toHaveBeenCalledOnce();
    expect(UploadXHR.current).toBe(failed);
    const repeated = api.upload(file, new AbortController().signal);
    const successful = UploadXHR.current;
    expect(successful).not.toBe(failed);
    for (const request of [failed, successful]) expect((request.send.mock.calls[0][0] as FormData).get('file')).toBe(file);
    successful.onload?.(); await expect(repeated).resolves.toMatchObject({ id: 'src_uploaded' });
  });

  it('passes the original File in FormData, throttles percentage updates and reports the response', async () => {
    vi.stubGlobal('XMLHttpRequest', UploadXHR);
    const file = new File(['media'], 'file.mp4', { type: 'video/mp4' });
    const read = vi.spyOn(file, 'arrayBuffer'); const onProgress = vi.fn();
    const controller = new AbortController(); const result = api.upload(file, controller.signal, onProgress);
    const xhr = UploadXHR.current;
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/v1/uploads');
    expect(xhr.send.mock.calls[0][0]).toBeInstanceOf(FormData);
    expect((xhr.send.mock.calls[0][0] as FormData).get('file')).toBe(file);
    expect(read).not.toHaveBeenCalled();
    xhr.upload.onprogress?.({ loaded: 10, total: 100, lengthComputable: true });
    xhr.upload.onprogress?.({ loaded: 10.5, total: 100, lengthComputable: true });
    xhr.upload.onprogress?.({ loaded: 101, total: 100, lengthComputable: true });
    expect(onProgress.mock.calls).toEqual([[{ loaded: 10, total: 100 }], [{ loaded: 100, total: 100 }]]);
    xhr.onload?.(); await expect(result).resolves.toMatchObject({ id: 'src_uploaded' });
    controller.abort(); expect(xhr.abort).not.toHaveBeenCalled(); read.mockRestore();
  });
  it('aborts a pending upload and removes progress handlers', async () => {
    vi.stubGlobal('XMLHttpRequest', UploadXHR);
    const controller = new AbortController();
    const result = api.upload(new File(['media'], 'file.mp4'), controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejection;
    expect(UploadXHR.current.abort).toHaveBeenCalledOnce(); expect(UploadXHR.current.upload.onprogress).toBeNull();
  });
  it('does not construct a request when the signal was already cancelled', async () => {
    const construct = vi.fn(); vi.stubGlobal('XMLHttpRequest', construct);
    const controller = new AbortController(); controller.abort();
    await expect(api.upload(new File(['media'], 'file.mp4'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(construct).not.toHaveBeenCalled();
  });
});


describe('bounded server waits', () => {
  it('turns a stalled status read into a retryable connection error and aborts the request', async () => {
    vi.useFakeTimers();
    try {
      let signal!: AbortSignal;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, options: RequestInit) => {
        signal = options.signal as AbortSignal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      }));
      const result = api.job('job_stalled');
      const rejection = expect(result).rejects.toMatchObject({ code: 'connection' });
      await vi.advanceTimersByTimeAsync(30000); await rejection; expect(signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});


describe('export storage budget recovery', () => {
  it('explains the worst-case per-fragment reservation rather than suggesting a shorter source', () => {
    const message = errorMessage(new ApiError('storage_limit', 'private diagnostic'), 'export');
    expect(message).toContain('Выберите меньше фрагментов');
    expect(translate(message, 'en')).toBe('This export exceeds the server storage budget. Select fewer clips and try again.');
  });
});
