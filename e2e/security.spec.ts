import { expect, test } from '@playwright/test'
import { api, upload, waitJob } from './helpers'

test('rejects private URL destinations and malformed uploads', async ({ request }) => {
  await request.get(`${api}/session`)
  for (const url of ['https://127.0.0.1/private.mp4', 'https://169.254.169.254/private.mp4', 'https://[::1]/private.mp4', 'file:///etc/passwd']) {
    const response = await request.post(`${api}/sources`, { data: { url } })
    expect(response.status(), url).toBeGreaterThanOrEqual(400)
    expect(response.status(), url).toBeLessThan(500)
    expect(await response.text(), url).not.toContain('root:')
  }

  const response = await request.post(`${api}/uploads`, {
    multipart: { file: { name: 'not-a-video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('This is not a video.') } },
  })
  expect(response.status()).toBeGreaterThanOrEqual(400)
  expect(response.status()).toBeLessThan(500)
})

test('rejects cross-site mutations and never serves uploaded media as active HTML', async ({ request }) => {
  await request.get(`${api}/session`)
  const crossSite = await request.post(`${api}/sources`, {
    headers: { Origin: 'https://attacker.invalid', 'Sec-Fetch-Site': 'cross-site' },
    data: { url: 'https://127.0.0.1/private.mp4' },
  })
  expect(crossSite.status()).toBe(403)

  const { readFile } = await import('node:fs/promises')
  const response = await request.post(`${api}/uploads`, {
    multipart: { file: { name: 'qa-interview.html', mimeType: 'text/html', buffer: await readFile(process.env.CUTMY_E2E_MEDIA!) } },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const source = await response.json()
  const preview = await request.get(source.preview_url, { headers: { Range: 'bytes=0-255' } })
  expect(preview.status()).toBe(206)
  expect(preview.headers()['content-type']).not.toMatch(/text\/html|svg|javascript/i)
})

test('source, job and finished files are isolated between sessions', async ({ playwright, baseURL }) => {
  const owner = await playwright.request.newContext({ baseURL })
  const stranger = await playwright.request.newContext({ baseURL })
  try {
    await owner.get(`${api}/session`)
    await stranger.get(`${api}/session`)
    const source = await upload(owner)
    const creation = await owner.post(`${api}/jobs`, {
      data: { source_id: source.id, ranges: [{ start_ms: 1000, end_ms: 2500, label: 'Private clip' }], format: 'mp4', quality: '720p', cut_mode: 'accurate' },
    })
    expect(creation.ok(), await creation.text()).toBeTruthy()
    const job = await waitJob(owner, (await creation.json()).id)
    expect(job.status).toBe('succeeded')

    for (const url of [`${api}/sources/${source.id}`, `${api}/jobs/${job.id}`, source.preview_url, ...job.items.map((item: any) => item.artifact?.download_url)]) {
      if (!url) continue
      const response = await stranger.get(url)
      expect([403, 404], url).toContain(response.status())
    }
    const exportAttempt = await stranger.post(`${api}/jobs`, {
      data: { source_id: source.id, ranges: [{ start_ms: 1000, end_ms: 2000 }], format: 'mp4', quality: '720p', cut_mode: 'accurate' },
    })
    expect([403, 404]).toContain(exportAttempt.status())
  } finally {
    await owner.dispose()
    await stranger.dispose()
  }
})
