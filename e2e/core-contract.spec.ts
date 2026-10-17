import { expect, test } from '@playwright/test'
import { holdDatabaseTableLock } from './databaseContract'
import { parseTimecode } from '../src/timecode'
import { api, goToExport, goToMoment, goToSource, showExactTimes, uploadThroughUI, waitJob } from './helpers'

test.describe('current core database contract', () => {
  test.skip(process.env.CUTMY_E2E_DATABASE_CONTROL !== 'hosted-disposable',
    'Requires the explicitly disposable hosted PostgreSQL integration job')

  test('a queued UI export survives reload, keeps source entry usable and can be cancelled', async ({ page }) => {
    await page.goto('/')
    await uploadThroughUI(page)
    await goToExport(page)
    // Hold real worker storage admission so the accepted job stays queued.
    // HTTP creation, job reads and cancellation use jobs, not this table.
    // Repeated clips can finish immediately through verified result reuse.
    const release = await holdDatabaseTableLock('storage_counters')
    try {
      const creationPromise = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
      await goToExport(page); await page.getByRole('button', { name: /Вырезать/ }).click()
      const creation = await creationPromise
      expect(creation.ok()).toBeTruthy()
      const id = (await creation.json()).id
      const cancel = page.getByRole('button', { name: 'Отменить обработку', exact: true })
      await expect(cancel).toBeVisible()
      await expect.poll(async () => (await (await page.request.get(`${api}/jobs/${id}`)).json()).status, { intervals: [100, 100, 200] }).toBe('queued')
      await goToSource(page)
      await expect(page.getByLabel('Ссылка на видео', { exact: true })).toBeEnabled()
      await goToExport(page)
      await page.reload()
      await expect(cancel).toBeVisible()
      const cancellation = page.waitForResponse(response => response.url().endsWith(`${api}/jobs/${id}/cancel`) && response.request().method() === 'POST')
      await cancel.click()
      expect((await cancellation).ok()).toBeTruthy()
      await release()
      const terminal = await waitJob(page.request, id)
      expect(terminal.status).toBe('cancelled')
      expect(terminal.items.every((item: { artifact: unknown }) => !item.artifact)).toBe(true)
      await expect(page.getByRole('heading', { name: 'Обработка отменена', exact: true })).toBeVisible()
      await goToSource(page)
      await expect(page.getByLabel('Ссылка на видео', { exact: true })).toBeEnabled()
    } finally { await release() }
  })

  test('real upload database timeout preserves the draft and requires a deliberate retry', async ({ page }) => {
    await page.goto('/')
    const firstUpload = page.waitForResponse(r => r.url().endsWith(`${api}/uploads`) && r.request().method() === 'POST')
    await uploadThroughUI(page)
    const original = await (await firstUpload).json()
    await showExactTimes(page)
    await page.getByLabel('Начало', { exact: true }).fill('1')
    await page.getByLabel('Начало', { exact: true }).press('Tab')
    await page.getByLabel('Конец', { exact: true }).fill('3')
    await page.getByLabel('Конец', { exact: true }).press('Tab')
    const draft = await Promise.all([
      page.getByLabel('Начало', { exact: true }).inputValue(), page.getByLabel('Конец', { exact: true }).inputValue(),
    ])
    expect(draft.map(parseTimecode)).toEqual([1000, 3000])
    await goToSource(page)
    let uploads = 0
    page.on('request', r => { if (r.url().endsWith(`${api}/uploads`) && r.method() === 'POST') uploads++ })
    const release = await holdDatabaseTableLock('storage_counters')
    try {
      const unavailable = page.waitForResponse(r => r.url().endsWith(`${api}/uploads`) && r.request().method() === 'POST')
      await uploadThroughUI(page)
      const response = await unavailable
      expect(response.status()).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'database_unavailable', message: 'Database is temporarily unavailable; try again' } })
      await expect(page.locator('#source-error')).toHaveText('Не удалось подтвердить сохранение видео. Оно могло уже сохраниться. Проверьте «Мои видео на сервере» перед повторной отправкой.')
      await expect(page.locator('button.upload-button')).toBeEnabled()
    } finally { await release() }
    await page.waitForTimeout(2200)
    expect(uploads).toBe(1)
    await goToMoment(page)
    await showExactTimes(page)
    await expect(page.getByLabel('Начало', { exact: true })).toHaveValue(draft[0])
    await expect(page.getByLabel('Конец', { exact: true })).toHaveValue(draft[1])
    const originalResponse = await page.request.get(`${api}/sources/${original.id}`)
    expect(originalResponse.ok()).toBeTruthy()
    const retry = page.waitForResponse(r => r.url().endsWith(`${api}/uploads`) && r.request().method() === 'POST')
    await uploadThroughUI(page)
    expect((await retry).status()).toBe(201)
    await expect(page.locator('.editor-workspace')).toBeVisible()
    expect(uploads).toBe(2)
  })

  test('real export database timeout retains the request key across reload and creates one job after retry', async ({ page }) => {
    await page.goto('/')
    await uploadThroughUI(page)
    await showExactTimes(page)
    await page.getByLabel('Начало', { exact: true }).fill('1')
    await page.getByLabel('Начало', { exact: true }).press('Tab')
    await page.getByLabel('Конец', { exact: true }).fill('3')
    await page.getByLabel('Конец', { exact: true }).press('Tab')
    await goToExport(page)
    const attempts: string[] = []
    page.on('request', r => {
      if (r.url().endsWith(`${api}/jobs`) && r.method() === 'POST') attempts.push(r.headers()['idempotency-key'])
    })
    // Admission reads jobs before inserting; storage counters are updated by
    // the later worker and cannot deterministically block this HTTP request.
    const release = await holdDatabaseTableLock('jobs')
    try {
      const unavailable = page.waitForResponse(r => r.url().endsWith(`${api}/jobs`) && r.request().method() === 'POST')
      await goToExport(page); await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
      const response = await unavailable
      expect(response.status()).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'database_unavailable', message: 'Database is temporarily unavailable; try again' } })
      await expect(page.getByRole('alert').filter({ hasText: 'Экспорт мог быть принят.' })).toHaveText(
        'Сервис временно недоступен. Экспорт мог быть принят. Проверьте «Экспорты и файлы» перед повторной отправкой. Подождите немного и повторите действие.')
    } finally { await release() }
    await page.waitForTimeout(2200)
    expect(attempts).toHaveLength(1)
    await page.reload()
    await goToExport(page); await expect(page.locator('.export-panel')).toBeVisible()
    const accepted = page.waitForResponse(r => r.url().endsWith(`${api}/jobs`) && r.request().method() === 'POST')
    await goToExport(page); await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
    const response = await accepted
    expect(response.status()).toBe(202)
    const created = await response.json()
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toBeTruthy()
    expect(attempts[1]).toBe(attempts[0])
    expect((await waitJob(page.request, created.id)).status).toBe('succeeded')
    const listing = await page.request.get(`${api}/jobs`)
    expect(listing.ok()).toBeTruthy()
    expect((await listing.json()).jobs).toHaveLength(1)
    const replay = await page.request.post(`${api}/jobs`, {
      headers: { 'Idempotency-Key': attempts[0] }, data: response.request().postDataJSON(),
    })
    expect(replay.status()).toBe(202)
    expect((await replay.json()).id).toBe(created.id)
  })
})
