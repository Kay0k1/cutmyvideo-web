import { expect, test, type Page } from '@playwright/test'
import { api, chooseOption, goToSource, goToMoment, goToClips, goToExport, showExportSettings, closeExportSettings } from './helpers'
import type { Job } from '../src/types'

const source = {
  id: 'src_usability', title: 'Current video', kind: 'upload', duration_ms: 12000,
  preview_url: null, embed_url: null, thumbnail_url: null, preview_kind: 'none', width: 640, height: 360,
  expires_at: '2099-10-05T12:00:00Z', retention_blocked: false,
}
const previous = { ...source, id: 'src_previous_usability', title: 'Previous video', duration_ms: 6000 }
const ranges = [
  { id: 'range_usability_first', label: 'First moment', start_ms: 1500, end_ms: 3250 },
  { id: 'range_usability_second', label: 'Second moment', start_ms: 4000, end_ms: 6000 },
]

async function prepare(page: Page, saved: Record<string, unknown> = {}) {
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({ json: source }))
  await page.route(`**${api}/sources`, route => route.request().method() === 'GET'
    ? route.fulfill({ json: { sources: [source, previous] } }) : route.fallback())
  await page.goto('/?lang=en')
  await expect(page.getByRole('button', { name: 'Open video', exact: true })).toBeEnabled()
  await page.evaluate(({ sourceID, ranges, saved }) => {
    window.dispatchEvent(new Event('pagehide'))
    localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, step: 3, source_id: sourceID,
      ranges, selected_id: ranges[0].id, selected_range_ids: ranges.map(range => range.id), ...saved }))
    // Restore the historical single-draft state before its first migration.
    // Later reloads exercise the migrated, per-project records.
    localStorage.removeItem('cutmy.projects.v2.ready')
  }, { sourceID: source.id, ranges, saved })
}

test('all settings stay in the draft until Save, and Reset restores the system theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.goto('/?lang=en')
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  const dialog = page.getByRole('dialog')
  await settings.click()
  await chooseOption(page, dialog.locator('#theme-preference'), 'Dark')
  await chooseOption(page, dialog.locator('#default-format'), 'MP3 — Audio')
  await chooseOption(page, dialog.locator('#default-zoom'), '10 seconds')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => localStorage.getItem('cutmyvideo.preferences'))).toBeNull()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(settings).toBeFocused()

  await settings.click()
  await expect(dialog.locator('#theme-preference')).toHaveText('System')
  await expect(dialog.locator('#default-format')).toContainText('MP4')
  await expect(dialog.locator('#default-zoom')).toHaveText('1 minute')
  await chooseOption(page, dialog.locator('#theme-preference'), 'Dark')
  await chooseOption(page, dialog.locator('#default-format'), 'MP3 — Audio')
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cutmyvideo.preferences')!).output.format)).toBe('mp3')
  await page.keyboard.press('Escape')

  await settings.click()
  await dialog.getByRole('button', { name: 'Reset defaults', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await settings.click()
  await expect(dialog.locator('#default-format')).toContainText('MP3')
  await dialog.getByRole('button', { name: 'Reset defaults', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click()
  expect(await page.evaluate(() => localStorage.getItem('cutmyvideo.theme'))).toBe('system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(dialog.locator('#default-format')).toContainText('MP4')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('select-all text is tappable and Undo keeps surviving selections made after deletion', async ({ page }) => {
  await prepare(page)
  await page.reload()
  const first = page.getByRole('checkbox', { name: 'Select clip 1', exact: true })
  const second = page.getByRole('checkbox', { name: 'Select clip 2', exact: true })
  await page.locator('.clip-select-all > label[for]').click()
  await expect(first).not.toBeChecked()
  await expect(second).not.toBeChecked()
  await first.check()
  await page.locator('.clip-list > li').first().locator('.clip-row-menu > summary').click()
  await page.getByRole('button', { name: 'Delete clip 1', exact: true }).click()
  await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('Second moment')
  await page.getByRole('checkbox', { name: 'Select clip 1', exact: true }).check()
  await page.getByRole('button', { name: 'Undo change', exact: true }).click()
  await expect(page.getByLabel('Clip 1 name', { exact: true })).toHaveValue('First moment')
  await expect(page.getByLabel('Clip 2 name', { exact: true })).toHaveValue('Second moment')
  await expect(first).toBeChecked()
  await expect(second).toBeChecked()
  const name = page.getByLabel('Clip 1 name', { exact: true })
  const title = page.locator('.clip-row-title').first()
  const bounds = await title.boundingBox()
  expect(bounds).not.toBeNull()
  await title.click({ position: { x: bounds!.width - 7, y: bounds!.height / 2 } })
  await expect(name).toBeFocused()
  await name.fill('Renamed moment')
  await name.press('Enter')
  await expect(name).not.toBeFocused()
})

test('saved videos resume the current draft and reopen other videos from fresh metadata', async ({ page }) => {
  let previousReads = 0
  await prepare(page, { step: 1 })
  await page.route(`**${api}/sources/${previous.id}`, route => {
    previousReads++
    return route.fulfill({ json: { ...previous, title: 'Updated previous video' } })
  })
  await page.reload()
  await page.getByRole('button', { name: 'My videos on the server', exact: true }).click()
  await page.getByRole('button', { name: 'Continue editing “Current video”', exact: true }).click()
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
  await expect(page.getByLabel('End', { exact: true })).toHaveValue('00:00:03.250')
  await goToSource(page)
  await page.getByRole('button', { name: 'My videos on the server', exact: true }).click()
  await page.getByRole('button', { name: 'Open video “Previous video”', exact: true }).click()
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await expect(page.locator('.source-title')).toContainText('Updated previous video')
  expect(previousReads).toBe(1)
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:00.000')
  await expect(page.getByLabel('End', { exact: true })).toHaveValue('00:00:06.000')
})

test('an active job permits saved-source replacement and remains available in export history', async ({ page }) => {
  const job = { id: 'job_usability', status: 'waiting_storage', stage: 'waiting_storage', message: '',
    storage_wait_until: '2099-10-05T12:30:00Z', items: [{ id: 'item_usability', label: '', start_ms: 1500, end_ms: 3250, status: 'queued', artifact: null }] }
  await prepare(page, { step: 1, job_id: job.id })
  await page.route(`**${api}/jobs/${job.id}`, route => route.fulfill({ json: job }))
  await page.route(`**${api}/jobs`, route => route.fulfill({ json: { jobs: [{ id: job.id, source_id: source.id, title: source.title, status: job.status, stage: job.stage, total: 1, files: [] }] } }))
  await page.route(`**${api}/sources/${previous.id}`, route => route.fulfill({ json: previous }))
  await page.reload()
  await page.getByRole('button', { name: 'My videos on the server', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open video “Previous video”', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Delete video “Current video” and files', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continue editing “Current video”', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Continue editing “Current video”', exact: true }).click()
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
  await goToExport(page)
  await expect(page.getByRole('heading', { name: 'Waiting for storage', exact: true })).toBeVisible()
  await goToSource(page)
  await page.getByRole('button', { name: 'My videos on the server', exact: true }).click()
  await page.getByRole('button', { name: 'Open video “Previous video”', exact: true }).click()
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await expect(page.locator('.source-title')).toContainText('Previous video')
  await goToSource(page)
  const history = page.getByRole('button', { name: 'Exports and files', exact: true })
  if (await history.getAttribute('aria-expanded') !== 'true') await history.click()
  await expect(page.locator('.job-library').getByRole('heading', { name: 'Current video', exact: true })).toBeVisible()
  await expect(page.locator('.job-library')).toContainText('Waiting for storage')
  await expect(page.locator('.job-library').getByRole('button', { name: 'Cancel processing', exact: true })).toBeEnabled()
})

test('an expired saved video reports the failure without replacing the current draft', async ({ page }) => {
  await prepare(page, { step: 1 })
  await page.route(`**${api}/sources/${previous.id}`, route => route.fulfill({ status: 404,
    json: { error: { code: 'not_found', message: 'expired' } } }))
  await page.reload()
  await page.getByRole('button', { name: 'My videos on the server', exact: true }).click()
  await page.getByRole('button', { name: 'Open video “Previous video”', exact: true }).click()
  await expect(page.locator('.source-chooser').first()).toBeVisible()
  await expect(page.getByRole('alert').first()).toBeVisible()
  await goToMoment(page)
  await expect(page.locator('.source-title')).toContainText('Current video')
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
  await expect(page.getByLabel('End', { exact: true })).toHaveValue('00:00:03.250')
})

test('a temporary saved-job failure preserves restored cuts and permits reconnecting', async ({ page }) => {
  const job: Job = { id: 'job_bootstrap_retry', status: 'succeeded', stage: 'finished', message: '',
    items: [{ id: 'item_bootstrap_retry', label: 'First moment', start_ms: 1500, end_ms: 3250, status: 'succeeded',
      artifact: { id: 'artifact_bootstrap_retry', filename: 'first-moment.mp4', size_bytes: 2048,
        download_url: `${api}/artifacts/artifact_bootstrap_retry/download`, actual_start_ms: 1500, actual_end_ms: 3250 } }] }
  await prepare(page, { step: 2, job_id: job.id })
  let reads = 0
  await page.route(`**${api}/jobs/${job.id}`, route => ++reads === 1
    ? route.fulfill({ status: 503, json: { error: { code: 'database_unavailable', message: 'Temporary job metadata failure' } } })
    : route.fulfill({ json: job }))
  await page.reload()
  await expect(page.locator('main#editor')).toHaveAttribute('data-bootstrap-state', 'error')
  await expect(page.locator('.source-chooser')).toBeVisible()
  await expect(page.locator('.return-to-editor')).toBeDisabled()
  await expect(page.locator('.export-submit')).toBeDisabled()
  await expect(page.locator('#range-start')).toHaveValue('00:00:01.500')
  await expect(page.locator('#range-end')).toHaveValue('00:00:03.250')
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(page.locator('main#editor')).toHaveAttribute('data-bootstrap-state', 'ready')
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
  await expect(page.getByLabel('End', { exact: true })).toHaveValue('00:00:03.250')
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', job.items[0].artifact!.download_url)
  await expect(page.locator('.export-submit')).toBeEnabled()
  expect(reads).toBe(2)
})

test('Enter keeps invalid times focused, Escape restores the committed range, and time buttons describe their values', async ({ page }) => {
  await prepare(page, { step: 2 })
  await page.reload()
  const start = page.getByLabel('Start', { exact: true })
  await expect(start).toHaveValue('00:00:01.500')
  await start.fill('invalid')
  await start.press('Enter')
  await expect(start).toBeFocused()
  await expect(start).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('alert')).toContainText('Enter a time')
  await expect(page.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '1500')
  await start.press('Escape')
  await expect(start).toHaveValue('00:00:01.500')
  await expect(start).toHaveAttribute('aria-invalid', 'false')
  await start.fill('2.250')
  await start.press('Enter')
  await expect(start).not.toBeFocused()
  await expect(page.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '2250')

  await page.getByRole('button', { name: 'Exact time and timeline', exact: true }).click()
  const time = page.getByRole('button', { name: 'Edit start time: 00:00:02.250', exact: true })
  await expect(time).toBeVisible()
  await time.click()
  await expect(start).toBeFocused()
  expect(await start.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd]))
    .toEqual([0, '2.250'.length])
})

test('the workspace exports explicit clip choices and keeps editing independent of inclusion', async ({ page }) => {
  await prepare(page, { step: 2, selected_range_ids: [ranges[1].id] })
  await page.reload()
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
  await expect(page.locator('.export-submit')).toBeEnabled()
  await expect(page.getByRole('checkbox', { name: 'Select clip 1', exact: true })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).toBeChecked()
  await expect(page.locator('.export-summary')).toContainText('1 clip')
  await page.getByRole('checkbox', { name: 'Select clip 1', exact: true }).check()
  await expect(page.locator('.export-summary')).toContainText('2 clips')
  await expect(page.locator('.editor-workspace')).toBeVisible()
})

for (const editing of [false, true]) test(`an active export locks options and undo, then completes ${editing ? 'without interrupting a time edit' : 'with download focus'}`, async ({ page }) => {
  let completed = false
  const job: Job = { id: 'job_usability_focus', status: 'running', stage: 'processing', message: '',
    items: [{ id: 'item_usability_focus', label: 'First moment', start_ms: 1500, end_ms: 3250, status: 'running', artifact: null }] }
  await prepare(page, { step: 4, job_id: job.id })
  await page.route(`**${api}/jobs/${job.id}`, route => route.fulfill({ json: completed ? {
    ...job, status: 'succeeded', stage: 'finished', items: [{ ...job.items[0], status: 'succeeded',
      artifact: { id: 'art_usability_focus', filename: 'first-moment.mp4', size_bytes: 2048,
        download_url: `${api}/artifacts/art_usability_focus/download`, actual_start_ms: 1500, actual_end_ms: 3250,
        expires_at: '2099-10-05T12:00:00Z' } }],
  } : job }))
  await page.reload()
  await goToExport(page)
  const format = page.getByRole('group', { name: 'File format', exact: true })
  await expect(format.getByRole('button', { name: 'MP4 Video', exact: true })).toBeDisabled()
  await expect(format.getByRole('button', { name: 'MP3 Audio', exact: true })).toBeDisabled()
  await goToMoment(page)
  // Boundary editing creates real undo history while the existing export runs.
  const start = page.getByLabel('Start', { exact: true })
  await start.fill('2.000')
  await start.press('Tab')
  await expect(page.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '2000')
  const undo = page.getByRole('button', { name: 'Undo change', exact: true })
  await expect(undo).toBeDisabled()
  await page.locator('h1').focus()
  for (const key of ['Control+KeyZ', 'Meta+KeyZ']) {
    await page.keyboard.press(key)
    await expect(page.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '2000')
  }
  await showExportSettings(page)
  await expect(page.locator('#quality')).toBeDisabled()
  await expect(page.locator('#cut-mode')).toBeDisabled()

  await closeExportSettings(page)
  await goToMoment(page)
  if (editing) {
    await start.focus()
    await start.fill('2.125')
  } else {
    await page.getByRole('button', { name: 'Cancel processing', exact: true }).scrollIntoViewIfNeeded()
  }
  completed = true
  const heading = page.getByRole('heading', { name: 'Files from the last export', exact: true })
  const download = page.getByRole('link', { name: 'Download', exact: true })
  await expect(download).toBeVisible()
  if (editing) {
    await expect(start).toBeFocused()
    await expect(start).toHaveValue('2.125')
    await expect(heading).not.toBeFocused()
    await start.press('Escape')
  } else {
    await expect(heading).toBeFocused()
    await expect(heading).toBeInViewport()
    expect(await page.locator('.results-panel').evaluate(element =>
      !!(element.compareDocumentPosition(document.querySelector('.export-panel')!) & Node.DOCUMENT_POSITION_FOLLOWING)))
      .toBe(true)
    await page.keyboard.press('Tab')
    await expect(download).toBeFocused()
  }
  await goToExport(page)
  await expect(format.getByRole('button', { name: 'MP3 Audio', exact: true })).toBeEnabled()
  await goToMoment(page)
  // The same history becomes usable after completion; a disabled shortcut above
  // cannot pass simply because the history stack was empty.
  await expect(undo).toBeEnabled()
  await page.locator('h1').focus()
  await page.keyboard.press('Control+KeyZ')
  await expect(page.locator('.trim-handle.start')).toHaveAttribute('aria-valuenow', '1500')

})

test('optional export settings retain quality and cut mode after switching format and reopening', async ({ page }) => {
  await prepare(page, { step: 4 })
  await page.reload()
  await showExportSettings(page)
  const dialog = page.locator('.export-settings-dialog')
  await chooseOption(page, page.locator('#quality'), 'Best available')
  await chooseOption(page, page.locator('#cut-mode'), 'Original quality')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.mode-hint')).toContainText('No re-encoding')
  await closeExportSettings(page)
  await goToExport(page)
  const format = page.getByRole('group', { name: 'File format', exact: true })
  await format.getByRole('button', { name: 'MP3 Audio', exact: true }).click()
  await showExportSettings(page)
  await expect(dialog.locator('.mode-hint')).toHaveText('Audio will be converted to MP3.')
  await closeExportSettings(page)
  await format.getByRole('button', { name: 'MP4 Video', exact: true }).click()
  await showExportSettings(page)
  await expect(page.locator('#quality')).toContainText('Best available')
})

test('browser Back and Forward follow source and workspace while retaining clip choices and exact times', async ({ page }) => {
  await prepare(page, { step: 2 })
  await page.reload()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Select clip 2', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Русский', exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await goToSource(page)
  await expect(page.locator('.source-chooser')).toBeVisible()
  await page.goBack()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Select clip 2', exact: true })).not.toBeChecked()
  await expect(page.locator('.page-heading h1')).toBeFocused()
  await expect(page.getByLabel('Start', { exact: true })).toHaveValue('00:00:01.500')
  await expect(page.getByLabel('End', { exact: true })).toHaveValue('00:00:03.250')
  await page.goForward()
  await expect(page.locator('.source-chooser')).toBeVisible()
  await page.goBack()
  await expect(page.locator('.export-summary')).toContainText('1 clip')
  expect(await page.evaluate(() => history.state.cutmyWorkflow)).toMatchObject({ version: 1, step: 2, panel: null })
})

test('browser Back keeps an invalid time draft focused and does not add duplicate entries', async ({ page }) => {
  await prepare(page, { step: 2 })
  await page.reload()
  await goToSource(page)
  await goToMoment(page)
  const start = page.getByLabel('Start', { exact: true })
  await start.fill('invalid')
  await start.press('Enter')
  const before = await page.evaluate(() => ({ length: history.length, index: history.state.cutmyWorkflow.index }))
  await page.goBack()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(start).toBeFocused()
  await expect(start).toHaveValue('invalid')
  await expect(start).toHaveAttribute('aria-invalid', 'true')
  await expect.poll(() => page.evaluate(() => ({ length: history.length, index: history.state.cutmyWorkflow.index }))).toEqual(before)
  await start.press('Escape')
  await page.goBack()
  await expect(page.locator('.source-chooser')).toBeVisible()
  await page.goForward()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(start).toHaveValue('00:00:01.500')
})

test('browser Back dismisses a settings popup first, restores focus and discards unsaved preferences', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await prepare(page, { step: 2 })
  await page.reload()
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  await settings.click()
  const dialog = page.getByRole('dialog')
  await chooseOption(page, dialog.locator('#theme-preference'), 'Dark')
  const theme = dialog.getByRole('combobox', { name: 'Appearance', exact: true })
  await theme.focus(); await theme.press('Enter')
  await expect(dialog.getByRole('listbox')).toBeVisible()
  await page.goBack()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('listbox')).not.toBeVisible()
  await expect(settings).toBeFocused()
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.goForward()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#theme-preference')).toHaveText('System')
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(settings).toBeFocused()
})

test('closing a directly linked dialog replaces its URL in place and the initial site entry can be left normally', async ({ page }) => {
  await prepare(page, { step: 2 })
  await page.route('**/outside-usability', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html lang="en"><title>Previous page</title><h1>Previous page</h1></html>' }))
  await page.goto('/outside-usability')
  await page.goto('/?lang=en&panel=settings')
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const length = await page.evaluate(() => history.length)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page).toHaveURL(/\?lang=en$/)
  expect(await page.evaluate(() => history.length)).toBe(length)
  await page.goBack()
  await expect(page).toHaveURL(/\/outside-usability$/)
  await expect(page.getByRole('heading', { name: 'Previous page', exact: true })).toBeVisible()
})

test('reload preserves the workspace and a refreshed settings dialog closes in place', async ({ page }) => {
  await prepare(page, { step: 2 })
  let releaseRestoration!: () => void
  const restoration = new Promise<void>(resolve => { releaseRestoration = resolve })
  let reads = 0
  await page.route(`**${api}/sources/${source.id}`, async route => {
    if (++reads === 1) await restoration
    await route.fulfill({ json: source }).catch(() => {})
  })
  const restoring = page.waitForRequest(request => new URL(request.url()).pathname === `${api}/sources/${source.id}`)
  await page.reload()
  await restoring
  // The initial chooser is visible while the saved source is restoring. It is
  // not the destination of a real source/workspace history transition yet.
  await expect(page.locator('.source-chooser')).toBeVisible()
  await expect(page.locator('.source-open')).toBeDisabled()
  let sourceReached = false
  const sourceNavigation = goToSource(page).then(() => { sourceReached = true })
  try {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(sourceReached, 'Source navigation waits for saved-source restoration').toBe(false)
  } finally { releaseRestoration() }
  await sourceNavigation
  await expect(page.locator('.source-chooser')).toBeVisible()
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow)).toMatchObject({ step: 1, index: 1 })
  await goToMoment(page)
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow)).toMatchObject({ step: 2, index: 2 })
  await page.reload()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(page.locator('main#editor')).toHaveAttribute('data-bootstrap-state', 'ready')
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow)).toMatchObject({ step: 2, index: 2 })
  await page.goBack()
  await expect(page.locator('.source-chooser')).toBeVisible()
  await page.goForward()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.reload()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(page.locator('main#editor')).toHaveAttribute('data-bootstrap-state', 'ready')
  const length = await page.evaluate(() => history.length)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(await page.evaluate(() => history.length)).toBe(length)
  await page.goBack()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.editor-workspace')).toBeVisible()
})

test('deleting all clips retains the player, supports undo and resumes an empty workspace', async ({ page }) => {
  await prepare(page, { step: 2 })
  await page.reload()
  const bulk = page.locator('.clip-bulk-menu')
  await bulk.locator('summary').click()
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No clips yet', exact: true })).toBeVisible()
  await expect(page.locator('.player-frame')).toBeVisible()
  await expect(page.locator('.export-submit')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Add first clip', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Undo change', exact: true }).click()
  await expect(page.locator('.clip-list > li')).toHaveCount(2)
  await page.getByRole('button', { name: 'Redo change', exact: true }).click()
  await expect(page.locator('.clip-list > li')).toHaveCount(0)
  await goToSource(page)
  await page.goBack()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No clips yet', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('.editor-workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No clips yet', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add first clip', exact: true }).click()
  await expect(page.locator('.clip-list > li')).toHaveCount(1)
  await expect(page.locator('.trim-track')).toBeVisible()
})

test('Back cannot interrupt opening a saved video and works again after the source is committed', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await prepare(page, { step: 2 })
  await page.route(`**${api}/sources/${previous.id}`, async route => { await gate; await route.fulfill({ json: previous }) })
  await page.reload()
  await goToClips(page)
  await goToSource(page)
  await page.getByRole('button', { name: 'My videos on the server', exact: true }).click()
  const reading = page.waitForRequest(request => request.url().endsWith(`${api}/sources/${previous.id}`))
  await page.getByRole('button', { name: 'Open video “Previous video”', exact: true }).click()
  await reading
  try {
    await expect(page.locator('.source-open')).toBeDisabled()
    await page.goBack()
    await expect(page.locator('.source-chooser').first()).toBeVisible()
    await expect.poll(() => page.evaluate(() => history.state.cutmyWorkflow.index)).toBe(1)
  } finally { release() }
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await expect(page.locator('.source-title')).toContainText('Previous video')
  await page.goBack()
  await expect(page.locator('.source-chooser').first()).toBeVisible()
})

test('opening an example awaits closing its dialog before entering the new source flow', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await prepare(page, { step: 2 })
  await page.route(`**${api}/sources`, async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    await gate
    return route.fulfill({ json: { ...source, id: 'src_example_usability', title: 'Example video', kind: 'youtube' } })
  })
  await page.reload()
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await page.getByRole('button', { name: 'Examples', exact: true }).click()
  const request = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`${api}/sources`))
  await page.getByRole('dialog').getByRole('button', { name: 'Open sample', exact: true }).click()
  expect((await request).postDataJSON()).toEqual({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })
  try {
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(page.locator('.source-chooser').first()).toBeVisible()
    await expect(page).not.toHaveURL(/panel=/)
    expect(await page.evaluate(() => history.state.cutmyWorkflow)).toMatchObject({ step: 1, panel: null, index: 1 })
  } finally { release() }
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await expect(page.locator('.source-title')).toContainText('Example video')
  await page.goBack()
  await expect(page.locator('.source-chooser').first()).toBeVisible()
})

test('an initial dialog can close while the session is still connecting without adding an exit trap', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`**${api}/session`, async route => { await gate; await route.fulfill({ json: { ok: true } }) })
  await page.goto('/?lang=en&panel=settings')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const length = await page.evaluate(() => history.length)
  try {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page).toHaveURL(/\?lang=en$/)
    expect(await page.evaluate(() => history.length)).toBe(length)
    await expect(page.getByRole('button', { name: 'Open video', exact: true })).toBeDisabled()
  } finally { release() }
  await expect(page.getByRole('button', { name: 'Open video', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => history.state.cutmyWorkflow)).toEqual({ version: 1, step: 1, panel: null, index: 0 })
})

test('native skip-link history keeps Settings Close, Back and Forward dismissible even after dialog anchors', async ({ page }) => {
  await prepare(page, { step: 2 })
  await page.reload()
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow?.step)).toBe(2)
  const skip = page.locator('.skip-link')
  await skip.focus(); await skip.press('Enter')
  await expect(page).toHaveURL(/#editor$/)
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow?.index)).toBe(1)
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  const dialog = page.getByRole('dialog')
  await settings.click()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(settings).toBeFocused()
  await expect(page).toHaveURL(/#editor$/)
  await page.goForward()
  await expect(dialog).toBeVisible()
  await page.goBack()
  await expect(dialog).not.toBeVisible()
  await page.goForward()
  await expect(dialog).toBeVisible()
  await page.evaluate(() => { location.hash = 'dialog-anchor' })
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow?.index)).toBe(3)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page).toHaveURL(/#editor$/)
  await page.goForward(); await page.goForward()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(settings).toBeFocused()
})

test('invalid time after repeated native anchors restores the exact entry on a multi-entry Back jump', async ({ page }) => {
  await prepare(page, { step: 1 })
  await page.reload()
  await goToMoment(page)
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow?.index)).toBe(1)
  await page.evaluate(() => { location.hash = 'first-editor-anchor' })
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow?.index)).toBe(2)
  await page.evaluate(() => { location.hash = 'editor' })
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow?.index)).toBe(3)
  const start = page.getByLabel('Start', { exact: true })
  await start.fill('invalid'); await start.press('Enter')
  const length = await page.evaluate(() => history.length)
  await page.evaluate(() => history.go(-3))
  await expect.poll(() => page.evaluate(() => history.state?.cutmyWorkflow?.index)).toBe(3)
  await expect(page).toHaveURL(/#editor$/)
  await expect(page.locator('.editor-workspace').first()).toBeVisible()
  await expect(start).toBeFocused()
  await expect(start).toHaveValue('invalid')
  expect(await page.evaluate(() => history.length)).toBe(length)
})
