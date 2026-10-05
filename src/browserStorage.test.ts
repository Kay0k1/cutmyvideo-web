import { afterEach, describe, expect, it, vi } from 'vitest';
import { maxDraftCharacters, readStoredRecord, storedResourceId } from './browserStorage';

afterEach(() => vi.unstubAllGlobals());
describe('untrusted persisted drafts', () => {
  it('rejects oversized input before invoking JSON.parse', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{'.repeat(maxDraftCharacters + 1) });
    const parse = vi.spyOn(JSON, 'parse');
    expect(readStoredRecord('draft')).toEqual({});
    expect(parse).not.toHaveBeenCalled(); parse.mockRestore();
  });
  it.each(['null', '[]', '42', '"text"', '{broken'])('ignores non-record or malformed %s', raw => {
    vi.stubGlobal('localStorage', { getItem: () => raw });
    expect(readStoredRecord('draft')).toEqual({});
  });
  it('handles denied storage while preserving editing', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    expect(readStoredRecord('draft')).toEqual({});
  });
  it('allows only bounded resource identifiers and header-safe retry keys', () => {
    expect(storedResourceId('src_abc-123')).toBe(true);
    for (const id of ['../other', 'x?token=secret', 'x\r\nHeader: injected', '', 'x'.repeat(129), null]) expect(storedResourceId(id)).toBe(false);
  });
});
