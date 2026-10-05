// The first update sets a deadline. Continuous playback/dragging must not keep
// postponing persistence; explicit flush also preserves the final update.
export function coalescedTask(run: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    run();
  };
  return {
    schedule(delay = 1000) { if (timer === undefined) timer = setTimeout(flush, delay); },
    flush,
  };
}
