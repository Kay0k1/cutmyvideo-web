/** Hidden/offline pages do no polling. Each restart invalidates old responses. */
export function startVisiblePolling<T>({ read, onResult, onError, delay = 1500 }: {
  read(signal: AbortSignal): Promise<T>;
  onResult(value: T): boolean;
  onError(error: unknown): boolean;
  delay?: number | ((value: T) => number);
}): () => void {
  let disposed = false;
  let finished = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let failures = 0;
  const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
  const network = typeof window === 'undefined' ? undefined : window;
  const stop = () => {
    generation++;
    clearTimeout(timer); timer = undefined;
    controller?.abort(); controller = undefined;
  };
  const schedule = (ms: number) => {
    if (!disposed && !finished && !document.hidden && online()) timer = setTimeout(() => { void poll(); }, ms);
  };
  const poll = async () => {
    timer = undefined;
    if (disposed || finished || document.hidden || !online()) return;
    const current = generation;
    const request = new AbortController(); controller = request;
    let nextDelay = typeof delay === 'number' ? delay : 1500;
    try {
      const value = await read(request.signal);
      if (disposed || current !== generation || request.signal.aborted) return;
      finished = !onResult(value);
      failures = 0;
      nextDelay = typeof delay === 'function' ? delay(value) : delay;
    } catch (error) {
      if (disposed || current !== generation || request.signal.aborted) return;
      finished = !onError(error);
      failures++;
      nextDelay = Math.min(30000, Math.max(3000, nextDelay) * 2 ** Math.min(failures - 1, 4));
    } finally { if (controller === request) controller = undefined; }
    schedule(nextDelay);
  };
  const visibility = () => { stop(); failures = 0; schedule(0); };
  document.addEventListener('visibilitychange', visibility);
  network?.addEventListener('offline', visibility);
  network?.addEventListener('online', visibility);
  schedule(500);
  return () => {
    disposed = true; stop(); document.removeEventListener('visibilitychange', visibility);
    network?.removeEventListener('offline', visibility);
    network?.removeEventListener('online', visibility);
  };
}
