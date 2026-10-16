import { afterEach, expect, it, vi } from 'vitest';
import { readCollectionSubtitles, retimeCollectionSubtitles } from './collectionSubtitles';
import type { Artifact } from './types';
afterEach(() => vi.unstubAllGlobals());
it('reads bounded UTF-8 sidecars and rejects bad bytes, size and extensions', async () => {
  const file = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, arrayBuffer: async () => bytes.buffer }) as File;
  expect(await readCollectionSubtitles(file('captions.srt', new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nПривет\n')))).toMatchObject({ name: 'captions.srt', format: 'srt' });
  await expect(readCollectionSubtitles(file('wrong.txt', new Uint8Array([65])))).rejects.toThrow();
  await expect(readCollectionSubtitles(file('bad.srt', new Uint8Array([255, 254])))).rejects.toThrow('UTF-8');
  await expect(readCollectionSubtitles(file('large.srt', new Uint8Array(512 * 1024 + 1)))).rejects.toThrow('512');
});
it('retimes against actual artifact mappings and never requests another source or render', async () => {
  const segments = [{ index: 0, label: '', source_start_ms: 2010, source_end_ms: 3010, output_start_ms: 0, output_end_ms: 1000 }], fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ outputs: [{ clip_id: 'clip-1', format: 'srt', text: 'retimed', sha256: 'a'.repeat(64) }] }))); vi.stubGlobal('fetch', fetch);
  expect(await retimeCollectionSubtitles('clip-1', { segments } as Artifact, { format: 'srt', text: 'original', name: 'source.srt' })).toEqual({ format: 'srt', text: 'retimed' });
  expect(fetch.mock.calls[0][0]).toBe('/api/v1/subtitles/retime'); expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ version: 1, format: 'srt', text: 'original', outputs: [{ clip_id: 'clip-1', segments }] });
  await expect(retimeCollectionSubtitles('clip-1', {} as Artifact, { format: 'srt', text: 'original', name: 'source.srt' })).rejects.toThrow('карты'); expect(fetch).toHaveBeenCalledTimes(1);
});
