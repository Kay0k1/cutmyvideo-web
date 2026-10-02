import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { expect, type APIRequestContext, type TestInfo } from '@playwright/test'

export const api = '/api/v1'

export async function upload(request: APIRequestContext) {
  const { readFile } = await import('node:fs/promises')
  const response = await request.post(`${api}/uploads`, {
    multipart: { file: { name: 'qa-interview.mp4', mimeType: 'video/mp4', buffer: await readFile(process.env.CUTMY_E2E_MEDIA!) } },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

export async function waitJob(request: APIRequestContext, jobId: string) {
  let result: any
  await expect.poll(async () => {
    const response = await request.get(`${api}/jobs/${jobId}`)
    expect(response.ok()).toBeTruthy()
    result = await response.json()
    return result.status
  }, { timeout: 60_000, intervals: [250, 500, 1000] }).toMatch(/^(succeeded|failed|cancelled)$/)
  return result
}

export async function probeDownloadedFile(request: APIRequestContext, url: string, name: string, testInfo: TestInfo) {
  const response = await request.get(url)
  expect(response.ok(), await response.text()).toBeTruthy()
  const filename = testInfo.outputPath(name)
  await writeFile(filename, await response.body())
  const details = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filename], { encoding: 'utf8' }))
  await testInfo.attach(name, { path: filename })
  await testInfo.attach(`${name}.probe.json`, { body: JSON.stringify(details, null, 2), contentType: 'application/json' })
  return details
}

export function assertFirstFrameMatchesSource(output: string, sourceMS: number) {
  const frame = (file: string, seconds: number) => execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file,
    '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', 'pipe:1',
  ], { timeout: 15_000 })
  const original = frame(process.env.CUTMY_E2E_MEDIA!, sourceMS / 1000)
  const result = frame(output, 0)
  expect(result.length).toBe(original.length)
  const difference = result.reduce((total, value, i) => total + Math.abs(value - original[i]), 0) / result.length
  // Allow normal codec loss and rounding to a neighboring frame, while detecting
  // an export that accidentally begins at time zero or the other selected range.
  expect(difference).toBeLessThan(2)
}
