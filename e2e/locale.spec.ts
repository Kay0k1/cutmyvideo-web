import { expect, test } from '@playwright/test'
import { api, assertFirstFrameMatchesSource, chooseOption, goToExport, goToMoment, goToSource, probeDownloadedFile, showExactTimes, uploadThroughUI, waitJob } from './helpers'

// Exact addresses supplied by the owner, independent of the app catalog.
const wallets = [
  { network: 'TRON', address: 'TEaL7LYGWKLGMALr8QZKV412xAjC6x4MdE' },
  { network: 'Solana', address: 'AfFgZ9Se53R9xKzoEpHrZnULmVKpm6iSE3aBx9DtBMdj' },
  { network: 'Ethereum', address: '0xC51fC6DB30e7EE6ed801F98bfA1c214991D21f78' },
  { network: 'Bitcoin', address: 'bc1q2ynccztq2t2z8f6nwx9rlve9tt29t72h2mnrpv' },
]

async function expectEnglishCopy(page: import('@playwright/test').Page) {
  expect((await page.locator('body').innerText()).replaceAll('Русский', '')).not.toMatch(/[А-Яа-яЁё]/)
  const labels = await page.locator('[aria-label]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')).join('\n'))
  expect(labels.replaceAll('Русский', '')).not.toMatch(/[А-Яа-яЁё]/)
}

test('language switching preserves the real source, ranges and export', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  await uploadThroughUI(page)
  await showExactTimes(page)
  await page.getByLabel('Начало', { exact: true }).fill('00:00:01.500')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('00:00:04.000')
  await page.getByLabel('Конец', { exact: true }).press('Tab')

  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
  await expect(page.getByLabel('End', { exact: true })).toHaveValue('00:00:04.000')
  await expect(page.locator('video')).toBeVisible()
  await goToSource(page)
  await page.getByRole('button', { name: 'Link', exact: true }).click()
  const sourceMutations: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith(`${api}/sources`)) sourceMutations.push(request.url())
  })
  await page.getByLabel('Video link', { exact: true }).fill('not a valid URL')
  await page.getByRole('button', { name: 'Open video', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByLabel('Video link', { exact: true })).toBeFocused()
  expect(sourceMutations, 'A malformed authority must be rejected before source preparation').toEqual([])
  await page.getByLabel('Video link', { exact: true }).fill('')
  await goToMoment(page)
  await showExactTimes(page)
  await expect(page.locator('video')).toBeVisible()
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
  await expectEnglishCopy(page)
  await page.getByRole('button', { name: 'Preview clip', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(1.8)
  await page.getByRole('button', { name: 'Stop preview', exact: true }).click()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('english-editor.png'), fullPage: true })
  await testInfo.attach('English editor', { path: testInfo.outputPath('english-editor.png'), contentType: 'image/png' })

  await goToExport(page)
  const creationPromise = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Cut a clip', exact: true }).click()
  const creation = await creationPromise
  expect(creation.ok()).toBeTruthy()
  const id = (await creation.json()).id
  await page.getByRole('button', { name: 'Русский', exact: true }).click()
  const job = await waitJob(page.request, id)
  expect(job.status).toBe('succeeded')
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', job.items[0].artifact.download_url)
  await expectEnglishCopy(page)
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', job.items[0].artifact.download_url)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: testInfo.outputPath('english-results.png'), fullPage: true })
  await testInfo.attach('English results', { path: testInfo.outputPath('english-results.png'), contentType: 'image/png' })
  await goToMoment(page)
  await showExactTimes(page)
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
})

test('navigation dialogs support Escape, trapped keyboard focus and focus return', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  for (const name of ['Examples', 'Settings', 'Support']) {
    const trigger = page.getByRole('button', { name, exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expectEnglishCopy(page)
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBeTruthy()
    }
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
  }
})

test('donation copy returns every exact owner address once', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Support', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  for (const wallet of wallets) {
    await expect(dialog.getByText(wallet.address, { exact: true })).toHaveCount(1)
    await expect(dialog.getByText(wallet.network, { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: `Copy ${wallet.network} address`, exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(wallet.address)
  }
  await expectEnglishCopy(page)
})

test('saved defaults survive reload and are applied without changing clip boundaries', async ({ page }) => {
  await page.goto('/')
  await uploadThroughUI(page)
  await showExactTimes(page)
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.000')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await chooseOption(page, dialog.locator('#default-format'), /MP3.*Audio/)
  await expect(dialog.locator('#default-cut')).toContainText('Exact boundaries')
  await expect(dialog.locator('#default-cut')).toBeDisabled()
  await chooseOption(page, dialog.locator('#default-zoom'), '10 seconds')
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:02.000')
  await goToExport(page)
  await expect(page.getByRole('button', { name: 'MP3 Audio', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await goToMoment(page)
  await showExactTimes(page)
  await expect(page.getByRole('combobox', { name: 'Timeline zoom', exact: true })).toContainText('10 seconds')

  // Reload must restore the genuine source even when metadata arrives after
  // the document. Delay only its real response; keep the source and draft intact.
  const sourceRestore = /\/api\/v1\/sources\/[^/?]+$/
  const restoredStatuses: number[] = []
  await page.route(sourceRestore, async route => {
    const response = await route.fetch()
    await new Promise(resolve => setTimeout(resolve, 600))
    restoredStatuses.push(response.status())
    await route.fulfill({ response })
  })
  await page.reload()
  await showExactTimes(page)
  expect(restoredStatuses).toEqual([200])
  await page.unroute(sourceRestore)
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:02.000')
  await expect(page.getByRole('combobox', { name: 'Timeline zoom', exact: true })).toContainText('10 seconds')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog.locator('#default-format')).toContainText('MP3')
  await expect(dialog.locator('#default-zoom')).toContainText('10 seconds')
  await page.keyboard.press('Escape')
  await uploadThroughUI(page)
  await showExactTimes(page)
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:00.000')
  await expect(page.getByRole('combobox', { name: 'Timeline zoom', exact: true })).toContainText('10 seconds')
  await goToExport(page)
  await expect(page.getByRole('button', { name: 'MP3 Audio', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('a real failed audio export explains the cause in both languages and can retry as MP4 without losing its range', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await uploadThroughUI(page, process.env.CUTMY_E2E_VIDEO_ONLY!)
  await showExactTimes(page)
  await page.getByLabel('Start', { exact: true }).fill('00:00:00.500')
  await page.getByLabel('Start', { exact: true }).press('Tab')
  await page.getByLabel('End', { exact: true }).fill('00:00:01.250')
  await page.getByLabel('End', { exact: true }).press('Tab')
  await goToExport(page)
  await page.getByRole('button', { name: 'MP3 Audio', exact: true }).click()
  const creationPromise = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Cut a clip', exact: true }).click()
  const creation = await creationPromise
  expect(creation.ok()).toBeTruthy()
  const job = await waitJob(page.request, (await creation.json()).id)
  expect(job.status).toBe('failed')
  expect(job.items).toHaveLength(1)
  expect(job.items[0].error_code).toBe('audio_missing')
  expect(job.items[0]).toMatchObject({ start_ms: 500, end_ms: 1250 })
  expect(job.items[0].artifact).toBeFalsy()
  await expect(page.getByText('No clips could be created. The reason is shown below.', { exact: true })).toBeVisible()
  await expect(page.getByText('This video has no audio track. Choose MP4 to save the video.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry export', exact: true })).toBeEnabled()
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0)
  await expectEnglishCopy(page)
  await page.getByRole('button', { name: 'Русский', exact: true }).click()
  await expect(page.getByText('Не удалось создать фрагменты. Причина указана ниже.', { exact: true })).toBeVisible()
  await expect(page.getByText('В видео нет аудиодорожки. Выберите MP4, чтобы сохранить видео.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Повторить экспорт', exact: true })).toBeEnabled()
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'MP4 Video', exact: true }).click()
  const retryPromise = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Retry export', exact: true }).click()
  const retry = await retryPromise
  expect(retry.ok(), await retry.text()).toBeTruthy()
  expect(retry.request().postDataJSON()).toMatchObject({
    source_id: creation.request().postDataJSON().source_id,
    ranges: creation.request().postDataJSON().ranges,
    format: 'mp4', cut_mode: 'accurate',
  })
  expect(retry.request().headers()['idempotency-key']).not.toBe(creation.request().headers()['idempotency-key'])
  const retriedJob = await waitJob(page.request, (await retry.json()).id)
  expect(retriedJob.id).not.toBe(job.id)
  expect(retriedJob.status, JSON.stringify(retriedJob)).toBe('succeeded')
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveCount(1)
  const outputName = 'retried-video-only.mp4'
  const probe = await probeDownloadedFile(page.request, retriedJob.items[0].artifact.download_url, outputName, testInfo)
  expect(Math.abs(Number(probe.format.duration) - .75)).toBeLessThan(.1)
  expect(probe.streams.filter((stream: { codec_type: string }) => stream.codec_type === 'video')).toHaveLength(1)
  expect(probe.streams.filter((stream: { codec_type: string }) => stream.codec_type === 'audio')).toHaveLength(0)
  assertFirstFrameMatchesSource(testInfo.outputPath(outputName), 500, process.env.CUTMY_E2E_VIDEO_ONLY!)
  await expectEnglishCopy(page)
})
