import { readBrowserDraft, replaceBrowserDraft } from './browserProjectStorage';
import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { api, goToExport, goToSource, probeDownloadedFile, showExactTimes, stepButton, uploadThroughUI, waitJob } from './helpers'

type YoutubeProbe = { commands: string[]; polls: number; destroyed: boolean; throwDestroy: boolean; throwSeek: boolean; destroy?: () => void; ready(): void; fail(): void }
type YoutubeProbeWindow = Window & { __youtubeProbe: { instances: YoutubeProbe[] } }

test('YouTube navigation and controls wait for readiness and ignore replaced or failed players', async ({ page }) => {
  await page.route(`**${api}/sources/*/preview?*`, route => route.fulfill({ contentType: 'video/mp4', body: readFileSync(process.env.CUTMY_E2E_MEDIA!) }))
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.clock.install()
  await page.addInitScript(() => {
    const probe = { instances: [] as YoutubeProbe[] }
    class ControlledPlayer {
      commands: string[] = []
      polls = 0
      destroyed = false
      throwDestroy = false
      throwSeek = false
      state = 2
      currentTime = 0
      frame: HTMLIFrameElement
      seekTo?: (seconds: number) => void
      playVideo?: () => void
      pauseVideo?: () => void
      getCurrentTime?: () => number
      getPlayerState?: () => number
      constructor(element: HTMLElement, private options: { events: { onReady(event: { target: ControlledPlayer }): void; onError(event: { target: ControlledPlayer }): void } }) {
        this.frame = document.createElement('iframe')
        this.frame.src = 'about:blank'
        element.replaceWith(this.frame)
        probe.instances.push(this)
      }
      ready() {
        this.seekTo = seconds => { this.commands.push(`seek:${seconds}`); if (this.throwSeek) throw new Error('SDK seek unavailable'); this.currentTime = seconds }
        this.playVideo = () => { this.commands.push('play'); this.state = 1 }
        this.pauseVideo = () => { this.commands.push('pause'); this.state = 2 }
        this.getCurrentTime = () => { this.polls++; return this.currentTime }
        this.getPlayerState = () => { this.commands.push('state'); return this.state }
        this.options.events.onReady({ target: this })
      }
      fail() {
        delete this.seekTo; delete this.playVideo; delete this.pauseVideo
        delete this.getCurrentTime; delete this.getPlayerState
        this.options.events.onError({ target: this })
      }
      destroy() { this.destroyed = true; this.frame.remove(); if (this.throwDestroy) throw new Error('SDK frame already unavailable') }
    }
    Object.assign(window, { YT: { Player: ControlledPlayer }, __youtubeProbe: probe })
  })
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  let sources = 0
  let restoredSourceReads = 0
  const preparedSources = new Map<string, object>()
  await page.route(`**${api}/sources/src_youtube_probe_*`, route => {
    restoredSourceReads++
    return route.fulfill({ json: preparedSources.get(new URL(route.request().url()).pathname.split('/').at(-1)!) })
  })
  await page.route(`**${api}/sources`, route => {
    const url = route.request().postDataJSON().url
    sources++
    const source = {
      id: `src_youtube_probe_${sources}`, kind: 'youtube', provider: 'youtube', provider_video_id: new URL(url).searchParams.get('v'),
      source_url: url, title: `Controlled video ${sources}`, duration_ms: 1200000,
      preview_url: null, embed_url: `https://www.youtube-nocookie.com/embed/${new URL(url).searchParams.get('v')}`, thumbnail_url: null, preview_kind: 'youtube',
    }
    preparedSources.set(source.id, source)
    return route.fulfill({ status: 201, json: source })
  })
  const snapshot = (index: number) => page.evaluate(index => {
    const instance = (window as YoutubeProbeWindow).__youtubeProbe.instances[index]
    return { commands: instance.commands, polls: instance.polls, destroyed: instance.destroyed }
  }, index)
  const ready = (index: number) => page.evaluate(index => (window as YoutubeProbeWindow).__youtubeProbe.instances[index].ready(), index)
  const fail = (index: number) => page.evaluate(index => (window as YoutubeProbeWindow).__youtubeProbe.instances[index].fail(), index)
  const open = async (id: string) => {
    await goToSource(page)
    await page.getByLabel('Ссылка на видео', { exact: true }).fill(`https://www.youtube.com/watch?v=${id}`)
    await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
    await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
    await expect.poll(() => page.evaluate(() => (window as YoutubeProbeWindow).__youtubeProbe.instances.length)).toBe(sources)
  }
  const preview = page.getByRole('button', { name: 'Посмотреть фрагмент', exact: true })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Открыть видео', exact: true })).toBeEnabled()
  await open('N3REfH4N9Dg')
  await expect(preview).toBeDisabled()
  await page.locator('.trim-track').click({ position: { x: 80, y: 4 } })
  await goToSource(page)
  await expect(page.getByLabel('Ссылка на видео', { exact: true })).toHaveValue('https://www.youtube.com/watch?v=N3REfH4N9Dg')
  await stepButton(page, 2).click()
  expect((await snapshot(0)).commands).toEqual([])
  await page.evaluate(() => { (window as YoutubeProbeWindow).__youtubeProbe.instances[0].throwDestroy = true })

  await open('aqz-KE-bpKQ')
  expect((await snapshot(0)).destroyed).toBe(true)
  await ready(0)
  await fail(0)
  await page.clock.runFor(300)
  await expect(preview).toBeDisabled()
  expect((await snapshot(0)).polls).toBe(0)
  await expect(page.getByText('Не удалось открыть плеер.', { exact: false })).toHaveCount(0)

  await showExactTimes(page)
  const position = page.locator('#overview')
  await position.focus(); await position.press('Home'); await position.press('ArrowRight'); await position.press('ArrowRight'); await position.press('ArrowLeft')
  await expect(position).toHaveValue('100')
  await goToSource(page)
  await ready(1)
  await page.clock.runFor(300)
  expect((await snapshot(1)).commands).toEqual(['seek:0.1', 'pause'])
  await stepButton(page, 2).click()
  await expect(position).toHaveValue('100')
  await page.getByRole('button', { name: 'Начало по позиции плеера', exact: true }).click()
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:00.100')
  await expect(preview).toBeEnabled()
  await preview.click()
  await page.getByRole('button', { name: 'Остановить просмотр', exact: true }).click()
  expect((await snapshot(1)).commands.slice(-3)).toEqual(['seek:0.1', 'play', 'pause'])
  await page.locator('h1').focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('Space')
  expect((await snapshot(1)).commands.slice(-4)).toEqual(['state', 'play', 'state', 'pause'])
  await page.clock.runFor(300)
  expect((await snapshot(1)).polls).toBeGreaterThan(0)

  await preview.click()
  await expect(page.getByRole('button', { name: 'Остановить просмотр', exact: true })).toBeEnabled()
  await fail(1)
  await expect(preview).toBeEnabled()
  await expect(page.locator('.window-player')).toBeVisible()
  const failed = await snapshot(1)
  await page.locator('.trim-track').click({ position: { x: 80, y: 4 } })
  await goToSource(page)
  await stepButton(page, 2).click()
  await ready(1)
  await page.clock.runFor(300)
  await expect(preview).toBeEnabled()
  expect((await snapshot(1)).polls).toBe(failed.polls)
  expect((await snapshot(1)).commands).toEqual(failed.commands)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:00.100')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:30.000')
  await page.evaluate(() => { (window as YoutubeProbeWindow).__youtubeProbe.instances[1].destroy = undefined })
  await open('HXpdwSt_8Ns')
  await ready(1); await fail(1)
  await expect(preview).toBeDisabled()
  await expect(page.getByText('Не удалось открыть плеер.', { exact: false })).toHaveCount(0)
  await ready(2)
  await expect(preview).toBeEnabled()

  const savedPosition = await readBrowserDraft(page); savedPosition.current_ms = 8000;
  await replaceBrowserDraft(page, savedPosition);
  await page.reload()
  await expect.poll(() => page.evaluate(() => (window as YoutubeProbeWindow).__youtubeProbe.instances.length)).toBe(1)
  await showExactTimes(page)
  await expect(position).toHaveValue('8000')
  await ready(0)
  await expect(preview).toBeEnabled()
  await page.clock.runFor(300)
  await expect(position).toHaveValue('8000')
  expect((await snapshot(0)).commands).toEqual(['seek:8'])

  await page.reload()
  await expect.poll(() => page.evaluate(() => (window as YoutubeProbeWindow).__youtubeProbe.instances.length)).toBe(1)
  await showExactTimes(page)
  await expect(position).toHaveValue('8000')
  await position.focus(); await position.press('Home'); await position.press('ArrowRight')
  await expect(position).toHaveValue('100')
  await ready(0)
  await expect(preview).toBeEnabled()
  await page.clock.runFor(300)
  await expect(position).toHaveValue('100')
  expect((await snapshot(0)).commands).toEqual(['seek:0.1'])
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:00.000')
  await expect(page.getByLabel('Конец', { exact: true })).toHaveValue('00:00:30.000')

  await page.reload()
  await expect.poll(() => page.evaluate(() => (window as YoutubeProbeWindow).__youtubeProbe.instances.length)).toBe(1)
  await page.evaluate(() => { (window as YoutubeProbeWindow).__youtubeProbe.instances[0].throwSeek = true })
  await ready(0)
  await expect(preview).toBeEnabled()
  await expect(page.locator('.window-player')).toBeVisible()
  await page.clock.runFor(300)
  expect((await snapshot(0)).polls).toBe(0)
  expect(pageErrors).toEqual([])
  expect(sources).toBe(3)
  expect(restoredSourceReads).toBe(3)
})

test('a real public platform source exposes honest preview availability and exports a manual middle interval', async ({ page, playwright, baseURL }, testInfo) => {
  const url = process.env.CUTMY_E2E_PLATFORM_SOURCE
  const provider = process.env.CUTMY_E2E_PLATFORM_PROVIDER
  test.skip(!url || !provider, 'Set CUTMY_E2E_PLATFORM_SOURCE and CUTMY_E2E_PLATFORM_PROVIDER for a real public provider check.')
  test.setTimeout(240_000)
  await page.goto('/')
  await page.getByRole('button', { name: 'English', exact: true }).click()
  const opened = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${api}/sources`), { timeout: 120_000 })
  await page.getByLabel('Video link', { exact: true }).fill(url!)
  await page.getByRole('button', { name: 'Open video', exact: true }).click()
  const response = await opened
  expect(response.ok(), await response.text()).toBeTruthy()
  const source = await response.json()
  expect(source.provider).toBe(provider)
  expect(source.title).toBeTruthy()
  expect(source.duration_ms).toBeGreaterThan(6000)
  expect(source.source_url).toMatch(/^https:\/\//)
  const sourcePage = new URL(source.source_url)
  expect(sourcePage.username).toBe('')
  expect(sourcePage.password).toBe('')
  await expect(stepButton(page, 2)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByText(source.title, { exact: true }).first()).toBeVisible()
  if (source.preview_kind === 'none') {
    // Provider metadata is real, but no controllable player was promised.
    await expect(page.locator('video')).not.toBeVisible()
    await expect(page.locator('iframe')).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Preview clip', exact: true })).toBeDisabled()
    await expect(page.getByLabel('Start', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Watch the original video', exact: true })).toHaveAttribute('href', sourcePage.href)
  } else if (source.preview_kind === 'native' || source.preview_kind === 'window') {
    await expect(page.locator('video')).toBeVisible()
    await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).duration)).toBeGreaterThan(6)
  } else {
    expect(source.preview_kind).toBe('youtube')
    await expect(page.locator('iframe')).toBeVisible()
  }
  if (source.thumbnail_url) {
    expect(source.thumbnail_url).toBe(`${api}/sources/${source.id}/thumbnail`)
    const ownedThumbnail = await page.request.get(source.thumbnail_url)
    expect(ownedThumbnail.status()).toBe(200)
    expect(ownedThumbnail.headers()['content-type']).toMatch(/^image\/(jpeg|png)/)
    expect((await ownedThumbnail.body()).length).toBeGreaterThan(100)
    const stranger = await playwright.request.newContext({ baseURL })
    try {
      expect((await stranger.get(`${api}/session`)).ok()).toBeTruthy()
      expect((await stranger.get(source.thumbnail_url)).status()).toBe(404)
    } finally { await stranger.dispose() }
  }
  await showExactTimes(page)
  const start = process.env.CUTMY_E2E_PLATFORM_START_MS ? Number(process.env.CUTMY_E2E_PLATFORM_START_MS) : Math.floor(source.duration_ms / 2 / 1000) * 1000
  const end = process.env.CUTMY_E2E_PLATFORM_END_MS ? Number(process.env.CUTMY_E2E_PLATFORM_END_MS) : start + 3000
  expect(Number.isSafeInteger(start)).toBe(true)
  expect(Number.isSafeInteger(end)).toBe(true)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  expect(end).toBeLessThan(source.duration_ms)
  const time = (value: number) => {
    const hours = Math.floor(value / 3_600_000), minutes = Math.floor(value / 60_000) % 60, seconds = Math.floor(value / 1000) % 60
    return [hours, minutes, seconds].map(part => String(part).padStart(2, '0')).join(':') + '.' + String(value % 1000).padStart(3, '0')
  }
  await page.getByLabel('Start', { exact: true }).fill(time(start))
  await page.getByLabel('Start', { exact: true }).press('Tab')
  await page.getByLabel('End', { exact: true }).fill(time(end))
  await page.getByLabel('End', { exact: true }).press('Tab')
  if (source.preview_kind === 'window') {
    await page.getByRole('button', { name: 'Preview clip', exact: true }).click()
    await expect(page.getByText('Preparing preview…', { exact: true })).toHaveCount(0, { timeout: 120000 })
    await expect.poll(() => page.locator('.window-player video').evaluate((element: HTMLVideoElement) => element.paused), { timeout: 15000 }).toBe(false)
    await page.getByRole('button', { name: 'Stop preview', exact: true }).click()
  }
  await goToExport(page)
  const created = page.waitForResponse(result => result.request().method() === 'POST' && result.url().endsWith(`${api}/jobs`))
  await page.getByRole('button', { name: 'Cut a clip', exact: true }).click()
  const creation = await created
  expect(creation.ok(), await creation.text()).toBeTruthy()
  expect(creation.request().postDataJSON()).toMatchObject({ format: 'mp4', quality: '1080p', cut_mode: 'accurate' })
  expect(creation.request().postDataJSON().ranges.map((range: { start_ms: number; end_ms: number }) => [range.start_ms, range.end_ms]))
    .toEqual([[start, end]])
  const job = await waitJob(page.request, (await creation.json()).id)
  expect(job.status, JSON.stringify(job)).toBe('succeeded')
  expect(job.items[0].artifact.actual_start_ms).toBe(start)
  expect(Math.abs(job.items[0].artifact.actual_end_ms - end)).toBeLessThan(200)
  const probe = await probeDownloadedFile(page.request, job.items[0].artifact.download_url, `${provider}-middle.mp4`, testInfo)
  expect(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === 'video')).toBeTruthy()
  expect(Math.abs(Number(probe.format.duration) - (end - start) / 1000)).toBeLessThan(0.2)
  await testInfo.attach('Actual public source metadata', { body: JSON.stringify({ provider: source.provider, title: source.title, duration_ms: source.duration_ms, preview_kind: source.preview_kind, source_url: source.source_url, thumbnail_checks_performed: Boolean(source.thumbnail_url) }, null, 2), contentType: 'application/json' })
  expect((await page.request.delete(`${api}/sources/${source.id}`, { headers: { Origin: new URL(baseURL!).origin } })).status()).toBe(204)
})

test('platform failures are actionable in both languages and preserve the existing real draft', async ({ page }) => {
  await page.goto('/')
  await uploadThroughUI(page)
  await showExactTimes(page)
  await page.getByLabel('Начало', { exact: true }).fill('00:00:02.250')
  await page.getByLabel('Начало', { exact: true }).press('Tab')
  const cases = [
    { code: 'invalid_source_url', status: 400, ru: 'Вставьте ссылку на отдельное видео, запись стрима или клип.', en: 'Paste a link to one video, stream recording or clip.' },
    { code: 'unsupported_collection', status: 400, ru: 'Ссылка на канал или плейлист не подойдёт.', en: 'Channel and playlist links will not work.' },
    { code: 'live_not_supported', status: 422, ru: 'Вставьте ссылку на запись стрима или готовый клип.', en: 'Paste a link to a stream recording or a finished clip.' },
    { code: 'platform_access_required', status: 422, ru: 'Видео требует входа, подписки или разрешения владельца.', en: "The video requires sign-in, a subscription or the owner's permission." },
    { code: 'platform_unavailable', status: 422, ru: 'Сервис не отдал видео.', en: 'The service did not provide the video.' },
    { code: 'unsupported_stream', status: 422, ru: 'Этот поток пока нельзя обработать.', en: 'This stream cannot be processed yet.' },
  ]
  let failure = cases[0]
  await page.route(`**${api}/sources`, route => route.fulfill({ status: failure.status, json: { error: { code: failure.code, message: 'Raw provider diagnostic must not appear in the interface.' } } }))
  for (const language of ['ru', 'en'] as const) {
    await page.getByRole('button', { name: language === 'ru' ? 'Русский' : 'English', exact: true }).click()
    await goToSource(page)
    await page.getByRole('button', { name: language === 'ru' ? 'Ссылка' : 'Link', exact: true }).click()
    for (const entry of cases) {
      failure = entry
      const field = page.getByLabel(language === 'ru' ? 'Ссылка на видео' : 'Video link', { exact: true })
      await field.fill('https://www.twitch.tv/videos/2833641956')
      await page.getByRole('button', { name: language === 'ru' ? 'Открыть видео' : 'Open video', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText(entry[language])
      await expect(page.getByRole('alert')).not.toContainText('Raw provider diagnostic')
      await expect(field).toHaveValue('https://www.twitch.tv/videos/2833641956')
    }
  }
  await page.getByRole('button', { name: 'Русский', exact: true }).click()
  await stepButton(page, 2).click()
  await showExactTimes(page)
  await expect(page.getByLabel('Начало', { exact: true })).toHaveValue('00:00:02.250')
  await expect.poll(() => page.locator('video').evaluate(element => (element as HTMLVideoElement).duration)).toBeCloseTo(12, 1)
})

test('playback coalesces draft writes, flushes the latest position and suspends polling outside the editor', async ({ page }) => {
  type ProbeWindow = Window & { __playbackProbe: { polls: number; writes: number } }
  await page.clock.install()
  await page.addInitScript(() => {
    const probe = { polls: 0, writes: 0 }
    const write = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('cutmy.project.view.v2.')) probe.writes++
      return write.call(this, key, value)
    }
    class Player {
      time = 0
      playing = false
      constructor(_element: HTMLElement, options: { events: { onReady(event: { target: Player }): void } }) {
        queueMicrotask(() => options.events.onReady({ target: this }))
      }
      getCurrentTime() { probe.polls++; if (this.playing) this.time += 0.15; return this.time }
      getPlayerState() { return this.playing ? 1 : 2 }
      seekTo(seconds: number) { this.time = seconds }
      playVideo() { this.playing = true }
      pauseVideo() { this.playing = false }
      destroy() {}
    }
    Object.assign(window, { __playbackProbe: probe, YT: { Player } })
  })
  const source = {
    id: 'src_playback_budget', title: 'Playback budget', kind: 'youtube', duration_ms: 120000,
    preview_url: null, embed_url: 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ', thumbnail_url: null,
  }
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.route(`**${api}/sources`, route => route.fulfill({ status: 201, json: source }))
  await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({ json: source }))
  await page.goto('/')
  await page.getByLabel('Ссылка на видео', { exact: true }).fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
  await showExactTimes(page)
  await page.getByRole('button', { name: 'Посмотреть фрагмент', exact: true }).click()
  await page.clock.runFor(1200)
  await page.evaluate(() => { const probe = (window as ProbeWindow).__playbackProbe; probe.writes = 0; probe.polls = 0 })
  await page.clock.runFor(15000)
  const active = await page.evaluate(() => (window as ProbeWindow).__playbackProbe)
  expect(active.polls).toBeGreaterThanOrEqual(99)
  expect(active.writes).toBeGreaterThan(0)
  expect(active.writes).toBeLessThanOrEqual(16)
  await page.getByRole('button', { name: 'Остановить просмотр', exact: true }).click()
  // The native range property snaps to its 100ms step; its value attribute
  // retains the exact playback time supplied by React.
  const current = Number(await page.locator('#overview').getAttribute('value'))
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  expect(await readBrowserDraft(page).then(saved => saved.current_ms)).toBe(current)

  await goToSource(page)
  const inactivePolls = await page.evaluate(() => (window as ProbeWindow).__playbackProbe.polls)
  await page.clock.runFor(3000)
  expect(await page.evaluate(() => (window as ProbeWindow).__playbackProbe.polls)).toBe(inactivePolls)
  await page.reload()
  await stepButton(page, 2).click()
  await showExactTimes(page)
  expect(Number(await page.locator('#overview').getAttribute('value'))).toBe(current)
})

for (const mode of ['platform', 'codec fallback'] as const) {
  test(`window preview: ${mode} seeks into hour eight, retries, and stops at the selected end`, async ({ page }) => {
    const requests: number[] = []
    const source = {
      id: 'src_window_preview', title: 'Nine-hour recording', kind: mode === 'platform' ? 'platform' : 'upload',
      provider: 'twitch', duration_ms: 9 * 3600000, preview_kind: mode === 'platform' ? 'window' : 'native',
      preview_url: mode === 'platform' ? null : `${api}/sources/src_window_preview/media`, embed_url: null, thumbnail_url: null,
    }
    await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
    await page.route(`**${api}/sources`, route => route.fulfill({ status: 201, json: source }))
    await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({ json: source }))
    await page.route(`**${api}/sources/${source.id}/media`, route => route.fulfill({ contentType: 'video/mp4', body: 'unsupported media' }))
    let failNext = false
    await page.route(`**${api}/sources/${source.id}/preview?*`, route => {
      const url = new URL(route.request().url())
      requests.push(Number(url.searchParams.get('start_ms')))
      if (failNext && !url.searchParams.has('priority')) { failNext = false; return route.fulfill({ status: 422, json: { error: { code: 'platform_unavailable' } } }) }
      return route.fulfill({ contentType: 'video/mp4', body: readFileSync(process.env.CUTMY_E2E_MEDIA!) })
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    await page.getByLabel('Ссылка на видео', { exact: true }).fill('https://www.twitch.tv/videos/123456789')
    await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
    await expect(page.locator('.window-player')).toBeVisible()
    const video = page.locator('.window-player video')
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0)
    const seek = page.getByRole('slider', { name: 'Позиция в видео', exact: true })
    await seek.evaluate(el => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '28802000')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect.poll(() => requests.includes(28800000)).toBe(true)
    await expect(page.getByText('Готовим предпросмотр…', { exact: true })).toHaveCount(0)
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeCloseTo(2, 1)
    await expect(seek).toHaveValue('28802000')
    await showExactTimes(page)
    await page.getByLabel('Конец', { exact: true }).fill('08:00:04.000')
    await page.getByLabel('Конец', { exact: true }).press('Tab')
    await page.getByLabel('Начало', { exact: true }).fill('08:00:02.000')
    await page.getByLabel('Начало', { exact: true }).press('Tab')
    await page.getByRole('button', { name: 'Посмотреть фрагмент', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Остановить просмотр', exact: true })).toBeVisible()
    await video.evaluate((el: HTMLVideoElement) => { el.currentTime = 4.1; el.dispatchEvent(new Event('timeupdate')) })
    await expect(page.getByRole('button', { name: 'Посмотреть фрагмент', exact: true })).toBeVisible()
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true)
    expect(requests.filter(ms => ms === 28800000)).toHaveLength(1)
    failNext = true
    await seek.evaluate(el => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '28922000')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(page.getByText('Не удалось загрузить участок видео.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Повторить', exact: true }).click()
    await expect(page.getByText('Не удалось загрузить участок видео.', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Готовим предпросмотр…', { exact: true })).toHaveCount(0)
    await expect(seek).toHaveValue('28922000')
    expect(requests.filter(ms => ms === 28920000)).toHaveLength(2)
    await video.evaluate(async (el: HTMLVideoElement) => { await el.play(); el.dispatchEvent(new Event('ended')) })
    await expect.poll(() => requests.includes(28950000)).toBe(true)
    await expect(page.getByText('Готовим предпросмотр…', { exact: true })).toHaveCount(0)
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(seek).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}

test('window preview caches revisits and preloads the next interval without another seek request', async ({ page }, testInfo) => {
  const requests: Array<{ start: number; background: boolean }> = []
  const source = { id: 'src_preview_cache', title: 'Nine-hour recording', kind: 'platform', provider: 'twitch', duration_ms: 9 * 3600000, preview_kind: 'window', preview_url: null, embed_url: null, thumbnail_url: null }
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.route(`**${api}/sources`, route => route.fulfill({ status: 201, json: source }))
  await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({ json: source }))
  await page.route(`**${api}/sources/${source.id}/preview?*`, route => {
    const url = new URL(route.request().url())
    requests.push({ start: Number(url.searchParams.get('start_ms')), background: url.searchParams.get('priority') === 'background' })
    return route.fulfill({ contentType: 'video/mp4', body: readFileSync(process.env.CUTMY_E2E_MEDIA!) })
  })
  await page.goto('/')
  await page.getByLabel('Ссылка на видео', { exact: true }).fill('https://www.twitch.tv/videos/123456789')
  await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
  const video = page.locator('.window-player video')
  const slider = page.getByRole('slider', { name: 'Позиция в видео', exact: true })
  const seek = async (ms: number) => {
    await slider.evaluate((el, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(value))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, ms)
    await expect(slider).toHaveValue(String(ms))
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeCloseTo(ms % 30000 / 1000, 1)
    await expect(page.getByText('Готовим предпросмотр…', { exact: true })).toHaveCount(0)
  }
  await expect(page.getByText('Следующий участок готов', { exact: true })).toBeVisible()
  expect(requests).toEqual([{ start: 0, background: false }, { start: 30000, background: true }])
  await seek(32000)
  expect(requests.filter(request => request.start === 30000)).toHaveLength(1)
  await seek(28802000)
  await seek(2000)
  expect(requests.filter(request => request.start === 0)).toHaveLength(1)
  await seek(28803000)
  expect(requests.filter(request => request.start === 28800000)).toHaveLength(1)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(slider).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('cached-preview-mobile.png'), fullPage: true })
})

test('window preview ignores stale seeks, bounds retained media, and releases it when switching source', async ({ page }) => {
  type ProbeWindow = Window & { __previewURLs: Set<string> }
  const requests: number[] = []
  const errors: string[] = []
  let sourceNumber = 0
  let releaseStale: (() => void) | undefined
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } })
    const live = new Set<string>()
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = blob => { const url = create(blob); live.add(url); return url }
    URL.revokeObjectURL = url => { live.delete(url); revoke(url) }
    Object.assign(window, { __previewURLs: live })
  })
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.route(`**${api}/sources`, route => route.fulfill({ status: 201, json: { id: `src_cache_bound_${++sourceNumber}`, title: 'Long recording', kind: 'platform', provider: 'twitch', duration_ms: 9 * 3600000, preview_kind: 'window', preview_url: null, embed_url: null, thumbnail_url: null } }))
  await page.route(`**${api}/sources/*/preview?*`, async route => {
    const start = Number(new URL(route.request().url()).searchParams.get('start_ms'))
    requests.push(start)
    if (start === 28800000) await new Promise<void>(resolve => { releaseStale = resolve })
    await route.fulfill({ contentType: 'video/mp4', body: readFileSync(process.env.CUTMY_E2E_MEDIA!) }).catch(() => undefined)
  })
  const open = async () => {
    await page.getByLabel('Ссылка на видео', { exact: true }).fill('https://www.twitch.tv/videos/123456789')
    await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
    await expect.poll(() => page.locator('.window-player video').evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0)
  }
  const slider = page.getByRole('slider', { name: 'Позиция в видео', exact: true })
  const seek = (ms: number) => slider.evaluate((el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(value))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, ms)
  await page.goto('/')
  await open()
  await seek(28802000)
  await expect.poll(() => Boolean(releaseStale)).toBe(true)
  await seek(28862000)
  await expect.poll(() => requests.includes(28860000)).toBe(true)
  await expect(page.getByText('Готовим предпросмотр…', { exact: true })).toHaveCount(0)
  releaseStale!()
  await expect(slider).toHaveValue('28862000')
  for (let index = 1; index <= 12; index++) {
    await seek(index * 120000 + 2000)
    await expect(page.getByText('Готовим предпросмотр…', { exact: true })).toHaveCount(0)
    await expect.poll(() => page.locator('.window-player video').evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0)
    expect(await page.evaluate(() => (window as ProbeWindow).__previewURLs.size)).toBeLessThanOrEqual(8)
  }
  await seek(2000)
  await expect.poll(() => requests.filter(start => start === 0).length).toBe(2)
  await goToSource(page)
  await open()
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__previewURLs.size)).toBe(1)
  expect(errors).toEqual([])
})

for (const mode of ['promote', 'replace'] as const) test(`window preview ${mode}s speculative loading for a seek and keeps playback intent`, async ({ page }) => {
  const requests: Array<{ start: number; background: boolean }> = []
  let releaseBackground: (() => void) | undefined
  const source = { id: 'src_preview_priority', title: 'Long recording', kind: 'platform', provider: 'twitch', duration_ms: 9 * 3600000, preview_kind: 'window', preview_url: null, embed_url: null, thumbnail_url: null }
  await page.route(`**${api}/session`, route => route.fulfill({ json: { ok: true } }))
  await page.route(`**${api}/sources`, route => route.fulfill({ status: 201, json: source }))
  await page.route(`**${api}/sources/${source.id}`, route => route.fulfill({ json: source }))
  await page.route(`**${api}/sources/${source.id}/preview?*`, async route => {
    const url = new URL(route.request().url())
    const start = Number(url.searchParams.get('start_ms')), background = url.searchParams.has('priority')
    requests.push({ start, background })
    if (start === 30000 && background) await new Promise<void>(resolve => { releaseBackground = resolve })
    await route.fulfill({ contentType: 'video/mp4', body: readFileSync(process.env.CUTMY_E2E_MEDIA!) }).catch(() => undefined)
  })
  await page.goto('/')
  await page.getByLabel('Ссылка на видео', { exact: true }).fill('https://www.twitch.tv/videos/123456789')
  await page.getByRole('button', { name: 'Открыть видео', exact: true }).click()
  await expect.poll(() => Boolean(releaseBackground)).toBe(true)
  const video = page.locator('.window-player video')
  await video.evaluate((el: HTMLVideoElement) => el.play())
  const seek = page.getByRole('slider', { name: 'Позиция в видео', exact: true })
  const target = mode === 'promote' ? 32000 : 28802000
  await seek.evaluate((el, target) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(target))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, target)
  if (mode === 'promote') releaseBackground!()
  else await expect.poll(() => requests.some(request => request.start === 28800000 && !request.background)).toBe(true)
  await expect(page.getByText('Готовим предпросмотр…', { exact: true })).toHaveCount(0)
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false)
  releaseBackground!()
  await video.evaluate((el: HTMLVideoElement) => el.pause())
  expect(Number(await seek.inputValue())).toBeGreaterThanOrEqual(target)
  expect(Number(await seek.inputValue())).toBeLessThan(target + 28000)
  expect(requests.filter(request => request.start === 30000)).toHaveLength(1)
  await expect(page.getByText('Загружаем следующий участок…', { exact: true })).toHaveCount(0)
})
