import { expect, test } from '@playwright/test'

test('mobile source and range controls remain usable at 360 and 390 px', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Загрузить файл', exact: true })).toBeEnabled()
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  }
  await page.screenshot({ path: testInfo.outputPath('mobile-empty.png'), fullPage: true })
  await testInfo.attach('Mobile empty state', { path: testInfo.outputPath('mobile-empty.png'), contentType: 'image/png' })
  await page.locator('input[type=file]').setInputFiles(process.env.CUTMY_E2E_MEDIA!)
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
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('button', { name: /Вырезать/ })).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: testInfo.outputPath(`mobile-editor-${width}.png`), fullPage: true })
    await testInfo.attach(`Mobile editor ${width}`, { path: testInfo.outputPath(`mobile-editor-${width}.png`), contentType: 'image/png' })
  }
})
