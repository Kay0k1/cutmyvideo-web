import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => { vi.unstubAllGlobals(); });

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
