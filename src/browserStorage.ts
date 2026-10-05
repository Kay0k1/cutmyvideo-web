export const draftStorageKey = 'cutmy.workbench.v1';
export const maxDraftCharacters = 256 * 1024;

/** Reject oversized persisted input before JSON parsing or creating requests. */
export function readStoredRecord(key: string, maxCharacters = maxDraftCharacters): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > maxCharacters) return {};
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export function storedResourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
