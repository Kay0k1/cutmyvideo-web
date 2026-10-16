import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { api, assertFirstFrameMatchesSource, showExactTimes, showEditorTools, closeEditorTools, goToSource, goToMoment, uploadThroughUI, waitJob } from './helpers'
import { diagnoseNativePreview } from './nativeDiagnostics'

const desktopSizes = [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]

async function readyWorkspace(page: Page) {
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect.poll(() => page.locator('video').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

async function fullyInViewport(control: Locator, description: string) {
  await expect(control, description).toBeVisible()
  const box = await control.evaluate(node => {
    const rect = node.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, viewportWidth: innerWidth, viewportHeight: innerHeight }
  })
  expect(box.top, `${description}: top`).toBeGreaterThanOrEqual(-1)
  expect(box.bottom, `${description}: bottom`).toBeLessThanOrEqual(box.viewportHeight + 1)
  expect(box.left, `${description}: left`).toBeGreaterThanOrEqual(-1)
  expect(box.right, `${description}: right`).toBeLessThanOrEqual(box.viewportWidth + 1)
}

async function workspaceFits(page: Page, collection = '.clip-library') {
  for (const [selector, description] of [
    ['video', 'Native player'], ['.trim-track', 'Timeline'],
    ['.trim-handle.start', 'Start handle'], ['.trim-handle.end', 'End handle'],
    [collection, 'Clip collection or ready files'], ['.export-submit', 'Export button'],
  ]) {
    // Short windows can scroll. The player keeps a usable size and every
    // action must be reachable without a clipped or locked document.
    const control = page.locator(selector)
    await control.scrollIntoViewIfNeeded()
    const height = await control.evaluate(node => node.getBoundingClientRect().height)
    if (height <= page.viewportSize()!.height) await fullyInViewport(control, description)
    else await expect(control, description).toBeVisible()
  }
  const documentSize = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth, viewportHeight: innerHeight, scrollX, scrollY,
  }))
  expect(documentSize.width, 'No horizontal page overflow').toBeLessThanOrEqual(documentSize.viewportWidth + 1)
  expect(documentSize.scrollX).toBe(0)
  const frame = await page.locator('.player-frame').boundingBox()
  expect(frame).not.toBeNull()
  expect(frame!.height, 'A short window must not squash the video into a strip').toBeGreaterThanOrEqual(Math.min(frame!.width * 9 / 16, documentSize.viewportHeight * .42, 240) - 1)
}

for (const language of ['ru', 'en']) {
  test(`fresh ${language} source screen stays reachable with Safari tab chrome`, async ({ page }) => {
    await page.route('**/api/v1/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith('/session') ? { authenticated: true, limits: { max_source_bytes: 1073741824 } } : { sources: [], jobs: [] } });
    });
    await page.goto(`/?lang=${language}`);
    await expect(page.locator('main')).toHaveAttribute('data-bootstrap-state', 'ready');
    for (const height of [800, 762, 620, 582, 540, 500]) {
      await page.setViewportSize({ width: 1280, height });
      for (const mode of ['link', 'file']) {
        await page.locator('.source-choice button').nth(mode === 'link' ? 0 : 1).click();
        await page.locator(mode === 'link' ? '.source-open' : '.upload-button').scrollIntoViewIfNeeded();
        await fullyInViewport(page.locator(mode === 'link' ? '.source-open' : '.upload-button'), 'Open/upload action');
        await page.locator('.page-footer').scrollIntoViewIfNeeded();
        await fullyInViewport(page.locator('.page-footer'), 'Footer');
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 'Source screen has no horizontal overflow').toBeLessThanOrEqual(1);
        await page.locator('.source-chooser').hover(); await page.mouse.wheel(0, 500);
      }
    }
    await page.locator('.project-library > button').click();
    await expect(page.locator('.project-library > button')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.project-library button').last().scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 390, height: 600 });
    await expect.poll(() => page.locator('.app-shell').evaluate(node => getComputedStyle(node).position)).not.toBe('fixed');
    await page.locator('.upload-button').scrollIntoViewIfNeeded();
    await fullyInViewport(page.locator('.upload-button'), 'Phone upload action');
  });
}

for (const orientation of ['landscape', 'portrait']) {
  test(`${orientation} workspace remains reachable below Safari toolbar breakpoints`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    let media = process.env.CUTMY_E2E_MEDIA!
    if (orientation === 'portrait') {
      media = testInfo.outputPath('short-window-portrait.mp4')
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', process.env.CUTMY_E2E_MEDIA!,
        '-vf', 'transpose=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', media], { timeout: 30_000 })
    }
    const bytes = await readFile(media)
    const source = { id: 'short_window_source', title: 'Safari window.mp4', kind: 'upload', duration_ms: 12000,
      width: orientation === 'portrait' ? 360 : 640, height: orientation === 'portrait' ? 640 : 360,
      preview_kind: 'file', preview_url: '/short-window.mp4', thumbnail_url: null, embed_url: null }
    const ranges = Array.from({ length: 12 }, (_, index) => ({ id: `short_clip_${index}`, label: `Clip ${index + 1}`, start_ms: 1000, end_ms: 5000 }))
    const job = { id: 'short_window_job', status: 'succeeded', stage: 'finished', message: '', items: ranges.map((range, index) => ({
      id: `short_item_${index}`, label: range.label, start_ms: range.start_ms, end_ms: range.end_ms, status: 'succeeded',
      artifact: { id: `short_artifact_${index}`, filename: `${range.label}.mp4`, size_bytes: bytes.length, download_url: '/short-window.mp4', actual_start_ms: range.start_ms, actual_end_ms: range.end_ms },
    })) }
    await page.route('**/short-window.mp4', route => route.fulfill({ contentType: 'video/mp4', body: bytes }))
    await page.route('**/api/v1/**', route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/session')) return route.fulfill({ json: { ok: true } })
      if (path.endsWith('/tracks')) return route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac' }] } })
      if (path === `${api}/sources/${source.id}`) return route.fulfill({ json: source })
      if (path === `${api}/sources`) return route.fulfill({ json: { sources: [source] } })
      if ((path === `${api}/jobs` && route.request().method() === 'POST') || path === `${api}/jobs/${job.id}`) return route.fulfill({ json: job })
      if (path === `${api}/jobs`) return route.fulfill({ json: { jobs: [] } })
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Fixture not available' } } })
    })
    await page.addInitScript(({ source, ranges }) => localStorage.setItem('cutmy.workbench.v1', JSON.stringify({
      workflow_version: 2, step: 2, source_id: source.id, ranges, selected_id: ranges[0].id,
      selected_range_ids: ranges.map(range => range.id), output: { format: 'mp4', quality: 'best', cut_mode: 'accurate', cleanup_source: true },
    })), { source, ranges })
    await page.goto('/?lang=en')
    await readyWorkspace(page)
    const originalPlayer = await page.locator('video').elementHandle()
    for (const [width, height] of [[1280, 720], [1280, 620], [1280, 619], [1280, 600], [1024, 600], [960, 540], [900, 500], [1440, 900], [1280, 600]]) {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await workspaceFits(page)
      await page.locator('.workspace-toolstrip').scrollIntoViewIfNeeded()
      await fullyInViewport(page.locator('.workspace-toolstrip'), 'Editing tools remain reachable')
      expect(await page.locator('video').evaluate((node, original) => node === original, originalPlayer)).toBe(true)
      await page.locator('video').hover(); await page.mouse.wheel(0, 500)
      await workspaceFits(page)
    }
    // Safari chrome can change the visible height before CSS viewport units
    // catch up. Exercise tab-bar appearance, disappearance and tab restoration.
    for (const toolbar of [38, 72, 0, 38]) {
      await page.evaluate(toolbar => {
        Object.defineProperty(visualViewport!, 'height', { configurable: true, value: innerHeight - toolbar });
        visualViewport!.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('pageshow'));
      }, toolbar)
      await workspaceFits(page)
      await page.locator('video').hover(); await page.mouse.wheel(0, 500)
      expect(await page.locator('video').evaluate((node, original) => node === original, originalPlayer)).toBe(true)
    }
    await page.evaluate(() => { Reflect.deleteProperty(visualViewport!, 'height'); visualViewport!.dispatchEvent(new Event('resize')); })
    await screenshot(page, testInfo, `${orientation}-safari-1280x600`)
    await page.locator('.clip-list').hover(); await page.mouse.wheel(0, 500)
    await expect.poll(() => page.locator('.clip-list').evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    await workspaceFits(page)
    await showExactTimes(page)
    await page.locator('#range-start').scrollIntoViewIfNeeded()
    await fullyInViewport(page.locator('#range-start'), 'Exact start input')
    await workspaceFits(page)
    await page.getByRole('button', { name: 'Exact time and timeline', exact: true }).click()
    await showEditorTools(page); await closeEditorTools(page)
    await workspaceFits(page)
    await page.locator('.export-submit').click()
    await expect(page.locator('.workspace-results')).toBeVisible()
    await workspaceFits(page, '.workspace-results')
    await page.getByRole('link', { name: 'Download', exact: true }).first().scrollIntoViewIfNeeded()
    await fullyInViewport(page.getByRole('link', { name: 'Download', exact: true }).first(), 'Ready-file download')
    await workspaceFits(page, '.workspace-results')
    await goToSource(page)
    await expect(page.locator('.workspace-shell')).toHaveCount(0)
    await goToMoment(page)
    await workspaceFits(page, '.workspace-results')
    if (orientation === 'landscape') {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.evaluate(() => {
        const nodes = [...document.querySelectorAll<HTMLElement>('body,body *')].filter(node => node instanceof HTMLElement)
        const sizes = nodes.map(node => parseFloat(getComputedStyle(node).fontSize))
        nodes.forEach((node, index) => { node.style.fontSize = `${sizes[index] * 2}px` })
      })
      // Large text may need a panel to scroll. Its controls must remain
      // reachable while the page, player and export stay in place.
      await page.locator('.editor-tools-toggle').scrollIntoViewIfNeeded()
      await fullyInViewport(page.locator('.editor-tools-toggle'), 'Tools at 200% text')
      await showEditorTools(page); await closeEditorTools(page)
      await page.locator('.export-submit').scrollIntoViewIfNeeded()
      await fullyInViewport(page.locator('.export-submit'), 'Export at 200% text')
      await page.locator('video').scrollIntoViewIfNeeded()
      await fullyInViewport(page.locator('video'), 'Player at 200% text')
    }
    expect(errors).toEqual([])
  })
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

for (const size of desktopSizes) {
  for (const orientation of ['landscape', 'portrait']) {
    test(`${orientation} source stays readable at ${size.width}×${size.height}`, async ({ page, browserName, headless }, testInfo) => {
      await diagnoseNativePreview(page, testInfo, { browserName, headless, context: 'desktop' }, async () => {
        await page.setViewportSize(size)
        await page.goto('/')
        let media = process.env.CUTMY_E2E_MEDIA!
        if (orientation === 'portrait') {
          media = testInfo.outputPath('portrait-source.mp4')
          execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', process.env.CUTMY_E2E_MEDIA!,
            '-vf', 'transpose=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', media], { timeout: 30_000 })
        }
        await uploadThroughUI(page, media)
        await readyWorkspace(page)
        await expect(page.locator('.clip-list > li')).toHaveCount(1)
        await expect(page.locator('.export-submit')).toBeEnabled()
        await expect(page.locator('.export-settings-dialog')).not.toHaveAttribute('open')
        await workspaceFits(page)
        await screenshot(page, testInfo, `${orientation}-${size.width}x${size.height}`)
        // Scrolling keeps the same usable player and all actions reachable.
        await page.locator('video').hover()
        await page.mouse.wheel(0, 500)
        await workspaceFits(page)
      })
    })
  }
}

test('trim and download directly from the workspace with untouched export defaults', async ({ page, browserName, headless }, testInfo) => {
  await diagnoseNativePreview(page, testInfo, { browserName, headless, context: 'desktop' }, async () => {
    await page.setViewportSize(desktopSizes[0])
    await page.goto('/')
    await uploadThroughUI(page)
    await readyWorkspace(page)
    const video = page.locator('video')
    const originalPlayer = await video.elementHandle()
    const start = page.locator('.trim-handle.start')
    // Keyboard adjustment exercises actual timeline controls without opening
    // export settings or routing through a clips/export stage.
    await start.focus()
    await start.press('Shift+ArrowRight')
    await start.press('ArrowRight')
    await start.press('ArrowRight')
    await expect(start).toHaveAttribute('aria-valuenow', '1200')
    // Exact fields are optional editing controls; close them before export.
    await showExactTimes(page)
    await page.getByLabel('Конец', { exact: true }).fill('00:00:03.700')
    await page.getByLabel('Конец', { exact: true }).press('Tab')
    await page.getByRole('button', { name: 'Точное время и шкала', exact: true }).click()
    await expect(page.locator('.export-settings-dialog')).not.toHaveAttribute('open')
    await workspaceFits(page)
    const created = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
    await page.locator('.export-submit').click()
    const creation = await created
    expect(creation.ok(), await creation.text()).toBeTruthy()
    const body = creation.request().postDataJSON()
    expect(body.ranges.map((range: { start_ms: number; end_ms: number }) => [range.start_ms, range.end_ms])).toEqual([[1200, 3700]])
    expect(body.format).toBe('mp4')
    const job = await waitJob(page.request, (await creation.json()).id)
    expect(job.status, JSON.stringify(job)).toBe('succeeded')
    const downloadLink = page.getByRole('link', { name: 'Скачать', exact: true })
    await downloadLink.scrollIntoViewIfNeeded()
    await fullyInViewport(downloadLink, 'Download after export')
    expect(await originalPlayer?.evaluate(node => node === document.querySelector('video')), 'Export retains the same player').toBe(true)
    await expect(page.locator('.export-settings-dialog')).not.toHaveAttribute('open')
    const downloadPromise = page.waitForEvent('download')
    await downloadLink.click()
    const download = await downloadPromise
    expect(await download.failure()).toBeNull()
    const filename = testInfo.outputPath('direct-workspace-clip.mp4')
    await download.saveAs(filename)
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filename], { encoding: 'utf8' }))
    expect(Number(probe.format.duration)).toBeCloseTo(2.5, 1)
    expect(probe.streams.map((stream: { codec_type: string }) => stream.codec_type)).toEqual(expect.arrayContaining(['video', 'audio']))
    assertFirstFrameMatchesSource(filename, 1200)
    await testInfo.attach('Real direct export', { path: filename, contentType: 'video/mp4' })
    await screenshot(page, testInfo, 'ready-direct-export-1280x720')
  })
})

test('a long clip collection scrolls internally while editing and export remain reachable', async ({ page, browserName, headless }, testInfo) => {
  await diagnoseNativePreview(page, testInfo, { browserName, headless, context: 'desktop' }, async () => {
    await page.setViewportSize(desktopSizes[0])
    await page.goto('/')
    await uploadThroughUI(page)
    await readyWorkspace(page)
    const add = page.locator('.clip-library').getByRole('button', { name: 'Добавить фрагмент', exact: true })
    for (let i = 0; i < 11; i++) await add.click()
    const list = page.locator('.clip-list')
    await expect(list.locator('> li')).toHaveCount(12)
    await expect.poll(() => list.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(20)
    await workspaceFits(page)
    await list.hover()
    // Firefox limits one wheel gesture to approximately one visible page.
    // Exercise ordinary repeated wheel input rather than assigning scrollTop.
    for (let gesture = 0; gesture < 12; gesture++) {
      const before = await list.evaluate(node => node.scrollTop)
      if (before === 0) break
      await page.mouse.wheel(0, -400)
      await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeLessThan(before)
    }
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(0)
    await page.getByRole('button', { name: 'Редактировать фрагмент 1', exact: true }).click()
    await workspaceFits(page)
    await screenshot(page, testInfo, 'twelve-clips-1280x720')
  })
})
