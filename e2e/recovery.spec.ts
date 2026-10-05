import { expect, test, type Page } from '@playwright/test'
import { api, goToExport, goToSource, showExactTimes, stepButton, uploadThroughUI, waitJob } from './helpers'

async function draft(page: Page) {
  await page.goto('/')
  await uploadThroughUI(page)
  await showExactTimes(page)
  await page.getByLabel('Начало', { exact: true }).fill('1')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  await page.getByLabel('Конец', { exact: true }).fill('3')
  await page.getByLabel('Конец', { exact: true }).press('Tab')
}

test('malformed saved clips do not discard the valid source and remaining clips', async ({ page }) => {
  await draft(page)
  await page.evaluate(() => {
    // Flush the live draft before deliberately replacing saved state.
    window.dispatchEvent(new Event('pagehide'))
    const key = 'cutmy.workbench.v1'
    const saved = JSON.parse(localStorage.getItem(key)!)
    saved.ranges = [null, 42, {}, saved.ranges[0], { ...saved.ranges[0], start_ms: 4000, end_ms: 5000 }]
    localStorage.setItem(key, JSON.stringify(saved))
  })
  await page.reload()
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
  await showExactTimes(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:01.000')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:03.000')
  await goToExport(page)
  await expect(page.locator('.output-selection ol > li')).toHaveCount(1)
})

test('saved output settings normalize MP3 copy mode and omit unknown request fields', async ({ page }) => {
  await draft(page)
  await goToExport(page)
  await page.evaluate(() => {
    // Flush the live draft before deliberately replacing saved state.
    window.dispatchEvent(new Event('pagehide'))
    const key = 'cutmy.workbench.v1'
    const saved = JSON.parse(localStorage.getItem(key)!)
    saved.output = { format: 'mp3', quality: 'best', cut_mode: 'copy', old_setting: true }
    localStorage.setItem(key, JSON.stringify(saved))
  })
  await page.reload()
  await expect(stepButton(page, 4)).toHaveAttribute('aria-current', 'step')
  const created = page.waitForResponse(response => response.url().endsWith(`${api}/jobs`) && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Вырезать фрагмент', exact: true }).click()
  const response = await created
  expect(response.request().postDataJSON()).toMatchObject({ format: 'mp3', cut_mode: 'accurate' })
  expect(response.request().postDataJSON()).not.toHaveProperty('old_setting')
  expect(response.ok(), await response.text()).toBeTruthy()
  expect((await waitJob(page.request, (await response.json()).id)).status).toBe('succeeded')
})

test('a lost export response can be retried without creating a duplicate server job', async ({ page }) => {
  await draft(page)
  await goToExport(page)
  const keys: string[] = []
  const jobs: string[] = []
  await page.route(`**${api}/jobs`, async route => {
    keys.push(route.request().headers()['idempotency-key'])
    const response = await route.fetch()
    expect(response.ok(), await response.text()).toBeTruthy()
    jobs.push((await response.json()).id)
    if (jobs.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  const submit = page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })
  await submit.click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.reload()
  await expect(stepButton(page, 4)).toHaveAttribute('aria-current', 'step')
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect.poll(() => jobs.length).toBe(2)
  expect(keys[1]).toBe(keys[0])
  expect(jobs[1]).toBe(jobs[0])
})

test('an expired active job stops polling and releases the export controls', async ({ page }) => {
  await draft(page)
  let reads = 0
  await page.route(`**${api}/jobs/job_expired`, route => {
    reads++
    return reads === 1 ? route.fulfill({ json: {
      id: 'job_expired', status: 'queued', stage: 'queued', message: '',
      items: [{ id: 'item_expired', label: '', start_ms: 1000, end_ms: 3000, status: 'queued', artifact: null }],
    } }) : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Expired' } } })
  })
  await page.evaluate(() => {
    // Flush the live draft before deliberately replacing saved state.
    window.dispatchEvent(new Event('pagehide'))
    const key = 'cutmy.workbench.v1'
    const saved = JSON.parse(localStorage.getItem(key)!)
    saved.job_id = 'job_expired'; saved.step = 4
    localStorage.setItem(key, JSON.stringify(saved))
  })
  await page.reload()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Вырезать фрагмент', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Отменить обработку', exact: true })).not.toBeVisible()
  await page.waitForTimeout(3500)
  expect(reads).toBe(2)
})

test('a failed YouTube SDK download is retried when another video opens', async ({ page }) => {
  let scripts = 0
  let sources = 0
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.route(`**${api}/sources`, route => {
    const id = new URL(route.request().postDataJSON().url).searchParams.get('v')
    return route.fulfill({ status: 201, json: {
      id: `src_sdk_${++sources}`, title: 'SDK recovery fixture', kind: 'youtube', duration_ms: 12000,
      preview_url: null, embed_url: `https://www.youtube-nocookie.com/embed/${id}`, thumbnail_url: null,
    } })
  })
  await page.route('https://www.youtube.com/iframe_api', route => {
    if (++scripts === 1) return route.abort('failed')
    return route.fulfill({ contentType: 'application/javascript', body: `
      window.YT = { Player: class {
        constructor(element, options) { this.element = element; setTimeout(() => options.events.onReady({ target: this }), 0); }
        seekTo() {} playVideo() {} pauseVideo() {} getCurrentTime() { return 0; } getPlayerState() { return 2; } destroy() { this.element.remove(); }
      } };
      window.onYouTubeIframeAPIReady?.();
    ` })
  })
  await page.goto('/')
  const open = async (id: string) => {
    await goToSource(page)
    await page.getByLabel('Ссылка на видео', { exact: true }).fill(`https://www.youtube.com/watch?v=${id}`)
    await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
    await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
  }
  await open('N3REfH4N9Dg')
  await expect(page.locator('.player-error')).toBeVisible()
  await open('aqz-KE-bpKQ')
  await expect.poll(() => scripts, { timeout: 2000 }).toBe(2)
  await expect(page.getByRole('button', { name: 'Посмотреть фрагмент', exact: true })).toBeEnabled()
  await expect(page.locator('.player-error')).not.toBeVisible()
})
