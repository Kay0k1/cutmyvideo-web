import type { CropRect, Source, SourceFingerprint } from './types';
import { validCrop } from './crop';

export type { SourceFingerprint } from './types';
export interface CollectionSourceIdentity { fingerprint?: SourceFingerprint; duration_ms?: number; title?: string; }
export interface CollectionOptions {
  format?: 'mp4' | 'mp3' | 'mkv' | ''; quality?: 'best' | '1080p' | '720p' | '';
  cut_mode?: 'accurate' | 'copy' | ''; subtitle_mode?: 'omit' | 'preserve' | '';
  audio_track?: number; no_audio?: boolean; crop?: CropRect; clear_crop?: boolean;
}
export interface CollectionRange { start_ms: number; end_ms: number; label?: string; }
export interface CollectionClip { id: string; label?: string; ranges: CollectionRange[]; options?: CollectionOptions; }
export interface CollectionPlan { version: 1; input?: string; options?: CollectionOptions; clips: CollectionClip[]; }
export interface CollectionRequest { source_id: string; plan: CollectionPlan; clip_ids?: string[]; rendition?: 'final' | 'draft'; }
/** Portable editing data. Server IDs, owner credentials and retry keys stay outside it. */
export interface CollectionProjectDocument {
  kind: 'cutmy.collection.project'; version: 1; source?: CollectionSourceIdentity;
  plan: CollectionPlan; clip_ids?: string[]; rendition?: 'final' | 'draft';
}
export class CollectionProjectError extends Error {
  constructor(public readonly field: string, message: string) { super(message); }
}
export const collectionDocumentLimit = 4 * 1024 * 1024;
const maximumMS = 366 * 86400000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && new TextEncoder().encode(value).length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
export const collectionClipID = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value);
function check(value: unknown, field: string, message: string): asserts value { if (!value) throw new CollectionProjectError(field, message); }
function keys(value: Record<string, unknown>, allowed: string[], field: string) { check(Object.keys(value).every(key => allowed.includes(key)), field, 'В плане есть неизвестные поля. Проверьте формат проекта.'); }

export function readSourceFingerprint(value: unknown): SourceFingerprint | undefined {
  if (!object(value)) return;
  if (value.kind === 'content' && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size_bytes) && Number(value.size_bytes) > 0) return { kind: 'content', sha256: value.sha256, size_bytes: Number(value.size_bytes) };
  if (value.kind === 'provider' && text(value.provider, 64) && text(value.provider_id, 256) && typeof value.canonical_url_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.canonical_url_sha256)) return { kind: 'provider', provider: value.provider, provider_id: value.provider_id, canonical_url_sha256: value.canonical_url_sha256 };
}
function readIdentity(value: unknown): CollectionSourceIdentity | undefined {
  if (value === undefined) return;
  check(object(value), 'source', 'Не удалось прочитать описание исходной записи.');
  keys(value, ['fingerprint', 'duration_ms', 'title'], 'source');
  const result: CollectionSourceIdentity = {};
  if (value.fingerprint !== undefined) { const fingerprint = readSourceFingerprint(value.fingerprint); check(fingerprint, 'source.fingerprint', 'Не удалось проверить отпечаток записи.'); result.fingerprint = fingerprint; }
  if (value.duration_ms !== undefined) { check(Number.isSafeInteger(value.duration_ms) && Number(value.duration_ms) > 0 && Number(value.duration_ms) <= maximumMS, 'source.duration_ms', 'Некорректная длительность записи.'); result.duration_ms = Number(value.duration_ms); }
  if (value.title !== undefined) { check(text(value.title, 500), 'source.title', 'Некорректное название записи.'); result.title = value.title; }
  return result;
}
function readOptions(value: unknown, field: string): CollectionOptions | undefined {
  if (value === undefined) return;
  check(object(value), field, 'Некорректные настройки клипа.');
  keys(value, ['format', 'quality', 'cut_mode', 'subtitle_mode', 'audio_track', 'no_audio', 'crop', 'clear_crop'], field);
  const result: CollectionOptions = {};
  for (const [key, allowed] of Object.entries({ format: ['', 'mp4', 'mp3', 'mkv'], quality: ['', 'best', '1080p', '720p'], cut_mode: ['', 'accurate', 'copy'], subtitle_mode: ['', 'omit', 'preserve'] })) {
    if (value[key] !== undefined) { check(typeof value[key] === 'string' && allowed.includes(value[key]), field + '.' + key, 'В плане указаны неподдерживаемые настройки экспорта.'); Object.assign(result, { [key]: value[key] }); }
  }
  if (value.audio_track !== undefined) { check(Number.isSafeInteger(value.audio_track) && Number(value.audio_track) >= -1 && Number(value.audio_track) <= 999, field + '.audio_track', 'Некорректная аудиодорожка.'); result.audio_track = Number(value.audio_track); }
  for (const key of ['no_audio', 'clear_crop'] as const) if (value[key] !== undefined) { check(typeof value[key] === 'boolean', field + '.' + key, 'Некорректные настройки клипа.'); result[key] = value[key]; }
  if (value.crop !== undefined) { check(validCrop(value.crop), field + '.crop', 'Область кадра выходит за изображение.'); result.crop = structuredClone(value.crop as CropRect); }
  check(!(result.crop && result.clear_crop), field + '.crop', 'Нельзя одновременно задать и сбросить кадр.');
  return result;
}
export function readCollectionPlan(value: unknown): CollectionPlan {
  check(object(value), 'plan', 'Не удалось прочитать план коллекции.');
  keys(value, ['version', 'input', 'options', 'clips'], 'plan');
  check(value.version === 1 && Array.isArray(value.clips) && value.clips.length >= 1 && value.clips.length <= 128, 'plan.clips', 'В коллекции должно быть от 1 до 128 клипов.');
  const plan: CollectionPlan = { version: 1, clips: [] }, seen = new Set<string>();
  if (value.input !== undefined) { check(text(value.input, 4096), 'plan.input', 'Некорректное имя исходного файла.'); plan.input = value.input; }
  const options = readOptions(value.options, 'plan.options'); if (options) plan.options = options;
  for (const [index, item] of value.clips.entries()) {
    const field = 'plan.clips[' + index + ']';
    check(object(item), field, 'Некорректный клип.'); keys(item, ['id', 'label', 'ranges', 'options'], field);
    check(collectionClipID(item.id) && !seen.has(item.id), field + '.id', 'У каждого клипа должен быть свой постоянный ID.'); seen.add(item.id);
    check(item.label === undefined || text(item.label, 200), field + '.label', 'Название клипа слишком длинное или содержит служебные символы.');
    check(Array.isArray(item.ranges) && item.ranges.length >= 1 && item.ranges.length <= 128, field + '.ranges', 'У клипа должно быть от 1 до 128 частей.');
    const ranges = item.ranges.map((range, r) => {
      const rf = field + '.ranges[' + r + ']'; check(object(range), rf, 'Некорректная часть клипа.'); keys(range, ['start_ms', 'end_ms', 'label'], rf);
      check(Number.isSafeInteger(range.start_ms) && Number.isSafeInteger(range.end_ms) && Number(range.start_ms) >= 0 && Number(range.end_ms) > Number(range.start_ms) && Number(range.end_ms) <= maximumMS, rf, 'Конец части должен быть после начала.');
      check(range.label === undefined || text(range.label, 200), rf + '.label', 'Некорректное название части клипа.');
      return { start_ms: Number(range.start_ms), end_ms: Number(range.end_ms), ...(range.label !== undefined ? { label: range.label as string } : {}) };
    });
    const clip: CollectionClip = { id: item.id, ...(item.label !== undefined ? { label: item.label as string } : {}), ranges };
    const overrides = readOptions(item.options, field + '.options'); if (overrides) clip.options = overrides;
    plan.clips.push(clip);
  }
  return plan;
}
export function readCollectionDocument(value: unknown): CollectionProjectDocument {
  if (typeof value === 'string') { check(value.length <= collectionDocumentLimit, 'document', 'План слишком большой.'); try { value = JSON.parse(value); } catch { throw new CollectionProjectError('document', 'Не удалось прочитать JSON-план.'); } }
  check(object(value), 'document', 'Не удалось прочитать проект коллекции.');
  check(JSON.stringify(value).length <= collectionDocumentLimit, 'document', 'План слишком большой.');
  const envelope = value.kind !== undefined;
  if (envelope) { check(value.kind === 'cutmy.collection.project' && value.version === 1, 'document', 'Неподдерживаемая версия проекта коллекции.'); keys(value, ['kind', 'version', 'source', 'plan', 'clip_ids', 'rendition'], 'document'); }
  else if (value.plan !== undefined) keys(value, ['source_id', 'plan', 'clip_ids', 'rendition'], 'document');
  const plan = readCollectionPlan(value.plan ?? value), result: CollectionProjectDocument = { kind: 'cutmy.collection.project', version: 1, plan };
  if (envelope) { const identity = readIdentity(value.source); if (identity) result.source = identity; }
  if (value.clip_ids !== undefined) { check(Array.isArray(value.clip_ids) && value.clip_ids.length <= 128 && value.clip_ids.every(collectionClipID) && new Set(value.clip_ids).size === value.clip_ids.length && value.clip_ids.every(id => plan.clips.some(clip => clip.id === id)), 'clip_ids', 'Выбор содержит неизвестные или повторяющиеся клипы.'); result.clip_ids = [...value.clip_ids] as string[]; }
  if (value.rendition !== undefined) { check(value.rendition === 'draft' || value.rendition === 'final', 'rendition', 'Выберите черновик или финальный результат.'); result.rendition = value.rendition; }
  return result;
}
export function isCollectionDocument(value: unknown): boolean { return object(value) && (value.kind === 'cutmy.collection.project' || Array.isArray(value.clips) || object(value.plan) && Array.isArray(value.plan.clips)); }
export function selectedCollectionIDs(document: CollectionProjectDocument): string[] { const chosen = new Set(document.clip_ids); return document.plan.clips.filter(clip => !document.clip_ids?.length || chosen.has(clip.id)).map(clip => clip.id); }
export function effectiveCollectionOptions(plan: CollectionPlan, clip: CollectionClip): CollectionOptions {
  const result: CollectionOptions = { format: 'mp4', quality: 'best', cut_mode: 'accurate', subtitle_mode: 'omit' };
  for (const options of [plan.options, clip.options]) {
    for (const [key, value] of Object.entries(options ?? {})) if (value !== '' && key !== 'crop' && key !== 'clear_crop') Object.assign(result, { [key]: value });
    if (options?.clear_crop) delete result.crop;
    if (options?.crop) result.crop = options.crop;
  }
  if (result.audio_track === -1) delete result.audio_track;
  delete result.clear_crop;
  return result;
}
export function clipSignature(document: CollectionProjectDocument, clip: CollectionClip, sourceID: string): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, next]) => next !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, next]) => [key, sorted(next)])) : value;
  const options = effectiveCollectionOptions(document.plan, clip);
  if (document.rendition === 'draft') options.quality = '720p';
  return JSON.stringify(sorted({ source_id: sourceID, ranges: clip.ranges, options, rendition: document.rendition ?? 'final' }));
}
export function collectionRequest(document: CollectionProjectDocument, sourceID: string, clipIDs?: string[]): CollectionRequest {
  const { input: _input, ...plan } = structuredClone(document.plan);
  return { source_id: sourceID, plan, ...(clipIDs ? { clip_ids: clipIDs } : document.clip_ids ? { clip_ids: document.clip_ids } : {}), ...(document.rendition ? { rendition: document.rendition } : {}) };
}
export function sourceIdentity(source: Source): CollectionSourceIdentity { const fingerprint = readSourceFingerprint(source.fingerprint); return { ...(fingerprint ? { fingerprint } : {}), title: source.title, duration_ms: source.duration_ms }; }
export function compareCollectionSource(identity: CollectionSourceIdentity | undefined, source: Source): 'content_match' | 'provider_match' | 'different' | 'unverified' {
  const actual = readSourceFingerprint(source.fingerprint), expected = identity?.fingerprint;
  if (!actual || !expected) return 'unverified';
  if (actual.kind === 'content' && expected.kind === 'content') return actual.sha256 === expected.sha256 && actual.size_bytes === expected.size_bytes ? 'content_match' : 'different';
  if (actual.kind === 'provider' && expected.kind === 'provider') return actual.provider === expected.provider && actual.provider_id === expected.provider_id && actual.canonical_url_sha256 === expected.canonical_url_sha256 ? 'provider_match' : 'different';
  return 'unverified';
}
