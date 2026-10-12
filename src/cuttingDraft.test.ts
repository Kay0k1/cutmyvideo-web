import { describe, expect, it } from 'vitest';
import { boundaryAudition, recoverCuttingDraft } from './cuttingDraft';

const ranges = [{ id: 'range_first', label: 'Opening', start_ms: 1250, end_ms: 3750 }, { id: 'range_later', label: 'Ending', start_ms: 9000, end_ms: 12000 }];

describe('cutting draft recovery', () => {
  it('preserves exact cuts, labels and export choices after source expiry', () => {
    expect(recoverCuttingDraft({ source_id: 'src_old', source_title: 'Recording', source_duration_ms: 30000, ranges, selected_id: 'range_later', selected_range_ids: ['range_later'] })).toEqual({ source: { id: 'src_old', title: 'Recording', duration_ms: 30000 }, ranges, selectedId: 'range_later', selectedIds: ['range_later'] });
  });
  it('recovers old drafts and keeps intentional empty export selections', () => {
    expect(recoverCuttingDraft({ source_id: 'src_old', ranges, selected_range_ids: [] })?.selectedIds).toEqual([]);
    expect(recoverCuttingDraft({ source_id: 'src_old', ranges })?.source.duration_ms).toBe(12000);
  });
  it('rejects invalid identities, malformed cuts and unbounded metadata', () => {
    expect(recoverCuttingDraft({ source_id: '../../secret', ranges })).toBeNull();
    expect(recoverCuttingDraft({ source_id: 'src_old', ranges: [{ ...ranges[0], end_ms: Number.MAX_SAFE_INTEGER }] })).toBeNull();
    expect(recoverCuttingDraft({ source_id: 'src_old', ranges: [null, {}, { ...ranges[0], label: 'invalid\n' }] })).toBeNull();
  });
});

describe('boundary audition', () => {
  it('includes context on both sides of a middle cut and handles source edges', () => {
    expect(boundaryAudition(5000, 12000)).toEqual([3500, 6500]);
    expect(boundaryAudition(0, 12000)).toEqual([0, 1500]);
    expect(boundaryAudition(12000, 12000)).toEqual([10500, 12000]);
    expect(boundaryAudition(50, 100)).toEqual([0, 100]);
  });
});
