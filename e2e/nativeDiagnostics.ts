import type { Page, TestInfo } from '@playwright/test'

interface NativeObservation {
  capture: () => unknown
  stop: () => void
}
type DiagnosticWindow = Window & { __cutmyNativeObservation?: NativeObservation }

export async function diagnoseNativePreview(
  page: Page,
  testInfo: TestInfo,
  runtime: { browserName: string; headless: boolean; context: 'desktop' | 'touch' },
  checks: () => Promise<void>,
) {
  const script = await page.addInitScript(() => {
    const startedAt = Date.now()
    const startedMonotonic = performance.now()
    let observationErrorCount = 0
    const events: unknown[] = []
    const samples: unknown[] = []
    const eventNames = ['loadstart', 'loadedmetadata', 'loadeddata', 'durationchange', 'progress', 'suspend', 'canplay', 'canplaythrough',
      'play', 'playing', 'seeking', 'seeked', 'timeupdate', 'waiting', 'stalled', 'ended', 'pause', 'abort', 'emptied', 'error']
    const finite = (value: number | undefined | null) => typeof value === 'number' && Number.isFinite(value) ? value : null
    const ranges = (value: TimeRanges) => Array.from({ length: Math.min(value.length, 8) },
      (_, index) => [finite(value.start(index)), finite(value.end(index))])
    function readSnapshot() {
      const video = document.querySelector('video')
      const preview = document.querySelector<HTMLButtonElement>('.moment-preview button')
      const label = preview?.textContent?.trim()
      const previewControl = !preview ? 'absent' : preview.disabled ? 'disabled'
        : /^(Остановить просмотр|Stop preview)$/.test(label ?? '') ? 'stop'
          : /^(Посмотреть фрагмент|Preview clip)$/.test(label ?? '') ? 'preview' : 'unknown'
      const steps = Array.from(document.querySelectorAll('.steps-nav button'))
      const stepIndex = steps.findIndex(button => button.getAttribute('aria-current') === 'step')
      const quality = video?.getVideoPlaybackQuality?.()
      return {
        elapsedMs: Date.now() - startedAt,
        monotonicElapsedMs: performance.now() - startedMonotonic,
        media: video ? {
          currentTime: finite(video.currentTime), paused: video.paused, seeking: video.seeking,
          readyState: video.readyState, networkState: video.networkState, errorCode: video.error?.code ?? null,
          duration: finite(video.duration),
          buffered: ranges(video.buffered), seekable: ranges(video.seekable),
          totalVideoFrames: finite(quality?.totalVideoFrames), droppedVideoFrames: finite(quality?.droppedVideoFrames),
        } : null,
        previewControl, currentStep: stepIndex < 0 ? null : stepIndex + 1,
        visibility: document.visibilityState,
        viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight, visualWidth: visualViewport?.width ?? null,
          visualHeight: visualViewport?.height ?? null, visualScale: visualViewport?.scale ?? null,
          screenWidth: screen.width, screenHeight: screen.height, devicePixelRatio },
      }
    }
    function snapshot() {
      try { return readSnapshot() }
      catch {
        observationErrorCount = Math.min(observationErrorCount + 1, 1_000_000)
        return { status: 'snapshot_unavailable', elapsedMs: Date.now() - startedAt,
          monotonicElapsedMs: performance.now() - startedMonotonic }
      }
    }
    function retain(queue: unknown[], value: unknown, limit: number) {
      queue.push(value)
      if (queue.length > limit) queue.shift()
    }
    const listener = (event: Event) => {
      if (event.target instanceof HTMLVideoElement) retain(events, { event: event.type, ...snapshot() }, 128)
    }
    for (const name of eventNames) document.addEventListener(name, listener, true)
    const timer = setInterval(() => retain(samples, snapshot(), 60), 250)
    ;(window as DiagnosticWindow).__cutmyNativeObservation = {
      capture: () => {
        const current = snapshot()
        return { startedAt, capturedAt: Date.now(), observationErrorCount, current, events, samples }
      },
      stop: () => {
        clearInterval(timer)
        for (const name of eventNames) document.removeEventListener(name, listener, true)
        delete (window as DiagnosticWindow).__cutmyNativeObservation
      },
    }
  })
  let failed = false
  try {
    await checks()
  } catch (error) {
    failed = true
    try {
      const observation = await page.evaluate(() => (window as DiagnosticWindow).__cutmyNativeObservation?.capture() ?? null)
      await testInfo.attach(`native-${runtime.context}-playback.json`, {
        body: JSON.stringify({ runtime, observation }, null, 2), contentType: 'application/json',
      })
      const screenshot = testInfo.outputPath(`native-${runtime.context}-playback.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`Native ${runtime.context} preview failure`, { path: screenshot, contentType: 'image/png' })
    } finally {
      // The original assertion remains the failure if diagnostics cannot be saved.
      throw error
    }
  } finally {
    try {
      try {
        for (const frame of page.frames()) await frame.evaluate(() => (window as DiagnosticWindow).__cutmyNativeObservation?.stop())
      }
      finally { await script.dispose() }
    } catch (error) {
      if (!failed) throw error
    }
  }
}
