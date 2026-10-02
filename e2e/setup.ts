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
  return () => rmSync(fixtureDir, { recursive: true, force: true })
}
