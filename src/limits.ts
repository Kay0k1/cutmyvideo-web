import type { PublicLimits } from './types';

export const maxClientRanges = 128;
export const defaultLimits: PublicLimits = { max_source_bytes: 1024 ** 3, max_ranges: 12, max_range_ms: 600000, max_job_ms: 3600000 };
const yearMS = 366 * 24 * 60 * 60 * 1000;

/** Old or malformed servers keep safe, known defaults; arrays/prototypes are ignored. */
export function readPublicLimits(value: unknown): PublicLimits {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultLimits;
  const record = value as Record<string, unknown>;
  const limit = (key: keyof PublicLimits, maximum: number, minimum = 1) => {
    const candidate = Object.hasOwn(record, key) ? record[key] : undefined;
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= minimum ? Math.min(candidate, maximum) : defaultLimits[key];
  };
  return { max_source_bytes: limit('max_source_bytes', 1024 ** 4), max_ranges: limit('max_ranges', maxClientRanges), max_range_ms: limit('max_range_ms', yearMS, 100), max_job_ms: limit('max_job_ms', yearMS, 100) };
}
