import { describe, expect, it } from 'vitest';
import { analysisWindowIssue, chaptersIssue, decisionIssue, draftDecisions, resolveCutList, sceneDecisions } from './analysisToolModel';

const limits = { duration: 10000, maxRanges: 128, maxRangeMS: 5000, maxJobMS: 8000 };
const decision = { label: 'Opening', start_ms: 1000, end_ms: 2000 };

describe('bounded analysis windows', () => {
  it('accepts an exact 30-minute source interval and refuses a larger one without truncation', () => {
    expect(analysisWindowIssue(5000, 1805000, 2000000)).toBeNull();
    expect(analysisWindowIssue(5000, 1805001, 2000000)?.key).toContain('30 минут');
  });
  it.each([[undefined, 1000, 2000], [0, NaN, 2000], [-1, 1000, 2000], [0, 3000, 2000], [1, 1, 2000], [0.1, 1000, 2000]])('rejects invalid window %s %s %s', (start, end, duration) => {
    expect(analysisWindowIssue(start, end, duration)).not.toBeNull();
  });
});

describe('cut list review', () => {
  it('preserves arbitrary explicit order, labels, overlapping intervals and repetitions', () => {
    const entries = [{ ...decision, start_ms: 7000, end_ms: 8000 }, decision, decision];
    expect(resolveCutList({ version: 1, entries }, 10000)).toEqual({ ranges: entries, issue: null });
  });
  it('expands markers against their next submitted start and final source duration explicitly', () => {
    expect(resolveCutList({ version: 1, entries: [{ label: 'First', start_ms: 1000, end_ms: null }, { label: 'Last', start_ms: 4000 }] }, 9000)).toEqual({ ranges: [{ label: 'First', start_ms: 1000, end_ms: 4000 }, { label: 'Last', start_ms: 4000, end_ms: 9000 }], issue: null });
  });
  it('refuses ambiguous markers instead of sorting or dropping them', () => {
    const entries = [{ label: 'Later', start_ms: 7000, end_ms: null }, { ...decision }];
    expect(resolveCutList({ version: 1, entries }, 10000).issue?.key).toContain('маркера');
    expect(entries[0].end_ms).toBeNull();
  });
  it.each([null, {}, { version: 2, entries: [decision] }, { version: 1, entries: [] }, { version: 1, entries: [null] }, { version: 1, entries: Array(129).fill(decision) }, { version: 1, entries: [{ ...decision, end_ms: 10001 }] }, { version: 1, entries: [{ ...decision, start_ms: Number.MAX_SAFE_INTEGER + 1 }] }])('rejects malformed or out-of-source imported lists %j', value => {
    expect(resolveCutList(value, 10000).issue).not.toBeNull();
  });
  it('retains excluded invalid drafts and parses exact included source milliseconds', () => {
    expect(draftDecisions([{ id: 'a', included: false, label: 'Ignored', start: 'invalid', end: '' }, { id: 'b', included: true, label: 'Exact', start: '1.125', end: '2,250' }])).toEqual({ ranges: [{ label: 'Exact', start_ms: 1125, end_ms: 2250 }], issue: null });
  });
  it('refuses malformed included timestamps with their visible row number', () => {
    expect(draftDecisions([{ id: 'a', included: false, label: '', start: '', end: '' }, { id: 'b', included: true, label: '', start: '1:60', end: '3' }]).issue?.values).toEqual({ index: 2 });
  });
  it('reports the visible row number when earlier suggestions are unchecked', () => {
    expect(decisionIssue([{ ...decision, end_ms: 1099 }], limits, 0, [3])?.values).toEqual({ index: 3 });
  });
  it('checks every selected interval and byte-based labels before an undoable edit', () => {
    expect(decisionIssue([decision], limits)).toBeNull();
    expect(decisionIssue([{ ...decision, label: 'я'.repeat(100) }], limits)).toBeNull();
    expect(decisionIssue([{ ...decision, label: 'я'.repeat(101) }], limits)?.key).toContain('Сократите название');
    expect(decisionIssue([{ ...decision, label: 'line\nline' }], limits)).not.toBeNull();
    expect(decisionIssue([{ ...decision, end_ms: 1099 }], limits)?.key).toContain('0,1');
    expect(decisionIssue([{ ...decision, end_ms: 7000 }], limits)?.key).toContain('длительность');
    expect(decisionIssue([decision], limits, 128)?.key).toContain('много');
    expect(decisionIssue(Array(9).fill(decision), limits)?.key).toContain('одного экспорта');
    expect(decisionIssue([], limits)?.key).toContain('хотя бы');
  });
  it('requires chapter order while keeping CSV-compatible arbitrary edits intact', () => {
    const cuts = [decision, { ...decision, start_ms: 2000, end_ms: 3000 }];
    expect(chaptersIssue(cuts)).toBeNull();
    expect(chaptersIssue([cuts[1], cuts[0]])).not.toBeNull();
    expect(chaptersIssue([decision, decision])).not.toBeNull();
    expect(chaptersIssue([{ ...decision, end_ms: NaN }])).not.toBeNull();
  });
});

describe('scene suggestions', () => {
  it('deduplicates scene boundaries and keeps the requested final source interval', () => {
    expect(sceneDecisions(1000, 5000, [{ at_ms: 3000 }, { at_ms: 3000 }, { at_ms: 1000 }, { at_ms: 5000 }])).toEqual([{ label: '', start_ms: 1000, end_ms: 3000 }, { label: '', start_ms: 3000, end_ms: 5000 }]);
  });
  it('rejects invalid external events without losing valid neighboring content silently', () => {
    expect(sceneDecisions(1000, 5000, [{ at_ms: 5001 }])).toEqual([]);
    expect(sceneDecisions(1000, 5000, [{ at_ms: NaN }])).toEqual([]);
  });
});
