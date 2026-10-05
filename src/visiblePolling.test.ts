import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVisiblePolling } from './visiblePolling';

let documentStub: EventTarget & { hidden: boolean };
beforeEach(() => { vi.useFakeTimers(); documentStub = Object.assign(new EventTarget(), { hidden: false }); vi.stubGlobal('document', documentStub); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const visibility = (hidden: boolean) => { documentStub.hidden = hidden; documentStub.dispatchEvent(new Event('visibilitychange')); };

describe('visibility-aware asynchronous job polling', () => {
  it('aborts hidden requests, ignores providers that resolve after abort and resumes immediately', async () => {
    let resolve!: (value: string) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<string>(done => { resolve = done; })).mockResolvedValue('fresh');
    const onResult = vi.fn().mockReturnValue(true);
    const stop = startVisiblePolling({ read, onResult, onError: () => true });
    await vi.advanceTimersByTimeAsync(500);
    const signal = read.mock.calls[0][0] as AbortSignal;
    visibility(true); expect(signal.aborted).toBe(true);
    resolve('stale'); await vi.advanceTimersByTimeAsync(10000);
    expect(read).toHaveBeenCalledTimes(1); expect(onResult).not.toHaveBeenCalled();
    visibility(false); await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledExactlyOnceWith('fresh');
    stop();
  });
  it('does not poll initially hidden pages and stops permanently after a terminal result', async () => {
    documentStub.hidden = true;
    const read = vi.fn().mockResolvedValue('cancelled');
    const stop = startVisiblePolling({ read, onResult: () => false, onError: () => true });
    await vi.advanceTimersByTimeAsync(10000); expect(read).not.toHaveBeenCalled();
    visibility(false); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(1);
    visibility(true); visibility(false); await vi.advanceTimersByTimeAsync(10000); expect(read).toHaveBeenCalledTimes(1);
    stop();
  });
  it('invalidates an in-flight read immediately when cancellation or unmount disposes polling', async () => {
    let resolve!: (value: string) => void;
    const read = vi.fn(() => new Promise<string>(done => { resolve = done; }));
    const onResult = vi.fn().mockReturnValue(true);
    const stop = startVisiblePolling({ read, onResult, onError: () => true });
    await vi.advanceTimersByTimeAsync(500); stop(); resolve('running');
    await vi.advanceTimersByTimeAsync(10000); expect(onResult).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
  });
  it('backs off transient failures but respects a permanent error', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockRejectedValueOnce(new Error('expired'));
    const onError = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const stop = startVisiblePolling({ read, onResult: () => true, onError });
    await vi.advanceTimersByTimeAsync(3499); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000); expect(read).toHaveBeenCalledTimes(2); stop();
  });
});
