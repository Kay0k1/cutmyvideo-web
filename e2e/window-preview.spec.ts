import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const source = { id: 'window-compat', title: 'Window.mkv', duration_ms: 90_000, width: 640, height: 360, kind: 'upload', preview_kind: 'window', preview_url: null, embed_url: null, thumbnail_url: null };

async function windowSource(page: Page, legacy: boolean) {
  const media = await readFile(process.env.CUTMY_E2E_MEDIA!);
  const foreground: number[] = [];
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith('/preview')) {
      const requested = Number(url.searchParams.get('start_ms'));
      const length = legacy ? 30_000 : Number(url.searchParams.get('window_ms') || 30_000);
      const start = Math.floor(requested / length) * length;
      if (!url.searchParams.has('priority')) foreground.push(requested);
      // Make the earlier distant seek finish late enough to expose stale clocks.
      if (start === 36_000) await new Promise(resolve => setTimeout(resolve, 250));
      await route.fulfill({ contentType: 'video/mp4', headers: { 'X-Preview-Start-MS': String(start), 'X-Preview-End-MS': String(Math.min(source.duration_ms, start + length)) }, body: media }).catch(() => {});
    } else if (path.endsWith('/session')) await route.fulfill({ json: { authenticated: true, limits: { max_ranges: 32 } } });
    else if (path.endsWith('/tracks')) await route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac', default: true }] } });
    else if (path.endsWith('/waveform')) await route.fulfill({ status: 429, json: { error: { code: 'server_busy', message: 'Busy' } } });
    else if (path.endsWith('/storyboard')) await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'No frames' } } });
    else if (path === `/api/v1/sources/${source.id}`) await route.fulfill({ json: source });
    else await route.fulfill({ json: { items: path.endsWith('/sources') ? [source] : [] } });
  });
  await page.addInitScript(source => {
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, source_id: source.id, source_title: source.title, source_duration_ms: source.duration_ms, step: 2, current_ms: 0,
      ranges: [{ id: 'window-cut', label: 'Cut', start_ms: 1000, end_ms: 2000 }], selected_id: 'window-cut', selected_range_ids: ['window-cut'] }));
  }, source);
  await page.goto('/?lang=en');
  await expect.poll(() => page.locator('.window-player video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  return foreground;
}

async function seekWindow(page: Page, target: number) {
  await page.locator('.window-player-navigation input[type=range]').evaluate((slider: HTMLInputElement, target) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, String(target));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }, target);
}

test('preview uses authoritative source-time headers with an older thirty-second server', async ({ page }) => {
  await windowSource(page, true);
  await seekWindow(page, 37_000);
  await expect.poll(() => page.locator('.window-player video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(7, 1);
  await expect(page.locator('.window-player-navigation input')).toHaveValue('37000');
  await expect(page.getByText('Could not load this part of the video.', { exact: true })).toHaveCount(0);
});

test('rapid distant seeks keep the last target and reuse its cached preview', async ({ page }) => {
  const foreground = await windowSource(page, false);
  await seekWindow(page, 37_000);
  await expect.poll(() => foreground.includes(36_000)).toBe(true);
  await seekWindow(page, 70_000);
  await expect.poll(() => page.locator('.window-player video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(4, 1);
  await expect(page.locator('.window-player-navigation input')).toHaveValue('70000');
  const requests = foreground.length;
  await seekWindow(page, 71_000);
  await expect.poll(() => page.locator('.window-player video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(5, 1);
  await expect(page.locator('.window-player-navigation input')).toHaveValue('71000');
  expect(foreground.length).toBe(requests);
});
