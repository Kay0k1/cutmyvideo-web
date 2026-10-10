import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { expect, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test'

export const api = '/api/v1'

export function stepNavigation(page: Page) {
  return page.getByRole('navigation', { name: /^(Шаги работы|Editing steps)$/ })
}

export function stepButton(page: Page, step: 1 | 2 | 3 | 4) {
  const labels = [/(?:^|\s)(?:Видео|Video)$/, /(?:^|\s)(?:Момент|Moment)$/, /(?:^|\s)(?:Фрагменты|Clips)$/, /(?:^|\s)(?:Экспорт|Export)$/]
  return stepNavigation(page).getByRole('button', { name: labels[step - 1] })
}

export async function goToSource(page: Page) {
  const button = stepButton(page, 1)
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'step')
}

export async function goToMoment(page: Page) {
  const button = stepButton(page, 2)
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'step')
}

export async function goToExport(page: Page) {
  const button = stepButton(page, 4)
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'step')
  // Existing export-setting scenarios explicitly request the optional controls.
  // The ordinary single-clip journey is separately tested with this closed.
  const advanced = page.locator('details.export-options')
  if (await advanced.count() && !await advanced.evaluate(element => (element as HTMLDetailsElement).open)) {
    await advanced.locator('summary').click()
  }
}

export async function goToClips(page: Page) {
  const button = stepButton(page, 3)
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'step')
}

export async function showExactTimes(page: Page) {
  const start = page.getByLabel(/^(Начало|Start)$/, { exact: true })
  const toggle = page.getByRole('button', { name: /^(Точное время и шкала|Exact time and timeline)$/ })
  // Source restoration is asynchronous. Wait for its actual disclosure before
  // reading state so we never close an already restored, expanded panel.
  await expect(toggle).toBeVisible()
  if (await toggle.getAttribute('aria-expanded') === 'false') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(start).toBeVisible()
}

export async function saveClip(page: Page) {
  await page.getByRole('button', { name: /^(Список фрагментов|Clip list)$/ }).click()
  await expect(stepButton(page, 3)).toHaveAttribute('aria-current', 'step')
}

export async function addClip(page: Page) {
  await goToClips(page)
  await page.getByRole('button', { name: /^(Добавить фрагмент|Add a clip)$/ }).click()
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
}

export async function chooseOption(page: Page, control: Locator, name: string | RegExp) {
  await expect(control).toHaveAttribute('role', 'combobox')
  const id = await control.getAttribute('id')
  expect(id, 'A named custom selector must have a stable trigger ID').toBeTruthy()
  const trigger = page.locator(`[id=${JSON.stringify(id)}]`)
  await control.click()
  // Radix hides the trigger from the accessibility tree while its modal popup
  // is open. Check expansion on that same DOM trigger, retaining named-role
  // lookup before opening and after closing.
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('option', { name, exact: true }).click()
  await expect(control).toHaveAttribute('aria-expanded', 'false')
}

export async function setTheme(page: Page, theme: 'light' | 'dark' | 'system') {
  await page.getByRole('button', { name: /^(Настройки|Settings)$/ }).click()
  const dialog = page.getByRole('dialog')
  const labels = { system: /^(Как в системе|System)$/, light: /^(Светлая|Light)$/, dark: /^(Тёмная|Dark)$/ }
  await chooseOption(page, dialog.getByRole('combobox', { name: /^(Тема оформления|Appearance)$/ }), labels[theme])
  await dialog.getByRole('button', { name: /^(Сохранить настройки|Save settings)$/ }).click()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(220) // Let the intentional color transition finish.
}

export async function uploadThroughUI(page: Page, filename = process.env.CUTMY_E2E_MEDIA!) {
  await goToSource(page)
  await page.getByRole('button', { name: /^(Файл|File)$/ }).click()
  const button = page.locator('button.upload-button')
  await expect(button).toBeEnabled()
  const chooser = page.waitForEvent('filechooser')
  await button.click()
  await (await chooser).setFiles(filename)
}

export async function upload(request: APIRequestContext) {
  const { readFile } = await import('node:fs/promises')
  const response = await request.post(`${api}/uploads`, {
    multipart: { file: { name: 'qa-interview.mp4', mimeType: 'video/mp4', buffer: await readFile(process.env.CUTMY_E2E_MEDIA!) } },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

export async function waitJob(request: APIRequestContext, jobId: string) {
  let result: any
  await expect.poll(async () => {
    const response = await request.get(`${api}/jobs/${jobId}`)
    expect(response.ok()).toBeTruthy()
    result = await response.json()
    return result.status
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).toMatch(/^(succeeded|failed|cancelled)$/)
  return result
}

export async function probeDownloadedFile(request: APIRequestContext, url: string, name: string, testInfo: TestInfo) {
  const response = await request.get(url)
  expect(response.ok(), await response.text()).toBeTruthy()
  const filename = testInfo.outputPath(name)
  await writeFile(filename, await response.body())
  const details = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filename], { encoding: 'utf8' }))
  await testInfo.attach(name, { path: filename })
  await testInfo.attach(`${name}.probe.json`, { body: JSON.stringify(details, null, 2), contentType: 'application/json' })
  return details
}

export function assertFirstFrameMatchesSource(output: string, sourceMS: number, source = process.env.CUTMY_E2E_MEDIA!) {
  const frame = (file: string, seconds: number) => execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file,
    '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', 'pipe:1',
  ], { timeout: 15_000 })
  const original = frame(source, sourceMS / 1000)
  const result = frame(output, 0)
  expect(result.length).toBe(original.length)
  const difference = result.reduce((total, value, i) => total + Math.abs(value - original[i]), 0) / result.length
  // Allow normal codec loss and rounding to a neighboring frame, while detecting
  // an export that accidentally begins at time zero or the other selected range.
  expect(difference).toBeLessThan(2)
}
