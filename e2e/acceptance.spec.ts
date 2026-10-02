import { expect, test } from '@playwright/test'
import { api, assertFirstFrameMatchesSource, probeDownloadedFile, upload, waitJob } from './helpers'

test('exports two precise MP4 ranges as real playable files', async ({ request }, testInfo) => {
  await request.get(`${api}/session`)
  const source = await upload(request)
  expect(source.duration_ms).toBeGreaterThanOrEqual(11_950)
  expect(source.duration_ms).toBeLessThanOrEqual(12_050)
  expect(source.preview_url).toBeTruthy()
  const preview = await request.get(source.preview_url, { headers: { Range: 'bytes=0-255' } })
  expect(preview.status()).toBe(206)

  const ranges = [
    { start_ms: 1000, end_ms: 3250, label: 'Opening' },
    { start_ms: 5500, end_ms: 8100, label: 'Second moment' },
  ]
  const response = await request.post(`${api}/jobs`, {
    headers: { 'Idempotency-Key': `qa-multi-${testInfo.testId}` },
    data: { source_id: source.id, ranges, format: 'mp4', quality: '720p', cut_mode: 'accurate' },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const job = await waitJob(request, (await response.json()).id)
  expect(job.status, JSON.stringify(job)).toBe('succeeded')
  expect(job.items).toHaveLength(2)
  for (let i = 0; i < ranges.length; i++) {
    const artifact = job.items[i].artifact
    expect(artifact).toBeTruthy()
    expect(artifact.actual_start_ms).toBe(ranges[i].start_ms)
    const probe = await probeDownloadedFile(request, artifact.download_url, `moment-${i + 1}.mp4`, testInfo)
    expect(probe.streams.some((stream: any) => stream.codec_type === 'video')).toBeTruthy()
    expect(probe.streams.some((stream: any) => stream.codec_type === 'audio')).toBeTruthy()
    expect(Math.abs(Number(probe.format.duration) - (ranges[i].end_ms - ranges[i].start_ms) / 1000)).toBeLessThan(0.2)
    assertFirstFrameMatchesSource(testInfo.outputPath(`moment-${i + 1}.mp4`), ranges[i].start_ms)
  }
})

test('opens and exports a public direct media URL', async ({ request }, testInfo) => {
  test.skip(!process.env.CUTMY_E2E_PUBLIC_SOURCE, 'Set CUTMY_E2E_PUBLIC_SOURCE to run the external-source check.')
  await request.get(`${api}/session`)
  const response = await request.post(`${api}/sources`, { data: { url: process.env.CUTMY_E2E_PUBLIC_SOURCE } })
  expect(response.ok(), await response.text()).toBeTruthy()
  const source = await response.json()
  expect(source.duration_ms).toBeGreaterThan(2000)
  const creation = await request.post(`${api}/jobs`, {
    data: { source_id: source.id, ranges: [{ start_ms: 500, end_ms: 2000, label: 'Public URL' }], format: 'mp4', quality: '720p', cut_mode: 'accurate' },
  })
  expect(creation.ok(), await creation.text()).toBeTruthy()
  const job = await waitJob(request, (await creation.json()).id)
  expect(job.status, JSON.stringify(job)).toBe('succeeded')
  const probe = await probeDownloadedFile(request, job.items[0].artifact.download_url, 'public-url.mp4', testInfo)
  expect(probe.streams.some((stream: any) => stream.codec_type === 'video')).toBeTruthy()
  expect(Math.abs(Number(probe.format.duration) - 1.5)).toBeLessThan(0.2)
})

test('exports MP3 audio and rejects invalid ranges before creating work', async ({ request }, testInfo) => {
  await request.get(`${api}/session`)
  const source = await upload(request)
  const data = { source_id: source.id, ranges: [{ start_ms: 2250, end_ms: 5750, label: 'Audio' }], format: 'mp3', quality: 'best', cut_mode: 'accurate' }
  const creation = await request.post(`${api}/jobs`, { data })
  expect(creation.ok(), await creation.text()).toBeTruthy()
  const job = await waitJob(request, (await creation.json()).id)
  expect(job.status, JSON.stringify(job)).toBe('succeeded')
  const probe = await probeDownloadedFile(request, job.items[0].artifact.download_url, 'moment.mp3', testInfo)
  expect(probe.streams).toHaveLength(1)
  expect(probe.streams[0].codec_type).toBe('audio')
  expect(probe.streams[0].codec_name).toBe('mp3')
  expect(Math.abs(Number(probe.format.duration) - 3.5)).toBeLessThan(0.2)

  for (const range of [{ start_ms: 5000, end_ms: 4000 }, { start_ms: -100, end_ms: 2000 }, { start_ms: 0, end_ms: 15000 }]) {
    const invalid = await request.post(`${api}/jobs`, { data: { ...data, ranges: [range] } })
    expect(invalid.status()).toBe(400)
    expect((await invalid.json()).error.message).toBeTruthy()
  }
})

test('copy mode reports its actual keyframe boundary', async ({ request }, testInfo) => {
  await request.get(`${api}/session`)
  const source = await upload(request)
  const creation = await request.post(`${api}/jobs`, {
    data: { source_id: source.id, ranges: [{ start_ms: 2500, end_ms: 4750, label: 'Copy' }], format: 'mp4', quality: 'best', cut_mode: 'copy' },
  })
  expect(creation.ok(), await creation.text()).toBeTruthy()
  const job = await waitJob(request, (await creation.json()).id)
  expect(job.status, JSON.stringify(job)).toBe('succeeded')
  const artifact = job.items[0].artifact
  expect(artifact.actual_start_ms).toBeGreaterThanOrEqual(0)
  expect(artifact.actual_start_ms).toBeLessThanOrEqual(2500)
  expect(artifact.actual_start_ms).not.toBe(2500)
  const probe = await probeDownloadedFile(request, artifact.download_url, 'copy.mp4', testInfo)
  expect(probe.streams.find((stream: any) => stream.codec_type === 'video').codec_name).toBe('h264')
  expect(Math.abs(Number(probe.format.duration) - (artifact.actual_end_ms - artifact.actual_start_ms) / 1000)).toBeLessThan(0.1)
})

test('cancelled queued or running exports reach a terminal state', async ({ request }) => {
  await request.get(`${api}/session`)
  const source = await upload(request)
  const response = await request.post(`${api}/jobs`, {
    data: {
      source_id: source.id,
      ranges: Array.from({ length: 12 }, (_, i) => ({ start_ms: 0, end_ms: 11_500, label: `Cancel ${i}` })),
      format: 'mp4', quality: '1080p', cut_mode: 'accurate',
    },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const id = (await response.json()).id
  const cancelled = await request.post(`${api}/jobs/${id}/cancel`)
  expect(cancelled.ok()).toBeTruthy()
  const terminal = await waitJob(request, id)
  expect(terminal.status).toBe('cancelled')
  expect(terminal.items.some((item: any) => item.status === 'queued' || item.status === 'running')).toBeFalsy()
})
