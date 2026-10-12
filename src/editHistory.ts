/** Each project owns a bounded history; a gesture records one before-state. */
export interface EditHistory<T> { past: T[]; future: T[]; gesture: boolean; previousFuture?: T[]; previousPast?: T[]; }
export const historyLimit = 50;
export function emptyHistory<T>(): EditHistory<T> { return { past: [], future: [], gesture: false }; }
export function rememberEdit<T>(history: EditHistory<T>, current: T): void {
  if (history.gesture) return;
  history.past.push(structuredClone(current));
  if (history.past.length > historyLimit) history.past.shift();
  history.future = [];
}
export function beginGesture<T>(history: EditHistory<T>, current: T): void {
  if (history.gesture) return;
  const previousFuture = history.future, previousPast = [...history.past];
  rememberEdit(history, current); history.previousFuture = previousFuture; history.previousPast = previousPast; history.gesture = true;
}
export function finishGesture<T>(history: EditHistory<T>, current: T): void {
  if (!history.gesture) return;
  history.gesture = false;
  if (JSON.stringify(history.past.at(-1)) === JSON.stringify(current)) { history.past = history.previousPast ?? history.past.slice(0, -1); history.future = history.previousFuture ?? []; }
  delete history.previousFuture; delete history.previousPast;
}
export function undoEdit<T>(history: EditHistory<T>, current: T): T | null {
  finishGesture(history, current);
  const previous = history.past.pop();
  if (previous === undefined) return null;
  history.future.push(structuredClone(current)); return previous;
}
export function redoEdit<T>(history: EditHistory<T>, current: T): T | null {
  finishGesture(history, current);
  const next = history.future.pop();
  if (next === undefined) return null;
  history.past.push(structuredClone(current)); return next;
}
