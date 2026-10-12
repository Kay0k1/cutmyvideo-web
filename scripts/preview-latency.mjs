// Real WindowPlayer + API/FFmpeg measurements. No network throttling or fake media.
// PROBE_URL=http://127.0.0.1:5173 PROBE_MEDIA=/abs/source.mp4 PROBE_OUTPUT=/abs/result.json node scripts/preview-latency.mjs
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const base = process.env.PROBE_URL || 'http://127.0.0.1:5173';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Use an isolated loopback test installation');
if (!process.env.PROBE_MEDIA || !process.env.PROBE_OUTPUT) throw new Error('Set PROBE_MEDIA and PROBE_OUTPUT');
const media = await readFile(process.env.PROBE_MEDIA);
const browser = await chromium.launch({ headless: true });
const observations = [];
const check = (value, message) => { if (!value) throw new Error(message); };
try {
  for (let index = 0; index < 5; index++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on('pageerror', error => console.error('Browser error:', error.message));
    let source;
    try {
      await context.request.get(`${base}/api/v1/session`);
      const uploaded = await context.request.post(`${base}/api/v1/uploads`, { multipart: { file: { name: 'preview-latency.mp4', mimeType: 'video/mp4', buffer: media } } });
      check(uploaded.ok(), `Upload failed: ${uploaded.status()}`);
      source = await uploaded.json();
      // Select the real server preview path for a natively playable test file.
      // Only the preview-mode metadata changes; API ownership, rendering, bytes,
      // decode and all WindowPlayer logic remain real.
      await page.route(`**/api/v1/sources/${source.id}`, async route => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, preview_url: null, embed_url: null, preview_kind: 'window' } });
      });
      await page.addInitScript(({ id, duration }) => {
        if (!location.protocol.startsWith('http')) return;
        localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, source_id: id, step: 2, current_ms: 0,
          ranges: [{ id: 'range_latency', label: 'Latency', start_ms: 0, end_ms: Math.min(3000, duration) }], selected_id: 'range_latency', selected_range_ids: ['range_latency'] }));
        const probe = window.__previewProbe = { start: 0, target: 0, frames: [], requests: [] };
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
          const measured = String(input).includes('/preview?') && !String(input).includes('priority=background');
          if (measured && !probe.start) probe.start = performance.now();
          return originalFetch.call(this, input, init).then(response => {
            if (measured) probe.requests.push({ status: response.status, headers_ms: performance.now() - probe.start });
            return response;
          });
        };
        const attach = video => {
          if (video.dataset.latencyProbe) return;
          video.dataset.latencyProbe = 'true';
          video.muted = true;
          video.addEventListener('loadeddata', () => { void video.play().catch(() => undefined); });
          const frame = (_, metadata) => {
            if (probe.start && Math.abs(metadata.mediaTime * 1000 - probe.target) < 150) {
              probe.frames.push({ elapsed_ms: performance.now() - probe.start, media_ms: metadata.mediaTime * 1000, target_ms: probe.target, requests: [...probe.requests] });
              probe.start = 0;
              video.pause();
            }
            video.requestVideoFrameCallback(frame);
          };
          video.requestVideoFrameCallback(frame);
        };
        new MutationObserver(() => document.querySelectorAll('video').forEach(attach)).observe(document, { childList: true, subtree: true });
      }, { id: source.id, duration: source.duration_ms });
      await page.goto(base);
      await page.waitForFunction(() => window.__previewProbe.frames.length === 1, null, { timeout: 90000 });
      const cold = await page.evaluate(() => window.__previewProbe.frames[0]);
      await page.evaluate(() => {
        const probe = window.__previewProbe;
        probe.target = 1000; probe.start = performance.now(); probe.requests = [];
        const slider = document.querySelector('.window-player-navigation input[type=range]');
        if (!slider) throw new Error('Missing real WindowPlayer seek control');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '1000');
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        void document.querySelector('video').play().catch(() => undefined);
      });
      await page.waitForFunction(() => window.__previewProbe.frames.length === 2, null, { timeout: 5000 });
      const warm = await page.evaluate(() => window.__previewProbe.frames[1]);
      observations.push({ observation: index + 1, cold, warm });
      console.log(JSON.stringify(observations.at(-1)));
    } catch (error) {
      console.error(await page.evaluate(() => ({ probe: window.__previewProbe, text: document.body.innerText, videos: [...document.querySelectorAll('video')].map(video => ({ src: video.currentSrc, time: video.currentTime, state: video.readyState, error: video.error?.message })) })));
      throw error;
    } finally {
      await page.goto('about:blank');
      if (source) {
        const deleted = await context.request.delete(`${base}/api/v1/sources/${source.id}`);
        check(deleted.ok(), `Owned fixture cleanup failed: ${deleted.status()}`);
      }
      await context.close();
    }
  }
  const stats = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { count: values.length, median_ms: median, min_ms: sorted[0], max_ms: sorted.at(-1), spread_ms: sorted.at(-1) - sorted[0] };
  };
  const report = { measured_at: new Date().toISOString(), browser: await browser.version(), viewport: '1440x1000', network: 'loopback, no throttling',
    fixture_sha256: execFileSync('sha256sum', [process.env.PROBE_MEDIA], { encoding: 'utf8' }).split(' ')[0],
    media_tools: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
    cold: stats(observations.map(value => value.cold.elapsed_ms)), warm: stats(observations.map(value => value.warm.elapsed_ms)), observations };
  await writeFile(process.env.PROBE_OUTPUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ cold: report.cold, warm: report.warm }));
} finally { await browser.close(); }
