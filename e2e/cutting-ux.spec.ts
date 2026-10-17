import { readBrowserDraft } from './browserProjectStorage';
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { api, goToClips, goToExport, probeDownloadedFile, showExactTimes, showEditorTools, closeEditorTools, showTimelineMedia, uploadThroughUI, waitJob } from './helpers';

const source = { id: 'src_cutting_controls', title: 'Recorded interview', kind: 'upload', duration_ms: 12000, width: 640, height: 360,
  preview_kind: 'native', preview_url: `${api}/sources/src_cutting_controls/file`, embed_url: null, thumbnail_url: null };
const ranges = [{ id: 'range_opening', label: 'Opening', start_ms: 1000, end_ms: 3000 }, { id: 'range_ending', label: 'Ending', start_ms: 10000, end_ms: 12000 }];

async function confirmUnverifiedReconnection(page: Page) {
  const confirmed = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toBe('The recording differs from the saved project. Apply the intervals? Check boundaries before exporting.');
    await dialog.accept();
  });
  await Promise.all([confirmed, page.getByRole('button', { name: 'Open video', exact: true }).click()]);
}

async function prepare(page: Page, saved: Record<string, unknown> = {}, expired = false, reopenedDuration = source.duration_ms, busyStoryboards = 0, storyboardReady?: Promise<void>) {
  const media = await readFile(process.env.CUTMY_E2E_MEDIA!);
  let storyboardRequests = 0;
  await page.route(`**${api}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === `${api}/session`) return route.fulfill({ json: { ok: true } });
    if (path === `${api}/jobs`) return route.fulfill({ json: { jobs: [] } });
    if (path === `${api}/sources`) return route.request().method() === 'POST'
      ? route.fulfill({ json: { ...source, id: 'src_reconnected', duration_ms: reopenedDuration } }) : route.fulfill({ json: { sources: [] } });
    if (path.endsWith('/file')) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
      const begin = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
      return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: media.subarray(begin, end + 1), headers: {
        'Accept-Ranges': 'bytes', 'Content-Length': String(end - begin + 1), ...(range ? { 'Content-Range': `bytes ${begin}-${end}/${media.length}` } : {}) } });
    }
    if (path.endsWith('/tracks')) return route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac' }] } });
    if (path.endsWith('/storyboard')) {
      if (++storyboardRequests <= busyStoryboards) return route.fulfill({ status: 503, json: { error: { code: 'server_busy', message: 'Foreground preview is preparing' } } });
      await storyboardReady;
      const sprite = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', process.env.CUTMY_E2E_MEDIA!, '-vf', 'fps=1/5,scale=160:90,tile=6x1:nb_frames=3', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { timeout: 15000 });
      return route.fulfill({ contentType: 'image/jpeg', body: sprite, headers: { 'X-Preview-Start-MS': '0', 'X-Preview-End-MS': '12000', 'X-Storyboard-Step-MS': '5000', 'X-Storyboard-Frames': '3' } });
    }
    if (path === `${api}/sources/${source.id}`) return expired
      ? route.fulfill({ status: 410, json: { error: { code: 'expired', message: 'Expired fixture' } } }) : route.fulfill({ json: source });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Controlled fixture' } } });
  });
  await page.addInitScript(({ source, ranges, saved }) => {
    if (localStorage.getItem('cutting-fixture-seeded')) return;
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, step: 2, source_id: source.id,
      source_title: source.title, source_duration_ms: source.duration_ms, ranges, selected_id: ranges[0].id,
      selected_range_ids: [ranges[1].id], precision_open: true, ...saved }));
    localStorage.setItem('cutting-fixture-seeded', 'yes');
  }, { source, ranges, saved });
  await page.goto('/?lang=en');
}

test('small cut steps, boundary checks and frame search use actual source positions', async ({ page }) => {
  await prepare(page);
  await expect(page.locator('.editor-workspace')).toBeVisible();
  const video = page.locator('video');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await showEditorTools(page);
  await page.getByRole('button', { name: 'Start 0.1 s later', exact: true }).click();
  await expect(page.locator('#range-start')).toHaveValue('00:00:01.100');
  await page.getByRole('button', { name: 'End 0.1 s earlier', exact: true }).click();
  await expect(page.locator('#range-end')).toHaveValue('00:00:02.900');
  await page.getByRole('button', { name: 'Check start', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(2.6, 2);
  await showEditorTools(page);
  await page.getByRole('button', { name: 'Check end', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(1.5);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(4.4, 2);
  await closeEditorTools(page);
  await showTimelineMedia(page);
  const frames = page.getByRole('button', { name: /^Go to frame/ });
  await expect(frames).toHaveCount(3);
  await frames.nth(2).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(10, 2);
  await expect(page.locator('#overview')).toHaveValue('10000');
  await page.getByRole('button', { name: 'Русский', exact: true }).click();
  await showEditorTools(page);
  await expect(page.getByRole('button', { name: 'Проверить начало', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Начало на 0,1 с позже', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('uncommitted exact entry survives reload and arrow shortcuts leave fields alone', async ({ page }) => {
  await prepare(page);
  await showExactTimes(page);
  const start = page.locator('#range-start');
  await start.fill('00:00:01.375');
  await page.reload();
  await expect(start).toHaveValue('00:00:01.375');
  await start.fill('invalid');
  await start.press('ArrowRight');
  await expect(start).toHaveValue('invalid');
  await page.reload();
  await expect(start).toHaveValue('invalid');
  await expect(page.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '1000');
});

test('committed short times restore canonically while malformed saved clips are discarded', async ({ page }) => {
  await prepare(page, { start_text: '1', end_text: '3', ranges: [null, 42, {}, ranges[0], { ...ranges[0], start_ms: 4000, end_ms: 5000 }] });
  await expect(page.locator('#range-start')).toHaveValue('00:00:01.000');
  await expect(page.locator('#range-end')).toHaveValue('00:00:03.000');
  await expect(page.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '1000');
  await expect(page.locator('.trim-handle.end')).toHaveAttribute('aria-valuenow', '3000');
  await goToClips(page);
  await expect(page.locator('.range-list > li')).toHaveCount(1);
});

test('expired sources retain names and exact cuts across reload and reconnect', async ({ page }) => {
  await prepare(page, { output: { format: 'mp3', quality: 'best', cut_mode: 'accurate' } }, true);
  await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  await expect(page.locator('.draft-recovery')).toContainText('Ending');
  await expect(page.locator('.draft-recovery')).toContainText('00:00:10.000 — 00:00:12.000');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Restore saved clips in the video you open', exact: true }).check();
  await page.getByLabel('Video link', { exact: true }).fill('https://video.example/recording.mp4');
  await confirmUnverifiedReconnection(page);
  await expect(page.locator('.editor-workspace')).toBeVisible();
  await goToClips(page);
  await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Opening');
  await expect(page.getByLabel('Clip 2 name', { exact: true })).toHaveValue('Ending');
  await expect(page.getByRole('checkbox', { name: 'Select clip 1', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).toBeChecked();
  await goToExport(page);
  await expect(page.locator('.format-picker button.active')).toContainText('MP3');
});

test('checking the final boundary stops exactly at the source end', async ({ page }) => {
  await prepare(page, { selected_id: ranges[1].id });
  const video = page.locator('video');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await showEditorTools(page);
  await page.getByRole('button', { name: 'Check end', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(10.6);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
  await closeEditorTools(page);
  await expect(page.getByRole('button', { name: 'Preview clip', exact: true })).toBeVisible();
  await expect(page.locator('#overview')).toHaveValue('12000');
});

test('an expired draft with no export selection survives rejecting a shorter replacement', async ({ page }) => {
  await prepare(page, { selected_range_ids: [], ranges: [{ ...ranges[0], start_ms: 1125, end_ms: 3875 }, ranges[1]] }, true, 5000);
  const restore = page.getByRole('checkbox', { name: 'Restore saved clips in the video you open', exact: true });
  await expect(restore).not.toBeChecked();
  await restore.check();
  await page.getByLabel('Video link', { exact: true }).fill('https://video.example/shorter.mp4');
  await page.getByRole('button', { name: 'Open video', exact: true }).click();
  await expect(page.locator('#source-error')).toHaveText('This recording is shorter than your saved clips. Open the original recording or turn off clip restoration.');
  await expect(page.locator('.draft-recovery')).toContainText('00:00:01.125 — 00:00:03.875');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  expect(await readBrowserDraft(page).then(saved => saved.selected_range_ids)).toEqual([]);
  await expect(page.locator('.draft-recovery li')).toHaveCount(2);
});

test('copy mode explains shifted boundaries before opening optional export controls', async ({ page }) => {
  await prepare(page, { step: 4, output: { format: 'mp4', quality: 'best', cut_mode: 'copy' } });
  await expect(page.locator('.export-settings-dialog')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('note')).toHaveText('Copying preserves original quality. The start may shift to a keyframe; actual boundaries will be shown with the finished file.');
  await page.getByRole('button', { name: 'Русский', exact: true }).click();
  await expect(page.getByRole('note')).toContainText('фактические границы будут указаны');
});

test('a source expiring during export offers recovery immediately without losing cuts', async ({ page }) => {
  await prepare(page, { ranges: [{ ...ranges[0], start_ms: 1125, end_ms: 3875 }, ranges[1]], start_text: '1.125', end_text: '3.875', output: { format: 'mp3', quality: 'best', cut_mode: 'accurate' } });
  await page.route(`**${api}/jobs`, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Source expired while editing' } } }) : route.fallback());
  await goToExport(page);
  await goToExport(page); await page.getByRole('button', { name: 'Cut a clip', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  await expect(page.locator('.draft-recovery')).toContainText('00:00:01.125 — 00:00:03.875');
  await page.getByRole('checkbox', { name: 'Restore saved clips in the video you open', exact: true }).check();
  await page.getByLabel('Video link', { exact: true }).fill('https://video.example/recording.mp4');
  await confirmUnverifiedReconnection(page);
  await expect(page.locator('#range-start')).toHaveValue('00:00:01.125');
  await expect(page.locator('#range-end')).toHaveValue('00:00:03.875');
  await goToClips(page);
  await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Opening');
  await expect(page.getByLabel('Clip 2 name', { exact: true })).toHaveValue('Ending');
  await expect(page.getByRole('checkbox', { name: 'Select clip 1', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).toBeChecked();
  await goToExport(page);
  await expect(page.locator('.format-picker button.active')).toContainText('MP3');
});

test('frames still prepare after three refusals while foreground preview is busy', async ({ page }) => {
  await prepare(page, {}, false, source.duration_ms, 3);
  await showTimelineMedia(page);
  await expect(page.getByRole('button', { name: /^Go to frame/ })).toHaveCount(3);
  await page.getByRole('button', { name: 'Go to frame 00:00:10', exact: true }).click();
  await expect(page.locator('#overview')).toHaveValue('10000');
});

test('late frame preparation keeps scrolled precision controls in place on a short phone', async ({ page }) => {
  let release!: () => void;
  const storyboardReady = new Promise<void>(resolve => { release = resolve; });
  await page.setViewportSize({ width: 360, height: 640 });
  await prepare(page, { precision_open: false }, false, source.duration_ms, 0, storyboardReady);
  await showTimelineMedia(page);
  const precision = page.getByRole('button', { name: 'Exact time and timeline', exact: true });
  await expect(precision).toBeVisible();
  await precision.scrollIntoViewIfNeeded();
  const before = await precision.boundingBox();
  expect(before).not.toBeNull();
  release();
  await showTimelineMedia(page);
  await expect(page.getByRole('button', { name: /^Go to frame/ })).toHaveCount(3);
  const after = await precision.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  expect(after!.y).toBeGreaterThanOrEqual(-1);
  expect(after!.y + after!.height).toBeLessThanOrEqual(641);
});

test('foreground preview retries brief contention promptly with bounded attempts', async ({ page }) => {
  // Count foreground retry attempts independently of speculative continuation.
  // Continuation and cache promotion have their own window-preview scenarios.
  await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }));
  await prepare(page);
  const windowSource = { ...source, duration_ms: 60000, preview_url: null, preview_kind: 'window' };
  const requests: number[] = [];
  await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({ json: windowSource }));
  await page.route(`**${api}/sources/${source.id}/preview?*`, async route => {
    requests.push(Date.now());
    return requests.length <= 3 ? route.fulfill({ status: 503, json: { error: { code: 'server_busy', message: 'Inspecting source metadata' } } })
      : route.fulfill({ contentType: 'video/mp4', body: await readFile(process.env.CUTMY_E2E_MEDIA!) });
  });
  await page.reload();
  await expect.poll(() => page.locator('.window-player video').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  expect(requests).toHaveLength(4);
  expect(requests[3] - requests[0]).toBeLessThan(2400);
});

test('a new seek cancels an obsolete foreground retry before it prepares more media', async ({ page }) => {
  await page.clock.install();
  // This assertion isolates foreground retries; speculative continuation is
  // covered separately by the window-preview cache and promotion scenarios.
  await page.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }));
  await prepare(page);
  const windowSource = { ...source, duration_ms: 60000, preview_url: null, preview_kind: 'window' };
  const requests: number[] = [];
  await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({ json: windowSource }));
  await page.route(`**${api}/sources/${source.id}/preview?*`, async route => {
    const start = Number(new URL(route.request().url()).searchParams.get('start_ms'));
    requests.push(start);
    // Freeze before completing the third busy reply so UI interaction cannot
    // accidentally race the next retry on a loaded browser runner.
    if (start === 0 && requests.filter(value => value === 0).length === 3) await page.clock.pauseAt(new Date());
    return start === 0 ? route.fulfill({ status: 503, json: { error: { code: 'server_busy', message: 'Busy obsolete window' } } })
      : route.fulfill({ contentType: 'video/mp4', body: await readFile(process.env.CUTMY_E2E_MEDIA!) });
  });
  const thirdBusy = page.waitForResponse(response => response.url().includes('/preview?start_ms=0') && requests.filter(start => start === 0).length === 3);
  await page.reload(); await thirdBusy;
  const seek = page.getByRole('slider', { name: 'Position in video', exact: true });
  await seek.evaluate(node => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, '32000');
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.clock.runFor(200);
  const video = page.locator('.window-player video');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(2, 1);
  await expect(seek).toHaveValue('32000');
  await page.clock.runFor(1200);
  expect(requests.filter(start => start === 0)).toHaveLength(3);
  expect(requests.filter(start => start === 30000)).toHaveLength(1);
});

test('a real upload keeps precise boundaries from audition through decoded download', async ({ page }, testInfo) => {
  await page.goto('/?lang=en');
  const uploaded = page.waitForResponse(response => response.url().endsWith(`${api}/uploads`) && response.request().method() === 'POST');
  await uploadThroughUI(page);
  const response = await uploaded;
  expect(response.ok(), await response.text()).toBeTruthy();
  const opened = await response.json();
  try {
    await showExactTimes(page);
    const video = page.locator('video');
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.locator('#range-start').fill('1.125'); await page.locator('#range-start').press('Tab');
    await page.locator('#range-end').fill('3.875'); await page.locator('#range-end').press('Tab');
    await showEditorTools(page);
    await page.getByRole('button', { name: 'Start 0.1 s later', exact: true }).click();
    await expect(page.locator('#range-start')).toHaveValue('00:00:01.225');
    await showEditorTools(page);
    await page.getByRole('button', { name: 'Check end', exact: true }).click();
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(2.5);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(5.375, 2);
    await closeEditorTools(page);
    await showTimelineMedia(page);
    await expect(page.getByRole('button', { name: /^Go to frame/ })).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath('cutting-editor.png'), fullPage: true });
    await testInfo.attach('cutting-editor.png', { path: testInfo.outputPath('cutting-editor.png'), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Preview clip', exact: true }).click();
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(1.3);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(3.875, 2);
    await goToExport(page);
    const created = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST');
    await goToExport(page); await page.getByRole('button', { name: 'Cut a clip', exact: true }).click();
    const exported = await created;
    expect(exported.ok(), await exported.text()).toBeTruthy();
    expect(exported.request().postDataJSON().ranges).toEqual([{ start_ms: 1225, end_ms: 3875, label: '' }]);
    const job = await waitJob(page.request, (await exported.json()).id);
    expect(job.status).toBe('succeeded');
    const artifact = job.items[0].artifact;
    expect(artifact.actual_start_ms).toBe(1225);
    expect(Math.abs(artifact.actual_end_ms - 3875)).toBeLessThanOrEqual(40); // One frame at the fixture's 25 fps.
    const decoded = await probeDownloadedFile(page.request, artifact.download_url, 'precise-cut.mp4', testInfo);
    expect(Number(decoded.format.duration)).toBeCloseTo(2.65, 1);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', testInfo.outputPath('precise-cut.mp4'), '-f', 'null', '-'], { timeout: 15000 });
  } finally {
    await page.goto('about:blank');
    const removed = await page.request.delete(`${api}/sources/${opened.id}`);
    expect(removed.ok(), await removed.text()).toBeTruthy();
  }
});
