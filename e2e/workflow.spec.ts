import { readBrowserDraft } from './browserProjectStorage';
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { addClip, api, goToClips, goToExport, goToMoment, goToSource, probeDownloadedFile, setTheme, showExactTimes, showExportSettings, closeExportSettings, uploadThroughUI, waitJob } from './helpers'
import { textContrast } from './contrast'

async function completedExport(page: Page) {
  await page.goto('/')
  const sourcePromise = page.waitForResponse(response => response.url().endsWith(`${api}/uploads`) && response.request().method() === 'POST')
  await uploadThroughUI(page)
  await showExactTimes(page)
  const source = await (await sourcePromise).json()
  await page.getByLabel('Начало', { exact: true }).fill('00:00:01.250')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:03.750')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await goToExport(page)
  // These scenarios return to the source after export to continue editing.
  await showExportSettings(page)
  await page.getByRole('checkbox', { name: 'Удалить исходник после экспорта', exact: true }).uncheck()
  await closeExportSettings(page)
  const jobPromise = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
  const creation = await jobPromise
  expect(creation.ok()).toBeTruthy()
  const job = await waitJob(page.request, (await creation.json()).id)
  expect(job.status).toBe('succeeded')
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible()
  return { source, job }
}

test('concurrent bootstrap effects share one real request and preserve the owner cookie on reload', async ({ page }) => {
  let requests = 0
  let received!: () => void
  let release!: () => void
  const intercepted = new Promise<void>(resolve => { received = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const setCookieCounts: number[] = []
  await page.route(`**${api}/session`, async route => {
    requests++
    const response = await route.fetch()
    setCookieCounts.push(response.headersArray().filter(header => header.name.toLowerCase() === 'set-cookie').length)
    received()
    await gate
    await route.fulfill({ response })
  })
  try {
    await page.goto('/')
    await intercepted
    // Let React's mount effects run while the real response is still in flight.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(requests).toBe(1)
  } finally {
    release()
  }
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled()
  const ownerCookies = (await page.context().cookies()).filter(cookie => cookie.name === 'cutmy_session')
  expect(ownerCookies).toHaveLength(1)
  expect(ownerCookies[0].httpOnly).toBe(true)
  expect(ownerCookies[0].sameSite).toBe('Lax')
  expect(setCookieCounts).toEqual([1])
  await page.reload()
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled()
  expect(requests).toBe(2)
  expect(setCookieCounts).toEqual([1, 0])
  const reloadedCookies = (await page.context().cookies()).filter(cookie => cookie.name === 'cutmy_session')
  expect(reloadedCookies).toHaveLength(1)
  expect(reloadedCookies[0].value === ownerCookies[0].value).toBe(true)
})

test('reconnecting after a rate-limited bootstrap makes a fresh real session request', async ({ page }) => {
  let requests = 0
  let reject = true
  await page.route(`**${api}/session`, async route => {
    requests++
    if (reject) await route.fulfill({ status: 429, json: { error: { code: 'rate_limit', message: 'Too many requests; wait a minute' } } })
    else await route.continue()
  })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Слишком много запросов')
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeDisabled()
  expect(requests).toBe(1)
  expect((await page.context().cookies()).filter(cookie => cookie.name === 'cutmy_session')).toHaveLength(0)
  reject = false
  const reconnected = page.waitForResponse(response => response.url().endsWith(`${api}/session`) && response.ok())
  await page.getByRole('button', { name: 'Повторить подключение', exact: true }).click()
  await reconnected
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled()
  await expect(page.getByRole('alert')).not.toBeVisible()
  expect(requests).toBe(2)
  expect((await page.context().cookies()).filter(cookie => cookie.name === 'cutmy_session')).toHaveLength(1)
})

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

test('workspace preserves edits and export choices while sources are replaced deliberately', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.source-chooser')).toBeVisible()
  await expect(page.locator('.editor-workspace')).not.toBeVisible()
  await expect(page.locator('.export-submit')).not.toBeVisible()
  await expect(page.getByLabel('Начало', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'MP3 Аудио', exact: true })).not.toBeVisible()
  await uploadThroughUI(page)
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await showExactTimes(page)
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.250')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:05.500')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await page.getByRole('button', { name: 'Посмотреть фрагмент', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(2.4)
  await page.getByRole('button', { name: 'Остановить просмотр', exact: true }).click()
  const playhead = await page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)
  await goToExport(page)
  await page.getByRole('button', { name: 'MP3 Аудио', exact: true }).click()
  await goToMoment(page)
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeCloseTo(playhead, 1)
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).paused)).toBe(true)
  await addClip(page)
  await goToClips(page)
  await expect(page.locator('.range-list > li')).toHaveCount(2)
  await page.getByRole('button', { name: /Другое видео/ }).click()
  await expect(page.locator('.source-chooser')).toBeVisible()
  await goToClips(page)
  await expect(page.locator('.range-list > li')).toHaveCount(2)
  await page.getByRole('button', { name: 'Редактировать фрагмент 1', exact: true }).click()
  await showExactTimes(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:02.250')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:05.500')
  await goToExport(page)
  await expect(page.getByRole('button', { name: 'MP3 Аудио', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await uploadThroughUI(page)
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await showExactTimes(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:00.000')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:12.000')
  await goToClips(page)
  await expect(page.locator('.range-list > li')).toHaveCount(1)
})

test('the website rejects unsupported files and unsafe URLs before an API mutation', async ({ page }) => {
  const mutations: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/v1\/(uploads|sources)$/.test(request.url())) mutations.push(request.url())
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  for (const url of ['file:///etc/passwd', 'https://user:password@example.com/video.mp4', 'https://example.com:8443/video.mp4']) {
    await page.getByLabel('Video link', { exact: true }).fill(url)
    await page.getByRole('button', { name: 'Open video', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByLabel('Video link', { exact: true })).toHaveValue(url)
  }
  await goToSource(page)
  await page.getByRole('button', { name: 'File', exact: true }).click()
  const wav = await readFile(process.env.CUTMY_E2E_AUDIO!)
  for (const file of [process.env.CUTMY_E2E_AUDIO!, { name: 'renamed.mp4', mimeType: 'video/webm', buffer: wav }, { name: 'renamed.mp4', mimeType: 'video/mp4', buffer: wav }]) {
    const chooser = page.waitForEvent('filechooser')
    await page.locator('button.upload-button').click()
    await (await chooser).setFiles(file)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.locator('.source-chooser')).toBeVisible()
  }
  expect(mutations).toEqual([])
  await uploadThroughUI(page)
  await expect(page.locator('video')).toBeVisible()
  expect(mutations).toHaveLength(1)
})

test('both themes keep visible text readable in the source chooser and workspace', async ({ page }, testInfo) => {
  await page.goto('/')
  await uploadThroughUI(page)
  const measurements: unknown[] = []
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    for (const stage of [goToSource, goToMoment, goToClips, goToExport]) {
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
  await showExactTimes(page)
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.250')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await uploadThroughUI(page, process.env.CUTMY_E2E_AUDIO_MP4!)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.locator('.source-chooser')).toBeVisible()
  await goToMoment(page)
  await showExactTimes(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:02.250')
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(12, 1)
})

test('a completed job does not override the chosen moments or source step on reload', async ({ page }, testInfo) => {
  const { job } = await completedExport(page)
  await goToMoment(page)
  await showExactTimes(page)
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.000')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:04.000')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await page.reload()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await showExactTimes(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:02.000')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:04.000')
  await goToSource(page)
  await page.reload()
  await expect(page.locator('.source-chooser')).toBeVisible()
  await goToMoment(page)
  await showExactTimes(page)
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
  await expect(page.locator('.output-stage')).toBeVisible()
  await expect(page.getByText('Видео больше недоступно, но результат экспорта сохранился. Чтобы вырезать новые моменты, откройте видео заново.', { exact: true })).toBeVisible()
  await expect(page.locator('.editor-workspace')).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })).not.toBeVisible()
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveAttribute('href', job.items[0].artifact.download_url)
  await goToSource(page)
  await expect(page.getByRole('alert')).toBeVisible()
  await goToExport(page)
  const probe = await probeDownloadedFile(page.request, job.items[0].artifact.download_url, 'download-after-source-expiry.mp4', testInfo)
  expect(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === 'video')).toBeTruthy()
  expect(Math.abs(Number(probe.format.duration) - 2.5)).toBeLessThan(0.2)
})

test('a legacy three-step draft restores its real completed export in the unified workspace', async ({ page }, testInfo) => {
  const { job } = await completedExport(page)
  const legacyDraft = await readBrowserDraft(page)
  delete legacyDraft.workflow_version; delete legacyDraft.selected_range_ids; legacyDraft.step = 3
  await page.evaluate(draft => {
    // Simulate the historical browser which only had the single draft store.
    for (const key of Object.keys(localStorage)) if (key.startsWith('cutmy.project.v2.')) localStorage.removeItem(key)
    localStorage.removeItem('cutmy.projects.v2.ready'); localStorage.removeItem('cutmy.projects.v1'); sessionStorage.clear()
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify(draft))
  }, legacyDraft)
  await page.reload()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveAttribute('href', job.items[0].artifact.download_url)
  await goToClips(page)
  await expect(page.getByRole('checkbox', { name: 'Выбрать фрагмент 1', exact: true })).toBeChecked()
  await goToMoment(page)
  await showExactTimes(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:01.250')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:03.750')
  await goToExport(page)
  const probe = await probeDownloadedFile(page.request, job.items[0].artifact.download_url, 'legacy-restored-export.mp4', testInfo)
  expect(Math.abs(Number(probe.format.duration) - 2.5)).toBeLessThan(0.2)
})
