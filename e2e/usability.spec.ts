import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { addClip, chooseOption, goToClips, goToExport, goToMoment, goToSource, showExactTimes, showExportSettings, closeExportSettings, uploadThroughUI } from './helpers'

// Text-only resizing leaves the viewport and layout media queries unchanged.
// It complements the 320 CSS-pixel reflow matrix; device scale is not text zoom.
async function resizeText(page: Page, scale = 2) {
  // Lazy selectors replace their loading trigger with a new DOM node. Capture
  // the final control so that replacement cannot discard the measured size.
  await expect(page.locator('.select-control[aria-busy="true"]')).toHaveCount(0)
  return page.evaluate(scale => {
    for (const element of document.querySelectorAll<HTMLElement>('[data-qa-text-resize]')) {
      element.style.fontSize = element.dataset.qaTextResize ?? ''
      delete element.dataset.qaTextResize
      delete element.dataset.qaTextResizeComputed
    }
    const elements = [...document.querySelectorAll<HTMLElement>('body, body *')]
      .filter(element => element instanceof HTMLElement)
    const sizes = elements.map(element => parseFloat(getComputedStyle(element).fontSize))
    for (const [index, element] of elements.entries()) {
      element.dataset.qaTextResize = element.style.fontSize
      element.dataset.qaTextResizeComputed = `${sizes[index]}`
      element.style.fontSize = `${sizes[index] * scale}px`
    }
    return { viewportWidth: innerWidth, scale }
  }, scale)
}

async function assertReflow(page: Page, description: string, textScale?: number) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  const result = await page.evaluate(textScale => {
    const visible = (element: HTMLElement) => {
      const disclosure = element.closest('details:not([open])')
      if (disclosure && !disclosure.querySelector(':scope > summary')?.contains(element)) return false
      const style = getComputedStyle(element)
      return element.getClientRects().length > 0 && style.visibility !== 'hidden'
        && !element.closest('[hidden],dialog:not([open])') && !element.classList.contains('skip-link')
    }
    const controls = [...document.querySelectorAll<HTMLElement>('button,input:not([type=file]),select,a[href],summary')]
      .filter(visible)
      .filter(element => !(element as HTMLButtonElement).disabled)
      .map(element => {
        const target = element.matches('input[type=checkbox]') ? element.closest('label') ?? element : element
        const bounds = target.getBoundingClientRect()
        return { label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 100) || element.id,
          left: bounds.left, right: bounds.right, width: bounds.width, height: bounds.height,
          textOverflow: element.matches('button,summary') && [...element.childNodes].some(node =>
            node.nodeType === Node.TEXT_NODE ? !!node.textContent?.trim()
              : node instanceof HTMLElement && node.getAttribute('aria-hidden') !== 'true' && !!node.textContent?.trim())
            && element.scrollWidth > element.clientWidth + 1 }
      })
    const clippedStepNumbers = [...document.querySelectorAll<HTMLElement>('.step-number')]
      .filter(visible)
      .filter(element => element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)
      .map(element => element.textContent)
    const clippedSupportingText = [...document.querySelectorAll<HTMLElement>('.source-meta,.tick-labels > span')]
      .filter(visible)
      .filter(element => {
        const bounds = element.getBoundingClientRect()
        return element.scrollWidth > element.clientWidth + 1 || bounds.left < -1 || bounds.right > innerWidth + 1
      })
      .map(element => element.textContent)
    const unscaledText = textScale ? [...document.querySelectorAll<HTMLElement>('h1,h2,h3,p,button,a[href],label,summary,time,.source-meta,.tick-labels > span')]
      .filter(visible)
      .filter(element => !element.dataset.qaTextResizeComputed || Math.abs(parseFloat(getComputedStyle(element).fontSize) - Number(element.dataset.qaTextResizeComputed) * textScale) > .2)
      .map(element => ({ text: element.textContent?.trim().slice(0, 80), actual: getComputedStyle(element).fontSize,
        expected: element.dataset.qaTextResizeComputed ? Number(element.dataset.qaTextResizeComputed) * textScale : null })) : []
    return { width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, controls, clippedStepNumbers, clippedSupportingText, unscaledText }
  }, textScale)
  expect(result.overflow, `${description}: horizontal page overflow`).toBeLessThanOrEqual(1)
  expect(result.controls.filter(control => control.left < -1 || control.right > result.width + 1),
    `${description}: interactive controls outside the viewport`).toEqual([])
  expect(result.controls.filter(control => control.textOverflow), `${description}: clipped button text`).toEqual([])
  expect(result.clippedStepNumbers, `${description}: clipped stage numbers`).toEqual([])
  expect(result.clippedSupportingText, `${description}: clipped source metadata or timeline labels`).toEqual([])
  expect(result.unscaledText, `${description}: all visible text received the requested font scaling`).toEqual([])
  return result
}

test('200% text measures the final selector when its lazy module is delayed', async ({ page }) => {
  const source = { id: 'src_text_resize', title: 'Delayed audio selector', kind: 'upload', duration_ms: 12000,
    width: 640, height: 360, preview_url: '/text-resize-fixture.mp4', embed_url: null, thumbnail_url: null, preview_kind: 'native' }
  let releaseModule!: () => void
  const moduleGate = new Promise<void>(resolve => { releaseModule = resolve })
  await page.route(/\/RadixSelectControl(?:-[^/]+)?\.(?:js|tsx)(?:\?.*)?$/, async route => {
    await moduleGate
    await route.continue()
  })
  await page.route('**/api/v1/session', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/v1/sources/' + source.id, route => route.fulfill({ json: source }))
  await page.route('**/api/v1/sources/' + source.id + '/tracks', route => route.fulfill({ json: { tracks: [
    { index: 0, type: 'video', codec: 'h264' }, { index: 1, type: 'audio', codec: 'aac', default: true },
  ] } }))
  await page.route('**/text-resize-fixture.mp4', async route => route.fulfill({
    contentType: 'video/mp4', body: await readFile(process.env.CUTMY_E2E_MEDIA!),
  }))
  await page.addInitScript(sourceID => {
    localStorage.setItem('cutmyvideo.locale', 'en')
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, step: 2, source_id: sourceID,
      ranges: [{ id: 'range_text_resize', label: 'Clip 1', start_ms: 1000, end_ms: 4000 }],
      selected_id: 'range_text_resize', selected_range_ids: ['range_text_resize'],
      output: { format: 'mp4', quality: '1080p', cut_mode: 'accurate' } }))
  }, source.id)
  await page.goto('/?lang=en')
  await showExportSettings(page)
  const selector = page.locator('#audio-track-export')
  await expect(selector).toHaveAttribute('aria-busy', 'true')
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
  const baseline = await selector.evaluate(element => parseFloat(getComputedStyle(element).fontSize))
  const resizing = resizeText(page)
  try {
    // A rendering turn while the module remains held proves that measurement
    // waits for replacement, rather than scaling the soon-to-be-discarded node.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await selector.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(baseline)
    await expect(selector).toHaveAttribute('aria-busy', 'true')
  } finally {
    releaseModule()
    await resizing
  }
  await expect(selector).not.toHaveAttribute('aria-busy', 'true')
  expect(await selector.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(baseline * 2)
  await expect(selector).toHaveAttribute('data-qa-text-resize-computed', String(baseline))
  await assertReflow(page, 'Delayed source selector at 200% text', 2)
})

for (const width of [320, 390, 1280]) {
  test(`200% text remains readable throughout the workspace at ${width}px without changing the viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 800 })
    await page.goto('/')
    await page.getByRole('button', { name: 'English', exact: true }).click()
    const measurements: unknown[] = []
    const measure = async (stage: string) => {
      expect((await resizeText(page)).viewportWidth).toBe(width)
      measurements.push({ stage, ...await assertReflow(page, `${stage} at 200% text`, 2) })
      await testInfo.attach(`${stage}-${width}-200-percent-text`, {
        body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
      })
    }
    await measure('source')
    await uploadThroughUI(page)
    await expect(page.locator('.editor-workspace')).toBeVisible()
    await expect(page.locator('.moment-controls')).toBeVisible()
    await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
    // The simplified clickable boundary values are the default Moment view;
    // checking only the disclosed inputs would miss overlapping large text.
    await measure('moment-collapsed')
    await showExactTimes(page)
    await measure('moment')
    const start = page.getByLabel('Start', { exact: true })
    await start.fill('1.250'); await start.press('Tab')
    const end = page.getByLabel('End', { exact: true })
    await end.fill('4.750'); await end.press('Tab')
    await goToClips(page)
    await measure('clips')
    await page.getByRole('textbox', { name: 'Clip 1 name', exact: true }).fill('Birthday 🎂 — family memories')
    await goToExport(page)
    await measure('export')
    await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled()
    await expect(page.locator('.clip-row-name').first()).toHaveValue('Birthday 🎂 — family memories')
    await testInfo.attach('text-resize-measurements', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
  })
}

test('long Unicode source and clip names keep actions reachable on a narrow phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  const filename = `${'🎬'.repeat(35)}семейное-видео.mp4`
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await expect(page.locator('.upload-button')).toBeEnabled()
  await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'video/mp4', buffer: await readFile(process.env.CUTMY_E2E_MEDIA!) })
  await expect(page.locator('video')).toBeVisible()
  await expect(page.locator('.source-title')).toContainText(filename)
  await assertReflow(page, 'Long source filename')
  await goToClips(page)
  const clipName = `${'🎂'.repeat(15)} Семейный праздник`
  await page.getByRole('textbox', { name: 'Clip 1 name', exact: true }).fill(clipName)
  await assertReflow(page, 'Long editable clip name')
  await goToExport(page)
  await assertReflow(page, 'Long export clip name')
  await expect(page.locator('.clip-row-name').first()).toHaveValue(clipName)
  await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled()
  await testInfo.attach('narrow-phone-long-names', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
})

test('Russian ready downloads remain readable at 200% text on a 320px phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/')
  await uploadThroughUI(page)
  await goToExport(page)
  await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
  const download = page.getByRole('link', { name: 'Скачать', exact: true })
  await expect(download).toBeVisible({ timeout: 60_000 })
  await resizeText(page)
  const result = await assertReflow(page, 'Russian ready downloads at 200% text', 2)
  await expect(page.locator('.results-panel time[datetime]')).toBeVisible()
  await download.scrollIntoViewIfNeeded()
  const pending = page.waitForEvent('download')
  await download.click()
  expect(await (await pending).failure()).toBeNull()
  await testInfo.attach('russian-ready-download-320-200-percent-text', {
    body: await page.screenshot({ fullPage: true }), contentType: 'image/png',
  })
  await testInfo.attach('ready-download-text-resize-measurements', {
    body: JSON.stringify(result, null, 2), contentType: 'application/json',
  })
})

test('keyboard source and workspace navigation preserves exact edits and restores heading focus', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.waitForFunction(() => Boolean(history.state?.cutmyWorkflow))
  await page.locator('.skip-link').focus(); await page.keyboard.press('Enter')
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  await settings.click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).not.toBeVisible(); await expect(settings).toBeFocused()
  await page.goForward(); await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible()
  await expect(settings).toBeFocused()
  await uploadThroughUI(page)
  await showExactTimes(page)
  await page.getByLabel('Start', { exact: true }).fill('1.250')
  await page.getByLabel('Start', { exact: true }).press('Tab')
  await page.getByLabel('End', { exact: true }).fill('4.750')
  await page.getByLabel('End', { exact: true }).press('Tab')
  const changeSource = page.getByRole('button', { name: 'Change video', exact: true })
  await changeSource.focus(); await page.keyboard.press('Enter')
  await expect(page.locator('.source-chooser')).toBeVisible()
  await expect(page.locator('.page-heading h1')).toBeFocused()
  const resume = page.getByRole('button', { name: 'Return to editing', exact: true })
  await resume.focus(); await page.keyboard.press('Enter')
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(page.locator('.page-heading h1')).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('#editor'))).toBe(true)
  await showExactTimes(page)
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('1.250')
  await expect(page.getByLabel('End', { exact: true })).toHaveValue('4.750')
  await expect(page.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '1250')
  await expect(page.locator('.trim-handle.end')).toHaveAttribute('aria-valuenow', '4750')
})

test('settings stay dismissible and keep native focus containment on short screens', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 })
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  await settings.click()
  const dialog = page.getByRole('dialog')
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  await close.focus(); await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Reset defaults', exact: true })).toBeFocused()
  await page.keyboard.press('Tab'); await expect(close).toBeFocused()
  const theme = dialog.getByRole('combobox', { name: 'Appearance', exact: true })
  await chooseOption(page, theme, 'Dark')
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).scrollIntoViewIfNeeded()
  const bounds = await close.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.y, 'Close remains in the visible viewport after scrolling settings').toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(390)
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  if (await dialog.isVisible()) await page.keyboard.press('Escape')
  await expect(settings).toBeFocused()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.setViewportSize({ width: 320, height: 480 })
  await settings.click(); await assertReflow(page, 'Narrow short settings')
  await page.keyboard.press('Escape'); await expect(settings).toBeFocused()
})

test('rotating touch layout preserves the selected interval and player position', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: process.env.CUTMY_E2E_URL || 'http://127.0.0.1:5173', hasTouch: true, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  try {
    await page.goto('/')
    await uploadThroughUI(page)
    await showExactTimes(page)
    await page.getByLabel('Начало', { exact: true }).fill('00:00:01.250')
    await page.getByLabel('Начало', { exact: true }).press('Tab')
    await page.getByLabel('Конец', { exact: true }).fill('00:00:04.750')
    await page.getByLabel('Конец', { exact: true }).press('Tab')
    const video = page.locator('video')
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1)
    await video.evaluate(element => { (element as HTMLVideoElement).currentTime = 2.5 })
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).seeking)).toBe(false)
    for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await assertReflow(page, `${viewport.width}×${viewport.height} after rotation`)
      await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:01.250')
      await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:04.750')
      expect(await video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(2.5, 1)
      expect(await video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
    }
    await testInfo.attach('rotation-restored', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  } finally { await context.close() }
})

test('reduced-motion preference removes nonessential transitions without blocking import', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const motion = await page.evaluate(() => ({
    requested: matchMedia('(prefers-reduced-motion: reduce)').matches,
    transitions: [...document.querySelectorAll<HTMLElement>('button,input,a,main')]
      .filter(element => element.getClientRects().length > 0)
      .flatMap(element => getComputedStyle(element).transitionDuration.split(',').map(value => parseFloat(value)))
  }))
  expect(motion.requested).toBe(true)
  expect(motion.transitions.every(duration => duration === 0)).toBe(true)
  await uploadThroughUI(page)
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await goToSource(page); await goToMoment(page)
  await expect(page.locator('.page-heading h1')).toBeFocused()
})

test('single-clip export keeps optional settings in a dismissible native dialog', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await uploadThroughUI(page)
  await goToExport(page)
  const dialog = page.locator('.export-settings-dialog')
  const toggle = page.getByRole('button', { name: 'Export settings', exact: true })
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('#quality')).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Cut a clip', exact: true })).toBeEnabled()
  await toggle.focus(); await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Video quality', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#quality')).not.toBeVisible()
  await expect(toggle).toBeFocused()
})

test('new editing controls keep full touch targets on narrow phones', async ({ browser, browserName }, testInfo) => {
  for (const width of [320, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 720 }, hasTouch: true,
      isMobile: browserName !== 'firefox' })
    try {
      const page = await context.newPage()
      const evidence: unknown[] = []
      const measure = async (name: string, scope: string) => {
        const controls = await page.locator(scope).evaluateAll(roots => roots.flatMap(root =>
          [...root.querySelectorAll<HTMLElement>('button,input:not([type=file]),select,[role=slider],summary')]
            .filter(element => {
              const bounds = element.getBoundingClientRect()
              return bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== 'hidden'
            })
            .map(element => {
              const target = element.matches('input[type=checkbox]') ? element.closest('label') ?? element : element
              const bounds = target.getBoundingClientRect()
              return { name: element.getAttribute('aria-label') || target.textContent?.trim() || element.id,
                width: bounds.width, height: bounds.height }
            })))
        expect(controls.length, `${name}: measured native controls`).toBeGreaterThan(0)
        expect(controls.filter(control => control.width < 43.5 || control.height < 43.5),
          `${name} at ${width}px: targets smaller than 44 CSS px`).toEqual([])
        evidence.push({ name, width, controls })
      }
      await page.goto('/?lang=en')
      await uploadThroughUI(page)
      await expect(page.locator('.editor-workspace')).toBeVisible()
      await showExactTimes(page)
      await page.locator('.timeline-media-disclosure > summary').click()
      await expect(page.locator('.audio-waveform')).toBeVisible()
      await measure('history and waveform', '.edit-history-actions,.audio-waveform')
      await page.locator('.timeline-media-disclosure > summary').click()
      const frame = page.locator('.crop-editor')
      await expect(frame.locator('select')).not.toBeVisible()
      await frame.locator('summary').click()
      await frame.locator('select').selectOption('1:1')
      await expect(page.locator('.crop-resize')).toBeVisible()
      await measure('crop presets, area controls and resize target', '.crop-editor,.crop-overlay')
      await frame.locator('select').selectOption('custom')
      await measure('custom crop dimensions and apply', '.crop-editor')
      await frame.getByLabel('Width', { exact: true }).fill('9')
      await frame.getByLabel('Height', { exact: true }).fill('16')
      await frame.getByRole('button', { name: 'Apply', exact: true }).click()
      await measure('applied custom crop and resize target', '.crop-editor,.crop-overlay')
      await frame.locator('summary').click()
      await expect(frame.locator('select')).not.toBeVisible()
      await addClip(page)
      await goToClips(page)
      await page.locator('.clip-list > li').first().locator('.clip-row-menu > summary').click()
      await measure('clip reordering and history', '.clip-row-actions,.edit-history-actions')
      await goToExport(page)
      await showExportSettings(page)
      await measure('source cleanup', '.source-cleanup-choice')
      await closeExportSettings(page)
      await goToSource(page)
      await page.getByRole('button', { name: 'My projects', exact: true }).click()
      await expect(page.locator('.project-row-actions')).toHaveCount(1)
      await measure('saved project and plan actions', '.project-library')
      await testInfo.attach(`new-controls-${width}-touch-targets`, {
        body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
      })
    } finally { await context.close() }
  }
})
