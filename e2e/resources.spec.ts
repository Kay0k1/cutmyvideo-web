import { expect, test, type Page } from '@playwright/test'
import { api, stepButton, uploadThroughUI } from './helpers'

const source = {
  id: 'src_resources', title: 'Resource lifecycle fixture', kind: 'upload', duration_ms: 12000,
  preview_url: null, embed_url: null, thumbnail_url: null, preview_kind: 'none', width: 640, height: 360,
  expires_at: '2099-10-05T12:00:00Z', retention_blocked: false,
}
const items = [{ id: 'item_resources', label: '', start_ms: 0, end_ms: 3000, status: 'queued', artifact: null }]
const job = { id: 'job_resources', status: 'queued', stage: 'queued', message: '', items }

async function prepare(page: Page, saved: Record<string, unknown> = {}) {
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.route(`**${api}/sources/${source.id}`, route => route.request().method() === 'GET' ? route.fulfill({ json: source }) : route.fallback())
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled()
  await page.evaluate(({ sourceID, saved }) => {
    window.dispatchEvent(new Event('pagehide'))
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, step: 4, source_id: sourceID,
      ranges: [{ id: 'range_resources', label: '', start_ms: 0, end_ms: 3000 }], selected_id: 'range_resources', selected_range_ids: ['range_resources'],
      ...saved }))
  }, { sourceID: source.id, saved })
}

test('resource lifecycle: deletion explains all consequences, respects dismissal, and accepts an empty 204', async ({ page }) => {
  await prepare(page)
  let deletes = 0
  await page.route(`**${api}/sources/${source.id}`, route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    deletes++; return route.fulfill({ status: 204, body: '' })
  })
  await page.reload(); await stepButton(page, 1).click()
  await expect(page.locator('.retention-note').first()).toContainText('Видео будет удалено после')
  const remove = page.getByRole('button', { name: 'Удалить видео и файлы', exact: true })
  page.once('dialog', async dialog => { expect(dialog.message()).toMatch(/все его задания и готовые файлы/); await dialog.dismiss() })
  await remove.click(); expect(deletes).toBe(0); await expect(remove).toBeEnabled()
  page.once('dialog', dialog => dialog.accept())
  await remove.click()
  await expect(stepButton(page, 1)).toHaveAttribute('aria-current', 'step')
  await expect(remove).not.toBeVisible(); expect(deletes).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.workbench.v1') || '{}'))).not.toHaveProperty('source_id')
})

test('resource lifecycle: source-in-use conflict keeps the editable source and explains recovery', async ({ page }) => {
  await prepare(page)
  await page.route(`**${api}/sources/${source.id}`, route => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 409, json: { error: { code: 'source_in_use', message: 'in use' } } }) : route.fallback())
  await page.reload(); await stepButton(page, 1).click(); page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Удалить видео и файлы', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Видео используется активным заданием')
  await expect(page.getByRole('button', { name: 'Удалить видео и файлы', exact: true })).toBeEnabled()
  await expect(stepButton(page, 2)).toBeEnabled()
})

test('resource lifecycle: waiting-storage is active, cancellable, bounded and translated', async ({ page }) => {
  await prepare(page, { job_id: job.id })
  await page.route(`**${api}/jobs/${job.id}`, route => route.fulfill({ json: { ...job, status: 'waiting_storage', stage: 'waiting_storage', storage_wait_until: '2099-10-05T12:30:00Z' } }))
  await page.route(`**${api}/jobs/${job.id}/cancel`, route => route.fulfill({ json: { ...job, status: 'cancelled', stage: 'cancelled', items: items.map(item => ({ ...item, status: 'cancelled' })) } }))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Ждём свободного места', exact: true })).toBeVisible()
  await expect(page.locator('.job-status')).toContainText('Ожидание места — до')
  await stepButton(page, 1).click()
  await expect(page.getByRole('button', { name: 'Удалить видео и файлы', exact: true })).toBeDisabled()
  await stepButton(page, 4).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Waiting for storage', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel processing', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Processing cancelled', exact: true })).toBeVisible()
  await stepButton(page, 1).click()
  await expect(page.getByRole('button', { name: 'Delete video and files', exact: true })).toBeEnabled()
})

test('resource lifecycle: hidden tabs stop reads and resume immediately without overlapping polls', async ({ page }) => {
  await prepare(page, { job_id: job.id })
  let reads = 0
  await page.route(`**${api}/jobs/${job.id}`, route => { reads++; return route.fulfill({ json: job }) })
  await page.reload(); await expect.poll(() => reads).toBeGreaterThanOrEqual(2)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  const before = reads; await page.waitForTimeout(3200); expect(reads).toBe(before)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect.poll(() => reads, { timeout: 1000 }).toBe(before + 1)
})

test('resource lifecycle: cancellation cannot be undone by an older running poll response', async ({ page }) => {
  await prepare(page, { job_id: job.id })
  let reads = 0, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route(`**${api}/jobs/${job.id}`, async route => {
    reads++
    if (reads > 1) await held
    try { await route.fulfill({ json: { ...job, status: reads > 1 ? 'running' : 'queued', stage: reads > 1 ? 'processing' : 'queued' } }) } catch { /* A cancelled fetch may already have closed. */ }
  })
  await page.route(`**${api}/jobs/${job.id}/cancel`, route => route.fulfill({ json: { ...job, status: 'cancelled', stage: 'cancelled', items: items.map(item => ({ ...item, status: 'cancelled' })) } }))
  await page.reload(); await expect.poll(() => reads).toBe(2)
  await page.getByRole('button', { name: 'Отменить обработку', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обработка отменена', exact: true })).toBeVisible()
  release(); await page.waitForTimeout(2000)
  await expect(page.getByRole('heading', { name: 'Обработка отменена', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })).toBeEnabled(); expect(reads).toBe(2)
})

test('resource lifecycle: a transient restore failure preserves the saved draft and can be retried', async ({ page }) => {
  await prepare(page)
  let reads = 0
  await page.route(`**${api}/sources/${source.id}`, route => ++reads === 1 ? route.abort('failed') : route.fulfill({ json: source }))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Повторить подключение', exact: true })).toBeVisible()
  await page.waitForTimeout(1200)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.workbench.v1')!).source_id)).toBe(source.id)
  await page.getByRole('button', { name: 'Повторить подключение', exact: true }).click()
  await expect(stepButton(page, 4)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })).toBeEnabled()
})

test('resource lifecycle: results survive subsequent reloads after their source has expired', async ({ page }) => {
  await prepare(page, { job_id: job.id })
  await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'expired' } } }))
  await page.route(`**${api}/jobs/${job.id}`, route => route.fulfill({ json: { ...job, status: 'succeeded', stage: 'finished', items: [{ ...items[0], status: 'succeeded', artifact: {
    id: 'artifact_resources', filename: 'clip.mp4', size_bytes: 1000, download_url: `${api}/artifacts/artifact_resources`, actual_start_ms: 0, actual_end_ms: 3000, expires_at: '2099-10-06T12:00:00Z',
  } }] } }))
  await page.reload(); await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible()
  await expect(page.locator('.file-description')).toContainText('Удаление после')
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.workbench.v1')!).job_id)).toBe(job.id)
  await page.reload(); await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible()
})

test('resource lifecycle: malformed IDs and oversized JSON never start restore requests', async ({ page }) => {
  await prepare(page, { source_id: '../unsafe?token=secret', job_id: 'invalid\r\nheader' })
  let restores = 0
  await page.route(`**${api}/sources/**`, route => { restores++; return route.abort() })
  await page.route(`**${api}/jobs/**`, route => { restores++; return route.abort() })
  await page.reload(); await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled(); expect(restores).toBe(0)
  await page.evaluate(() => localStorage.setItem('cutmy.workbench.v1', '{"source_id":"src_resources","padding":"' + 'x'.repeat(256 * 1024) + '"}'))
  await page.reload(); await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled(); expect(restores).toBe(0)
})

test('resource lifecycle: upload displays measured bytes before server inspection without buffering File', async ({ page }) => {
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.addInitScript(source => {
    const fake = class {
      upload: { onprogress?: (value: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
      onload?: () => void; onabort?: () => void; onerror?: () => void; ontimeout?: () => void
      status = 201; response = source; responseType = ''; timeout = 0
      open(method: string, url: string) { if (method !== 'POST' || !url.endsWith('/uploads')) throw new Error('Unexpected upload route') }
      send(body: FormData) {
        if (!(body instanceof FormData) || !(body.get('file') instanceof File)) throw new Error('Upload must use native File/FormData')
        setTimeout(() => this.upload.onprogress?.({ lengthComputable: true, loaded: 524288, total: 1048576 }), 20)
        setTimeout(() => this.upload.onprogress?.({ lengthComputable: true, loaded: 1048576, total: 1048576 }), 500)
        setTimeout(() => this.onload?.(), 1500)
      }
      abort() { this.onabort?.() }
    }
    Object.defineProperty(window, 'XMLHttpRequest', { value: fake })
    File.prototype.arrayBuffer = () => { throw new Error('Whole-file JS read is forbidden') }
  }, source)
  await page.goto('/'); await uploadThroughUI(page)
  await expect(page.getByRole('progressbar', { name: 'Загрузка видео', exact: true })).toBeVisible()
  await expect(page.locator('.upload-progress')).toContainText('Передано')
  await expect(page.locator('.source-progress')).toContainText('Проверяем видео')
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
})

test('resource lifecycle: previous sources can be removed while the current job waits for disk', async ({ page }) => {
  const previous = { ...source, id: 'src_previous', title: 'Previous upload', retention_blocked: true, expires_at: null }
  await prepare(page, { job_id: job.id })
  let remaining = [source, previous]
  await page.route(`**${api}/sources`, route => route.request().method() === 'GET' ? route.fulfill({ json: { sources: remaining } }) : route.fallback())
  await page.route(`**${api}/jobs/${job.id}`, route => route.fulfill({ json: { ...job, status: 'waiting_storage', stage: 'waiting_storage', storage_wait_until: '2099-10-05T12:30:00Z' } }))
  let deletes = 0
  await page.route(`**${api}/sources/${previous.id}`, route => { deletes++; remaining = remaining.filter(item => item.id !== previous.id); return route.fulfill({ status: 204 }) })
  await page.reload(); await stepButton(page, 1).click()
  await page.getByRole('button', { name: 'Мои видео на сервере', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Previous upload', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Удалить видео «${source.title}» и файлы`, exact: true })).toBeDisabled()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Удалить видео «Previous upload» и файлы', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Previous upload', exact: true })).not.toBeVisible()
  expect(deletes).toBe(1); await expect(page.getByRole('button', { name: 'Мои видео на сервере', exact: true })).toBeFocused()
  await stepButton(page, 4).click(); await expect(page.getByRole('heading', { name: 'Ждём свободного места', exact: true })).toBeVisible()
})

test('resource lifecycle: leaving the source list during deletion still clears the deleted draft', async ({ page }) => {
  await prepare(page)
  await page.route(`**${api}/sources`, route => route.fulfill({ json: { sources: [source] } }))
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  let deleting = false
  await page.route(`**${api}/sources/${source.id}`, async route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    deleting = true; await pending; await route.fulfill({ status: 204 })
  })
  await page.reload(); await stepButton(page, 1).click()
  await page.getByRole('button', { name: 'Мои видео на сервере', exact: true }).click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: `Удалить видео «${source.title}» и файлы`, exact: true }).click()
  await expect.poll(() => deleting).toBe(true)
  await stepButton(page, 4).click(); await expect(page.locator('.source-library')).not.toBeVisible()
  finish()
  await expect(stepButton(page, 1)).toHaveAttribute('aria-current', 'step')
  await expect(stepButton(page, 2)).toBeDisabled()
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmy.workbench.v1') || '{}'))).not.toHaveProperty('source_id')
})

test('resource lifecycle: real multipart export results and source are explicitly removed together', async ({ page }) => {
  await page.addInitScript(() => {
    const original = XMLHttpRequest.prototype.send;
    const evidence = { nativeFile: false, progress: 0, loaded: 0 };
    Object.assign(window, { uploadEvidence: evidence });
    XMLHttpRequest.prototype.send = function(body) {
      if (body instanceof FormData) {
        evidence.nativeFile = body.get('file') instanceof File;
        this.upload.addEventListener('progress', event => { evidence.progress++; evidence.loaded = event.loaded; });
      }
      return original.call(this, body);
    };
  });
  await page.goto('/'); await uploadThroughUI(page)
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
  const uploadEvidence = await page.evaluate(() => (window as typeof window & { uploadEvidence: { nativeFile: boolean; progress: number; loaded: number } }).uploadEvidence)
  expect(uploadEvidence.nativeFile).toBe(true); expect(uploadEvidence.progress).toBeGreaterThan(0); expect(uploadEvidence.loaded).toBeGreaterThan(0)
  const storedSource = await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); return JSON.parse(localStorage.getItem('cutmy.workbench.v1')!).source_id as string })
  await stepButton(page, 4).click()
  const createdResponse = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
  const response = await createdResponse; expect(response.ok(), await response.text()).toBeTruthy()
  const created = await response.json()
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible({ timeout: 60000 })
  const download = await page.getByRole('link', { name: 'Скачать', exact: true }).getAttribute('href')
  const list = await page.request.get(`${api}/sources`); expect(list.ok()).toBeTruthy()
  expect((await list.json()).sources.some((item: { id: string }) => item.id === storedSource)).toBe(true)
  await stepButton(page, 1).click(); page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Удалить видео и файлы', exact: true }).click()
  await expect(stepButton(page, 1)).toHaveAttribute('aria-current', 'step')
  expect((await page.request.get(`${api}/sources/${storedSource}`)).status()).toBe(404)
  expect((await page.request.get(`${api}/jobs/${created.id}`)).status()).toBe(404)
  expect((await page.request.get(download!)).status()).toBe(404)
})

test('resource policy: a lower upload byte limit rejects before any upload mutation', async ({ page }) => {
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true, limits: { max_source_bytes: 1024, max_ranges: 2, max_range_ms: 2000, max_job_ms: 3000 } } }))
  let uploads = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`${api}/uploads`)) uploads++ })
  await page.goto('/'); await uploadThroughUI(page)
  await expect(page.getByRole('alert')).toContainText('Файл превышает лимит сервиса')
  await expect(page.locator('#source-file-hint')).toContainText('MP4 до 1 КБ')
  expect(uploads).toBe(0)
})

test('resource policy: shorter range and total duration limits preserve drafts and prevent impossible exports', async ({ page }) => {
  await prepare(page, { ranges: [
    { id: 'range_first', label: 'Short', start_ms: 0, end_ms: 1000 },
    { id: 'range_second', label: 'Too long', start_ms: 4000, end_ms: 7000 },
  ], selected_id: 'range_first', selected_range_ids: ['range_first', 'range_second'] })
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true, limits: { max_source_bytes: 1024 ** 3, max_ranges: 2, max_range_ms: 2000, max_job_ms: 3000 } } }))
  let posts = 0
  await page.route(`**${api}/jobs`, route => { posts++; return route.fulfill({ json: job }) })
  await page.reload(); await expect(page.locator('.output-selection ol > li')).toHaveCount(2)
  await expect(page.getByRole('alert')).toContainText('Фрагмент превышает лимит сервиса')
  await expect(page.getByRole('button', { name: 'Вырезать фрагменты', exact: true })).toBeDisabled()
  await stepButton(page, 3).click()
  await page.getByRole('button', { name: 'Редактировать фрагмент 2', exact: true }).click()
  await page.getByLabel('Конец', { exact: true }).fill('6'); await page.getByLabel('Конец', { exact: true }).press('Tab')
  await stepButton(page, 4).click()
  await expect(page.getByRole('button', { name: 'Вырезать фрагменты', exact: true })).toBeEnabled(); expect(posts).toBe(0)
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.locator('.export-limits')).toContainText('Each clip: up to 2 s; entire export: up to 3 s.')
})

test('resource policy: lowered count limits keep all saved clips and existing downloads', async ({ page }) => {
  const ranges = Array.from({ length: 3 }, (_, index) => ({ id: `range_${index}`, label: '', start_ms: index * 1000, end_ms: (index + 1) * 1000 }))
  await prepare(page, { ranges, selected_id: ranges[0].id, selected_range_ids: ranges.map(range => range.id), job_id: job.id })
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true, limits: { max_ranges: 2 } } }))
  await page.route(`**${api}/jobs/${job.id}`, route => route.fulfill({ json: { ...job, status: 'succeeded', stage: 'finished', items: [{ ...items[0], status: 'succeeded', artifact: {
    id: 'artifact_resources', filename: 'previous.mp4', size_bytes: 1000, download_url: `${api}/artifacts/artifact_resources`, actual_start_ms: 0, actual_end_ms: 3000,
  } }] } }))
  await page.reload()
  await expect(page.locator('.output-selection ol > li')).toHaveCount(3)
  await expect(page.getByRole('alert')).toContainText('Можно экспортировать не больше 2 фрагментов')
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible()
  await stepButton(page, 3).click(); await expect(page.locator('.clip-list > li')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Добавить фрагмент', exact: true })).toBeDisabled()
})
