import { describe, expect, it } from 'vitest';
import { clipSignature, collectionRequest, compareCollectionSource, effectiveCollectionOptions, readCollectionDocument, selectedCollectionIDs, sourceIdentity } from './collectionProject';
import { takeHandoffFragment } from './collectionHandoff';
import type { CollectionPlan } from './collectionProject';
import type { Source } from './types';

const plan: CollectionPlan = { version: 1, options: { format: 'mp4', quality: '1080p', audio_track: 2, no_audio: true, crop: { x: .2, y: 0, width: .5, height: 1 } }, clips: [
  { id: '2', label: 'Вторая мысль', ranges: [{ start_ms: 9000, end_ms: 11000, label: 'Ответ' }, { start_ms: 1000, end_ms: 2000 }], options: { no_audio: false, audio_track: -1, clear_crop: true } },
  { id: '1', ranges: [{ start_ms: 2000, end_ms: 4000 }], options: { crop: { x: 0, y: .1, width: 1, height: .8 } } },
] };
const fingerprint = { kind: 'content' as const, sha256: 'a'.repeat(64), size_bytes: 12345 };
const source = { id: 'source-a', title: 'talk.mp4', duration_ms: 12000, fingerprint } as Source;

describe('portable collection editing', () => {
  it('round trips stable numeric IDs, nonchronological joins, inherited options and independent crops', () => {
    const document = readCollectionDocument({ kind: 'cutmy.collection.project', version: 1, source: sourceIdentity(source), plan, clip_ids: ['1', '2'], rendition: 'final' });
    expect(readCollectionDocument(JSON.stringify(document))).toEqual(document);
    expect(selectedCollectionIDs(document)).toEqual(['2', '1']);
    expect(document.plan.clips[0].ranges.map(range => range.start_ms)).toEqual([9000, 1000]);
    expect(effectiveCollectionOptions(document.plan, document.plan.clips[0])).toMatchObject({ quality: '1080p', no_audio: false });
    expect(effectiveCollectionOptions(document.plan, document.plan.clips[0])).not.toHaveProperty('crop');
    expect(effectiveCollectionOptions(document.plan, document.plan.clips[0])).not.toHaveProperty('audio_track');
    expect(effectiveCollectionOptions(document.plan, document.plan.clips[1]).crop).toEqual(plan.clips[1].options!.crop);
    expect(effectiveCollectionOptions({ ...plan, options: { clear_crop: true } }, plan.clips[1]).crop).toEqual(plan.clips[1].options!.crop);
    expect(JSON.stringify(document)).not.toMatch(/source_id|collection_key|cookie|download_url/);
  });
  it('accepts native SDK requests without trusting their source ID or retaining owner/key material', () => {
    const document = readCollectionDocument({ source_id: 'other-owner-source', plan: { ...plan, input: '/local/talk.mp4' }, clip_ids: ['1'] });
    expect(document).not.toHaveProperty('source_id'); expect(document).not.toHaveProperty('source');
    expect(collectionRequest(document, 'explicitly-bound-source')).toMatchObject({ source_id: 'explicitly-bound-source', clip_ids: ['1'] });
    expect(collectionRequest(document, 'explicitly-bound-source').plan).not.toHaveProperty('input');
    expect(() => readCollectionDocument({ plan, collection_key: 'secret' })).toThrow();
  });
  it('two revisions change exactly two of fifteen clip signatures while cosmetic order/name edits reuse them', () => {
    const document = readCollectionDocument({ version: 1, clips: Array.from({ length: 15 }, (_, index) => ({ id: 'clip-' + index, label: 'Label ' + index, ranges: [{ start_ms: index * 100, end_ms: index * 100 + 1000 }] })) });
    const before = new Map(document.plan.clips.map(clip => [clip.id, clipSignature(document, clip, 'source-a')]));
    const revised = structuredClone(document); revised.plan.clips[3].ranges[0].end_ms += 100; revised.plan.clips[9].options = { crop: { x: .1, y: 0, width: .8, height: 1 } }; revised.plan.clips[5].label = 'Cosmetic'; revised.plan.clips.reverse();
    expect(revised.plan.clips.filter(clip => clipSignature(revised, clip, 'source-a') !== before.get(clip.id)).map(clip => clip.id).sort()).toEqual(['clip-3', 'clip-9']);
  });
  it('rejects ambiguous IDs, invalid ranges, unknown options and contradictory crop resets before binding media', () => {
    for (const clips of [[plan.clips[0], plan.clips[0]], [{ ...plan.clips[0], id: '../x' }], [{ ...plan.clips[0], id: 'con' }], [{ ...plan.clips[0], ranges: [{ start_ms: 1.5, end_ms: 5 }] }], [{ ...plan.clips[0], ranges: [{ start_ms: 4, end_ms: 4 }] }], [{ ...plan.clips[0], options: { crop: { x: 0, y: 0, width: 1, height: 1 }, clear_crop: true } }]]) expect(() => readCollectionDocument({ version: 1, clips })).toThrow();
    expect(() => readCollectionDocument({ ...plan, options: { cleanup_source: true } })).toThrow();
    expect(() => readCollectionDocument({ plan, clip_ids: ['missing'] })).toThrow();
    expect(() => readCollectionDocument({ plan, rendition: 'fast' })).toThrow();
  });
  it('allows same-name/same-duration content to match only by actual bytes, with provider metadata explicitly weaker', () => {
    expect(compareCollectionSource(sourceIdentity(source), source)).toBe('content_match');
    expect(compareCollectionSource(sourceIdentity(source), { ...source, fingerprint: { ...fingerprint, sha256: 'b'.repeat(64) } })).toBe('different');
    expect(compareCollectionSource({ title: source.title, duration_ms: source.duration_ms }, source)).toBe('unverified');
    const provider = { kind: 'provider' as const, provider: 'youtube', provider_id: 'abc', canonical_url_sha256: 'c'.repeat(64) };
    expect(compareCollectionSource({ fingerprint: provider }, { ...source, fingerprint: provider })).toBe('provider_match');
    expect(compareCollectionSource({ fingerprint: provider }, source)).toBe('unverified');
  });
  it('removes valid, duplicate and malformed handoff fragments before a caller can start network work', () => {
    for (const hash of ['#handoff=' + 'A'.repeat(43), '#handoff=bad', '#handoff=' + 'A'.repeat(43) + '&handoff=' + 'B'.repeat(43)]) {
      const calls: unknown[][] = [], history = { state: { retained: true }, replaceState: (...args: unknown[]) => { calls.push(args); } };
      const token = takeHandoffFragment({ hash, pathname: '/', search: '?lang=en' }, history);
      expect(calls).toEqual([[{ retained: true }, '', '/?lang=en']]);
      expect(token).toBe(hash.length === 52 ? 'A'.repeat(43) : '');
    }
  });
});
