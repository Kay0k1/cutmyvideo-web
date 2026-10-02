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
  return error instanceof ApiError ? error.message : 'Нет связи с сервером. Проверьте подключение и попробуйте ещё раз.';
}
