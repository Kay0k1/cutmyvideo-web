/** Parse seconds, MM:SS, or HH:MM:SS with up to millisecond precision. */
export function parseTimecode(value: string): number | null {
  const text = value.trim().replace(',', '.');
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(text)) return null;
  const parts = text.split(':');
  const numbers = parts.map(Number);
  if (numbers.some(n => !Number.isFinite(n))) return null;
  if (parts.length > 1 && numbers.at(-1)! >= 60) return null;
  if (parts.length === 3 && numbers[1] >= 60) return null;
  let seconds = 0;
  for (const number of numbers) seconds = seconds * 60 + number;
  const ms = Math.round(seconds * 1000);
  return Number.isSafeInteger(ms) ? ms : null;
}

export function formatTimecode(ms: number, precise = false): string {
  const safe = Math.max(0, Math.round(ms));
  const seconds = Math.floor(safe / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return precise ? `${base}.${String(safe % 1000).padStart(3, '0')}` : base;
}

export function durationLabel(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${Number(seconds.toFixed(3))} с`;
  return `${Math.floor(seconds / 60)} мин ${Number((seconds % 60).toFixed(1))} с`;
}

export function validateRange(start: number | null, end: number | null, duration: number): string | null {
  if (start === null || end === null) return 'Введите время в формате 01:23:10.000 или 83:10.';
  if (start < 0 || end > duration) return 'Границы должны находиться внутри видео.';
  if (end <= start) return 'Конец должен быть позже начала.';
  if (end - start < 100) return 'Выберите фрагмент не короче 0,1 секунды.';
  return null;
}

export function zoomWindow(duration: number, center: number, span: number): [number, number] {
  const width = Math.max(1, Math.min(duration, span));
  const start = Math.max(0, Math.min(duration - width, center - width / 2));
  return [start, start + width];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
