import { expect, test } from '@playwright/test'
import { api, goToExport, goToMoments, goToSource, uploadThroughUI, waitJob } from './helpers'

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
  await page.getByRole('button', { name: 'YouTube', exact: true }).click()
  await page.getByLabel('YouTube link', { exact: true }).fill('not-a-url')
  await page.getByRole('button', { name: 'Open video', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Paste a YouTube video link')
  await expect(page.getByLabel('YouTube link', { exact: true })).toBeFocused()
  await page.getByLabel('YouTube link', { exact: true }).fill('')
  await goToMoments(page)
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
  await goToMoments(page)
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
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.000')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('#default-format').selectOption('mp3')
  await expect(dialog.locator('#default-cut')).toHaveValue('accurate')
  await expect(dialog.locator('#default-cut')).toBeDisabled()
  await dialog.locator('#default-zoom').selectOption('10000')
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:02.000')
  await goToExport(page)
  await expect(page.getByRole('button', { name: 'MP3 Audio', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await goToMoments(page)
  await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue('10000')

  await page.reload()
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:02.000')
  await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue('10000')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(dialog.locator('#default-format')).toHaveValue('mp3')
  await expect(dialog.locator('#default-zoom')).toHaveValue('10000')
  await page.keyboard.press('Escape')
  await uploadThroughUI(page)
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:00.000')
  await expect(page.getByLabel('Timeline zoom', { exact: true })).toHaveValue('10000')
  await goToExport(page)
  await expect(page.getByRole('button', { name: 'MP3 Audio', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('a real failed audio export explains that no clips were created in both languages', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await uploadThroughUI(page, process.env.CUTMY_E2E_VIDEO_ONLY!)
  await goToExport(page)
  await page.getByRole('button', { name: 'MP3 Audio', exact: true }).click()
  const creationPromise = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Cut a clip', exact: true }).click()
  const creation = await creationPromise
  expect(creation.ok()).toBeTruthy()
  const job = await waitJob(page.request, (await creation.json()).id)
  expect(job.status).toBe('failed')
  expect(job.items).toHaveLength(1)
  expect(job.items[0].artifact).toBeFalsy()
  await expect(page.getByText('No clips could be created. Change export settings or try another source.', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0)
  await expectEnglishCopy(page)
  await page.getByRole('button', { name: 'Русский', exact: true }).click()
  await expect(page.getByText('Не удалось создать фрагменты. Измените настройки экспорта или попробуйте другой источник.', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toHaveCount(0)
})
