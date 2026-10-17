import { readBrowserDraft } from './browserProjectStorage';
import { expect, test, type Page } from '@playwright/test'
import { api, closeEditorTools, closeExportSettings, goToClips, goToExport, goToSource, showEditorTools, showExactTimes, showExportSettings, uploadThroughUI } from './helpers'

const source = {
  id: 'src_resources', title: 'Resource lifecycle fixture', kind: 'upload', duration_ms: 12000,
  preview_url: null, embed_url: null, thumbnail_url: null, preview_kind: 'none', width: 640, height: 360,
  expires_at: '2099-10-05T12:00:00Z', retention_blocked: false,
}
const items = [{ id: 'item_resources', label: '', start_ms: 0, end_ms: 3000, status: 'queued', artifact: null }]
const job = { id: 'job_resources', status: 'queued', stage: 'queued', message: '', items }

test('resource lifecycle: selector code is downloaded only when a selector is first shown', async ({ page }) => {
  const selectorRequests: string[] = []
  page.on('request', request => {
    if (/\/RadixSelectControl(?:-[^/]+)?\.(?:js|tsx)$/.test(new URL(request.url()).pathname)) selectorRequests.push(request.url())
  })
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled()
  expect(selectorRequests).toEqual([])
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await expect(page.locator('button#theme-preference')).toBeVisible()
  expect(selectorRequests).toHaveLength(1)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await expect(page.locator('button#theme-preference')).toBeVisible()
  expect(selectorRequests).toHaveLength(1)
})

for (const action of ['Enter', 'pointer', 'focus', 'Tab', 'Escape'] as const) {
  test(`resource lifecycle: a delayed selector preserves ${action} intent and focus`, async ({ page }) => {
    await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
    let release!: () => void, received!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const intercepted = new Promise<void>(resolve => { received = resolve })
    await page.route(/\/RadixSelectControl(?:-[^/]+)?\.(?:js|tsx)(?:\?.*)?$/, async route => {
      received(); await gate; await route.continue()
    })
    try {
      await page.goto('/?lang=en')
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await intercepted
      const dialog = page.getByRole('dialog')
      const theme = dialog.getByRole('combobox', { name: 'Appearance', exact: true })
      await expect(theme).toHaveAttribute('aria-busy', 'true')
      await theme.focus()
      if (action === 'pointer') await theme.click()
      else if (action !== 'focus') {
        await theme.press('Enter')
        if (action !== 'Enter') await page.keyboard.press(action)
      }
      release()
      await expect(dialog.locator('#theme-preference')).not.toHaveAttribute('aria-busy', 'true')
      if (action === 'Enter' || action === 'pointer') {
        await expect(dialog.getByRole('listbox')).toBeVisible()
        await expect(dialog.locator('#theme-preference')).toHaveAttribute('aria-expanded', 'true')
        await page.keyboard.press('Escape')
        await expect(theme).toBeFocused()
      } else {
        await expect(dialog.getByRole('listbox')).not.toBeVisible()
        await expect(dialog).toBeVisible()
        await expect(action === 'Tab' ? dialog.locator('#default-format') : theme).toBeFocused()
      }
    } finally { release() }
  })
}

test('resource lifecycle: a missing lazy selector chunk keeps native settings usable and persists changes', async ({ page }) => {
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  let rejected = 0
  await page.route(/\/RadixSelectControl(?:-[^/]+)?\.(?:js|tsx)(?:\?.*)?$/, route => { rejected++; return route.abort('failed') })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await expect.poll(() => rejected).toBe(1)
  await page.locator('select#theme-preference').selectOption('dark')
  await page.locator('select#default-format').selectOption('mp3')
  await expect(page.locator('#default-quality')).toBeDisabled()
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Настройки сохранены.')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await expect(page.locator('select#default-format')).toHaveValue('mp3')
  await expect(page.locator('select#theme-preference')).toHaveValue('dark')
})

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
    // This fixture represents a previously saved legacy draft. The initial
    // empty page already completed migration, so reset that marker before the
    // first restoration; later reloads must use the actual migrated project.
    localStorage.removeItem('cutmy.projects.v2.ready')
  }, { sourceID: source.id, saved })
}

test('resource lifecycle: deletion explains all consequences, respects dismissal, and accepts an empty 204', async ({ page }) => {
  await prepare(page)
  let deletes = 0
  await page.route(`**${api}/sources/${source.id}`, route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    deletes++; return route.fulfill({ status: 204, body: '' })
  })
  await page.reload(); await expect(page.locator('.editor-workspace')).toBeVisible(); await goToSource(page)
  await expect(page.locator('.retention-note').first()).toContainText('Видео будет удалено после')
  const remove = page.getByRole('button', { name: 'Удалить видео и файлы', exact: true })
  page.once('dialog', async dialog => { expect(dialog.message()).toMatch(/все его задания и готовые файлы/); await dialog.dismiss() })
  await remove.click(); expect(deletes).toBe(0); await expect(remove).toBeEnabled()
  page.once('dialog', dialog => dialog.accept())
  await remove.click()
  await expect(page.locator('.source-chooser')).toBeVisible()
  await expect(remove).not.toBeVisible(); expect(deletes).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  expect(await readBrowserDraft(page)).not.toHaveProperty('source_id')
})

test('resource lifecycle: source-in-use conflict keeps the editable source and explains recovery', async ({ page }) => {
  await prepare(page)
  await page.route(`**${api}/sources/${source.id}`, route => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 409, json: { error: { code: 'source_in_use', message: 'in use' } } }) : route.fallback())
  await page.reload(); await expect(page.locator('.editor-workspace')).toBeVisible(); await goToSource(page); page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Удалить видео и файлы', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Видео используется активным заданием')
  await expect(page.getByRole('button', { name: 'Удалить видео и файлы', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Вернуться к редактированию', exact: true })).toBeEnabled()
})

test('resource lifecycle: waiting-storage is active, cancellable, bounded and translated', async ({ page }) => {
  await prepare(page, { job_id: job.id })
  await page.route(`**${api}/jobs/${job.id}`, route => route.fulfill({ json: { ...job, status: 'waiting_storage', stage: 'waiting_storage', storage_wait_until: '2099-10-05T12:30:00Z' } }))
  await page.route(`**${api}/jobs/${job.id}/cancel`, route => route.fulfill({ json: { ...job, status: 'cancelled', stage: 'cancelled', items: items.map(item => ({ ...item, status: 'cancelled' })) } }))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Ждём свободного места', exact: true })).toBeVisible()
  await expect(page.locator('.job-status')).toContainText('Ожидание места — до')
  await goToSource(page)
  await expect(page.getByRole('button', { name: 'Удалить видео и файлы', exact: true })).toBeDisabled()
  await goToExport(page)
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Waiting for storage', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel processing', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Processing cancelled', exact: true })).toBeVisible()
  await goToSource(page)
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
  await goToExport(page); await expect(page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })).toBeEnabled(); expect(reads).toBe(2)
})

test('resource lifecycle: a transient restore failure preserves the saved draft and can be retried', async ({ page }) => {
  await prepare(page)
  let reads = 0
  await page.route(`**${api}/sources/${source.id}`, route => ++reads === 1 ? route.abort('failed') : route.fulfill({ json: source }))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Повторить подключение', exact: true })).toBeVisible()
  await page.waitForTimeout(1200)
  expect(await readBrowserDraft(page).then(saved => saved.source_id)).toBe(source.id)
  await page.getByRole('button', { name: 'Повторить подключение', exact: true }).click()
  await goToExport(page); await expect(page.locator('.export-panel')).toBeVisible()
  await goToExport(page); await expect(page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })).toBeEnabled()
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
  expect(await readBrowserDraft(page).then(saved => saved.job_id)).toBe(job.id)
  await page.reload(); await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible()
})

test('resource lifecycle: malformed IDs and oversized JSON never start restore requests', async ({ page }) => {
  await prepare(page, { source_id: '../unsafe?token=secret', job_id: 'invalid\r\nheader' })
  let restores = 0
  await page.route(`**${api}/sources/**`, route => { restores++; return route.abort() })
  await page.route(`**${api}/jobs/**`, route => { restores++; return route.abort() })
  await page.reload(); await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled(); expect(restores).toBe(0)
  await page.evaluate(() => {
    localStorage.setItem('cutmy.workbench.v1', '{"source_id":"src_resources","padding":"' + 'x'.repeat(256 * 1024) + '"}')
    localStorage.removeItem('cutmy.projects.v2.ready')
  })
  await page.reload(); await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled(); expect(restores).toBe(0)
})

test('resource lifecycle: upload displays measured bytes before server inspection without buffering File', async ({ page }) => {
  type UploadFixtureWindow = Window & { uploadFixture?: { progress(loaded: number, total: number): void; finish(): void } }
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.addInitScript(source => {
    const fake = class {
      upload: { onprogress?: (value: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
      onload?: () => void; onabort?: () => void; onerror?: () => void; ontimeout?: () => void
      status = 201; response = source; responseType = ''; timeout = 0
      open(method: string, url: string) { if (method !== 'POST' || !url.endsWith('/uploads')) throw new Error('Unexpected upload route') }
      send(body: FormData) {
        if (!(body instanceof FormData) || !(body.get('file') instanceof File)) throw new Error('Upload must use native File/FormData')
        Object.assign(window, { uploadFixture: {
          progress: (loaded: number, total: number) => this.upload.onprogress?.({ lengthComputable: true, loaded, total }),
          finish: () => this.onload?.(),
        } })
      }
      abort() { this.onabort?.() }
    }
    Object.defineProperty(window, 'XMLHttpRequest', { value: fake })
    File.prototype.arrayBuffer = () => { throw new Error('Whole-file JS read is forbidden') }
  }, source)
  await page.goto('/')
  await page.getByRole('button', { name: 'Файл', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.locator('button.upload-button').click()
  await (await chooser).setFiles(process.env.CUTMY_E2E_MEDIA!)
  await expect.poll(() => page.evaluate(() => !!(window as UploadFixtureWindow).uploadFixture)).toBe(true)
  await page.evaluate(() => (window as UploadFixtureWindow).uploadFixture!.progress(524288, 1048576))
  await expect(page.getByRole('progressbar', { name: 'Загрузка видео', exact: true })).toBeVisible()
  await expect(page.locator('.upload-progress')).toContainText('Передано')
  await page.evaluate(() => (window as UploadFixtureWindow).uploadFixture!.progress(1048576, 1048576))
  await expect(page.locator('.source-progress')).toContainText('Проверяем видео')
  await page.evaluate(() => (window as UploadFixtureWindow).uploadFixture!.finish())
  await expect(page.locator('.editor-workspace')).toBeVisible()
})

test('resource lifecycle: previous sources can be removed while the current job waits for disk', async ({ page }) => {
  const previous = { ...source, id: 'src_previous', title: 'Previous upload', retention_blocked: true, expires_at: null }
  await prepare(page, { job_id: job.id })
  let remaining = [source, previous]
  await page.route(`**${api}/sources`, route => route.request().method() === 'GET' ? route.fulfill({ json: { sources: remaining } }) : route.fallback())
  await page.route(`**${api}/jobs/${job.id}`, route => route.fulfill({ json: { ...job, status: 'waiting_storage', stage: 'waiting_storage', storage_wait_until: '2099-10-05T12:30:00Z' } }))
  let deletes = 0
  await page.route(`**${api}/sources/${previous.id}`, route => { deletes++; remaining = remaining.filter(item => item.id !== previous.id); return route.fulfill({ status: 204 }) })
  await page.reload(); await expect(page.locator('.editor-workspace')).toBeVisible(); await goToSource(page)
  await page.getByRole('button', { name: 'Мои видео на сервере', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Previous upload', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Удалить видео «${source.title}» и файлы`, exact: true })).toBeDisabled()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Удалить видео «Previous upload» и файлы', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Previous upload', exact: true })).not.toBeVisible()
  expect(deletes).toBe(1); await expect(page.getByRole('button', { name: 'Мои видео на сервере', exact: true })).toBeFocused()
  await goToExport(page); await expect(page.getByRole('heading', { name: 'Ждём свободного места', exact: true })).toBeVisible()
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
  await page.reload(); await expect(page.locator('.editor-workspace')).toBeVisible(); await goToSource(page)
  await page.getByRole('button', { name: 'Мои видео на сервере', exact: true }).click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: `Удалить видео «${source.title}» и файлы`, exact: true }).click()
  await expect.poll(() => deleting).toBe(true)
  await goToExport(page); await expect(page.locator('.source-library')).not.toBeVisible()
  finish()
  await expect(page.locator('.source-chooser')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Вернуться к редактированию', exact: true })).not.toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  expect(await readBrowserDraft(page)).not.toHaveProperty('source_id')
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
  await expect(page.locator('.editor-workspace')).toBeVisible()
  const uploadEvidence = await page.evaluate(() => (window as typeof window & { uploadEvidence: { nativeFile: boolean; progress: number; loaded: number } }).uploadEvidence)
  expect(uploadEvidence.nativeFile).toBe(true); expect(uploadEvidence.progress).toBeGreaterThan(0); expect(uploadEvidence.loaded).toBeGreaterThan(0)
  const storedSource = await readBrowserDraft(page).then(saved => saved.source_id as string)
  await goToExport(page)
  await showExportSettings(page)
  await page.getByRole('checkbox', { name: 'Удалить исходник после экспорта', exact: true }).uncheck()
  await closeExportSettings(page)
  const createdResponse = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await goToExport(page); await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
  const response = await createdResponse; expect(response.ok(), await response.text()).toBeTruthy()
  const created = await response.json()
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible({ timeout: 60000 })
  const download = await page.getByRole('link', { name: 'Скачать', exact: true }).getAttribute('href')
  const list = await page.request.get(`${api}/sources`); expect(list.ok()).toBeTruthy()
  expect((await list.json()).sources.some((item: { id: string }) => item.id === storedSource)).toBe(true)
  await goToSource(page); page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Удалить видео и файлы', exact: true }).click()
  await expect(page.locator('.source-chooser')).toBeVisible()
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
  await expect(page.locator('#source-file-hint')).toContainText('MP4, MOV, MKV или WebM до 1 КБ')
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
  await page.reload(); await expect(page.locator('.clip-list > li')).toHaveCount(2)
  await goToExport(page)
  await expect(page.getByRole('alert')).toContainText('Один фрагмент может длиться до 2 с.')
  await expect(page.getByRole('button', { name: 'Вырезать фрагменты', exact: true })).toBeDisabled()
  await goToClips(page)
  await page.getByRole('button', { name: 'Редактировать фрагмент 2', exact: true }).click()
  await showExactTimes(page)
  await page.getByLabel('Конец', { exact: true }).fill('7'); await page.getByLabel('Конец', { exact: true }).press('Tab')
  await expect(page.locator('#range-error')).toHaveText('Один фрагмент может длиться до 2 с.')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.locator('#range-error')).toHaveText('A single clip can be up to 2 s long.')
  await page.getByRole('button', { name: 'Русский', exact: true }).click()
  await page.getByLabel('Конец', { exact: true }).fill('6'); await page.getByLabel('Конец', { exact: true }).press('Tab')
  await goToExport(page)
  await goToExport(page); await expect(page.getByRole('button', { name: 'Вырезать фрагменты', exact: true })).toBeEnabled(); expect(posts).toBe(0)
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await showExportSettings(page)
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
  await expect(page.locator('.clip-list > li')).toHaveCount(3)
  await goToExport(page)
  await expect(page.getByRole('alert')).toContainText('Можно экспортировать не больше 2 фрагментов')
  await expect(page.getByRole('link', { name: 'Скачать', exact: true })).toBeVisible()
  await goToClips(page); await expect(page.locator('.clip-list > li')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Добавить фрагмент', exact: true })).toBeDisabled()
})

test('long recordings: 42-minute and full-stream selections, fast export, and a second source during processing', async ({ page }, testInfo) => {
  const { readFileSync } = await import('node:fs')
  const recording = { id: 'src_long_workflow', title: 'Запись стрима · 9 часов', kind: 'platform', provider: 'twitch', duration_ms: 9 * 3600000, width: 1920, height: 1080, preview_kind: 'window', preview_url: null, thumbnail_url: null, embed_url: null }
  const second = { ...recording, id: 'src_next_workflow', title: 'Следующее видео' }
  const running = { id: 'job_long_workflow', status: 'running', stage: 'fetching', message: 'Preparing fragment 1 of 1: 25% downloaded', items: [{ id: 'item_workflow', label: '', start_ms: 0, end_ms: 2520000, status: 'running', artifact: null }] }
  const history = { id: running.id, source_id: recording.id, title: recording.title, status: 'running', stage: 'fetching', total: 1, files: [], created_at: new Date().toISOString() }
  let opens = 0
  let submitted: any = null
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true, limits: { max_source_bytes: 32 * 1024 ** 3, max_output_bytes: 16 * 1024 ** 3, max_ranges: 32, max_range_ms: 12 * 3600000, max_job_ms: 24 * 3600000 } } }))
  await page.route(`**${api}/sources`, route => route.fulfill({ status: route.request().method() === 'POST' ? 201 : 200, json: route.request().method() === 'POST' ? (++opens === 1 ? recording : second) : { sources: [recording, second] } }))
  await page.route(`**${api}/sources/*/preview?*`, route => route.fulfill({ contentType: 'video/mp4', body: readFileSync(process.env.CUTMY_E2E_MEDIA!) }))
  await page.route(`**${api}/jobs`, route => { if (route.request().method() === 'POST') { submitted = route.request().postDataJSON(); return route.fulfill({ status: 202, json: running }) } return route.fulfill({ json: { jobs: [history] } }) })
  await page.route(`**${api}/jobs/${running.id}`, route => route.fulfill({ json: running }))
  await page.goto('/')
  await page.getByLabel('Ссылка на видео', { exact: true }).fill('https://www.twitch.tv/videos/2896088341')
  await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
  await showExactTimes(page)
  await showEditorTools(page)
  await page.getByRole('button', { name: 'Выбрать всё видео', exact: true }).click()
  await closeEditorTools(page)
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('09:00:00.000')
  await page.getByLabel('Конец', { exact: true }).fill('00:42:00')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
  await showExportSettings(page)
  await expect(page.getByText('Один фрагмент — до 12 ч; весь экспорт — до 24 ч.', { exact: true })).toBeVisible()
  await expect(page.getByText('Готовый файл — до 16.0 ГБ.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Ускорить без перекодирования', exact: true }).click()
  await expect(page.getByText('Быстрый экспорт включён', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('long-export-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('long-export-mobile.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  await closeExportSettings(page)
  await goToExport(page); await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
  await expect.poll(() => submitted?.cut_mode).toBe('copy')
  expect(submitted.ranges).toMatchObject([{ start_ms: 0, end_ms: 2520000 }])
  await expect(page.getByText('25%', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Пока обрабатывается — открыть другое видео', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled()
  const disclosure = page.getByRole('button', { name: 'Экспорты и файлы', exact: true })
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
  await expect(page.locator('.job-library').getByRole('heading', { name: recording.title, exact: true })).toBeVisible()
  await page.getByLabel('Ссылка на видео', { exact: true }).fill('https://www.twitch.tv/videos/2896088342')
  await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
  await expect(page.locator('.source-title')).toContainText(second.title)
  await goToSource(page)
  const library = page.getByRole('button', { name: 'Экспорты и файлы', exact: true })
  if (await library.getAttribute('aria-expanded') !== 'true') await library.click()
  await expect(page.locator('.job-library').getByRole('heading', { name: recording.title, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Exports and files', exact: true })).toBeVisible()
})

test('background exports: replacing a source ignores the previous job poll already in flight', async ({ page }) => {
  const { readFileSync } = await import('node:fs')
  await prepare(page, { job_id: job.id })
  let reads = 0, release!: () => void, finished!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const responded = new Promise<void>(resolve => { finished = resolve })
  await page.route(`**${api}/jobs/${job.id}`, async route => {
    reads++
    if (reads === 1) return route.fulfill({ json: job })
    await gate
    await route.fulfill({ json: { ...job, status: 'running', stage: 'encoding' } }).catch(() => undefined)
    finished()
  })
  const replacement = { ...source, id: 'src_replacement', title: 'New recording' }
  await page.route(`**${api}/sources`, route => route.fulfill({ status: 201, json: replacement }))
  await page.route(`**${api}/sources/*/preview?*`, route => route.fulfill({ contentType: 'video/mp4', body: readFileSync(process.env.CUTMY_E2E_MEDIA!) }))
  await page.route(`**${api}/jobs`, route => route.fulfill({ json: { jobs: [] } }))
  try {
    await page.reload()
    await expect.poll(() => reads).toBe(2)
    await goToSource(page)
    await page.getByLabel('Ссылка на видео', { exact: true }).fill('https://www.twitch.tv/videos/123456789')
    await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
    await expect(page.locator('.source-title')).toContainText(replacement.title)
    release(); await responded
    await goToExport(page)
    await goToExport(page); await expect(page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })).toBeEnabled()
    await expect(page.locator('.job-status')).toHaveCount(0)
    const draft = await readBrowserDraft(page)
    expect(draft.source_id).toBe(replacement.id)
    expect(draft.job_id).toBeUndefined()
  } finally { release() }
})

test('background exports: long download names and cancellation controls fit a narrow phone in both languages', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 })
  const longName = `${'🎬'.repeat(12)}длинная-запись-с-очень-длинным-названием-и-без-разрывов.mp4`
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.route(`**${api}/jobs`, route => route.fulfill({ json: { jobs: [
    { id: 'job_mobile_running', source_id: source.id, title: longName, status: 'running', stage: 'fetching', total: 1, files: [] },
    { id: 'job_mobile_done', source_id: source.id, title: longName, status: 'succeeded', stage: 'finished', total: 1, files: [{ id: 'art_mobile', filename: longName, size_bytes: 1024 ** 3, download_url: `${api}/artifacts/art_mobile`, expires_at: '2099-10-05T12:00:00Z' }] },
  ] } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Экспорты и файлы', exact: true }).click()
  await expect(page.locator('.job-library-files a')).toBeVisible()
  for (const language of ['Русский', 'English']) {
    await page.getByRole('button', { name: language, exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const controls = await page.locator('.job-library button, .job-library-files a').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth } }))
    expect(controls.every(control => control.left >= 0 && control.right <= control.width)).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('background-library-mobile.png'), fullPage: true })
})
