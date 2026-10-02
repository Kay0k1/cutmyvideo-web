import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { api, goToExport, goToMoments, goToSource, probeDownloadedFile, setTheme, stepButton, uploadThroughUI, waitJob } from './helpers'
import { textContrast } from './contrast'

async function completedExport(page: Page) {
  await page.goto('/')
  const sourcePromise = page.waitForResponse(response => response.url().endsWith(`${api}/uploads`) && response.request().method() === 'POST')
  await uploadThroughUI(page)
  const source = await (await sourcePromise).json()
  await page.getByLabel('Начало', { exact: true }).fill('00:00:01.250')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:03.750')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await goToExport(page)
  const jobPromise = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
  const creation = await jobPromise
  expect(creation.ok()).toBeTruthy()
  const job = await waitJob(page.request, (await creation.json()).id)
  expect(job.status).toBe('succeeded')
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible()
  return { source, job }
}

test('theme follows the system, explicit choice survives reload and is applied before the first frame', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      (window as Window & { firstTheme?: string }).firstTheme = document.documentElement.dataset.theme
    })
  })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await setTheme(page, 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => page.evaluate(() => (window as Window & { firstTheme?: string }).firstTheme)).toBe('dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await setTheme(page, 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await setTheme(page, 'system')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('steps preserve work, keep export controls off the first screen and replace sources deliberately', async ({ page }) => {
  await page.goto('/')
  await expect(stepButton(page, 1)).toHaveAttribute('aria-current', 'step')
  await expect(stepButton(page, 2)).toBeDisabled()
  await expect(stepButton(page, 3)).toBeDisabled()
  await expect(page.getByLabel('Начало', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'MP3 Аудио', exact: true })).not.toBeVisible()
  await uploadThroughUI(page)
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.250')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:05.500')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await page.getByRole('button', { name: 'Посмотреть фрагмент', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(2.4)
  await page.getByRole('button', { name: 'Остановить просмотр', exact: true }).click()
  const playhead = await page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)
  await page.getByRole('button', { name: 'Добавить фрагмент', exact: true }).click()
  await goToExport(page)
  await page.getByRole('button', { name: 'MP3 Аудио', exact: true }).click()
  await goToMoments(page)
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(playhead, 1)
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
  await expect(page.locator('.range-list > li')).toHaveCount(2)
  await page.getByRole('button', { name: /Другое видео/ }).click()
  await expect(stepButton(page, 1)).toHaveAttribute('aria-current', 'step')
  await goToMoments(page)
  await expect(page.locator('.range-list > li')).toHaveCount(2)
  await page.locator('.range-list > li').first().getByRole('button').first().click()
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:02.250')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:05.500')
  await goToExport(page)
  await expect(page.getByRole('button', { name: 'MP3 Аудио', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(stepButton(page, 3)).toHaveAttribute('aria-current', 'step')
  await uploadThroughUI(page)
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
  await expect(page.locator('.range-list > li')).toHaveCount(1)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:00.000')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:12.000')
})

test('the website rejects non-MP4 files and non-YouTube URLs before an API mutation', async ({ page }) => {
  const mutations: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/v1\/(uploads|sources)$/.test(request.url())) mutations.push(request.url())
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByLabel('YouTube link', { exact: true }).fill('https://example.com/video.mp4')
  await page.getByRole('button', { name: 'Open video', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByLabel('YouTube link', { exact: true })).toHaveValue('https://example.com/video.mp4')
  await goToSource(page)
  await page.getByRole('button', { name: 'MP4 file', exact: true }).click()
  const wav = await readFile(process.env.CUTMY_E2E_AUDIO!)
  for (const file of [process.env.CUTMY_E2E_AUDIO!, { name: 'renamed.mp4', mimeType: 'video/webm', buffer: wav }, { name: 'renamed.mp4', mimeType: 'video/mp4', buffer: wav }]) {
    const chooser = page.waitForEvent('filechooser')
    await page.locator('button.upload-button').click()
    await (await chooser).setFiles(file)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(stepButton(page, 1)).toHaveAttribute('aria-current', 'step')
  }
  expect(mutations).toEqual([])
  await uploadThroughUI(page)
  await expect(page.locator('video')).toBeVisible()
  expect(mutations).toHaveLength(1)
})

test('both themes keep visible text readable through every editing stage', async ({ page }, testInfo) => {
  await page.goto('/')
  await uploadThroughUI(page)
  const measurements: unknown[] = []
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    for (const stage of [goToSource, goToMoments, goToExport]) {
      await stage(page)
      const values = await textContrast(page)
      measurements.push({ theme, stage: stage.name, values })
      expect(values.filter(value => value.ratio < value.minimum), `${theme} ${stage.name}: text contrast below W3C minimum`).toEqual([])
    }
  }
  await testInfo.attach('Computed text contrast across themes and stages', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
})

test('an MP4 containing only audio does not replace the current video or ranges', async ({ page }) => {
  await page.goto('/')
  await uploadThroughUI(page)
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.250')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await uploadThroughUI(page, process.env.CUTMY_E2E_AUDIO_MP4!)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(stepButton(page, 1)).toHaveAttribute('aria-current', 'step')
  await goToMoments(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:02.250')
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(12, 1)
})

test('a completed job does not override the chosen moments or source step on reload', async ({ page }, testInfo) => {
  const { job } = await completedExport(page)
  await goToMoments(page)
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.000')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:04.000')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await page.reload()
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:02.000')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:04.000')
  await goToSource(page)
  await page.reload()
  await expect(stepButton(page, 1)).toHaveAttribute('aria-current', 'step')
  await goToMoments(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:02.000')
  await goToExport(page)
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveAttribute('href', job.items[0].artifact.download_url)
  const probe = await probeDownloadedFile(page.request, job.items[0].artifact.download_url, 'restored-original-job.mp4', testInfo)
  expect(Math.abs(Number(probe.format.duration) - 2.5)).toBeLessThan(0.2)
})

test('a surviving completed download stays usable when source restoration returns 404', async ({ page }, testInfo) => {
  const { source, job } = await completedExport(page)
  // Simulate only expired source metadata. The job, artifact and download are real.
  await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({
    status: 404,
    json: { error: { code: 'source_unavailable', message: 'Source expired' } },
  }))
  await page.reload()
  await expect(stepButton(page, 3)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByText('Видео больше недоступно, но результат экспорта сохранился. Чтобы вырезать новые моменты, откройте видео заново.', { exact: true })).toBeVisible()
  await expect(stepButton(page, 2)).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })).not.toBeVisible()
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveAttribute('href', job.items[0].artifact.download_url)
  await goToSource(page)
  await expect(page.getByRole('alert')).toBeVisible()
  await goToExport(page)
  const probe = await probeDownloadedFile(page.request, job.items[0].artifact.download_url, 'download-after-source-expiry.mp4', testInfo)
  expect(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === 'video')).toBeTruthy()
  expect(Math.abs(Number(probe.format.duration) - 2.5)).toBeLessThan(0.2)
})
