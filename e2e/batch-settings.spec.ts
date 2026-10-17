import { readBrowserDraft } from './browserProjectStorage';
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { chooseOption, goToExport, goToMoment, showExportSettings, closeExportSettings } from './helpers'

const source = { id: 'src_batch_ui', title: 'Multiple tracks', kind: 'upload', duration_ms: 12000,
  width: 640, height: 360, preview_url: '/native-fixture.mp4', embed_url: null, thumbnail_url: null, preview_kind: 'native' }
const tracks = [
  { index: 0, type: 'video', codec: 'h264' },
  { index: 1, type: 'audio', codec: 'aac', language: 'rus', title: 'Original', channels: 1, sample_rate: 48000 },
  { index: 2, type: 'audio', codec: 'aac', language: 'eng', title: 'Commentary', channels: 1, sample_rate: 48000, default: true },
  { index: 3, type: 'subtitle', codec: 'subrip', language: 'eng', title: 'Captions' },
]
const ranges = [{ id: 'range_batch_ui_a', label: 'Second first', start_ms: 6000, end_ms: 8000 },
  { id: 'range_batch_ui_b', label: 'Opening last', start_ms: 1000, end_ms: 3000 }]

type PlatformPreviewWindow = Window & { __batchPlatformPreview: { fail(): void } }

async function installPlatformPreview(page: Page) {
  // Export settings exercise our provider boundary, not a live YouTube video.
  // Keep readiness and failure controllable while real fallback MP4s still decode.
  await page.addInitScript(() => {
    class ControlledPlayer {
      frame: HTMLIFrameElement
      currentTime = 0
      state = 2
      constructor(element: HTMLElement, options: { events: {
        onReady(event: { target: ControlledPlayer }): void
        onError(event: { target: ControlledPlayer }): void
      } }) {
        this.frame = document.createElement('iframe')
        this.frame.src = 'about:blank'
        element.replaceWith(this.frame)
        Object.assign(window, { __batchPlatformPreview: { fail: () => options.events.onError({ target: this }) } })
        queueMicrotask(() => options.events.onReady({ target: this }))
      }
      seekTo(seconds: number) { this.currentTime = seconds }
      getCurrentTime() { return this.currentTime }
      getPlayerState() { return this.state }
      playVideo() { this.state = 1 }
      pauseVideo() { this.state = 2 }
      destroy() { this.frame.remove() }
    }
    Object.assign(window, { YT: { Player: ControlledPlayer } })
  })
}

async function prepare(page: Page, options: { platform?: boolean; subtitleCodec?: string; output?: object } = {}) {
  if (options.platform) await installPlatformPreview(page)
  const current = options.platform ? { ...source, kind: 'youtube', preview_url: null, embed_url: 'https://www.youtube-nocookie.com/embed/abcdefghijk' } : source
  await page.route('**/api/v1/session', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/v1/sources/' + source.id, route => route.fulfill({ json: current }))
  await page.route('**/api/v1/sources/' + source.id + '/tracks', route => options.platform
    ? route.fulfill({ status: 422, json: { error: { code: 'tracks_unavailable', message: 'Private raw diagnostic' } } })
    : route.fulfill({ json: { tracks: tracks.map(track => track.type === 'subtitle' && options.subtitleCodec ? { ...track, codec: options.subtitleCodec } : track) } }))
  await page.route('**/api/v1/sources/' + source.id + '/preview?**', async route => route.fulfill({
    contentType: 'video/mp4', body: await readFile(process.env.CUTMY_E2E_MEDIA!) }))
  await page.route('**/native-fixture.mp4', async route => route.fulfill({ contentType: 'video/mp4', body: await readFile(process.env.CUTMY_E2E_MEDIA!) }))
  await page.addInitScript(({ ranges, output, sourceID }) => {
    localStorage.setItem('cutmyvideo.locale', 'en')
    if (!localStorage.getItem('cutmy.workbench.v1')) localStorage.setItem('cutmy.workbench.v1', JSON.stringify({ workflow_version: 2, step: 2, source_id: sourceID,
      ranges, selected_id: ranges[0].id, selected_range_ids: ranges.map(range => range.id),
      output: output ?? { format: 'mp4', quality: '1080p', cut_mode: 'accurate' } }))
  }, { ranges, output: options.output, sourceID: source.id })
  await page.goto('/?lang=en')
  await showExportSettings(page)
  await expect(page.locator('#audio-track-export')).toContainText('Source default')
}

test('audio selection follows preview, joined export, language switching and retained result details', async ({ page }) => {
  const requests: string[] = []
  page.on('request', request => { if (request.url().includes('/preview?')) requests.push(request.url()) })
  await prepare(page)
  await expect.poll(() => requests.some(url => url.includes('audio_track=2'))).toBeTruthy()
  // A browser that picks the first track must still preview the exporter default.
  await chooseOption(page, page.locator('#audio-track-export'), 'Audio #1 · rus · Original · aac · 1 channel · 48000 Hz')
  await expect.poll(() => requests.some(url => url.includes('audio_track=1'))).toBeTruthy()
  await showExportSettings(page)
  await expect(page.locator('#copy-container')).toHaveCount(0)
  await expect(page.locator('#subtitle-mode')).toHaveCount(0)
  await chooseOption(page, page.locator('#output-mode'), 'One joined file')
  await chooseOption(page, page.locator('#cut-mode'), 'Original quality')
  await chooseOption(page, page.locator('#copy-container'), 'MKV')
  await chooseOption(page, page.locator('#subtitle-mode'), 'Preserve text subtitles')
  await expect(page.locator('#quality')).toBeDisabled()
  await closeExportSettings(page)
  await page.getByRole('button', { name: 'Русский', exact: true }).click()
  await showExportSettings(page)
  await expect(page.locator('#output-mode')).toContainText('Один объединённый файл')
  await closeExportSettings(page)
  await page.getByRole('button', { name: 'English', exact: true }).click()
  await showExportSettings(page)
  await expect(page.locator('#audio-track-export')).toContainText('Original')
  let submitted: any
  await page.route('**/api/v1/jobs', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { jobs: [] } })
    submitted = route.request().postDataJSON()
    await route.fulfill({ json: { id: 'job_batch_ui', status: 'succeeded', stage: 'finished', message: '', items: [{
      id: 'item_joined', label: 'Joined result', start_ms: 0, end_ms: 4000, status: 'succeeded',
      artifact: { id: 'file_joined', filename: 'joined.mkv', size_bytes: 120000, download_url: '/download.mkv',
        actual_start_ms: 0, actual_end_ms: 4000,
        segments: ranges.map((range, index) => ({ index, label: range.label, source_start_ms: range.start_ms,
          source_end_ms: range.end_ms, output_start_ms: index * 2000, output_end_ms: (index + 1) * 2000 })),
        track_manifest: tracks.map(track => ({ ...track, included: track.index !== 2, reason: track.index === 2 ? 'audio_not_selected' : '' })) },
    }] } })
  })
  await closeExportSettings(page)
  await goToExport(page); await page.getByRole('button', { name: 'Cut clips', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Joined result' })).toBeVisible()
  expect(submitted).toMatchObject({ output_mode: 'joined', format: 'mkv', quality: 'best', cut_mode: 'copy', audio_track: 1, subtitle_mode: 'preserve' })
  expect(submitted.ranges.map((range: any) => range.label)).toEqual(['Second first', 'Opening last'])
  await page.locator('.file-description .artifact-details summary').click()
  await expect(page.locator('.file-description')).toContainText('Another audio track is selected')
  await expect(page.locator('.file-description')).toContainText('00:00:06.000')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
})

test('keyboard no-sound selection reaches the same preview and export and disables MP3', async ({ page }) => {
  await prepare(page)
  const selected = page.locator('#audio-track-export')
  const preview = page.waitForRequest(request => request.url().includes('/preview?') && request.url().includes('no_audio=true'))
  await selected.focus()
  await selected.press('ArrowDown')
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect(page.getByRole('option', { name: 'Source default', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(page.getByRole('option', { name: 'No sound', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(selected).toContainText('No sound')
  await preview
  await showExportSettings(page)
  await closeExportSettings(page)
  await expect(page.getByRole('button', { name: 'MP3 Audio', exact: true })).toBeDisabled()
  await showExportSettings(page)
  await expect(page.locator('#audio-track-export')).toContainText('No sound')
  await goToMoment(page)
  await expect.poll(() => readBrowserDraft(page).then(saved => saved.output)).toMatchObject({ no_audio: true })
})

test('platform and unsupported subtitles explain available choices without silent fallback', async ({ page }) => {
  await prepare(page, { platform: true })
  await expect(page.locator('#audio-track-export-hint')).toContainText('Upload the original file')
  await chooseOption(page, page.locator('#audio-track-export'), 'No sound')
  await showExportSettings(page)
  await chooseOption(page, page.locator('#cut-mode'), 'Original quality')
  await expect(page.locator('#copy-container')).toContainText('MP4')
  await expect(page.locator('#subtitle-mode')).toHaveCount(0)
  expect(await page.locator('body').innerText()).not.toContain('Private raw diagnostic')
})

test('platform copy offers MKV while retaining explicit quality and no-sound settings', async ({ page }) => {
  await prepare(page, { platform: true, output: { format: 'mp4', quality: '720p', cut_mode: 'accurate' } })
  await chooseOption(page, page.locator('#audio-track-export'), 'No sound')
  await showExportSettings(page)
  await chooseOption(page, page.locator('#cut-mode'), 'Original quality')
  await chooseOption(page, page.locator('#copy-container'), 'MKV')
  await expect(page.locator('#quality')).toBeEnabled()
  await expect(page.locator('#quality')).toContainText('Up to 720p')
  await expect(page.locator('#subtitle-mode')).toHaveCount(0)
  let submitted: any
  await page.route('**/api/v1/jobs', route => {
    submitted = route.request().postDataJSON()
    return route.fulfill({ json: { id: 'job_platform_mkv', status: 'cancelled', stage: 'cancelled', message: '', items: [] } })
  })
  await closeExportSettings(page)
  const exportButton = page.getByRole('button', { name: 'Cut clips', exact: true })
  await expect(exportButton).toBeEnabled()
  await exportButton.click()
  await expect.poll(() => submitted).toMatchObject({ format: 'mkv', quality: '720p', cut_mode: 'copy', no_audio: true })
  expect(submitted).not.toHaveProperty('audio_track')
  expect(submitted).not.toHaveProperty('subtitle_mode')
  expect(await readBrowserDraft(page).then(saved => saved.output.quality)).toBe('720p')
})

test('unsupported subtitle tracks remain excluded and preservation is disabled', async ({ page }) => {
  await prepare(page, { subtitleCodec: 'ass' })
  await showExportSettings(page)
  await chooseOption(page, page.locator('#cut-mode'), 'Original quality')
  await page.locator('#subtitle-mode').click()
  await expect(page.getByRole('option', { name: 'Preserve text subtitles', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(page.locator('#subtitle-mode')).toContainText('Omit subtitles')
  await expect(page.locator('.export-panel')).toContainText('ASS, SSA and image subtitles cannot be preserved yet.')
})

test('joined audio retry retains one request identity after restoring reordered settings', async ({ page }) => {
  await prepare(page)
  await chooseOption(page, page.locator('#audio-track-export'), 'Audio #1 · rus · Original · aac · 1 channel · 48000 Hz')
  await showExportSettings(page)
  await chooseOption(page, page.locator('#output-mode'), 'One joined file')
  const attempts: Array<{ body: object; key: string | undefined }> = []
  await page.route('**/api/v1/jobs', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { jobs: [] } })
    attempts.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] })
    await route.fulfill({ status: 503, json: { error: { code: 'database_unavailable', message: 'Controlled lost confirmation' } } })
  })
  await closeExportSettings(page)
  await goToExport(page); await page.getByRole('button', { name: 'Cut clips', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('The export may have been accepted.')
  await page.reload()
  await showExportSettings(page)
  await expect(page.locator('#output-mode')).toContainText('One joined file')
  await expect(page.locator('#audio-track-export')).toContainText('Original')
  await closeExportSettings(page)
  await goToExport(page); await page.getByRole('button', { name: 'Cut clips', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('The export may have been accepted.')
  expect(attempts).toHaveLength(2)
  expect(attempts[0].key).toBeTruthy()
  expect(attempts[1]).toEqual(attempts[0])
})

for (const phase of ['pointermove', 'pointerdown'] as const) {
  test(`export settings retain pointer activation during platform fallback at ${phase}`, async ({ page }) => {
    const externalRequests: string[] = []
    page.on('request', request => {
      if (/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\//.test(request.url())) externalRequests.push(request.url())
    })
    await prepare(page, { platform: true })
    await expect(page.locator('.youtube-player iframe')).toBeVisible()
    await closeExportSettings(page)
    const trigger = page.locator('.export-options-toggle')
    await trigger.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    // Inject the provider failure after actionability/hit testing or after press,
    // instead of hoping a third-party response happens to hit this input window.
    await page.evaluate(phase => document.addEventListener(phase, () => (window as unknown as PlatformPreviewWindow).__batchPlatformPreview.fail(), { once: true }), phase)
    await trigger.click()
    await expect(page.locator('.window-player')).toBeVisible()
    const fallbackVideo = page.locator('.window-player-screen video')
    await expect(fallbackVideo).toHaveJSProperty('videoWidth', 640)
    await expect.poll(() => fallbackVideo.evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2)
    await expect(page.locator('.export-settings-dialog')).toBeVisible()
    await expect(page.locator('#audio-track-export-hint')).toContainText('Upload the original file')
    expect(externalRequests).toEqual([])
  })
}
