import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { api, goToExport, probeDownloadedFile, showExactTimes, stepButton, uploadThroughUI, waitJob } from './helpers';

const source = { id: 'src_cutting_controls', title: 'Recorded interview', kind: 'upload', duration_ms: 12000, width: 640, height: 360,
  preview_kind: 'native', preview_url: `${api}/sources/src_cutting_controls/file`, embed_url: null, thumbnail_url: null };
const ranges = [{ id: 'range_opening', label: 'Opening', start_ms: 1000, end_ms: 3000 }, { id: 'range_ending', label: 'Ending', start_ms: 10000, end_ms: 12000 }];

async function prepare(page: Page, saved: Record<string, unknown> = {}, expired = false, reopenedDuration = source.duration_ms) {
  const media = await readFile(process.env.CUTMY_E2E_MEDIA!);
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
      const sprite = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', process.env.CUTMY_E2E_MEDIA!, '-vf', 'fps=1/5,scale=160:90,tile=6x1:nb_frames=3', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { timeout: 15000 });
      return route.fulfill({ contentType: 'image/jpeg', body: sprite, headers: { 'X-Preview-Start-MS': '0', 'X-Preview-End-MS': '12000', 'X-Storyboard-Step-MS': '5000', 'X-Storyboard-Frames': '3' } });
    }
    if (path === `${api}/sources/${source.id}`) return expired
      ? route.fulfill({ status: 410, json: { error: { code: 'expired', message: 'Expired fixture' } } }) : route.fulfill({ json: source });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Controlled fixture' } } });
  });
  await page.goto('/?lang=en');
  await expect(page.getByRole('button', { name: 'Open video', exact: true })).toBeEnabled();
  await page.evaluate(({ source, ranges, saved }) => {
    window.dispatchEvent(new Event('pagehide'));
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, step: 2, source_id: source.id,
      source_title: source.title, source_duration_ms: source.duration_ms, ranges, selected_id: ranges[0].id,
      selected_range_ids: [ranges[1].id], precision_open: true, ...saved }));
  }, { source, ranges, saved });
  await page.reload();
}

test('small cut steps, boundary checks and frame search use actual source positions', async ({ page }) => {
  await prepare(page);
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step');
  const video = page.locator('video');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Start 0.1 s later', exact: true }).click();
  await expect(page.locator('#range-start')).toHaveValue('00:00:01.100');
  await page.getByRole('button', { name: 'End 0.1 s earlier', exact: true }).click();
  await expect(page.locator('#range-end')).toHaveValue('00:00:02.900');
  await page.getByRole('button', { name: 'Check start', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(2.6, 2);
  await page.getByRole('button', { name: 'Check end', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(1.5);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(4.4, 2);
  const frames = page.getByRole('button', { name: /^Go to frame/ });
  await expect(frames).toHaveCount(3);
  await frames.nth(2).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(10, 2);
  await expect(page.locator('#overview')).toHaveValue('10000');
  await page.getByRole('button', { name: 'Русский', exact: true }).click();
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

test('expired sources retain names and exact cuts across reload and reconnect', async ({ page }) => {
  await prepare(page, { output: { format: 'mp3', quality: 'best', cut_mode: 'accurate' } }, true);
  await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  await expect(page.locator('.draft-recovery')).toContainText('Ending');
  await expect(page.locator('.draft-recovery')).toContainText('00:00:10.000 — 00:00:12.000');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Restore saved clips in the video you open', exact: true }).check();
  await page.getByLabel('Video link', { exact: true }).fill('https://video.example/recording.mp4');
  await page.getByRole('button', { name: 'Open video', exact: true }).click();
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step');
  await page.getByRole('button', { name: 'Clip list', exact: true }).click();
  await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Opening');
  await expect(page.getByLabel('Clip 2 name', { exact: true })).toHaveValue('Ending');
  await expect(page.getByRole('checkbox', { name: 'Select clip 1', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).toBeChecked();
  await stepButton(page, 4).click();
  await expect(page.locator('.format-picker button.active')).toContainText('MP3');
});

test('checking the final boundary stops exactly at the source end', async ({ page }) => {
  await prepare(page, { selected_id: ranges[1].id });
  const video = page.locator('video');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Check end', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(10.6);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
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
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.workbench.v1')!).selected_range_ids)).toEqual([]);
  await expect(page.locator('.draft-recovery li')).toHaveCount(2);
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
    await page.getByRole('button', { name: 'Start 0.1 s later', exact: true }).click();
    await expect(page.locator('#range-start')).toHaveValue('00:00:01.225');
    await page.getByRole('button', { name: 'Check end', exact: true }).click();
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(2.5);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(5.375, 2);
    await expect(page.getByRole('button', { name: /^Go to frame/ })).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath('cutting-editor.png'), fullPage: true });
    await testInfo.attach('cutting-editor.png', { path: testInfo.outputPath('cutting-editor.png'), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Preview clip', exact: true }).click();
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(1.3);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
    await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(3.875, 2);
    await goToExport(page);
    const created = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Cut clip', exact: true }).click();
    const exported = await created;
    expect(exported.ok(), await exported.text()).toBeTruthy();
    expect(exported.request().postDataJSON().ranges).toEqual([{ start_ms: 1225, end_ms: 3875, label: '' }]);
    const job = await waitJob(page.request, (await exported.json()).id);
    expect(job.status).toBe('succeeded');
    const artifact = job.items[0].artifact;
    expect(artifact.actual_start_ms).toBe(1225); expect(artifact.actual_end_ms).toBe(3875);
    const decoded = await probeDownloadedFile(page.request, artifact.download_url, 'precise-cut.mp4', testInfo);
    expect(Number(decoded.format.duration)).toBeCloseTo(2.65, 1);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', testInfo.outputPath('precise-cut.mp4'), '-f', 'null', '-'], { timeout: 15000 });
  } finally {
    const removed = await page.request.delete(`${api}/sources/${opened.id}`);
    expect(removed.ok(), await removed.text()).toBeTruthy();
  }
});
