import { expect, test } from '@playwright/test'
import { api, goToExport, setTheme, uploadThroughUI, waitJob } from './helpers'

test('mobile source and range controls remain usable at 360 and 390 px', async ({ page }, testInfo) => {
  await page.goto('/')
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  }
  await page.screenshot({ path: testInfo.outputPath('mobile-empty.png'), fullPage: true })
  await testInfo.attach('Mobile empty state', { path: testInfo.outputPath('mobile-empty.png'), contentType: 'image/png' })
  await uploadThroughUI(page)
  await expect(page.locator('video')).toBeVisible()
  const start = page.getByLabel('Начало', { exact: true })
  await start.fill('00:00:01.500')
  await start.press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:04.000')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await page.getByRole('button', { name: 'Добавить фрагмент', exact: true }).tap()
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
