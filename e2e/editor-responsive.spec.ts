import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { goToExport, closeExportSettings, goToMoment, goToSource, showExactTimes, showExportSettings } from './helpers'
import { textContrast } from './contrast'

const desktopSizes = [
  [1280, 600], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440],
  [1100, 700], [1099, 700], [1024, 768], [900, 500], [899, 600], [768, 1024],
] as const
const touchSizes = [[320, 720], [360, 640], [390, 844], [430, 932], [640, 360], [844, 390], [1024, 768]] as const

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  expect(await page.evaluate(() => document.fonts.check('16px "Geologica Variable"')), 'The actual interface font must load').toBe(true)
}

async function reachable(control: Locator, label: string) {
  await expect(control, label).toBeVisible()
  await control.scrollIntoViewIfNeeded()
  const box = await control.evaluate(node => {
    const rect = node.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, width: innerWidth, viewport: innerHeight }
  })
  expect(box.left, `${label}: left edge`).toBeGreaterThanOrEqual(-1)
  expect(box.right, `${label}: right edge`).toBeLessThanOrEqual(box.width + 1)
  expect(box.bottom, `${label}: scroll reaches control`).toBeGreaterThan(0)
  expect(box.top, `${label}: scroll reaches control`).toBeLessThan(box.viewport)
  if (box.height <= box.viewport - 2) {
    expect(box.top, `${label}: complete control is reachable`).toBeGreaterThanOrEqual(-1)
    expect(box.bottom, `${label}: complete control is reachable`).toBeLessThanOrEqual(box.viewport + 1)
  }
}

async function noHorizontalClipping(page: Page, touch = false) {
  const geometry = await page.evaluate(touch => {
    const controls = [...document.querySelectorAll<HTMLElement>('button, input:not([type=file]), select, a[href], summary, [role=slider]')]
      .filter(element => {
        if (element.classList.contains('skip-link')) return false
        const closed = element.closest('details:not([open])')
        if (closed && !closed.querySelector(':scope > summary')?.contains(element)) return false
        const rect = element.getBoundingClientRect()
        const css = getComputedStyle(element)
        return rect.width > 1 && rect.height > 1 && css.visibility !== 'hidden'
      })
      .map(element => {
        const target = element.matches('input[type=checkbox]') ? element.closest('label') ?? element : element
        const rect = target.getBoundingClientRect()
        return { name: element.getAttribute('aria-label') || element.id || element.textContent?.trim().slice(0, 70),
          clipped: rect.left < -1 || rect.right > innerWidth + 1,
          smallTouchTarget: touch && !(element as HTMLButtonElement).disabled && (rect.width < 43.5 || rect.height < 43.5) }
      })
    return { overflow: document.documentElement.scrollWidth - innerWidth, controls }
  }, touch)
  expect(geometry.overflow, 'Document must reflow without horizontal scrolling').toBeLessThanOrEqual(1)
  expect(geometry.controls.filter(control => control.clipped), 'Visible controls must stay inside the page').toEqual([])
  expect(geometry.controls.filter(control => control.smallTouchTarget), 'Touch actions need 44 CSS pixel targets').toEqual([])
}

async function readablePlayer(page: Page, youtube = false) {
  const frame = page.locator('.player-frame')
  await reachable(frame, 'Video preview')
  const rect = (await frame.boundingBox())!
  const viewport = page.viewportSize()!
  expect(rect.height, 'A short window must not squash the preview into a strip').toBeGreaterThanOrEqual(Math.min(rect.width * 9 / 16, viewport.height * .42, 240) - 1)
  if (youtube) {
    const iframe = page.locator('.youtube-player iframe')
    await expect(iframe).toBeVisible()
    const video = (await iframe.boundingBox())!
    expect(Math.abs(video.width / video.height - 16 / 9), 'YouTube needs its own undistorted 16:9 viewport').toBeLessThan(.03)
    expect(video.width).toBeLessThanOrEqual(rect.width + 1)
    expect(video.height).toBeLessThanOrEqual(rect.height + 1)
  } else {
    const video = page.locator('.player-frame video')
    await expect(video).toBeVisible()
    await expect(video).toHaveCSS('object-fit', 'contain')
  }
}

async function fixture(page: Page, testInfo: TestInfo, options: { portrait?: boolean; youtube?: boolean; seed?: boolean } = {}) {
  let mediaPath = process.env.CUTMY_E2E_MEDIA!
  if (options.portrait) {
    mediaPath = testInfo.outputPath('portrait.mp4')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', process.env.CUTMY_E2E_MEDIA!,
      '-vf', 'transpose=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', mediaPath], { timeout: 30_000 })
  }
  const bytes = await readFile(mediaPath)
  const source = {
    id: 'responsive-source', title: 'Интервью: длинное название записи для проверки переноса и читаемости.mp4',
    kind: options.youtube ? 'youtube' : 'upload', provider: options.youtube ? 'youtube' : undefined,
    duration_ms: 12_000, width: options.portrait ? 360 : 640, height: options.portrait ? 640 : 360,
    preview_kind: options.youtube ? 'youtube' : 'native', preview_url: options.youtube ? null : '/responsive-preview.mp4',
    embed_url: options.youtube ? 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ' : null, thumbnail_url: null,
  }
  const ranges = Array.from({ length: 12 }, (_, index) => ({
    id: `responsive-cut-${index}`, label: index === 0 ? 'Важный момент с длинным названием фрагмента' : `Фрагмент ${index + 1}`,
    start_ms: 1000, end_ms: 4000,
  }))
  let submitted: Record<string, unknown> | undefined
  const job = { id: 'responsive-job', status: 'succeeded', stage: 'finished', message: '', items: [{
    id: 'responsive-item', label: ranges[0].label, start_ms: 1000, end_ms: 4000, status: 'succeeded',
    artifact: { id: 'responsive-artifact', filename: 'Интервью — готовый фрагмент.mp4', size_bytes: bytes.length,
      download_url: '/responsive-result.mp4', actual_start_ms: 1000, actual_end_ms: 4000 },
  }] }
  await page.route('**/responsive-*.mp4', route => route.fulfill({ contentType: 'video/mp4', body: bytes }))
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true } })
    if (path.endsWith('/tracks')) return route.fulfill({ json: { tracks: [{ index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac' }] } })
    if (path === '/api/v1/sources' && route.request().method() === 'POST') return route.fulfill({ status: 201, json: source })
    if (path === `/api/v1/sources/${source.id}`) return route.fulfill({ json: source })
    if (path === '/api/v1/sources') return route.fulfill({ json: { sources: [source] } })
    if (path === '/api/v1/jobs' && route.request().method() === 'POST') {
      submitted = route.request().postDataJSON()
      return route.fulfill({ json: job })
    }
    if (path === `/api/v1/jobs/${job.id}`) return route.fulfill({ json: job })
    if (path === '/api/v1/jobs') return route.fulfill({ json: { jobs: [] } })
    return route.fulfill({ status: 404, json: { error: { code: 'preview_unavailable', message: 'Optional media fixture unavailable' } } })
  })
  if (options.youtube) await page.addInitScript(() => {
    class Player {
      frame: HTMLIFrameElement
      currentTime = 0
      constructor(element: HTMLElement, options: { events: { onReady(event: { target: Player }): void } }) {
        this.frame = document.createElement('iframe')
        this.frame.src = 'about:blank'
        this.frame.title = 'Controlled YouTube preview'
        element.replaceWith(this.frame)
        queueMicrotask(() => options.events.onReady({ target: this }))
      }
      seekTo(seconds: number) { this.currentTime = seconds }
      playVideo() {}
      pauseVideo() {}
      getCurrentTime() { return this.currentTime }
      getPlayerState() { return 2 }
      destroy() { this.frame.remove() }
    }
    Object.assign(window, { YT: { Player } })
  })
  if (options.seed !== false) await page.addInitScript(({ source, ranges }) => {
    const draft = { workflow_version: 2, source_id: source.id, source_title: source.title, source_duration_ms: source.duration_ms,
      step: 2, ranges, selected_id: ranges[0].id, selected_range_ids: [ranges[0].id], precision_open: false,
      output: { format: 'mp4', quality: 'best', cut_mode: 'accurate', cleanup_source: false } }
    localStorage.setItem('cutmy.projects.v1', JSON.stringify({ version: 1, active_id: source.id, projects: [{ id: source.id, updated_at: 1, draft }] }))
  }, { source, ranges })
  await page.goto('/?lang=ru')
  await expect(page.locator('main')).toHaveAttribute('data-bootstrap-state', 'ready')
  if (options.seed !== false) {
    await expect(page.locator('.editor-workspace')).toBeVisible()
    if (!options.youtube) await expect.poll(() => page.locator('video').evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
  }
  return { submitted: () => submitted }
}

async function workspace(page: Page, youtube = false, touch = false) {
  await settle(page)
  await noHorizontalClipping(page, touch)
  await readablePlayer(page, youtube)
  for (const selector of ['.trim-handle.start', '.trim-handle.end', '.precision-toggle', '.editor-tools-toggle']) {
    await reachable(page.locator(selector), selector)
  }
  await reachable(page.locator('.clip-library').getByRole('button', { name: /^(Добавить фрагмент|Add a clip)$/ }), 'Add a clip')
  const exportControl = await page.locator('.workspace-export-toggle').isVisible() ? '.workspace-export-toggle' : '.export-submit'
  await reachable(page.locator(exportControl), 'Open export')
  // A long collection must leave the final clip reachable as well.
  await reachable(page.locator('.clip-list > li').last().locator('.clip-edit'), 'Last clip')
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => {
    document.querySelector('.clip-list')?.scrollTo(0, 0)
    for (const node of document.querySelectorAll('.moment-controls,.editing-panel,.workspace-sidebar,.workspace-clips,.export-panel,.export-scroll')) node.scrollTo(0, 0)
    scrollTo(0, 0)
  })
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('desktop panels track tab-bar height changes and restored Safari viewports without scrolling the document', async ({ page }, testInfo) => {
  for (const youtube of [false, true]) {
    await fixture(page, testInfo, { youtube })
    const player = await page.locator(youtube ? '.youtube-player iframe' : '.player-frame video').elementHandle()
    for (const height of [900, 734, 706, 678, 600, 500, 900]) {
      await page.setViewportSize({ width: 1440, height })
      await settle(page)
      await expect.poll(() => page.locator('.workspace-shell').evaluate(node => node.getBoundingClientRect().height)).toBe(height)
      expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), `No page scroll at 1440×${height}`).toBeLessThanOrEqual(1)
      await readablePlayer(page, youtube)
      await reachable(page.locator('.trim-handle.start'), 'Start boundary inside the panel')
      await reachable(page.locator('.trim-handle.end'), 'End boundary inside the panel')
      await reachable(page.locator('.clip-list > li').last().locator('.clip-edit'), 'Last clip inside its list')
      await page.locator('.clip-list > li').last().locator('.clip-edit').click({ trial: true })
      const list = (await page.locator('.clip-list').boundingBox())!
      const firstRow = (await page.locator('.clip-list > li').first().boundingBox())!
      expect(list.height, 'The clip list must retain enough room for a complete clip').toBeGreaterThanOrEqual(firstRow.height)
      await goToExport(page)
      await reachable(page.locator('.export-submit'), 'Export in the review dialog')
      await page.locator('.format-picker button').first().click({ trial: true })
      await goToExport(page)
      await page.locator('.export-submit').click({ trial: true })
      await goToMoment(page)
      expect(await page.evaluate(() => scrollY), 'Reaching panel controls must not scroll the page').toBe(0)
      expect(await page.locator(youtube ? '.youtube-player iframe' : '.player-frame video').evaluate((node, old) => node === old, player), 'Tab-bar changes preserve the player').toBe(true)
    }
    // Safari can update its visual viewport before the layout viewport. Also
    // cover pageshow: restoring a background tab need not deliver window.resize.
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, 'height', { configurable: true, value: 664 })
      visualViewport!.dispatchEvent(new Event('resize'))
    })
    await expect.poll(() => page.locator('.workspace-shell').evaluate(node => node.getBoundingClientRect().height)).toBe(664)
    await page.evaluate(() => {
      Object.defineProperty(visualViewport!, 'height', { configurable: true, value: 628 })
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    await expect.poll(() => page.locator('.workspace-shell').evaluate(node => node.getBoundingClientRect().height)).toBe(628)
    const anotherTab = await page.context().newPage()
    await anotherTab.goto('about:blank')
    await anotherTab.bringToFront()
    await page.bringToFront()
    await anotherTab.close()
    await reachable(page.locator('.workspace-export-toggle'), 'Export after returning from another tab')
    expect(await page.evaluate(() => scrollY)).toBe(0)
    await page.evaluate(() => { Reflect.deleteProperty(visualViewport!, 'height') })
    await page.setViewportSize({ width: 1440, height: 678 })
    await settle(page)
    await capture(page, testInfo, `desktop-tabs-${youtube ? 'youtube' : 'native'}-1440x678`)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--workspace-height'))).toBe('')
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 'Phone reflow retains ordinary document scrolling').toBeGreaterThan(0)
  }
})

test('the desktop editing canvas exposes its primary controls without scrolling any editing panel', async ({ page }, testInfo) => {
  await fixture(page, testInfo)
  for (const [width, height] of [[900, 500], [1280, 600], [1440, 706], [1920, 1080]]) {
    await page.setViewportSize({ width, height })
    await settle(page)
    const panels = await page.locator('.workspace-page,.editor-workspace,.moment-controls,.workspace-sidebar').evaluateAll(nodes => nodes.map(node => ({
      name: node.className, overflow: node.scrollHeight - node.clientHeight, top: node.scrollTop,
    })))
    for (const panel of panels) {
      expect(panel.overflow, `${width}×${height}: ${panel.name} needs no scrolling`).toBeLessThanOrEqual(1)
      expect(panel.top).toBe(0)
    }
    for (const selector of ['.trim-handle.start', '.trim-handle.end', '.time-value', '.precision-toggle', '.moment-preview > .button', '.timeline-media-disclosure > summary', '.editor-tools-toggle', '.workspace-export-toggle']) {
      for (const control of await page.locator(selector).all()) {
        const hit = await control.evaluate(node => {
          const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
          return r.top >= 0 && r.bottom <= innerHeight && node.contains(document.elementFromPoint(x, y))
        })
        expect(hit, `${width}×${height}: ${selector} is immediately usable`).toBe(true)
      }
    }
    await page.locator('.player-frame').hover()
    await page.mouse.wheel(0, 600)
    expect(await page.evaluate(() => scrollY)).toBe(0)
  }
})

test('short desktop windows expose trim values without toolbar overlap on first open', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  await fixture(page, testInfo)
  await settle(page)
  const start = page.locator('.moment-boundaries .time-value').first()
  const end = page.locator('.moment-boundaries .time-value').last()
  for (const control of [start, end]) {
    const point = await control.evaluate(node => {
      const rect = node.getBoundingClientRect()
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
      return { x, y, hit: node.contains(document.elementFromPoint(x, y)) }
    })
    expect(point.hit, 'Trim time values must accept a real click without scrolling first').toBe(true)
  }
  const box = (await start.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('#range-start')).toBeFocused()
  expect(await page.evaluate(() => scrollY)).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(1)
  await capture(page, testInfo, 'short-desktop-trim-values-1280x600')
})

test('native preview and editing stay readable across desktop, laptop and tablet sizes', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await fixture(page, testInfo)
  const original = await page.locator('video').elementHandle()
  for (const [index, [width, height]] of desktopSizes.entries()) {
    await page.setViewportSize({ width, height })
    await page.getByRole('button', { name: index % 2 ? 'English' : 'Русский', exact: true }).click()
    await page.locator('.theme-toggle').click()
    await workspace(page)
    const contrast = await textContrast(page)
    expect(contrast.filter(value => value.ratio < value.minimum), `Readable text contrast at ${width}×${height}`).toEqual([])
    expect(await page.locator('video').evaluate((node, old) => node === old, original), 'Resizing preserves the player').toBe(true)
    if (width === 1280 && height === 600 || width === 768 || width === 2560) await capture(page, testInfo, `native-${width}x${height}`)
  }
  expect(errors).toEqual([])
})

test('YouTube keeps a 16:9 iframe in short and narrow windows', async ({ page }, testInfo) => {
  await fixture(page, testInfo, { youtube: true })
  for (const [width, height] of [...desktopSizes, ...touchSizes]) {
    await page.setViewportSize({ width, height })
    await workspace(page, true)
    if (width === 1280 && height === 600 || width === 320) await capture(page, testInfo, `youtube-${width}x${height}`)
  }
})

test('portrait media and touch controls reflow through phone and landscape sizes', async ({ browser, browserName }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, hasTouch: true, isMobile: browserName !== 'firefox', viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  try {
    await fixture(page, testInfo, { portrait: true })
    await expect.poll(() => page.locator('video').evaluate(node => [(node as HTMLVideoElement).videoWidth, (node as HTMLVideoElement).videoHeight])).toEqual([360, 640])
    for (const [width, height] of touchSizes) {
      await page.setViewportSize({ width, height })
      await workspace(page, false, true)
      await capture(page, testInfo, `portrait-touch-${width}x${height}`)
    }
  } finally { await context.close() }
})

test('source, exact editing, export settings and download remain reachable at 200% text', async ({ page }, testInfo) => {
  const state = await fixture(page, testInfo, { seed: false })
  for (const [width, height] of [[320, 720], [768, 1024], [1280, 600], [2560, 1440]]) {
    await page.setViewportSize({ width, height })
    await settle(page)
    await noHorizontalClipping(page)
    await reachable(page.locator('.source-form input'), 'Video link')
    await reachable(page.locator('.source-open'), 'Open video')
    await page.locator('.source-choice button').nth(1).click()
    await reachable(page.locator('.upload-button'), 'Choose a video file')
    await page.locator('.source-choice button').nth(0).click()
  }
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.locator('.source-form input').fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  await page.locator('.source-open').click()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await page.evaluate(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('body, body *')]
    const sizes = nodes.map(node => parseFloat(getComputedStyle(node).fontSize))
    nodes.forEach((node, index) => { node.style.fontSize = `${sizes[index] * 2}px` })
  })
  await showExactTimes(page)
  for (const selector of ['#range-start', '#range-end']) await reachable(page.locator(selector), `200% text ${selector}`)
  await page.locator('#range-start').fill('00:00:01.000')
  await page.locator('#range-start').press('Tab')
  await page.locator('#range-end').fill('00:00:04.000')
  await page.locator('#range-end').press('Tab')
  await noHorizontalClipping(page)
  await readablePlayer(page)
  await showExportSettings(page)
  const dialog = page.locator('.export-settings-dialog')
  await reachable(dialog.locator('.dialog-header button'), 'Export settings close')
  for (const control of await dialog.locator('button,input:not([type=file]),select,[role=combobox]').all()) {
    if (await control.isVisible() && await control.isEnabled()) await reachable(control, 'Export setting at 200% text')
  }
  await closeExportSettings(page)
  await goToExport(page)
  await page.locator('.export-submit').click()
  await expect.poll(() => state.submitted()?.ranges).toEqual([expect.objectContaining({ start_ms: 1000, end_ms: 4000 })])
  await goToMoment(page)
  const download = page.getByRole('link', { name: 'Скачать', exact: true })
  await reachable(download, 'Exported clip download')
  await expect(download).toHaveAttribute('href', '/responsive-result.mp4')
  await noHorizontalClipping(page)
  await capture(page, testInfo, 'export-200-percent-text')
  await goToSource(page)
  await reachable(page.locator('.source-open'), 'Source screen after export')
  await goToMoment(page)
  await readablePlayer(page)
})
