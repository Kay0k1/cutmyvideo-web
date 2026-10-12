export interface WaveformWindow { start_ms: number; end_ms: number; step_ms: number; has_audio: boolean; audio_track?: number; peaks: number[]; }

export function parseWaveform(value: unknown, start: number, duration: number): WaveformWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Partial<WaveformWindow>;
  const end = Math.min(duration, start + 30000);
  if (data.start_ms !== start || data.end_ms !== end || data.step_ms !== 100 || typeof data.has_audio !== 'boolean' ||
      !Array.isArray(data.peaks) || data.peaks.length !== Math.ceil((end - start) / 100) ||
      data.peaks.some(peak => typeof peak !== 'number' || !Number.isFinite(peak) || peak < 0 || peak > 1) ||
      data.audio_track !== undefined && (!Number.isInteger(data.audio_track) || data.audio_track < 0)) return null;
  if (!data.has_audio && data.peaks.some(peak => peak !== 0)) return null;
  return data as WaveformWindow;
}

/** Collapse known source bins into display pixels; unknown areas stay empty. */
export function waveformPath(windows: Iterable<WaveformWindow>, view: [number, number], width = 600, height = 40): string {
  const bins = new Float64Array(width), known = new Uint8Array(width);
  const span = view[1] - view[0];
  if (span <= 0) return '';
  for (const window of windows) {
    for (let i = 0; i < window.peaks.length; i++) {
      const begin = window.start_ms + i * window.step_ms;
      const end = Math.min(window.end_ms, begin + window.step_ms);
      if (end <= view[0] || begin >= view[1]) continue;
      const first = Math.max(0, Math.floor((begin - view[0]) / span * width));
      const last = Math.min(width - 1, Math.max(first, Math.ceil((end - view[0]) / span * width) - 1));
      for (let x = first; x <= last; x++) { known[x] = 1; bins[x] = Math.max(bins[x], window.peaks[i]); }
    }
  }
  const center = height / 2;
  return Array.from(bins, (peak, x) => known[x] ? `M${x},${(center - Math.max(.5, peak * center)).toFixed(2)}V${(center + Math.max(.5, peak * center)).toFixed(2)}` : '').join('');
}
