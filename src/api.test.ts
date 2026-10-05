import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorMessage } from './api';
import { translate } from './locales';

afterEach(() => { vi.unstubAllGlobals(); });

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
  open = vi.fn(); send = vi.fn(); abort = vi.fn(() => this.onabort?.());
  constructor() { UploadXHR.current = this; }
}

describe('native uploads with bounded progress work', () => {
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
