export function keyboardTrimValue(key: string, value: number, minimum: number, maximum: number, shift = false): number | null {
  const step = shift ? 1000 : 100;
  let next: number;
  switch (key) {
    case 'ArrowLeft': case 'ArrowDown': next = value - step; break;
    case 'ArrowRight': case 'ArrowUp': next = value + step; break;
    case 'PageDown': next = value - 5000; break;
    case 'PageUp': next = value + 5000; break;
    case 'Home': next = minimum; break;
    case 'End': next = maximum; break;
    default: return null;
  }
  return Math.max(minimum, Math.min(maximum, next));
}

export function pointerTrimValue(original: number, movement: number, width: number, span: number): number {
  if (width <= 0) return original;
  // Measure movement from the grab point, keeping the existing millisecond
  // precision and avoiding a jump when the larger hit area is grabbed.
  return original + Math.round(movement / width * span / 100) * 100;
}

/** Translate a point on the visible track without losing its time offset. */
export function pointerSeekValue(point: number, left: number, width: number, view: [number, number]): number {
  if (width <= 0) return view[0];
  const fraction = Math.max(0, Math.min(1, (point - left) / width));
  if (fraction === 0) return view[0];
  if (fraction === 1) return view[1];
  const value = Math.round((view[0] + fraction * (view[1] - view[0])) / 100) * 100;
  return Math.max(view[0], Math.min(view[1], value));
}
