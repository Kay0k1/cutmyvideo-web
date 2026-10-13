import { expect, test, type Locator, type Page } from '@playwright/test';
import { readBrowserDraft } from './browserProjectStorage';
import { goToMoment, goToSource } from './helpers';

const source = {
  id: 'timeline-section-fixture', title: 'Three minute recording.mp4', kind: 'upload',
  duration_ms: 180_000, width: 640, height: 360,
  preview_kind: 'none', preview_url: null, embed_url: null, thumbnail_url: null,
};
const cut = { id: 'section-cut', label: 'Chosen moment', start_ms: 72_000, end_ms: 108_000 };

async function prepare(page: Page, saved: Record<string, unknown> = {}, duration = source.duration_ms) {
  const opened = { ...source, duration_ms: duration };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/session') return route.fulfill({ json: { authenticated: true } });
    if (path === `/api/v1/sources/${opened.id}`) return route.fulfill({ json: opened });
    if (path.endsWith('/tracks')) return route.fulfill({ json: { tracks: [] } });
    if (path === '/api/v1/sources') return route.fulfill({ json: { sources: [] } });
    if (path === '/api/v1/jobs') return route.fulfill({ json: { jobs: [] } });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Controlled timeline fixture' } } });
  });
  await page.addInitScript(({ opened, cut, saved }) => {
    // Seed once: reload must exercise the project's own saved state.
    if (localStorage.getItem('timeline-section-fixture-seeded')) return;
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify({
      workflow_version: 2, step: 2, source_id: opened.id, source_title: opened.title,
      source_duration_ms: opened.duration_ms, ranges: [cut], selected_id: cut.id,
      selected_range_ids: [cut.id], current_ms: 90_000, precision_open: true,
      simple_view: [60_000, 120_000], timeline_span: 60_000, view_center: 90_000,
      ...saved,
    }));
    localStorage.setItem('timeline-section-fixture-seeded', 'yes');
  }, { opened, cut, saved });
  await page.goto('/?lang=ru');
  await expect(page.locator('.timeline')).toBeVisible();
}

function picker(page: Page) { return page.getByRole('slider', { name: 'Участок для обрезки', exact: true }); }
function start(page: Page) { return page.getByRole('slider', { name: 'Начало фрагмента на шкале', exact: true }); }
function end(page: Page) { return page.getByRole('slider', { name: 'Конец фрагмента на шкале', exact: true }); }

async function expectSection(page: Page, section: [number, number]) {
  await expect(page.locator('.timeline')).toHaveAttribute('data-section-start', String(section[0]));
  await expect(page.locator('.timeline')).toHaveAttribute('data-section-end', String(section[1]));
}

async function expectCut(page: Page, range: [number, number]) {
  await expect(start(page)).toHaveAttribute('aria-valuenow', String(range[0]));
  await expect(end(page)).toHaveAttribute('aria-valuenow', String(range[1]));
}

async function view(page: Page): Promise<[number, number]> {
  const timeline = page.locator('.timeline');
  return [Number(await timeline.getAttribute('data-view-start')), Number(await timeline.getAttribute('data-view-end'))];
}

async function wheel(page: Page, options: { deltaX?: number; deltaY?: number; ctrlKey?: boolean }) {
  const track = page.locator('.trim-track');
  await track.scrollIntoViewIfNeeded();
  const box = (await track.boundingBox())!;
  const canceled = await track.evaluate((node, event) => !node.dispatchEvent(new WheelEvent('wheel', event)), {
    bubbles: true, cancelable: true, clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2, deltaMode: 0, ...options,
  });
  expect(canceled, 'Timeline gestures must prevent page scrolling and browser pinch zoom').toBe(true);
}

async function dragBy(page: Page, handle: Locator, movement: number) {
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Use a physical screen edge: Firefox maps positions outside its viewport
  // back to the left edge, unlike Chromium's captured-pointer behavior.
  const width = page.viewportSize()!.width;
  await page.mouse.move(Math.max(1, Math.min(width - 1, x + movement)), y, { steps: 4 });
  await page.mouse.up();
}

test('moving the chosen minute preserves the cut and undo restores both together', async ({ page }) => {
  await prepare(page);
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
  await picker(page).press('End');
  await expectSection(page, [120_000, 180_000]);
  await expectCut(page, [132_000, 168_000]);
  expect(await view(page)).toEqual([120_000, 180_000]);

  // A repeated press at the edge must not create an extra undo step.
  await picker(page).press('End');
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click();
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
  await page.getByRole('button', { name: 'Повторить изменение', exact: true }).click();
  await expectSection(page, [120_000, 180_000]);
  await expectCut(page, [132_000, 168_000]);
  await picker(page).press('Home');
  await expectSection(page, [0, 60_000]);
  await expectCut(page, [12_000, 48_000]);
  await picker(page).press('Shift+ArrowRight');
  await expectSection(page, [1000, 61_000]);
  await expectCut(page, [13_000, 49_000]);
});

test('keyboard seeking outside the section leaves the chosen minute and cut unchanged', async ({ page }) => {
  await prepare(page);
  const overview = page.locator('#overview');
  await overview.press('Home');
  await expect(overview).toHaveValue('0');
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
  await overview.press('End');
  await expect(overview).toHaveValue('180000');
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
  expect(await view(page)).toEqual([60_000, 120_000]);
  await expect(page.getByRole('button', { name: 'Отменить изменение', exact: true })).toBeDisabled();
});

test('valid exact fields outside the section reframe it without truncating the cut', async ({ page }) => {
  await prepare(page);
  await page.locator('#range-start').fill('00:00:30.125');
  await page.locator('#range-start').press('Tab');
  await expectCut(page, [30_125, 108_000]);
  const timeline = page.locator('.timeline');
  expect(Number(await timeline.getAttribute('data-section-start'))).toBeLessThanOrEqual(30_125);
  expect(Number(await timeline.getAttribute('data-section-end'))).toBeGreaterThanOrEqual(108_000);
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click();
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
});

test('invalid exact text blocks section movement and keeps the dirty entry', async ({ page }) => {
  await prepare(page);
  const field = page.locator('#range-start');
  await field.fill('not a time');
  await picker(page).press('End');
  await expect(field).toHaveValue('not a time');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#range-error')).toBeVisible();
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
  expect((await readBrowserDraft(page)).start_text).toBe('not a time');
  await expect(page.getByRole('button', { name: 'Отменить изменение', exact: true })).toBeDisabled();
});

test('a tap outside the chosen minute relocates it while preserving the cut offsets', async ({ page, isMobile }) => {
  await prepare(page);
  const track = page.locator('.timeline-section-track');
  await track.scrollIntoViewIfNeeded();
  const box = (await track.boundingBox())!;
  const x = box.x + 2, y = box.y + box.height / 2;
  if (isMobile) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await expectSection(page, [0, 60_000]);
  await expectCut(page, [12_000, 48_000]);
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click();
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
});

test('importing a distant plan into the open video reframes the section and undo restores the old one', async ({ page }) => {
  await prepare(page);
  await goToSource(page);
  await page.getByRole('button', { name: 'Мои проекты', exact: true }).click();
  const plan = { version: 1, input: source.title, ranges: [{ label: 'Distant cut', start_ms: 150_000, end_ms: 160_000 }],
    options: { format: 'mp4', quality: 'best', cut_mode: 'accurate' }, output_mode: 'separate' };
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Файл плана нарезки', { exact: true }).setInputFiles({
    name: 'distant-plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan)),
  });
  await goToMoment(page);
  await expectSection(page, [120_000, 180_000]);
  await expectCut(page, [150_000, 160_000]);
  expect(await view(page)).toEqual([120_000, 180_000]);
  await expect(start(page)).not.toHaveClass(/offscreen/);
  await expect(end(page)).not.toHaveClass(/offscreen/);
  await page.getByRole('button', { name: 'Отменить изменение', exact: true }).click();
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
});

test('lower handles stop at the chosen minute and remain separately reachable when close', async ({ page }) => {
  await prepare(page);
  await start(page).press('Home');
  await end(page).press('End');
  await expectCut(page, [60_000, 120_000]);
  await start(page).press('ArrowLeft');
  await end(page).press('ArrowRight');
  await expectCut(page, [60_000, 120_000]);
  await start(page).press('End');
  await start(page).press('ArrowRight');
  await end(page).press('Home');
  await expectCut(page, [119_900, 120_000]);
  await expect(start(page)).toHaveAttribute('aria-valuemin', '60000');
  await expect(end(page)).toHaveAttribute('aria-valuemax', '120000');
  await start(page).focus();
  await expect(start(page)).toBeFocused();
  await end(page).focus();
  await expect(end(page)).toBeFocused();

  for (const suffix of ['', ' .trim-grip']) {
    const first = (await page.locator(`.trim-handle.start${suffix}`).boundingBox())!;
    const last = (await page.locator(`.trim-handle.end${suffix}`).boundingBox())!;
    const overlapX = Math.min(first.x + first.width, last.x + last.width) - Math.max(first.x, last.x);
    const overlapY = Math.min(first.y + first.height, last.y + last.height) - Math.max(first.y, last.y);
    expect(overlapX <= 0 || overlapY <= 0, `Both ${suffix ? 'visible grips' : 'handle hit areas'} must be distinct`).toBe(true);
  }
  await start(page).press('ArrowLeft');
  await expectCut(page, [119_800, 120_000]);
  await expectSection(page, [60_000, 120_000]);
  await page.getByRole('button', { name: 'Приблизить границы', exact: true }).click();
  await expect.poll(async () => { const [a, b] = await view(page); return b - a; }).toBeLessThan(60_000);
  await expectCut(page, [119_800, 120_000]);
  await expectSection(page, [60_000, 120_000]);
});

test('dragging the minute and trim handles respects the section edges', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Touch bounds are covered by the keyboard and touch-scroll scenarios.');
  await prepare(page);
  await dragBy(page, picker(page), 2000);
  await expectSection(page, [120_000, 180_000]);
  await expectCut(page, [132_000, 168_000]);
  await dragBy(page, start(page), -2000);
  await dragBy(page, end(page), 2000);
  await expectCut(page, [120_000, 180_000]);
  await dragBy(page, start(page), 2000);
  await expectCut(page, [179_900, 180_000]);
  await expectSection(page, [120_000, 180_000]);
});

test('wheel, trackpad pinch and horizontal pan change only the lower viewport', async ({ page }) => {
  await prepare(page);
  const full = await view(page);
  await wheel(page, { deltaY: -120 });
  await expect.poll(async () => { const [a, b] = await view(page); return b - a; }).toBeLessThan(full[1] - full[0]);
  const zoomed = await view(page);
  await wheel(page, { deltaY: -60, ctrlKey: true });
  await expect.poll(async () => { const [a, b] = await view(page); return b - a; }).toBeLessThan(zoomed[1] - zoomed[0]);
  const pinched = await view(page);
  await wheel(page, { deltaX: 50, deltaY: 0 });
  await expect.poll(async () => (await view(page))[0]).toBeGreaterThan(pinched[0]);
  const panned = await view(page);
  expect(panned[1] - panned[0]).toBeCloseTo(pinched[1] - pinched[0], 0);
  expect(panned[0]).toBeGreaterThanOrEqual(60_000);
  expect(panned[1]).toBeLessThanOrEqual(120_000);
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
  await page.getByRole('button', { name: 'Показать весь участок', exact: true }).click();
  await expect.poll(() => view(page)).toEqual([60_000, 120_000]);
  await page.getByRole('button', { name: 'Приблизить шкалу', exact: true }).click();
  await expect.poll(async () => { const [a, b] = await view(page); return b - a; }).toBeLessThan(60_000);
  await page.getByRole('button', { name: 'Отдалить шкалу', exact: true }).click();
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
});

test('native Safari trackpad gestures zoom the timeline without changing the cut', async ({ page }) => {
  await prepare(page);
  const original = await view(page);
  const track = page.locator('.trim-track');
  await track.scrollIntoViewIfNeeded();
  for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 2], ['gestureend', 2]] as const) {
    const canceled = await track.evaluate((node, { type, scale }) => {
      const box = node.getBoundingClientRect();
      const gesture = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        scale, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
      });
      return !node.dispatchEvent(gesture);
    }, { type, scale });
    expect(canceled, `${type} must prevent the browser from scaling the page`).toBe(true);
  }
  await expect.poll(async () => { const [a, b] = await view(page); return b - a; }).toBeCloseTo((original[1] - original[0]) / 2, 0);
  await expectSection(page, [60_000, 120_000]);
  await expectCut(page, [72_000, 108_000]);
});

test('a real wheel zoom and far handle drags keep saved times at whole milliseconds', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The phone project verifies wheel math and real touch scrolling separately.');
  const nearCut = { ...cut, start_ms: 88_000, end_ms: 92_000 };
  await prepare(page, { ranges: [nearCut] });
  const track = page.locator('.trim-track');
  await track.scrollIntoViewIfNeeded();
  const box = (await track.boundingBox())!;
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => { const [a, b] = await view(page); return b - a; }).toBeLessThan(60_000);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  const zoomed = await view(page);
  expect(zoomed.some(value => !Number.isInteger(value)), 'Wheel zoom should exercise fractional viewport edges').toBe(true);
  await dragBy(page, start(page), -2000);
  await dragBy(page, end(page), 2000);
  const bounds = [Number(await start(page).getAttribute('aria-valuenow')), Number(await end(page).getAttribute('aria-valuenow'))];
  expect(bounds.every(Number.isSafeInteger)).toBe(true);
  expect(bounds[0]).toBe(Math.ceil(zoomed[0]));
  expect(bounds[1]).toBe(Math.floor(zoomed[1]));
  const saved = await readBrowserDraft(page);
  expect(saved.ranges[0].start_ms).toBe(bounds[0]);
  expect(saved.ranges[0].end_ms).toBe(bounds[1]);
  await page.reload();
  await expectCut(page, bounds as [number, number]);
  await expectSection(page, [60_000, 120_000]);
});

test('the selected minute and zoom survive mode changes, reload and translation', async ({ page }) => {
  await prepare(page);
  await picker(page).press('End');
  await page.getByRole('button', { name: 'Приблизить шкалу', exact: true }).click();
  const zoomed = await view(page);
  const mode = page.getByRole('button', { name: 'Точное время и шкала', exact: true });
  await mode.click();
  await mode.click();
  await expectSection(page, [120_000, 180_000]);
  await expectCut(page, [132_000, 168_000]);
  expect(await view(page)).toEqual(zoomed);
  const saved = await readBrowserDraft(page);
  expect(saved.simple_view).toEqual([120_000, 180_000]);
  await page.reload();
  await expectSection(page, [120_000, 180_000]);
  await expectCut(page, [132_000, 168_000]);
  expect(await view(page)).toEqual(zoomed);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Trim section', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom in timeline', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show entire section', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a video shorter than a minute uses its full duration without moving the cut', async ({ page }) => {
  const shortCut = { ...cut, start_ms: 2000, end_ms: 9000 };
  await prepare(page, { ranges: [shortCut], simple_view: null, timeline_span: 60_000, current_ms: 3000 }, 12_000);
  await expectSection(page, [0, 12_000]);
  await expectCut(page, [2000, 9000]);
  await picker(page).press('End');
  await picker(page).press('Home');
  await expectSection(page, [0, 12_000]);
  await expectCut(page, [2000, 9000]);
  await expect(page.getByRole('button', { name: 'Отменить изменение', exact: true })).toBeDisabled();
});

for (const section of [[-1000, 120_000], [150_000, 30_000], [0, 60_000], ['invalid', 120_000]]) {
  test(`an invalid saved section ${JSON.stringify(section)} is repaired without changing the saved cut`, async ({ page }) => {
    await prepare(page, { simple_view: section });
    await expectSection(page, [60_000, 120_000]);
    await expectCut(page, [72_000, 108_000]);
  });
}

test('a saved cut longer than one minute keeps both boundaries available', async ({ page }) => {
  const longCut = { ...cut, start_ms: 50_000, end_ms: 120_000 };
  await prepare(page, { ranges: [longCut], simple_view: [60_000, 120_000] });
  await expectCut(page, [50_000, 120_000]);
  const timeline = page.locator('.timeline');
  expect(Number(await timeline.getAttribute('data-section-start'))).toBeLessThanOrEqual(50_000);
  expect(Number(await timeline.getAttribute('data-section-end'))).toBeGreaterThanOrEqual(120_000);
  await page.getByRole('button', { name: 'Показать весь участок', exact: true }).click();
  await expect(start(page)).not.toHaveClass(/offscreen/);
  await expect(end(page)).not.toHaveClass(/offscreen/);
});

test('real phone drags move the minute with its cut and stop the trim handles at its edges', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Uses the phone project\'s actual touch input.');
  await prepare(page);
  const session = await page.context().newCDPSession(page);
  const touchDrag = async (handle: Locator, right: boolean) => {
    await handle.scrollIntoViewIfNeeded();
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const target = right ? page.viewportSize()!.width - 1 : 1;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const fraction of [.2, .4, .6, .8, 1]) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (target - x) * fraction, y }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await touchDrag(picker(page), true);
  await expectSection(page, [120_000, 180_000]);
  await expectCut(page, [132_000, 168_000]);
  await touchDrag(start(page), false);
  await touchDrag(end(page), true);
  await expectCut(page, [120_000, 180_000]);
  await expectSection(page, [120_000, 180_000]);
  await session.detach();
});

test('a vertical touch gesture over the lower timeline scrolls without moving the cut', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Uses the real Chromium touch event stream on the phone project.');
  await prepare(page);
  const track = page.locator('.track-scrubber');
  await track.scrollIntoViewIfNeeded();
  const box = (await track.boundingBox())!;
  const before = await readBrowserDraft(page);
  const session = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const delta of [10, 25, 40, 60]) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - delta }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await expectCut(page, [72_000, 108_000]);
  await expectSection(page, [60_000, 120_000]);
  expect((await readBrowserDraft(page)).current_ms).toBe(before.current_ms);
});
