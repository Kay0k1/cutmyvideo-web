import { parseTimecode } from './timecode';

export const MAX_ANALYSIS_WINDOW_MS = 30 * 60 * 1000;
export const MAX_CUT_LIST_BYTES = 1024 * 1024;
export const MAX_CUT_LIST_ENTRIES = 128;

export interface CutDecision { label: string; start_ms: number; end_ms: number; }
export interface SuggestionDraft { id: string; included: boolean; label: string; start: string; end: string; }
export interface ToolIssue { key: string; values?: Record<string, string | number>; }
export interface DecisionLimits { duration: number; maxRanges: number; maxRangeMS: number; maxJobMS: number; }

function safeMS(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function analysisWindowIssue(start: number | undefined, end: number | undefined, duration: number): ToolIssue | null {
  if (!safeMS(start) || !safeMS(end) || !safeMS(duration) || end <= start || end > duration) return { key: 'Выберите фрагмент для анализа.' };
  if (end - start > MAX_ANALYSIS_WINDOW_MS) return { key: 'Для анализа выберите фрагмент не длиннее 30 минут.' };
  return null;
}

/** Expand every marker in submitted order. Never sort, drop, clamp or repair an edit. */
export function resolveCutList(list: unknown, duration: number): { ranges: CutDecision[]; issue: null } | { ranges: []; issue: ToolIssue } {
  const fail = (key: string, values?: Record<string, string | number>): { ranges: []; issue: ToolIssue } => ({ ranges: [], issue: { key, values } });
  if (!safeMS(duration) || duration <= 0 || typeof list !== 'object' || list === null) return fail('Сервер вернул некорректный список фрагментов.');
  const value = list as { version?: unknown; entries?: unknown };
  if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > MAX_CUT_LIST_ENTRIES) return fail('Список должен содержать от 1 до 128 фрагментов.');
  const ranges: CutDecision[] = [];
  for (let index = 0; index < value.entries.length; index++) {
    const entry: unknown = value.entries[index];
    if (typeof entry !== 'object' || entry === null) return fail('Сервер вернул некорректный список фрагментов.');
    const row = entry as { start_ms?: unknown; end_ms?: unknown; label?: unknown };
    if (!safeMS(row.start_ms) || typeof row.label !== 'string') return fail('Сервер вернул некорректный список фрагментов.');
    let end = row.end_ms;
    if (end === null || end === undefined) {
      const next: unknown = value.entries[index + 1];
      end = index + 1 === value.entries.length ? duration : typeof next === 'object' && next !== null ? (next as { start_ms?: unknown }).start_ms : undefined;
      if (!safeMS(end) || end <= row.start_ms) return fail('У маркера {index} нет следующей границы. Укажите конец явно.', { index: index + 1 });
    }
    if (!safeMS(end) || end <= row.start_ms || end > duration) return fail('Фрагмент {index} выходит за границы видео или имеет неверный конец.', { index: index + 1 });
    ranges.push({ label: row.label, start_ms: row.start_ms, end_ms: end });
  }
  return { ranges, issue: null };
}

export function decisionIssue(ranges: CutDecision[], limits: DecisionLimits, existingCount = 0, rowNumbers?: number[]): ToolIssue | null {
  if (!ranges.length) return { key: 'Выберите хотя бы одно предложение.' };
  if (ranges.length + existingCount > Math.min(MAX_CUT_LIST_ENTRIES, limits.maxRanges)) return { key: 'В списке будет слишком много фрагментов. Снимите лишние отметки.' };
  let total = 0;
  for (const [index, range] of ranges.entries()) {
    const row = rowNumbers?.[index] ?? index + 1;
    if (!safeMS(range.start_ms) || !safeMS(range.end_ms) || range.end_ms > limits.duration || range.end_ms <= range.start_ms) return { key: 'Проверьте границы предложения {index}.', values: { index: row } };
    if (range.end_ms - range.start_ms < 100) return { key: 'Предложение {index} короче 0,1 секунды.', values: { index: row } };
    if (range.end_ms - range.start_ms > limits.maxRangeMS) return { key: 'Предложение {index} превышает допустимую длительность фрагмента.', values: { index: row } };
    if (new TextEncoder().encode(range.label).byteLength > 200 || /[\u0000-\u001f\u007f]/.test(range.label)) return { key: 'Сократите название предложения {index} и уберите переносы строк.', values: { index: row } };
    total += range.end_ms - range.start_ms;
  }
  if (!Number.isSafeInteger(total) || total > limits.maxJobMS) return { key: 'Выбранные предложения превышают длительность одного экспорта. Снимите лишние отметки.' };
  return null;
}

export function draftDecisions(rows: SuggestionDraft[]): { ranges: CutDecision[]; issue: ToolIssue | null } {
  const ranges: CutDecision[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row.included) continue;
    const start = parseTimecode(row.start), end = parseTimecode(row.end);
    if (start === null || end === null) return { ranges: [], issue: { key: 'Введите время предложения {index} в формате 00:00:01.250.', values: { index: index + 1 } } };
    ranges.push({ label: row.label, start_ms: start, end_ms: end });
  }
  return { ranges, issue: null };
}

export function chaptersIssue(ranges: CutDecision[]): ToolIssue | null {
  let previousEnd = 0;
  for (const [index, range] of ranges.entries()) {
    if (!safeMS(range.start_ms) || !safeMS(range.end_ms) || range.end_ms <= range.start_ms || (index > 0 && range.start_ms < previousEnd)) return { key: 'Главам нужен порядок по времени без пересечений. Для повторов и другого порядка скачайте CSV.' };
    previousEnd = range.end_ms;
  }
  return null;
}

/** Suggestions preserve the entire requested source window, including its final frame. */
export function sceneDecisions(start: number, end: number, scenes: Array<{ at_ms: number }>): CutDecision[] {
  if (!safeMS(start) || !safeMS(end) || end <= start || scenes.some(scene => !safeMS(scene.at_ms) || scene.at_ms < start || scene.at_ms > end)) return [];
  const boundaries = [...new Set([start, ...scenes.map(scene => scene.at_ms).filter(at => at > start && at < end), end])].sort((a, b) => a - b);
  return boundaries.slice(1).map((until, index) => ({ label: '', start_ms: boundaries[index], end_ms: until }));
}
