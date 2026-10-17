import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { expect, test, type CDPSession, type Locator, type Page, type TestInfo } from '@playwright/test'
import { diagnoseNativePreview } from './nativeDiagnostics'
import { addClip, api, assertFirstFrameMatchesSource, goToClips, goToExport, goToMoment, goToSource, saveClip, setTheme, showExactTimes, showEditorTools, closeEditorTools, showExportSettings, closeExportSettings, uploadThroughUI, waitJob } from './helpers'

const desktopSizes = [
  { width: 1440, height: 900 }, { width: 1366, height: 768 },
  { width: 1280, height: 800 }, { width: 1280, height: 720 },
  { width: 1920, height: 1080 }, { width: 2560, height: 1440 },
  { width: 1024, height: 768 },
]
const phoneSizes = [
  { width: 360, height: 640 }, { width: 390, height: 844 }, { width: 430, height: 932 },
  { width: 640, height: 360 }, { width: 844, height: 390 }, { width: 932, height: 430 },
  // A 320 CSS-pixel viewport exercises reflow. It is not a claim about browser
  // zoom, physical display density, or a deviceScaleFactor setting.
  { width: 320, height: 720 },
]
const labels = {
  preview: /^(Посмотреть фрагмент|Preview clip)$/,
  add: /^(Добавить фрагмент|Add a clip)$/,
  precision: /^(Точное время и шкала|Exact time and timeline)$/,
  download: /^(Скачать|Download)$/,
  cut: /^(Вырезать фрагменты|Cut clips)$/,
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

async function withinFirstViewport(locator: Locator, description: string) {
  await expect(locator, description).toBeVisible()
  const bounds = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: innerWidth, height: innerHeight }
  })
  expect(bounds.left, `${description}: left edge`).toBeGreaterThanOrEqual(-1)
  expect(bounds.right, `${description}: right edge`).toBeLessThanOrEqual(bounds.width + 1)
  expect(bounds.top, `${description}: top edge`).toBeGreaterThanOrEqual(-1)
  expect(bounds.bottom, `${description}: bottom edge`).toBeLessThanOrEqual(bounds.height + 1)
  return bounds
}

async function reachableByScrolling(locator: Locator, description: string) {
  await expect(locator, description).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  const bounds = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, viewport: innerHeight, width: innerWidth }
  })
  expect(bounds.left, `${description}: left edge`).toBeGreaterThanOrEqual(-1)
  expect(bounds.right, `${description}: right edge`).toBeLessThanOrEqual(bounds.width + 1)
  expect(bounds.bottom, `${description}: reachable by ordinary scrolling`).toBeGreaterThan(0)
  expect(bounds.top, `${description}: reachable by ordinary scrolling`).toBeLessThan(bounds.viewport)
  // Bounded collections can be taller than short viewports; individual actions
  // must fit when brought into view, rather than reducing font sizes to fit all.
  const collectionPanel = await locator.evaluate(element => element.matches('.clip-library,.clip-list,.workspace-results'))
  if (!collectionPanel && bounds.height <= bounds.viewport) {
    expect(bounds.top, `${description}: scroll reveals the complete control`).toBeGreaterThanOrEqual(-1)
    expect(bounds.bottom, `${description}: scroll reveals the complete control`).toBeLessThanOrEqual(bounds.viewport + 1)
  }
  return bounds
}

async function collectLayout(page: Page, touch: boolean) {
  return page.evaluate(touch => {
    const controls = [...document.querySelectorAll<HTMLElement>('button, input:not([type=file]), select, a[href], summary, [role=slider]')]
      .filter(element => {
        const disclosure = element.closest('details:not([open])')
        if (disclosure && !disclosure.querySelector(':scope > summary')?.contains(element)) return false
        const target = element.matches('input[type="checkbox"]') ? element.closest('label') ?? element : element
        const rect = target.getBoundingClientRect()
        const css = getComputedStyle(element)
        return rect.width > 1 && rect.height > 1 && css.visibility !== 'hidden' && !element.closest('[hidden]')
          && !element.classList.contains('skip-link') && !(element as HTMLButtonElement).disabled
      })
      .map(element => {
        const target = element.matches('input[type="checkbox"]') ? element.closest('label') ?? element : element
        const rect = target.getBoundingClientRect()
        return {
          name: element.getAttribute('aria-label') || element.getAttribute('id') || element.textContent?.trim().slice(0, 80),
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          clippedHorizontally: rect.left < -1 || rect.right > innerWidth + 1,
          smallTouchTarget: touch && (rect.width < 43.5 || rect.height < 43.5),
        }
      })
    return { width: innerWidth, height: innerHeight, coarsePointer: matchMedia('(pointer: coarse)').matches, scrollHeight: document.documentElement.scrollHeight,
      overflow: document.documentElement.scrollWidth - innerWidth, controls }
  }, touch)
}

type LayoutState = 'source' | 'workspace' | 'tools' | 'export-settings' | 'files'

async function checkLayout(page: Page, state: LayoutState, touch: boolean, description: string) {
  await settle(page)
  await page.evaluate(() => scrollTo(0, 0))
  const result = await collectLayout(page, touch)
  expect(result.overflow, `${description}: horizontal document overflow`).toBeLessThanOrEqual(1)
  expect(result.controls.filter(control => control.clippedHorizontally), `${description}: horizontally clipped controls`).toEqual([])
  expect(result.controls.filter(control => control.smallTouchTarget), `${description}: targets smaller than 44 CSS px`).toEqual([])
  if (state === 'workspace' || state === 'files') {
    const primary = ['video', '.trim-handle.start', '.trim-handle.end', await page.locator('.workspace-export-toggle').isVisible() ? '.workspace-export-toggle' : '.export-submit', ...(state === 'workspace' ? ['.clip-library', '.clip-list'] : ['.workspace-results'])]
    for (const selector of primary) {
      await reachableByScrolling(page.locator(selector), `${description}: ${selector}`)
    }
    const frame = (await page.locator('.player-frame').boundingBox())!
    expect(frame.height, `${description}: a readable preview keeps its height`).toBeGreaterThanOrEqual(Math.min(frame.width * 9 / 16, result.height * .42, 240) - 1)
  }
  if (touch && state === 'workspace' && result.width > result.height) {
    const video = await page.locator('video').boundingBox()
    expect(video, `${description}: real landscape player`).not.toBeNull()
    expect(video!.height, `${description}: unnecessarily tall landscape player`).toBeLessThanOrEqual(result.height * .7 + 1)
    expect(video!.height, `${description}: readable native controls`).toBeGreaterThanOrEqual(140)
  }
  if (state === 'source') {
    for (const selector of ['.source-choice', '.source-form input', '.source-open']) {
      await reachableByScrolling(page.locator(selector), `${description}: ${selector}`)
    }
  } else if (state === 'workspace' || state === 'files') {
    const primary = [...(await page.locator('.workspace-export-toggle').isVisible() ? [page.locator('.workspace-export-toggle')] : [page.locator('.format-picker'), page.locator('.export-submit')]),
      ...(state === 'workspace' ? [page.getByRole('button', { name: labels.add })] : await page.getByRole('link', { name: labels.download }).all())]
    for (const control of primary) await reachableByScrolling(control, `${description}: workspace action`)
  } else {
    const dialog = page.getByRole('dialog').last()
    await withinFirstViewport(dialog.locator('.dialog-header .icon-button'), `${description}: dialog close`)
    const controls = await dialog.locator('button,input:not([type=file]),[role=combobox]').all()
    for (const control of controls) if (await control.isVisible() && await control.isEnabled()) {
      await reachableByScrolling(control, `${description}: optional tool`)
    }
  }
  await page.evaluate(() => scrollTo(0, 0))
  return result
}

async function screen(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('real clips remain usable across laptop, desktop, tablet and touch viewport matrix', async ({ page, browser, browserName, headless }, testInfo) => {
  // Every engine checks real source/workspace/dialog states across all sizes.
  // Alternating language/theme combinations keep the matrix useful and bounded.
  test.setTimeout(600_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await diagnoseNativePreview(page, testInfo, { browserName, headless, context: 'desktop' }, async () => {
    await page.goto('/')
    await uploadThroughUI(page)
    await expect(page.locator('video')).toBeVisible()
    // preload="metadata" may legitimately stop at HAVE_METADATA until play.
    // Decoded frames and advancement are checked after the real preview click.
    await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
    await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(12, 1)
    await showExactTimes(page)
    await page.locator('#range-start').fill('00:00:01.250')
    await page.locator('#range-start').press('Tab')
    await page.locator('#range-end').fill('00:00:03.750')
    await page.locator('#range-end').press('Tab')
    await page.getByRole('button', { name: labels.preview }).click()
    await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(1.25)
    await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
    await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThanOrEqual(3.7)
    await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(3)
  })
  const startHandle = page.locator('.trim-handle.start')
  await startHandle.focus()
  await page.keyboard.press('ArrowRight')
  await expect(startHandle).toHaveAttribute('aria-valuenow', '1350')
  await page.keyboard.press('Tab')
  await expect(page.locator('.trim-handle.end')).toBeFocused()
  await startHandle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(startHandle).toHaveAttribute('aria-valuenow', '1250')
  await addClip(page)
  await showExactTimes(page)
  await page.locator('#range-start').fill('00:00:06.000')
  await page.locator('#range-start').press('Tab')
  await page.locator('#range-end').fill('00:00:08.500')
  await page.locator('#range-end').press('Tab')
  await goToExport(page)
  // The viewport matrix revisits and plays the original after this export.
  await showExportSettings(page)
  await page.getByRole('checkbox', { name: 'Удалить исходник после экспорта', exact: true }).uncheck()
  await closeExportSettings(page)
  const created = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: labels.cut }).click()
  const creation = await created
  expect(creation.ok(), await creation.text()).toBeTruthy()
  expect(creation.request().postDataJSON().ranges.map((range: { start_ms: number; end_ms: number }) => [range.start_ms, range.end_ms]))
    .toEqual([[1250, 3750], [6000, 8500]])
  const job = await waitJob(page.request, (await creation.json()).id)
  expect(job.status).toBe('succeeded')
  await expect(page.getByRole('link', { name: labels.download })).toHaveCount(2)
  for (let i = 0; i < 2; i++) {
    const pending = page.waitForEvent('download')
    await page.getByRole('link', { name: labels.download }).nth(i).click()
    const download = await pending
    expect(await download.failure()).toBeNull()
    const path = testInfo.outputPath(`actual-${browserName}-clip-${i + 1}.mp4`)
    await download.saveAs(path)
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { encoding: 'utf8' }))
    expect(Number(probe.format.duration)).toBeCloseTo(2.5, 1)
    expect(probe.streams.map((stream: { codec_type: string }) => stream.codec_type)).toEqual(expect.arrayContaining(['video', 'audio']))
    assertFirstFrameMatchesSource(path, i === 0 ? 1250 : 6000)
    await testInfo.attach(`Actual ${browserName} clip ${i + 1}`, { path, contentType: 'video/mp4' })
    const probePath = `${path}.probe.json`
    await writeFile(probePath, JSON.stringify(probe, null, 2))
    await testInfo.attach(`Probe ${i + 1}`, { path: probePath, contentType: 'application/json' })
  }

  const evidence: unknown[] = []
  let chromeTouch: CDPSession | undefined
  async function matrix(target: Page, sizes: typeof desktopSizes, touch: boolean) {
    for (const [sizeIndex, size] of sizes.entries()) {
      await target.setViewportSize(size)
      if (touch) {
        // GTK mobile emulation applies the new layout viewport after navigation.
        await target.reload()
        await goToExport(target)
        await expect(target.getByRole('link', { name: labels.download })).toHaveCount(2)
      }
      await settle(target)
      expect(await target.evaluate(() => ({ width: innerWidth, height: innerHeight })),
        `${browserName}-${size.width}x${size.height}: requested viewport`).toEqual(size)
      const locale = sizeIndex % 2 ? 'en' : 'ru'
      const theme = sizeIndex % 2 ? 'dark' : 'light'
      await target.getByRole('button', { name: locale === 'ru' ? 'Русский' : 'English', exact: true }).click()
      await setTheme(target, theme)
      for (const state of ['source', 'workspace', 'tools', 'export-settings', 'files'] as const) {
        if (state === 'source') {
          await goToSource(target)
          await target.getByRole('button', { name: /^(Ссылка|Link)$/ }).click()
        } else {
          await goToMoment(target)
          const precision = target.getByRole('button', { name: labels.precision })
          if (await precision.getAttribute('aria-expanded') === 'true') await precision.click()
          await expect(precision).toHaveAttribute('aria-expanded', 'false')
          if (state === 'workspace') await goToClips(target)
          if (state === 'files') await goToExport(target)
          if (state === 'tools') await showEditorTools(target)
          if (state === 'export-settings') await showExportSettings(target)
        }
        const key = `${browserName}-${size.width}x${size.height}-${locale}-${theme}-${state}`
        evidence.push({ key, state, locale, theme, touch, ...await checkLayout(target, state, touch, key) })
        if (state === 'source') {
          await target.getByRole('button', { name: /^(Файл|File)$/ }).click()
          await settle(target)
          const uploadLayout = await collectLayout(target, touch)
          expect(uploadLayout.overflow, `${key}: file chooser overflow`).toBeLessThanOrEqual(1)
          expect(uploadLayout.controls.filter(control => control.clippedHorizontally || control.smallTouchTarget), `${key}: file controls`).toEqual([])
          await reachableByScrolling(target.locator('.upload-button'), `${key}: choose video`)
          evidence.push({ key: `${key}-upload`, ...uploadLayout })
        }
        if (state === 'workspace' || size.width === 1280 && size.height === 720 || size.width === 320) {
          await screen(target, testInfo, key)
          if (touch && chromeTouch) await chromeTouch.send('Emulation.setTouchEmulationEnabled', { enabled: true })
        }
        if (state === 'tools') await closeEditorTools(target)
        if (state === 'export-settings') await closeExportSettings(target)
      }
    }
  }
  await matrix(page, desktopSizes, false)

  const touchContext = await browser.newContext({
    baseURL: process.env.CUTMY_E2E_URL || 'http://127.0.0.1:5173',
    storageState: await page.context().storageState(), hasTouch: true,
    isMobile: browserName !== 'firefox',
    viewport: { width: 390, height: 844 },
  })
  const touchPage = await touchContext.newPage()
  touchPage.on('pageerror', error => errors.push(error.message))
  try {
    await diagnoseNativePreview(touchPage, testInfo, { browserName, headless, context: 'touch' }, async () => {
      await touchPage.goto('/')
      if (browserName === 'chromium') chromeTouch = await touchContext.newCDPSession(touchPage)
      // A separate tab starts with its own active project and selection. Shared
      // localStorage contains the cuts, but this context has no session view.
      await touchPage.getByRole('button', { name: /^(Мои проекты|My projects)$/ }).click()
      await expect(touchPage.locator('.project-row-actions')).toHaveCount(1)
      await touchPage.getByRole('button', { name: /^(Открыть проект «|Open project “)/ }).click()
      await goToClips(touchPage)
      await touchPage.getByRole('button', { name: /^(Редактировать фрагмент 2|Edit clip 2)$/ }).click()
      await goToMoment(touchPage)
      await expect.poll(() => touchPage.locator('video').evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
      await expect.poll(() => touchPage.locator('video').evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(12, 1)
      // Native touch input reaches the timeline and seeks the actual media.
      await touchPage.locator('.trim-track').tap({ position: { x: 12, y: 30 } })
      await expect.poll(() => touchPage.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeLessThan(2)
      await expect.poll(() => touchPage.locator('video').evaluate(element => (element as HTMLVideoElement).seeking)).toBe(false)
      await touchPage.locator('.trim-handle.start').tap()
      await expect(touchPage.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '6000')
      if (browserName === 'chromium') {
        // Chromium exposes trusted multi-point touch injection via CDP. Firefox
        // and WebKit are tested with native taps and exact-field fallback; these
        // checks do not pretend that synthetic DOM events are a physical drag.
        const handle = await touchPage.locator('.trim-handle.start').boundingBox()
        const track = await touchPage.locator('.trim-track').boundingBox()
        expect(handle).not.toBeNull(); expect(track).not.toBeNull()
        const cdp = chromeTouch!
        const x = handle!.x + handle!.width / 2, y = handle!.y + handle!.height / 2
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + track!.width * .04, y, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect.poll(async () => Number(await touchPage.locator('.trim-handle.start').getAttribute('aria-valuenow'))).toBeGreaterThan(6000)
        // This input session is released together with its touch context below.
        await showExactTimes(touchPage)
        await touchPage.locator('#range-start').fill('00:00:06.000')
        await touchPage.locator('#range-start').press('Tab')
      }
      await touchPage.getByRole('button', { name: labels.preview }).tap()
      await expect.poll(() => touchPage.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(6)
      await expect.poll(() => touchPage.locator('video').evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
    })
    await matrix(touchPage, phoneSizes, true)
    await goToExport(touchPage)
    const pending = touchPage.waitForEvent('download')
    await touchPage.getByRole('link', { name: labels.download }).first().tap()
    const download = await pending
    expect(await download.failure()).toBeNull()
    await download.saveAs(testInfo.outputPath(`${browserName}-touch-download.mp4`))
  } finally { await touchContext.close() }

  // A full collection uses its own scroll area and reveals the newest clip.
  // Its actions remain reachable while the desktop document stays fixed.
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await setTheme(page, 'light')
  for (let i = 0; i < 10; i++) await addClip(page)
  await saveClip(page)
  await expect(page.locator('.range-list li')).toHaveCount(12)
  const list = page.locator('.range-list')
  await expect.poll(() => list.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(10)
  const selected = list.locator('li.editing')
  await expect.poll(() => selected.evaluate(element => {
    const rect = element.getBoundingClientRect(), parent = element.closest('.range-list')!.getBoundingClientRect()
    return rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1
  })).toBe(true)
  await checkLayout(page, 'workspace', false, `${browserName}-twelve-clips-short-laptop`)
  await screen(page, testInfo, `${browserName}-twelve-clips-short-laptop`)
  expect(errors, 'uncaught browser errors').toEqual([])
  const matrixPath = testInfo.outputPath('viewport-matrix.json')
  await writeFile(matrixPath, JSON.stringify(evidence, null, 2))
  await testInfo.attach('Viewport matrix and measured controls', { path: matrixPath, contentType: 'application/json' })
})
