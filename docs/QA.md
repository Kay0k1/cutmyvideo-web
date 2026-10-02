# MVP acceptance and UX review

The MVP is a working manual media tool. Reviews must exercise the real Go API
and real FFmpeg outputs; screenshots or mocked API responses alone are not proof.

## Acceptance checklist

- The website accepts a genuine YouTube video link or a local MP4 with a video
  stream. Watch, share and Shorts links resolve to the same real video. Non-MP4
  files, including a renamed WAV claiming `video/mp4`, fail the browser's container
  check before an upload. An audio-only MP4 does not replace an existing video.
  Invalid, oversized or unavailable inputs explain how to try another source.
- The first screen shows source choices. Moment controls and export settings
  appear on their own steps. Moving backward or forward preserves intervals and
  output choices; returning to the source step keeps the current draft until a
  new source is accepted. Accepted replacements start at the moments step with
  fresh ranges. Reload preserves the current step and completed files.
- Play uploaded media, seek, and preview the selected interval. A platform embed
  and unavailable preview must be identified honestly; selection still works
  through exact time fields.
- Enter millisecond boundaries, add at least two intervals, edit and delete the
  intended interval, and keep the export order visible. Invalid text is preserved
  long enough to correct it rather than silently converted into a different time.
- Both range handles are named, focusable, keyboard-operable, and bounded by the
  opposite handle. Focus order remains stable. Exact fields provide a fallback
  for touch and assistive technology users.
- MP4 and MP3 export create real files. Verify output duration and streams with
  ffprobe; MP3 has audio and no video. Accurate mode uses the selected boundaries;
  copy mode explains its limitations before export.
- Export shows the actual server state, handles failures and cancellation, and
  exposes only completed files. Reloading or changing source must not attach an
  old job's files to a new source. A completed job must not override a chosen
  earlier step on reload. A surviving artifact remains downloadable if source
  restoration fails; the page explains how to reopen a source for new exports.
- Source changes reset source-dependent ranges/player/job state. Saved drafts
  restore only after checking the source still belongs to the current session.
- At 360 px and 390 px, controls remain reachable with no horizontal document
  overflow on every step and in navigation dialogs. Touch preview, stage movement,
  export and a real download work; focus indicators remain visible.
- Laptop, desktop and tablet layouts keep the player, both handles, precise
  fields, preview, add-fragment and Continue on the first viewport. Source opening
  and export/download controls also fit without unnecessary page scrolling. Ten
  moments use a bounded desktop list; adding a moment reveals its selected row.
  Phones retain a natural vertical layout rather than shrinking controls to fit:
  touch targets are at least 44 by 44 CSS pixels, with no horizontal clipping.
- Light and dark choices persist. System mode follows changes to the browser's
  color preference. A stored theme is applied before the first rendering frame.
  Normal text reaches 4.5:1 contrast and large text 3:1 in both themes; computed
  solid-color checks supplement visual inspection of gradients and native UI.
- Russian is the default. Switching to English preserves the source, exact
  boundaries, playback and job. English visible copy and accessible labels are
  checked for untranslated Russian strings, excluding user content and the
  language selector. The chosen language survives reload.
- Examples, settings and support dialogs keep keyboard focus inside, close with
  Escape, and return focus to their trigger. Narrow-screen dialogs remain usable.
- Saved export and zoom defaults survive reload and apply to the current and next
  source without changing selected intervals. MP3 always uses accurate mode.
- Each of the four owner-supplied donation addresses is shown once and copied
  exactly to the actual clipboard. Expected values come from the owner, not the
  app's constants; the tests never initiate a transaction.
- Separate browser sessions cannot read each other's sources, jobs, previews or
  downloads. User URLs cannot reach loopback, private networks, link-local cloud
  metadata, or unsafe destinations through redirects and media manifests.

## Design review principles

Keep the editor and its actual task on the first screen. Visual structure should
explain the source, selection, and output; avoid decorative statistics, imaginary
waveforms, sample progress, or unsupported promises. Every visible action must
work or explain why it is unavailable. Use clear verbs and keep the same action
name through its result.

Errors identify what failed, explain the correction, and preserve useful work.
Associate field errors with their fields and announce asynchronous failures.
Avoid presenting transient incomplete time input as an immediate error while the
user is still typing; validate on commit or submission.

## Reference guidance

- [W3C APG: multi-thumb sliders](https://www.w3.org/WAI/ARIA/apg/patterns/slider-multithumb/)
  — independent names and semantics, dependent bounds, and stable tab order.
- [W3C APG: slider keyboard interaction](https://www.w3.org/WAI/ARIA/apg/patterns/slider/)
  — arrow keys, Home/End, and understandable time-valuetext.
- [W3C WAI: form notifications](https://www.w3.org/WAI/tutorials/forms/notifications/)
  — actionable errors, association with fields, and focus recovery.
- [W3C WCAG: minimum contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
  — legible text in each theme, including helper text and placeholders.
- [W3C WCAG: minimum target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
  — controls at least 24 CSS px or with the required surrounding space.

Automated tests supplement visual and keyboard inspection. They do not establish
full assistive technology compatibility; touch screen-reader testing requires a
physical device.

## Running the integrated checks

Start the real core API on port 8080 with its PostgreSQL database and worker,
then start the frontend on port 5173. Install FFmpeg and ffprobe on the test host.

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
```

`CUTMY_E2E_URL` overrides the frontend address. To include the network-dependent
direct-URL check, set `CUTMY_E2E_PUBLIC_SOURCE` to a public HTTPS MP4 fixture, for
example `https://media.w3.org/2010/05/sintel/trailer.mp4`. That check is explicitly
skipped when no URL is provided. It is separate from deterministic upload tests.

`CUTMY_E2E_LONG_MEDIA` enables an additional real three-hour upload test. Use an
actual 10,800-second media fixture with audio and whole-second video frames; the
test selects 01:23:10–01:23:40, verifies a useful zoomed selection, and probes the
real exported 30-second MP4. Its duration is never mocked.

`CUTMY_E2E_YOUTUBE_ID` enables actual watch/share/Shorts metadata checks and a real
middle-of-video export. For example, `aqz-KE-bpKQ` is the public Big Buck Bunny
fixture used during development. This network-dependent check is opt-in and
uses actual provider metadata, never a fabricated duration.

The suite generates a real 12-second video with audio, a short WAV, an audio-only
MP4 and a video-only MP4 in a temporary directory. The WAV fixtures exercise
client rejection, including renamed input. Exporting video-only MP4 as MP3
exercises an actual FFmpeg failure; both languages must explain that no clips
were created and offer a next step instead of referring to nonexistent files.
`CUTMY_E2E_MEDIA` can point to an existing equivalent fixture. The report records
actual downloaded MP4/MP3 files, ffprobe output, and desktop/mobile screenshots.
Accurate MP4 tests also compare the first output frame against the requested
position of the original fixture, catching accidental cuts from time zero.

The focused responsive checks run against all three browser engines:

```sh
npm run test:e2e -- --project=layout-chromium --project=layout-firefox --project=layout-webkit
```

Each engine opens a real MP4, verifies decoded native playback and keyboard
handles, exports two precise intervals, downloads both files through browser
links, and checks streams, duration and first frames. A separate touch context
shares that same real session, source and job, avoiding additional exports.
Native touch taps seek the media, preview a range and download a result. Chromium
also checks a trusted touch drag through its browser input protocol; Firefox and
WebKit use native taps and exact-field fallback, without pretending that synthetic
DOM pointer events prove physical dragging.

The viewport matrix covers 1440×900, 1366×768, 1280×800, 1280×720, 1920×1080,
2560×1440 and 1024×768; phones at 360×640, 390×844 and 430×932, plus each landscape
orientation. Every size is measured on all three steps in both languages and
themes. A 320×720 CSS-pixel viewport additionally checks narrow reflow. This is
not a browser-zoom test or a claim that setting device pixel density simulates
zoom. Reports include measured control rectangles, real files and screenshots.
Landscape phone previews are capped below 70% of viewport height while retaining
at least 140 CSS pixels for the native player; the editor continues vertically.

These are automated Linux Chromium, Firefox and WebKit checks. WebKit approximates
Safari's rendering engine; they do not establish testing on physical Macs,
iPhones, laptops or Android hardware. Real device, native browser chrome and
assistive technology checks remain separate.

`CUTMY_E2E_OUTPUT` can place both results and the HTML report in an external
directory, useful when running with a read-only source mount.

During Linux WebKit runtime diagnosis, playback from zero sometimes stalled in a
bare native video despite a fully buffered, valid H.264/AAC file. The same behavior
occurred through a simple Node HTTP server without React, Vite, the Go API, cookies
or application code, and with two independently encoded fixtures. Full responses
and byte ranges matched the original files. Fresh nonzero seeks played and decoded
frames normally. The integrated check exercises actual nonzero range previews,
checks frame decoding, progress and automatic pause, and waits for native seek
completion before further touch actions. It does not replace playback checks with
metadata assertions or imply that this Linux runtime proves physical Safari audio
compatibility.

Cancellation is tested on a multi-item export so a tiny completed encode cannot
be mistaken for a successful cancellation. Session isolation uses independent
cookie jars; SSRF checks use HTTPS private addresses to reach the actual network
guard rather than only fail scheme validation.

Direct public HTTPS sources are tested against the reusable core API. They are
not exposed as website inputs in this MVP.

The expired-source regression substitutes only the source metadata response with
a 404. Its job and downloaded MP4 are created by the real backend. This exercises
the browser recovery path without inventing media, durations or successful jobs.

For a deployed server with stricter request limits, run focused scenarios rather
than the full development suite in one burst. A useful first HTTPS check is:

```sh
CUTMY_E2E_URL=https://cutmy.video npm run test:e2e -- --project=desktop editor.spec.ts --grep 'real editor supports'
```

## Recorded verification — 2026-10-02 redesign

The final core passed ten API/media/security scenarios in 26 seconds, including
the opt-in public HTTPS and actual YouTube watch/share/Shorts extraction checks.
The redesigned browser flow passed its seventeen existing scenarios, including
the opt-in real three-hour fixture, light/dark contrast, system theme changes,
first-frame theme application, native preview, touch export/download, settings,
localization and exact donation clipboard values. Two added recovery regressions
also passed against real completed jobs. The corrected localization case and the
two recovery cases were verified together in a focused 15.8-second run after the
final restoration fix. These are combined results from independent runs, not a
claim that all twenty-nine cases ran in one invocation.

Screenshots and probes were inspected; no confirmed blocker remained in that
tested scope. The production redesign smoke is performed separately after deploy
and stays below the production mutation limit.

## Recorded verification — 2026-10-03 compact layout

The final responsive scenarios passed in Chromium 153, Firefox 155 and Linux
WebKit 26.6 in one 7.1-minute invocation. Each engine measured 224 layouts:
168 stage/language/theme/viewport combinations and 56 alternate MP4 chooser
states. Across all 672 measurements, horizontal document overflow, horizontally
clipped controls and undersized touch targets were zero. The report contains
141 original screenshots, including short laptops, portrait and landscape phones,
320-pixel reflow and the ten-moment list.

All engines decoded and previewed the actual selected interval, automatically
paused, operated keyboard handles, exported two real 2.520-second H.264/AAC MP4s,
downloaded them through browser links and matched their first frames to the
requested source positions. Touch contexts also sought, previewed and downloaded
the real source/job; Chromium additionally performed a trusted touch drag. The
final landscape cap and 44-pixel targets were covered by this invocation.

The existing functional/security/localization/theme suite separately passed
26 checks in 1.9 minutes. Its three network/long-source opt-ins were intentionally
skipped in this scope; their earlier verification remains recorded above. The
subsequent changes affected only the landscape height cap and narrow hit areas,
which the final cross-engine matrix covers. Production verification runs
separately after release with only one upload and one export per engine.

Chromium tall full-page captures were found to clear touch emulation in the test
runtime. The harness restores that browser override after captures; all 84 phone
stage measurements in its final JSON retained the intended coarse pointer. No
product playback workaround or assertion retry was introduced for the independent
Linux WebKit behavior described above.
