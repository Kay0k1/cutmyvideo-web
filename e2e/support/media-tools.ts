import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { api, uploadThroughUI, waitJob } from '../helpers'

export interface MediaToolsFixtures { directory: string; video: string; audio: string; dispose(): void }

/** Deliberate real signals: two quiet intervals, a black interval, two visual cuts,
 * and a replacement tone different from the source. No production media is used. */
export function mediaToolsFixtures(): MediaToolsFixtures {
  const directory = mkdtempSync(join(tmpdir(), 'cutmy-browser-media-tools-'))
  const video = join(directory, 'interview-with-pauses.mp4')
  const audio = join(directory, 'recorder-997hz.wav')
  const run = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 30_000 })
  run([
    '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'color=black:duration=1:size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'color=white:duration=4:size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000',
    '-filter_complex', "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a]volume='if(between(t,1.5,2.3)+between(t,5,6),0,0.5)':eval=frame[a]",
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '25', '-c:a', 'aac', '-movflags', '+faststart', video,
  ])
  run(['-f', 'lavfi', '-i', 'sine=frequency=997:duration=8:sample_rate=48000', '-c:a', 'pcm_s16le', audio])
  return { directory, video, audio, dispose: () => rmSync(directory, { recursive: true, force: true }) }
}

export async function openMediaToolsFixture(page: Page, file: string, owned: Set<string>) {
  await page.goto('/?lang=ru')
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`${api}/uploads`))
  await uploadThroughUI(page, file)
  const response = await accepted
  expect(response.status(), await response.text()).toBe(201)
  const source = await response.json()
  owned.add(source.id)
  await expect(page.locator('.editor-workspace')).toBeVisible()
  return source
}

export async function uploadOwnedAudio(request: APIRequestContext, file: string, owned: Set<string>) {
  const response = await request.post(`${api}/uploads`, { multipart: { file: { name: 'recorder-997hz.wav', mimeType: 'audio/wav', buffer: await readFile(file) } } })
  expect(response.status(), await response.text()).toBe(201)
  const source = await response.json()
  owned.add(source.id)
  return source
}

/** Delete only resources admitted in this browser's own session by this test. */
export async function removeOwnedSources(request: APIRequestContext, owned: Set<string>) {
  for (const source of owned) {
    let response = await request.delete(`${api}/sources/${source}`)
    if (response.status() === 409) {
      const listing = await request.get(`${api}/jobs`)
      expect(listing.ok(), await listing.text()).toBeTruthy()
      for (const job of (await listing.json()).jobs) {
        if (job.source_id !== source || !['queued', 'waiting_storage', 'running'].includes(job.status)) continue
        const cancellation = await request.post(`${api}/jobs/${job.id}/cancel`)
        expect(cancellation.ok(), await cancellation.text()).toBeTruthy()
        await waitJob(request, job.id)
      }
      response = await request.delete(`${api}/sources/${source}`)
    }
    expect([204, 404], await response.text()).toContain(response.status())
  }
  owned.clear()
}

export async function savedMediaDraft(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => {
    const active = sessionStorage.getItem('cutmy.project.active.v2')
    if (!active) return null
    const pending = sessionStorage.getItem(`cutmy.project.pending.v2.${active}`)
    if (pending) return JSON.parse(pending).draft ?? null
    const raw = localStorage.getItem(`cutmy.project.v2.${active}`)
    return raw ? JSON.parse(raw).draft ?? null : null
  })
}

export async function downloadedText(page: Page, click: () => Promise<void>) {
  const received = page.waitForEvent('download')
  await click()
  const download = await received
  const file = await download.path()
  expect(file).toBeTruthy()
  return { filename: download.suggestedFilename(), text: await readFile(file!, 'utf8') }
}

export function pcmAudio(file: string, start: number, duration: number) {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', file, '-map', '0:a:0', '-t', String(duration), '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { timeout: 30_000 })
}

export function rms(samples: Buffer) {
  let total = 0
  for (let offset = 0; offset < samples.length; offset += 2) total += (samples.readInt16LE(offset) / 32768) ** 2
  return Math.sqrt(total / (samples.length / 2))
}

export function frequency(samples: Buffer, sampleRate = 8000) {
  let crossings = 0
  for (let offset = 2; offset < samples.length; offset += 2) if ((samples.readInt16LE(offset - 2) < 0) !== (samples.readInt16LE(offset) < 0)) crossings++
  return crossings / 2 / (samples.length / 2 / sampleRate)
}

export function encodedLoudness(file: string): { input_i: string; input_tp: string; input_lra: string } {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], { timeout: 30_000, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  const report = result.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g)?.at(-1)
  expect(report, result.stderr).toBeTruthy()
  return JSON.parse(report!)
}
