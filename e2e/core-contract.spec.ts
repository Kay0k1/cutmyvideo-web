import { expect, test } from '@playwright/test'
import { holdDatabaseTableLock } from './databaseContract'
import { parseTimecode } from '../src/timecode'
import { api, goToExport, goToMoment, goToSource, showExactTimes, stepButton, uploadThroughUI, waitJob } from './helpers'

test.describe('current core database contract', () => {
  test.skip(process.env.CUTMY_E2E_DATABASE_CONTROL !== 'hosted-disposable',
    'Requires the explicitly disposable hosted PostgreSQL integration job')

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
      await expect(page.locator('#source-error')).toHaveText('Сервис временно недоступен. Подождите немного и повторите действие.')
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
    await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
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
      await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
      const response = await unavailable
      expect(response.status()).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'database_unavailable', message: 'Database is temporarily unavailable; try again' } })
      await expect(page.getByRole('alert').filter({ hasText: 'Экспорт мог быть принят.' })).toHaveText(
        'Сервис временно недоступен. Экспорт мог быть принят. Проверьте «Экспорты и файлы» перед повторной отправкой. Подождите немного и повторите действие.')
    } finally { await release() }
    await page.waitForTimeout(2200)
    expect(attempts).toHaveLength(1)
    await page.reload()
    await expect(stepButton(page, 4)).toHaveAttribute('aria-current', 'step')
    const accepted = page.waitForResponse(r => r.url().endsWith(`${api}/jobs`) && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
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
