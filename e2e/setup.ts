import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function setup() {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'cutmy-e2e-'))
  const mediaPath = process.env.CUTMY_E2E_MEDIA || join(fixtureDir, 'qa-interview.mp4')
  if (!process.env.CUTMY_E2E_MEDIA) {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=duration=12:size=640x360:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-g', '25', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', mediaPath,
    ], { timeout: 30_000 })
  }
  process.env.CUTMY_E2E_MEDIA = mediaPath
  const audioPath = join(fixtureDir, 'qa-audio-only.wav')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'pcm_s16le', audioPath,
  ], { timeout: 10_000 })
  process.env.CUTMY_E2E_AUDIO = audioPath
  const audioMP4Path = join(fixtureDir, 'qa-audio-only.mp4')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'aac', '-f', 'mp4', audioMP4Path,
  ], { timeout: 10_000 })
  process.env.CUTMY_E2E_AUDIO_MP4 = audioMP4Path
  const videoOnlyPath = join(fixtureDir, 'qa-video-only.mp4')
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=25',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-an', '-movflags', '+faststart', videoOnlyPath,
  ], { timeout: 10_000 })
  process.env.CUTMY_E2E_VIDEO_ONLY = videoOnlyPath
  return () => rmSync(fixtureDir, { recursive: true, force: true })
}
