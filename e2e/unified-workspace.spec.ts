import { execFileSync } from 'node:child_process'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { api, assertFirstFrameMatchesSource, showExactTimes, uploadThroughUI, waitJob } from './helpers'
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

async function workspaceFits(page: Page) {
  for (const [selector, description] of [
    ['video', 'Native player'], ['.trim-track', 'Timeline'],
    ['.trim-handle.start', 'Start handle'], ['.trim-handle.end', 'End handle'],
    ['.clip-library', 'Clip collection'], ['.export-submit', 'Export button'],
  ]) await fullyInViewport(page.locator(selector), description)
  const documentSize = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth, viewportHeight: innerHeight, scrollX, scrollY,
  }))
  expect(documentSize.width, 'No horizontal page overflow').toBeLessThanOrEqual(documentSize.viewportWidth + 1)
  expect(documentSize.height, 'Editing must fit the desktop window without page scrolling').toBeLessThanOrEqual(documentSize.viewportHeight + 1)
  expect(documentSize.scrollX).toBe(0)
  expect(documentSize.scrollY).toBe(0)
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

for (const size of desktopSizes) {
  for (const orientation of ['landscape', 'portrait']) {
    test(`${orientation} source fits one workspace at ${size.width}×${size.height}`, async ({ page, browserName, headless }, testInfo) => {
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
        // Trackpad wheel input must not push the player or export out of view.
        await page.locator('video').hover()
        await page.mouse.wheel(0, 500)
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
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

test('a long clip collection scrolls internally while player, timeline and export remain in view', async ({ page, browserName, headless }, testInfo) => {
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
      expect(await page.evaluate(() => scrollY), 'Scrolling clips retains the page position').toBe(0)
    }
    await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(0)
    await page.getByRole('button', { name: 'Редактировать фрагмент 1', exact: true }).click()
    await workspaceFits(page)
    await screenshot(page, testInfo, 'twelve-clips-1280x720')
  })
})
