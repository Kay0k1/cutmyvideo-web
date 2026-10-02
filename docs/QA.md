# MVP acceptance and UX review

The MVP is a working manual media tool. Reviews must exercise the real Go API
and real FFmpeg outputs; screenshots or mocked API responses alone are not proof.

## Acceptance checklist

- Open a public media URL or upload a local video; display the actual title and
  duration. Invalid, unsupported, oversized, or unavailable inputs produce a
  useful explanation and leave a way to try another source.
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
  old job's files to a new source.
- Source changes reset source-dependent ranges/player/job state. Saved drafts
  restore only after checking the source still belongs to the current session.
- At 360 px and 390 px, controls remain reachable with no horizontal document
  overflow; focus indicators are visible and reduced motion is respected.
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

Automated tests supplement visual and keyboard inspection. They do not establish
full assistive technology compatibility; touch screen-reader testing requires a
physical device.

## Running the integrated checks

Start the real core API on port 8080 with its PostgreSQL database and worker,
then start the frontend on port 5173. Install FFmpeg and ffprobe on the test host.

```sh
npm ci
npx playwright install chromium
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

The suite generates a real 12-second video with audio in a temporary directory.
`CUTMY_E2E_MEDIA` can point to an existing equivalent fixture. The report records
actual downloaded MP4/MP3 files, ffprobe output, and desktop/mobile screenshots.
Accurate MP4 tests also compare the first output frame against the requested
position of the original fixture, catching accidental cuts from time zero.

Cancellation is tested on a multi-item export so a tiny completed encode cannot
be mistaken for a successful cancellation. Session isolation uses independent
cookie jars; SSRF checks use HTTPS private addresses to reach the actual network
guard rather than only fail scheme validation.
