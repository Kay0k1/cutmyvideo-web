import { readBrowserProject } from './browserProjectStorage';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { goToClips, showExactTimes, stepButton } from './helpers';

const source = { id: 'efficient-source', title: 'Long recording.mp4', duration_ms: 3600000, width: 640, height: 360, kind: 'upload', preview_kind: 'native', preview_url: '/efficient-source.mp4', embed_url: null, thumbnail_url: null };
const cuts = [{ id: 'later', label: 'Later', start_ms: 8000, end_ms: 8500 }, { id: 'excluded', label: 'Excluded', start_ms: 5000, end_ms: 5500 }, { id: 'earlier', label: 'Earlier', start_ms: 1000, end_ms: 1500 }];
async function prepare(page: Page, saved: Record<string, unknown> = {}, beforeOpen?: () => Promise<void>) {
  const media = await readFile(process.env.CUTMY_E2E_MEDIA!);
  const previewQueries: URL[] = [];
  await page.route('**/efficient-source.mp4', route => route.fulfill({ contentType: 'video/mp4', body: media }));
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith('/session')) return route.fulfill({ json: { ok: true, limits: { max_ranges: 32 } } });
    if (path.endsWith('/tracks')) return route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac' }, { index: 2, type: 'audio', codec: 'aac', default: true }] } });
    if (path.endsWith('/preview')) { previewQueries.push(url); return route.fulfill({ contentType: 'video/mp4', body: media, headers: { 'X-Source-Display-Width': '640', 'X-Source-Display-Height': '360' } }); }
    if (path === `/api/v1/sources/${source.id}`) return route.fulfill({ json: source });
    if (path === '/api/v1/sources') return route.fulfill({ json: { sources: [source] } });
    if (path === '/api/v1/jobs') return route.fulfill({ json: { jobs: [] } });
    return route.fulfill({ status: 404, json: { error: { code: 'preview_unavailable', message: 'Controlled preview fixture' } } });
  });
  await beforeOpen?.();
  await page.addInitScript(({ source, cuts, saved }) => {
    if (localStorage.getItem('efficient-seeded')) return;
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, source_id: source.id, source_title: source.title, source_duration_ms: source.duration_ms, ranges: cuts, selected_id: cuts[0].id, selected_range_ids: cuts.map(range => range.id), output: { format: 'mp4', quality: '720p', cut_mode: 'accurate' }, step: 2, ...saved }));
    localStorage.setItem('efficient-seeded', 'yes');
  }, { source, cuts, saved });
  await page.goto('/'); await expect(stepButton(page, saved.step === 4 ? 4 : 2)).toHaveAttribute('aria-current', 'step');
  return { previewQueries };
}

for (const count of [2, 10, 20]) test(`create ${count} cuts without leaving the player and undo one add`, async ({ page }) => {
  await prepare(page, { ranges: [cuts[0]], selected_range_ids: [cuts[0].id] });
  const next = page.getByRole('button', { name: 'Сохранить и добавить следующий', exact: true });
  for (let index = 1; index < count; index++) {
    await next.click();
    await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step');
    await expect(page.locator('.moment-clip-navigation')).toContainText(`из ${index + 1}.`);
  }
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click();
  await expect(page.locator('.moment-clip-navigation')).toContainText(`из ${count - 1}.`);
  await page.getByRole('button', { name: 'Повторить изменение', exact: true }).click();
  await expect(page.locator('.moment-clip-navigation')).toContainText(`из ${count}.`);
  await goToClips(page); await expect(page.locator('.clip-list > li')).toHaveCount(count);
  await expect(page.getByRole('checkbox', { name: /^Выбрать фрагмент / }).filter({ visible: true })).toHaveCount(count);
  for (const checkbox of await page.getByRole('checkbox', { name: /^Выбрать фрагмент / }).all()) await expect(checkbox).toBeChecked();
});

test('safe shortcuts and switching clips seek to their start', async ({ page }) => {
  await prepare(page);
  const video = page.locator('video'); await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Следующий фрагмент', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(5, 1);
  await page.locator('h1').focus(); await page.keyboard.press('BracketRight');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(1, 1);
  await showExactTimes(page); await page.locator('#range-start').focus(); await page.keyboard.press('KeyN');
  await expect(page.locator('.moment-clip-navigation')).toContainText('из 3.');
  await page.keyboard.press('Escape'); await page.locator('h1').focus(); await page.keyboard.press('KeyN');
  await expect(page.locator('.moment-clip-navigation')).toContainText('из 4.');
});

test('draft playback follows reordered selected cuts and stops without exporting', async ({ page }) => {
  await prepare(page, { selected_range_ids: ['later', 'earlier'] });
  const video = page.locator('video'); await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await goToClips(page); await page.getByRole('button', { name: 'Переместить фрагмент 3 вверх', exact: true }).click();
  await page.getByRole('button', { name: 'Посмотреть подборку', exact: true }).click();
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('.sequence-preview')).toContainText('Сейчас: Later');
  await expect(page.locator('.sequence-preview')).toContainText('Сейчас: Earlier');
  await expect(page.getByRole('button', { name: 'Остановить подборку', exact: true })).toHaveCount(0);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(1.5, 1);
  await page.getByRole('button', { name: 'Посмотреть подборку', exact: true }).click();
  await page.getByRole('button', { name: 'Остановить подборку', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).paused)).toBe(true);
});

test('a released or nudged boundary shows its new position', async ({ page }) => {
  await prepare(page, { ranges: [cuts[2]], selected_id: cuts[2].id, selected_range_ids: [cuts[2].id], precision_open: true });
  const video = page.locator('video'); await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Начало на 0,1 с позже', exact: true }).click();
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(1.1, 1);
  const handle = page.getByRole('slider', { name: 'Конец фрагмента на шкале', exact: true });
  await handle.focus(); await handle.press('ArrowRight');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(1.6, 1);
  const box = await handle.boundingBox(); expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down(); await page.mouse.move(box!.x + box!.width / 2 + 8, box!.y + box!.height / 2, { steps: 3 }); await page.mouse.up();
  const milliseconds = Number(await handle.getAttribute('aria-valuenow'));
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).currentTime)).toBeCloseTo(milliseconds / 1000, 1);
});

test('phone controls fit 320 and 360 pixels and retain the compact frame disclosure', async ({ page }, testInfo) => {
  await prepare(page);
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 780 });
    const next = page.getByRole('button', { name: 'Сохранить и добавить следующий', exact: true }); await next.scrollIntoViewIfNeeded();
    await expect(next).toBeVisible();
    const box = await next.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeLessThanOrEqual(width);
    const frame = await page.locator('.player-frame').boundingBox(); expect(frame).toBeTruthy();
    for (const name of ['Начало по позиции плеера', 'Конец по позиции плеера']) {
      const marker = page.getByRole('button', { name, exact: true }); await expect(marker).toHaveCount(1);
      const bounds = await marker.boundingBox(); expect(bounds).toBeTruthy(); expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.y - (frame!.y + frame!.height)).toBeLessThanOrEqual(100);
      await expect(marker.locator('kbd')).toHaveText(name.startsWith('Начало') ? 'I' : 'O');
    }
    await expect(page.getByRole('heading', { name: 'Нарежьте видео', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.locator('.crop-editor')).not.toHaveAttribute('open');
    await page.screenshot({ path: testInfo.outputPath(`moment-${width}.png`), fullPage: true });
  }
});

for (const loseResponse of [false, true]) test(`selective retry retains earlier files and recovers after source cleanup${loseResponse ? ' with a lost response' : ''}`, async ({ page }) => {
  const artifact = (id: string, index: number) => ({ id, filename: `${cuts[index].label}.mp4`, download_url: `/ready-${id}.mp4`, size_bytes: 100, actual_start_ms: cuts[index].start_ms, actual_end_ms: cuts[index].end_ms });
  const failed = { id: 'failed-job', status: 'failed', stage: 'failed', message: '', items: cuts.map((cut, index) => ({ ...cut, id: `item-${index}`, status: index === 0 ? 'succeeded' : index === 1 ? 'failed' : 'cancelled', artifact: index === 0 ? artifact('ready-original', index) : null })) };
  let removed = false, accepted = false;
  let releasePost: () => void = () => {};
  const heldPost = new Promise<void>(resolve => { releasePost = resolve; });
  const requests: { key: string; body: Record<string, any> }[] = [];
  const succeeded = { id: 'retry-job', status: 'succeeded', stage: 'finished', message: '', items: cuts.slice(1).map((cut, index) => ({ ...cut, id: `retry-item-${index}`, status: 'succeeded', artifact: artifact(`retry-${index}`, index + 1) })) };
  await prepare(page, { job_id: 'failed-job', job_range_numbers: [1, 2, 3], job_ranges: cuts, step: 4 }, async () => {
  await page.route('**/api/v1/jobs/failed-job', route => route.fulfill({ json: failed }));
  await page.route('**/api/v1/jobs/retry-job', route => route.fulfill({ json: succeeded }));
  await page.route(`**/api/v1/sources/${source.id}`, route => route.fulfill({ json: { ...source, media_removed: removed } }));
  await page.route('**/api/v1/jobs', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { jobs: [] } });
    requests.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    if (!accepted) { accepted = true; removed = true; if (loseResponse) { await heldPost; return route.abort('failed'); } }
    return route.fulfill({ json: succeeded });
  });
  });
  await expect(page.getByRole('button', { name: 'Повторить неудавшиеся', exact: true })).toBeVisible();
  await goToClips(page);
  await page.getByRole('button', { name: 'Переместить фрагмент 3 вверх', exact: true }).click();
  await page.getByRole('button', { name: 'Переместить фрагмент 2 вверх', exact: true }).click();
  await stepButton(page, 4).click();
  await page.getByRole('button', { name: 'Повторить неудавшиеся', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].body.ranges).toEqual(cuts.slice(1).map(({ label, start_ms, end_ms }) => ({ label, start_ms, end_ms })));
  expect(requests[0].body.cleanup_source).toBe(true);
  if (loseResponse) {
    await expect(stepButton(page, 1)).toBeDisabled(); await expect(stepButton(page, 3)).toBeDisabled();
    releasePost();
    await expect(page.locator('.error-message')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Повторить экспорт', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Повторить экспорт', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2); expect(requests[1]).toEqual(requests[0]);
  }
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(3);
  await expect(page.locator('.file-list h3')).toHaveText(['Later', 'Excluded', 'Earlier']);
  const all = page.getByRole('link', { name: 'Скачать всё ZIP', exact: true });
  await expect(all).toHaveAttribute('href', '/api/v1/jobs/retry-job/download.zip?artifact_id=ready-original&artifact_id=retry-0&artifact_id=retry-1');
  await page.reload(); await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(3); await expect(all).toBeVisible();
  await stepButton(page, 1).click();
  await page.getByRole('button', { name: 'Мои проекты', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть проект «Long recording.mp4»', exact: true }).click();
  await expect(stepButton(page, 4)).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(3);
  await expect(all).toHaveAttribute('href', '/api/v1/jobs/retry-job/download.zip?artifact_id=ready-original&artifact_id=retry-0&artifact_id=retry-1');
});

for (const sound of ['selected', 'silent'] as const) test(`selection preview retains global framing and ${sound} audio settings`, async ({ page }, testInfo) => {
  const { previewQueries } = await prepare(page, { ranges: [{ ...cuts[2], end_ms: 3500 }, { ...cuts[0], start_ms: 6500, end_ms: 9500 }], selected_id: 'earlier', selected_range_ids: ['earlier', 'later'], output: { format: 'mp4', quality: '720p', cut_mode: 'accurate', crop: { x: .21875, y: 0, width: .5625, height: 1 }, ...(sound === 'selected' ? { audio_track: 1 } : { no_audio: true }) } });
  await expect(page.getByRole('button', { name: 'Посмотреть подборку', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Посмотреть подборку', exact: true }).click();
  const mask = page.locator('.draft-crop-preview'); await expect(mask).toBeVisible();
  const ratio = await mask.evaluate(node => node.querySelector('span')!.getBoundingClientRect().width / node.getBoundingClientRect().width);
  expect(ratio).toBeCloseTo(.5625, 3);
  await expect.poll(() => previewQueries.some(url => sound === 'selected' ? url.searchParams.get('audio_track') === '1' && !url.searchParams.has('no_audio') : url.searchParams.get('no_audio') === 'true')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`selection-crop-${sound}.png`), fullPage: true });
  await page.getByRole('button', { name: 'Остановить подборку', exact: true }).click(); await expect(mask).toHaveCount(0);
});

test('retrying a joined result keeps its original selected cuts and request order', async ({ page }) => {
  let submitted: Record<string, any> | undefined;
  await prepare(page, { step: 4, job_id: 'joined-failed', job_output_mode: 'joined', job_ranges: [cuts[0], cuts[2]], selected_range_ids: cuts.map(range => range.id), output: { format: 'mp4', quality: '720p', cut_mode: 'accurate', output_mode: 'joined' } }, async () => {
    await page.route('**/api/v1/jobs/joined-failed', route => route.fulfill({ json: { id: 'joined-failed', status: 'failed', stage: 'failed', message: '', items: [{ id: 'joined-item', start_ms: 0, end_ms: 1000, label: 'Joined result', status: 'failed', artifact: null }] } }));
    await page.route('**/api/v1/jobs', route => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: { jobs: [] } });
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: { id: 'joined-retry', status: 'queued', stage: 'queued', message: '', items: [{ id: 'joined-new', start_ms: 0, end_ms: 1000, label: 'Joined result', status: 'queued', artifact: null }] } });
    });
  });
  await page.getByRole('button', { name: 'Повторить объединение', exact: true }).click();
  await expect.poll(() => submitted).toBeTruthy();
  expect(submitted!.ranges).toEqual([cuts[0], cuts[2]].map(({ label, start_ms, end_ms }) => ({ label, start_ms, end_ms })));
  expect(submitted!.output_mode).toBe('joined');
});

test('delayed YouTube seeks cannot skip a backward cut in the selection', async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { times: [] as number[], targets: [] as number[] };
    class DelayedPlayer {
      time = 0; playing = false; frame: HTMLIFrameElement; timers: number[] = [];
      constructor(element: HTMLElement, options: { events: { onReady(event: { target: DelayedPlayer }): void } }) {
        this.frame = document.createElement('iframe'); this.frame.src = 'about:blank'; element.replaceWith(this.frame);
        queueMicrotask(() => options.events.onReady({ target: this }));
      }
      seekTo(seconds: number) { probe.targets.push(seconds); this.timers.push(window.setTimeout(() => { this.time = seconds; }, 300)); }
      playVideo() { this.playing = true; }
      pauseVideo() { this.playing = false; }
      getPlayerState() { return this.playing ? 1 : 2; }
      getCurrentTime() { if (this.playing) this.time += .15; probe.times.push(this.time); return this.time; }
      destroy() { this.timers.forEach(window.clearTimeout); this.frame.remove(); }
    }
    Object.assign(window, { YT: { Player: DelayedPlayer }, __sequenceProbe: probe });
  });
  await prepare(page, { selected_range_ids: ['later', 'earlier'] }, async () => {
    await page.route(`**/api/v1/sources/${source.id}`, route => route.fulfill({ json: { ...source, kind: 'youtube', preview_url: null, embed_url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ' } }));
    await page.route('**/tracks', route => route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac', default: true }] } }));
  });
  await page.getByRole('button', { name: 'Посмотреть подборку', exact: true }).click();
  await expect(page.locator('.sequence-preview')).toContainText('Сейчас: Earlier');
  await expect(page.getByRole('button', { name: 'Остановить подборку', exact: true })).toHaveCount(0);
  const times = await page.evaluate(() => (window as unknown as { __sequenceProbe: { times: number[] } }).__sequenceProbe.times);
  expect(times.filter(value => value >= 1 && value <= 1.5).length).toBeGreaterThanOrEqual(2);
});

test('a cropped embed keeps its server preview when the frame controls close', async ({ page }) => {
  await prepare(page, { output: { format: 'mp4', quality: '720p', cut_mode: 'accurate', crop: { x: .21875, y: 0, width: .5625, height: 1 } } }, async () => {
    await page.route(`**/api/v1/sources/${source.id}`, route => route.fulfill({ json: { ...source, kind: 'youtube', preview_url: null, embed_url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ' } }));
    await page.route('**/tracks', route => route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac', default: true }] } }));
  });
  await expect(page.locator('video')).toBeVisible();
  await page.locator('.crop-editor summary').click(); await page.locator('.crop-editor summary').click();
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: 'Посмотреть подборку', exact: true }).click();
  await expect(page.locator('.draft-crop-preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Остановить подборку', exact: true })).toBeVisible();
});

test('save-next at the end preserves cuts and history until another moment is chosen', async ({ page }) => {
  await prepare(page, { ranges: [{ ...cuts[0], end_ms: 12000 }], selected_id: 'later', selected_range_ids: ['later'], current_ms: 8000 }, async () => {
    await page.route(`**/api/v1/sources/${source.id}`, route => route.fulfill({ json: { ...source, duration_ms: 12000 } }));
  });
  await expect(page.locator('.window-player-seek input')).toHaveValue('8000');
  await page.getByRole('button', { name: 'Сохранить и добавить следующий', exact: true }).click();
  await expect(page.locator('.moment-clip-navigation')).toContainText('из 1.');
  await expect(page.getByRole('button', { name: 'Отменить изменение', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Видео закончилось.');
  await page.locator('.window-player-seek input').focus(); await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Сохранить и добавить следующий', exact: true }).click();
  await expect(page.locator('.moment-clip-navigation')).toContainText('из 2.');
});

test('save-next preserves an existing excluded clip while including the new one', async ({ page }) => {
  await prepare(page, { selected_id: 'excluded', selected_range_ids: ['later', 'earlier'] });
  await page.getByRole('button', { name: 'Сохранить и добавить следующий', exact: true }).click(); await goToClips(page);
  await expect(page.getByRole('checkbox', { name: 'Выбрать фрагмент 2', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Выбрать фрагмент 4', exact: true })).toBeChecked();
});

for (const playhead of [0, 3000, 12000]) test(`library add opens an editable cut from a full-length selection at playhead ${playhead}`, async ({ page }) => {
  await prepare(page, { ranges: [{ ...cuts[0], start_ms: 0, end_ms: 12000 }], selected_id: 'later', selected_range_ids: ['later'], current_ms: playhead }, async () => {
    await page.route(`**/api/v1/sources/${source.id}`, route => route.fulfill({ json: { ...source, duration_ms: 12000 } }));
  });
  await goToClips(page);
  await page.getByRole('button', { name: 'Добавить фрагмент', exact: true }).click();
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('.moment-clip-navigation')).toContainText('Фрагмент 2 из 2.');
  await showExactTimes(page);
  // At the exact source end, choose a usable default interval ending there.
  await expect(page.locator('#range-start')).toHaveValue(playhead === 3000 ? '00:00:03.000' : '00:00:00.000');
  await expect(page.locator('#range-end')).toHaveValue('00:00:12.000');
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click();
  await expect(page.locator('.moment-clip-navigation')).toContainText('Фрагмент 1 из 1.');
  await page.getByRole('button', { name: 'Повторить изменение', exact: true }).click();
  await goToClips(page); await expect(page.locator('.clip-list > li')).toHaveCount(2);
  await expect(page.getByRole('checkbox', { name: 'Выбрать фрагмент 2', exact: true })).toBeChecked();
});

for (const savedPosition of [3000, 8000]) test(`restored playhead ${savedPosition} survives delayed native seek acknowledgment and audio preview handoff`, async ({ page }) => {
  const media = await readFile(process.env.CUTMY_E2E_MEDIA!);
  let releaseTracks!: () => void, releaseMetadata!: () => void;
  const tracksReady = new Promise<void>(resolve => { releaseTracks = resolve; });
  const metadataReady = new Promise<void>(resolve => { releaseMetadata = resolve; });
  try {
    await prepare(page, { ranges: [{ ...cuts[0], start_ms: 0, end_ms: 12000 }], selected_id: 'later', selected_range_ids: ['later'], current_ms: savedPosition, precision_open: true }, async () => {
      await page.route(`**/api/v1/sources/${source.id}`, route => route.fulfill({ json: { ...source, duration_ms: 12000 } }));
      await page.route('**/tracks', async route => {
        await tracksReady;
        await route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac' }, { index: 2, type: 'audio', codec: 'aac', default: true }] } }).catch(() => {});
      });
      await page.route('**/efficient-source.mp4', async route => {
        await metadataReady;
        await route.fulfill({ contentType: 'video/mp4', body: media }).catch(() => {});
      });
    });
    const native = page.locator('.player-frame > video');
    await native.evaluate(node => {
      // Model a requested seek whose clock is not yet acknowledged. Install
      // this before metadata; WindowPlayer's later blob node remains untouched.
      Object.defineProperty(node, 'currentTime', { configurable: true, get: () => 0, set: value => { (node as HTMLVideoElement & { requestedSeek?: number }).requestedSeek = value; } });
    });
    releaseMetadata();
    await expect.poll(() => native.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => native.evaluate(node => (node as HTMLVideoElement & { requestedSeek?: number }).requestedSeek)).toBe(savedPosition / 1000);
    expect(await native.evaluate(node => (node as HTMLVideoElement).currentTime)).toBe(0);
    expect(await native.evaluate(node => (node as HTMLVideoElement).seeking)).toBe(false);
    // App has sent and consumed its restore command. The native stale zero
    // must not replace the requested position before the audio mode changes.
    await native.evaluate(node => {
      Object.defineProperty(node, 'seeking', { configurable: true, value: true });
      node.dispatchEvent(new Event('seeking'));
      Object.defineProperty(node, 'seeking', { configurable: true, value: false });
    });
    await native.evaluate(node => node.dispatchEvent(new Event('timeupdate')));
    await expect(page.locator('#overview')).toHaveValue(String(savedPosition));
    releaseTracks();
    const windowSeek = page.locator('.window-player-seek input');
    await expect(windowSeek).toHaveValue(String(savedPosition));
    await expect.poll(() => page.locator('.window-player video').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await expect(windowSeek).toHaveValue(String(savedPosition));
    await expect(page.locator('#overview')).toHaveValue(String(savedPosition));
    await goToClips(page); await page.getByRole('button', { name: 'Добавить фрагмент', exact: true }).click();
    await expect(page.locator('#range-start')).toHaveValue(savedPosition === 3000 ? '00:00:03.000' : '00:00:08.000');
  } finally { releaseTracks(); releaseMetadata(); }
});

for (const failure of ['slow', 'temporary', 'expired'] as const) test(`saved prior files survive ${failure} metadata reads according to their availability`, async ({ page }) => {
  const file = (id: string, index: number) => ({ id, filename: `${cuts[index].label}.mp4`, download_url: `/retained-${id}.mp4`, size_bytes: 100, actual_start_ms: cuts[index].start_ms, actual_end_ms: cuts[index].end_ms });
  const previous = { id: 'prior-ready', status: 'failed', stage: 'failed', message: '', items: [{ ...cuts[0], id: 'old-ready-item', status: 'succeeded', artifact: file('old-ready', 0) }, { ...cuts[2], id: 'old-failed-item', status: 'failed', artifact: null }] };
  const latest = { id: 'latest-ready', status: 'succeeded', stage: 'finished', message: '', items: [{ ...cuts[2], id: 'new-ready-item', status: 'succeeded', artifact: file('new-ready', 2) }] };
  let reads = 0, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    await prepare(page, { step: 4, job_id: latest.id, job_ranges: [cuts[2]], job_range_numbers: [3], selected_range_ids: [cuts[0].id, cuts[2].id], prior_job_ids: [previous.id], prior_job_range_numbers: { [previous.id]: [1, 3] } }, async () => {
      await page.route(`**/api/v1/sources/${source.id}`, route => route.fulfill({ json: { ...source, media_removed: true } }));
      await page.route(`**/api/v1/jobs/${latest.id}`, route => route.fulfill({ json: latest }));
      await page.route(`**/api/v1/jobs/${previous.id}`, async route => {
        reads++;
        if (reads === 1) {
          if (failure === 'slow') await blocked;
          if (failure === 'temporary') return route.fulfill({ status: 503, json: { error: { code: 'database_unavailable', message: 'Transient metadata failure' } } });
          if (failure === 'expired') return route.fulfill({ status: 410, json: { error: { code: 'expired', message: 'Expired job' } } });
        }
        await route.fulfill({ json: previous }).catch(() => {});
      });
    });
    await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(1);
    // The changed cleanup state proves an actual autosave completed while the
    // earlier job details were pending/unavailable, rather than reading the seed.
    await expect.poll(async () => (await readBrowserProject(page, source.id)).media_unavailable).toBe(true);
    await expect.poll(async () => (await readBrowserProject(page, source.id)).prior_job_ids).toEqual(failure === 'expired' ? [] : [previous.id]);
    await page.reload();
    if (failure === 'expired') {
      await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(1);
      expect(reads).toBe(1);
    } else {
      await expect.poll(() => reads).toBe(2);
      await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(2);
      await expect(page.locator('.file-list h3')).toHaveText(['Later', 'Earlier']);
      await expect(page.getByRole('link', { name: 'Скачать всё ZIP', exact: true })).toHaveAttribute('href', '/api/v1/jobs/latest-ready/download.zip?artifact_id=old-ready&artifact_id=new-ready');
      expect((await readBrowserProject(page, source.id)).prior_job_ids).toEqual([previous.id]);
    }
  } finally { release(); }
});
