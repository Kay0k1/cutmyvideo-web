import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { api, chooseOption, goToExport, goToSource, probeDownloadedFile, showExactTimes, stepButton, uploadThroughUI, waitJob } from './helpers';

const cropPresets = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9'];
const sourceID = 'release-source';
const source = { id: sourceID, title: 'release-video.mp4', duration_ms: 12000, width: 640, height: 360, display_width: 640, display_height: 360, kind: 'upload', preview_kind: 'native', preview_url: '/release-preview.mp4', embed_url: null, thumbnail_url: null };
const tracks = [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac', title: 'Original', language: 'rus', channels: 1 }, { index: 2, type: 'audio', codec: 'aac', title: 'Commentary', language: 'eng', channels: 1, default: true }];

async function releaseMock(page: Page, { noSourceAudio = false }: { noSourceAudio?: boolean } = {}) {
  const media = await readFile(process.env.CUTMY_E2E_MEDIA!);
  let removed = false;
  let submitted: Record<string, any> | null = null;
  const artifact = { id: 'release-artifact', filename: 'release-clip.mp4', size_bytes: media.length, download_url: '/release-clip.mp4', actual_start_ms: 1000, actual_end_ms: 4000 };
  const job = () => ({ id: 'release-job', status: 'succeeded', stage: 'finished', message: '', items: [{ id: 'release-item', label: 'Saved moment', start_ms: 1000, end_ms: 4000, status: 'succeeded', artifact }] });
  await page.route('**/release-preview.mp4', route => route.fulfill({ contentType: 'video/mp4', body: media }));
  await page.route('**/release-clip.mp4', route => route.fulfill({ contentType: 'video/mp4', body: media }));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path.endsWith('/preview')) { await route.fulfill({ contentType: 'video/mp4', body: media }); return; }
    if (path.endsWith('/waveform')) {
      const start = Number(url.searchParams.get('start_ms') ?? 0), end = Math.min(12000, start + 30000), track = Number(url.searchParams.get('audio_track') ?? (noSourceAudio ? 0 : 2));
      const peaks = Array.from({ length: Math.ceil((end - start) / 100) }, (_, index) => noSourceAudio ? 0 : track === 1 ? index === 20 ? 1 : 0 : index === 80 ? .2 : 0);
      await route.fulfill({ json: { start_ms: start, end_ms: end, step_ms: 100, has_audio: !noSourceAudio, ...(noSourceAudio ? {} : { audio_track: track }), peaks } }); return;
    }
    const freshSource = { ...source, media_removed: removed, ...(removed ? { media_removed_at: '2026-10-12T12:00:00Z', preview_url: null } : {}) };
    if (path === `${api}/jobs` && request.method() === 'POST') {
      submitted = request.postDataJSON(); removed = submitted?.cleanup_source === true;
      await route.fulfill({ json: job() }); return;
    }
    const value = path.endsWith('/session') ? { ok: true } : path.endsWith('/tracks') ? { tracks: noSourceAudio ? tracks.slice(0, 1) : tracks } : path === `${api}/sources/${sourceID}` ? freshSource : path === `${api}/sources` ? { sources: [freshSource] } : path === `${api}/jobs/release-job` ? job() : path === `${api}/jobs` ? { jobs: submitted ? [{ id: 'release-job', source_id: sourceID, title: source.title, status: 'succeeded', stage: 'finished', created_at: '2026-10-12T12:00:00Z', total: 1, files: [artifact] }] : [] } : { error: { code: 'preview_unavailable', message: 'Unused mocked endpoint' } };
    await route.fulfill({ status: 'error' in value ? 400 : 200, json: value });
  });
  await page.addInitScript(({ id, title }) => {
    if (localStorage.getItem('release-seeded')) return;
    const draft = { workflow_version: 2, source_id: id, source_title: title, source_duration_ms: 12000, ranges: [{ id: 'release-range', label: 'Saved moment', start_ms: 1000, end_ms: 4000 }], selected_id: 'release-range', selected_range_ids: ['release-range'], step: 2, precision_open: true, current_ms: 2000, timeline_span: 12000, simple_view: [0, 12000], output: { format: 'mp4', quality: '720p', cut_mode: 'accurate' } };
    localStorage.setItem('cutmy.projects.v1', JSON.stringify({ version: 1, active_id: id, projects: [{ id, updated_at: 1, draft }] })); localStorage.setItem('release-seeded', 'yes');
  }, { id: sourceID, title: source.title });
  return { submitted: () => submitted };
}

async function openFrame(page: Page) {
  const frame = page.locator('.moments-stage details.crop-editor');
  await expect(frame).toBeVisible();
  if (!await frame.evaluate(node => (node as HTMLDetailsElement).open)) await frame.locator('summary').click();
  const aspect = frame.getByLabel('Frame aspect ratio', { exact: true });
  await expect(aspect).toBeEnabled();
  return { frame, aspect };
}

test('Frame stays compact, all aspect presets and custom ratios work, and crop gestures undo as one action', async ({ page }, testInfo) => {
  await releaseMock(page); await page.goto('/?lang=en');
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step');
  const disclosure = page.locator('.moments-stage details.crop-editor');
  await expect(disclosure).not.toHaveAttribute('open', '');
  await expect(disclosure.getByLabel('Frame aspect ratio', { exact: true })).toBeHidden();
  const { frame, aspect } = await openFrame(page);
  await expect(aspect.locator('option')).toHaveText(['Original aspect ratio', ...cropPresets, 'Custom aspect ratio']);
  for (const preset of cropPresets) {
    await aspect.selectOption(preset);
    const box = await page.locator('.crop-selection').boundingBox(); expect(box).toBeTruthy();
    const [width, height] = preset.split(':').map(Number);
    expect(Math.abs(box!.width / box!.height - width / height)).toBeLessThan(.05);
  }
  await aspect.selectOption('custom'); await frame.getByLabel('Width', { exact: true }).fill('7'); await frame.getByLabel('Height', { exact: true }).fill('5'); await frame.getByRole('button', { name: 'Apply', exact: true }).click();
  const customBox = await page.locator('.crop-selection').boundingBox(); expect(Math.abs(customBox!.width / customBox!.height - 7 / 5)).toBeLessThan(.03);
  await aspect.selectOption('1:1');
  const area = page.getByRole('group', { name: 'Move crop area', exact: true }); await area.scrollIntoViewIfNeeded();
  const before = await area.getAttribute('style'); const box = await area.boundingBox(); expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 20, box!.y + box!.height / 2, { steps: 6 }); await page.mouse.up();
  await expect(area).not.toHaveAttribute('style', before!);
  const after = await area.getAttribute('style');
  await page.getByRole('button', { name: 'Undo change', exact: true }).click(); await expect(area).toHaveAttribute('style', before!);
  await page.getByRole('button', { name: 'Redo change', exact: true }).click(); await expect(area).toHaveAttribute('style', after!);
  await frame.locator('summary').click(); await expect(frame.getByLabel('Frame aspect ratio', { exact: true })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Русский', exact: true }).click();
  await expect(frame.locator('summary')).toContainText('Кадр');
  await expect(frame.getByLabel('Пропорции кадра', { exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('compact-frame-editor.png'), fullPage: true });
  await goToExport(page); await expect(page.getByRole('checkbox', { name: 'Удалить исходник после экспорта', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await chooseOption(page, page.locator('#cut-mode'), 'Original quality');
  await expect(page.getByRole('button', { name: 'Cut clip', exact: true })).toBeDisabled();
  await expect(page.locator('.export-panel')).toContainText(/Crop|crop/);
});

test('waveform follows the selected track and source-time positions, and silent sources remain usable', async ({ page }) => {
  await releaseMock(page); await page.goto('/?lang=en');
  const waveform = page.locator('.audio-waveform'); await expect(waveform).toBeVisible();
  await expect(waveform.locator('.waveform-detail path')).toHaveAttribute('d', /M400,16\.00V24\.00/);
  await expect(waveform.locator('.waveform-overview path')).toHaveAttribute('d', /M400,4\.80V7\.20/);
  const changedTrack = page.waitForRequest(request => request.url().includes('/waveform?') && new URL(request.url()).searchParams.get('audio_track') === '1');
  await chooseOption(page, page.locator('#audio-track-preview'), /Audio #1.*rus/); await changedTrack;
  await expect(waveform.locator('.waveform-detail path')).toHaveAttribute('d', /M100,0\.00V40\.00/);
  await expect(waveform.locator('.waveform-detail path')).not.toHaveAttribute('d', /M400,16\.00V24\.00/);
  const overview = waveform.getByRole('button', { name: 'Whole recording audio overview; visited areas are prepared', exact: true }); await overview.scrollIntoViewIfNeeded(); const box = await overview.boundingBox(); expect(box).toBeTruthy();
  await overview.click({ position: { x: box!.width / 2, y: box!.height / 2 } });
  await expect(page.getByRole('slider', { name: 'Player position', exact: true }).last()).toHaveAttribute('aria-valuenow', '6000');
  await chooseOption(page, page.locator('#audio-track-preview'), 'No sound'); await expect(waveform).toHaveCount(0); await expect(page.locator('#range-start')).toBeEnabled();
});

test('no-audio waveform is explained without disabling cutting', async ({ page }) => {
  await releaseMock(page, { noSourceAudio: true }); await page.goto('/?lang=en');
  await expect(page.locator('.audio-waveform')).toContainText('This source has no audio'); await expect(page.locator('#range-start')).toBeEnabled();
  await expect(page.locator('.audio-waveform .waveform-detail path')).toHaveAttribute('d', /M0,19\.50V20\.50/);
});

test('default cleanup submits an explicit policy and preserves browser projects and completed downloads', async ({ page }) => {
  const state = await releaseMock(page); await page.goto('/?lang=en'); await goToExport(page);
  const cleanup = page.getByRole('checkbox', { name: 'Delete source after export', exact: true }); await expect(cleanup).toBeChecked();
  await cleanup.uncheck(); await page.reload(); await expect(cleanup).not.toBeChecked(); await cleanup.check();
  await page.getByRole('button', { name: 'Cut clip', exact: true }).click();
  await expect.poll(() => state.submitted()?.cleanup_source).toBe(true);
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', '/release-clip.mp4');
  await page.reload(); await expect(page.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
  await goToSource(page); await expect(page.locator('.draft-recovery')).toContainText('Saved moment');
  await page.getByRole('button', { name: 'My projects', exact: true }).click(); await expect(page.getByRole('button', { name: 'Open project “release-video.mp4”', exact: true })).toBeVisible();
});

test('real square crop keeps selected audio and cleanup removes original media while output and project survive', async ({ page }, testInfo) => {
  await page.goto('/?lang=en');
  const opened = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${api}/uploads`));
  await uploadThroughUI(page, process.env.CUTMY_E2E_MULTITRACK!);
  const sourceResponse = await opened; expect(sourceResponse.ok(), await sourceResponse.text()).toBeTruthy(); const openedSource = await sourceResponse.json();
  await showExactTimes(page); await page.getByLabel('Start', { exact: true }).fill('00:00:02.000'); await page.getByLabel('Start', { exact: true }).press('Tab'); await page.getByLabel('End', { exact: true }).fill('00:00:05.000'); await page.getByLabel('End', { exact: true }).press('Tab');
  await chooseOption(page, page.locator('#audio-track-preview'), /Audio #1.*rus/);
  await expect(page.locator('.audio-waveform .waveform-detail path')).toHaveAttribute('d', /M\d+,/);
  const { frame, aspect } = await openFrame(page); await aspect.selectOption('1:1'); await frame.locator('summary').click();
  await goToExport(page); await expect(page.getByRole('checkbox', { name: 'Delete source after export', exact: true })).toBeChecked();
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${api}/jobs`));
  await page.getByRole('button', { name: 'Cut clip', exact: true }).click(); const response = await accepted; expect(response.ok(), await response.text()).toBeTruthy();
  const submitted = response.request().postDataJSON(); expect(submitted.cleanup_source).toBe(true); expect(submitted.audio_track).toBe(1); expect(submitted.crop).toMatchObject({ width: .5625, height: 1 });
  const job = await waitJob(page.request, (await response.json()).id); expect(job.status, JSON.stringify(job)).toBe('succeeded');
  const artifact = job.items[0].artifact; const probe = await probeDownloadedFile(page.request, artifact.download_url, 'square-crop.mp4', testInfo);
  const video = probe.streams.find((stream: any) => stream.codec_type === 'video'); expect(video.width).toBe(360); expect(video.height).toBe(360); expect(video.sample_aspect_ratio).toBe('1:1');
  expect(probe.streams.filter((stream: any) => stream.codec_type === 'audio')).toHaveLength(1); expect(Math.abs(Number(probe.format.duration) - 3)).toBeLessThan(.2);
  const filename = testInfo.outputPath('square-crop.mp4'); execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', filename, '-f', 'null', '-'], { timeout: 30_000 });
  const firstFrame = (input: string, seek: string, filter: string) => execFileSync('ffmpeg', ['-v', 'error', '-ss', seek, '-i', input, '-frames:v', '1', '-vf', filter, '-f', 'rawvideo', '-'], { timeout: 15000 });
  const expectedFrame = firstFrame(process.env.CUTMY_E2E_MULTITRACK!, '2', 'crop=360:360:140:0,scale=64:64,format=gray');
  const actualFrame = firstFrame(filename, '0', 'scale=64:64,format=gray'); expect(actualFrame.length).toBe(expectedFrame.length);
  const difference = actualFrame.reduce((sum, value, index) => sum + Math.abs(value - expectedFrame[index]), 0) / actualFrame.length; expect(difference).toBeLessThan(2.5);
  const samples = execFileSync('ffmpeg', ['-v', 'error', '-ss', '.5', '-i', filename, '-map', '0:a:0', '-t', '1', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { timeout: 30_000 });
  let crossings = 0; for (let offset = 2; offset < samples.length; offset += 2) if ((samples.readInt16LE(offset - 2) < 0) !== (samples.readInt16LE(offset) < 0)) crossings++;
  expect(crossings / 2).toBeGreaterThan(430); expect(crossings / 2).toBeLessThan(450);
  await expect.poll(async () => { const sourceResponse = await page.request.get(`${api}/sources/${openedSource.id}`); expect(sourceResponse.ok()).toBeTruthy(); return (await sourceResponse.json()).media_removed; }, { timeout: 30000, intervals: [250, 500, 1000] }).toBe(true);
  const unavailablePreview = await page.request.get(`${api}/sources/${openedSource.id}/preview?start_ms=0`); expect([404, 410]).toContain(unavailablePreview.status());
  const retained = await page.request.get(artifact.download_url); expect(retained.ok()).toBeTruthy(); expect((await retained.body()).length).toBeGreaterThan(1000);
  await page.reload(); await expect(page.getByRole('link', { name: 'Download', exact: true }).first()).toBeVisible(); await goToSource(page); await expect(page.getByRole('heading', { name: 'Clips saved', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'My projects', exact: true }).click(); await expect(page.locator('.project-library')).toContainText(openedSource.title);
  // Delete only this test's source after verifying the separate cleanup contract.
  const deleted = await page.request.delete(`${api}/sources/${openedSource.id}`); expect([204, 404]).toContain(deleted.status());
});
