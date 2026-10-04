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
