import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVisiblePolling } from './visiblePolling';

let documentStub: EventTarget & { hidden: boolean };
let networkStub: EventTarget;
let navigatorStub: { onLine: boolean };
beforeEach(() => {
  vi.useFakeTimers();
  documentStub = Object.assign(new EventTarget(), { hidden: false });
  networkStub = new EventTarget(); navigatorStub = { onLine: true };
  vi.stubGlobal('document', documentStub); vi.stubGlobal('window', networkStub); vi.stubGlobal('navigator', navigatorStub);
});
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
  it('changes cadence from the latest result without overlapping pending reads', async () => {
    let resolve!: (value: string) => void;
    const read = vi.fn().mockResolvedValueOnce('waiting').mockImplementationOnce(() => new Promise<string>(done => { resolve = done; })).mockResolvedValue('running');
    const stop = startVisiblePolling({ read, onResult: () => true, onError: () => true, delay: value => value === 'waiting' ? 10000 : 1500 });
    await vi.advanceTimersByTimeAsync(10499); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10001); expect(read).toHaveBeenCalledTimes(2);
    resolve('running'); await vi.advanceTimersByTimeAsync(1499); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(3); stop();
  });
  it('pauses and invalidates an in-flight read offline, then refreshes immediately on reconnect', async () => {
    let resolve!: (value: string) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<string>(done => { resolve = done; })).mockResolvedValue('fresh');
    const onResult = vi.fn().mockReturnValue(true);
    const stop = startVisiblePolling({ read, onResult, onError: () => true });
    await vi.advanceTimersByTimeAsync(500);
    const signal = read.mock.calls[0][0] as AbortSignal;
    navigatorStub.onLine = false; networkStub.dispatchEvent(new Event('offline'));
    expect(signal.aborted).toBe(true);
    resolve('stale'); await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1); expect(onResult).not.toHaveBeenCalled();
    navigatorStub.onLine = true; networkStub.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0); expect(onResult).toHaveBeenCalledExactlyOnceWith('fresh');
    stop(); networkStub.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(10000); expect(read).toHaveBeenCalledTimes(2);
  });
  it('caps exponential retries and restores the usual cadence after a successful read', async () => {
    const times: number[] = [];
    const started = Date.now();
    let calls = 0;
    const read = vi.fn(() => {
      times.push(Date.now() - started); calls++;
      return calls === 6 ? Promise.resolve('running') : Promise.reject(new Error('temporary'));
    });
    const stop = startVisiblePolling({ read, onResult: () => true, onError: () => true });
    await vi.advanceTimersByTimeAsync(80000);
    expect(times).toEqual([500, 3500, 9500, 21500, 45500, 75500, 77000, 80000]);
    stop();
  });
});
