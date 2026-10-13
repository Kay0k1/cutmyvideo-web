import { expect, test } from '@playwright/test'
import { api, goToClips, goToExport, setTheme, showExactTimes, stepButton, uploadThroughUI, waitJob, showExportSettings } from './helpers'

test('mobile source and range controls remain usable at 360 and 390 px', async ({ page }, testInfo) => {
  await page.goto('/')
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  }
  await page.screenshot({ path: testInfo.outputPath('mobile-empty.png'), fullPage: true })
  await testInfo.attach('Mobile empty state', { path: testInfo.outputPath('mobile-empty.png'), contentType: 'image/png' })
  await uploadThroughUI(page)
  await showExactTimes(page)
  await expect(page.locator('video')).toBeVisible()
  const start = page.getByLabel('Начало', { exact: true })
  await start.fill('00:00:01.500')
  await start.press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:04.000')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await goToClips(page)
  await page.getByRole('button', { name: 'Добавить фрагмент', exact: true }).tap()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await showExactTimes(page)
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
  await page.getByRole('button', { name: 'Посмотреть фрагмент', exact: true }).tap()
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0.2)
  await page.getByRole('button', { name: 'Остановить просмотр', exact: true }).tap()
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
      await expect(page.getByLabel('Начало', { exact: true })).toBeVisible()
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: testInfo.outputPath(`mobile-moments-${theme}-${width}.png`), fullPage: true })
      await testInfo.attach(`Mobile moments ${theme} ${width}`, { path: testInfo.outputPath(`mobile-moments-${theme}-${width}.png`), contentType: 'image/png' })
    }
  }
  await goToExport(page)
  const creationPromise = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: /Вырезать/ }).tap()
  const creation = await creationPromise
  expect(creation.ok()).toBeTruthy()
  const job = await waitJob(page.request, (await creation.json()).id)
  expect(job.status).toBe('succeeded')
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(2)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Скачать', exact: true }).first().tap()
  const download = await downloadPromise
  expect(await download.failure()).toBeNull()
  await download.saveAs(testInfo.outputPath('mobile-clip.mp4'))
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: testInfo.outputPath(`mobile-output-${theme}.png`), fullPage: true })
    await testInfo.attach(`Mobile output ${theme}`, { path: testInfo.outputPath(`mobile-output-${theme}.png`), contentType: 'image/png' })
  }
})

test('mobile English navigation and donation dialog fit the screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).tap()
  for (const name of ['Examples', 'Settings', 'Support']) {
    await page.getByRole('button', { name, exact: true }).tap()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    if (name === 'Support') {
      await expect(dialog.getByText('TEaL7LYGWKLGMALr8QZKV412xAjC6x4MdE', { exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('mobile-support.png'), fullPage: true })
      await testInfo.attach('Mobile support', { path: testInfo.outputPath('mobile-support.png'), contentType: 'image/png' })
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).tap()
    await expect(dialog).not.toBeVisible()
  }
})

test('touch selectors and clip selection remain usable without native select popups', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 })
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).tap()
  await uploadThroughUI(page)
  await goToClips(page)
  const first = page.getByRole('checkbox', { name: 'Select clip 1', exact: true })
  await first.tap()
  await expect(first).not.toBeChecked()
  await expect(page.locator('.export-submit')).toBeDisabled()
  await first.tap()
  await expect(first).toBeChecked()
  await goToExport(page)
  await showExportSettings(page)
  const quality = page.getByRole('combobox', { name: 'Video quality', exact: true })
  await quality.tap()
  const popup = page.getByRole('listbox')
  await expect(popup).toBeVisible()
  const bounds = await popup.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(-1)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1)
  expect(bounds.top).toBeGreaterThanOrEqual(-1)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 1)
  for (const option of await popup.getByRole('option').all()) {
    const rect = await option.boundingBox()
    expect(rect).not.toBeNull()
    expect(rect!.height).toBeGreaterThanOrEqual(43.5)
    expect(rect!.width).toBeGreaterThanOrEqual(43.5)
  }
  await popup.getByRole('option', { name: 'Up to 720p', exact: true }).tap()
  await expect(quality).toContainText('720p')
  await expect(popup).not.toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('touch timeline permits page scrolling and horizontal scrubbing without moving clip boundaries', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 })
  await page.goto('/')
  await uploadThroughUI(page)
  const scrubber = page.getByRole('slider', { name: 'Позиция плеера', exact: true })
  await expect(scrubber).toBeVisible()
  await scrubber.scrollIntoViewIfNeeded()
  const bounds = await scrubber.boundingBox()
  expect(bounds).not.toBeNull()
  const x = bounds!.x + bounds!.width * .25, y = bounds!.y + bounds!.height / 2
  const session = await page.context().newCDPSession(page)
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', touchX = x, touchY = y) => {
    await session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: touchX, y: touchY }] })
  }
  const beforePosition = await scrubber.getAttribute('aria-valuenow')
  const scroll = await page.evaluate(() => ({ top: scrollY, remaining: document.documentElement.scrollHeight - innerHeight - scrollY }))
  const direction = scroll.remaining > 80 ? -1 : 1
  await touch('touchStart')
  for (let step = 1; step <= 5; step++) await touch('touchMove', x, y + direction * step * 15)
  await touch('touchEnd')
  if (direction === -1) await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scroll.top + 10)
  else await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(scroll.top - 10)
  await expect(scrubber).toHaveAttribute('aria-valuenow', beforePosition!)
  await scrubber.scrollIntoViewIfNeeded()
  const nextBounds = await scrubber.boundingBox()
  expect(nextBounds).not.toBeNull()
  const nextX = nextBounds!.x + nextBounds!.width * .25, nextY = nextBounds!.y + nextBounds!.height / 2
  await touch('touchStart', nextX, nextY)
  for (let step = 1; step <= 5; step++) await touch('touchMove', nextX + nextBounds!.width * .06 * step, nextY)
  await touch('touchEnd')
  await expect.poll(async () => Number(await scrubber.getAttribute('aria-valuenow'))).toBeGreaterThan(6000)
  const start = page.getByRole('slider', { name: 'Начало фрагмента на шкале', exact: true })
  await expect(start).toHaveAttribute('aria-valuenow', '0')
  await expect(page.getByRole('slider', { name: 'Конец фрагмента на шкале', exact: true })).toHaveAttribute('aria-valuenow', '12000')
  const startBounds = await start.boundingBox()
  expect(startBounds).not.toBeNull()
  const startX = startBounds!.x + startBounds!.width / 2, startY = startBounds!.y + startBounds!.height / 2
  await touch('touchStart', startX, startY)
  for (let step = 1; step <= 5; step++) await touch('touchMove', startX + nextBounds!.width * .02 * step, startY)
  await touch('touchEnd')
  await expect(start).toHaveAttribute('aria-valuenow', '1200')
  await expect(page.getByRole('slider', { name: 'Конец фрагмента на шкале', exact: true })).toHaveAttribute('aria-valuenow', '12000')
  await session.detach()
})
