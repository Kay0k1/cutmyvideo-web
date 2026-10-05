/** Hidden pages do no polling. Each visible restart invalidates old responses. */
export function startVisiblePolling<T>({ read, onResult, onError, delay = 1500 }: {
  read(signal: AbortSignal): Promise<T>;
  onResult(value: T): boolean;
  onError(error: unknown): boolean;
  delay?: number;
}): () => void {
  let disposed = false;
  let finished = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const stop = () => {
    generation++;
    clearTimeout(timer); timer = undefined;
    controller?.abort(); controller = undefined;
  };
  const schedule = (ms: number) => {
    if (!disposed && !finished && !document.hidden) timer = setTimeout(() => { void poll(); }, ms);
  };
  const poll = async () => {
    timer = undefined;
    if (disposed || finished || document.hidden) return;
    const current = generation;
    const request = new AbortController(); controller = request;
    let nextDelay = delay;
    try {
      const value = await read(request.signal);
      if (disposed || current !== generation || request.signal.aborted) return;
      finished = !onResult(value);
    } catch (error) {
      if (disposed || current !== generation || request.signal.aborted) return;
      finished = !onError(error); nextDelay = Math.max(3000, delay);
    } finally { if (controller === request) controller = undefined; }
    schedule(nextDelay);
  };
  const visibility = () => { stop(); schedule(0); };
  document.addEventListener('visibilitychange', visibility);
  schedule(500);
  return () => { disposed = true; stop(); document.removeEventListener('visibilitychange', visibility); };
}
