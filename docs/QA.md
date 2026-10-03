# MVP acceptance and UX review

The MVP is a working manual media tool. Reviews must exercise the real Go API
and real FFmpeg outputs; screenshots or mocked API responses alone are not proof.

## Acceptance checklist

- The website accepts a public video-page or HTTPS media-file link, or a local
  MP4 with a video stream. Known providers are identified honestly; recognition
  is distinct from a successful import or export. Watch, share and Shorts links
  resolve to the same real YouTube video. Channels, collections, live streams and
  sources requiring access must explain the restriction rather than create fake
  media. Non-MP4
  files, including a renamed WAV claiming `video/mp4`, fail the browser's container
  check before an upload. An audio-only MP4 does not replace an existing video.
  Invalid, oversized or unavailable inputs explain how to try another source.
- The first screen shows source choices. The four steps are Video, Moment, Clips
  and Export. The moment screen offers the player, handles and preview; precise
  fields and zoom live behind an accessible disclosure. Moving backward or
  forward preserves intervals and
  output choices; returning to the source step keeps the current draft until a
  new source is accepted. Accepted replacements start at the Moment step with
  fresh ranges. Reload preserves the current step and completed files.
- Play uploaded media, seek, and preview the selected interval. A platform embed
  and unavailable preview must be identified honestly; selection still works
  through exact time fields.
- Enter millisecond boundaries, add at least two intervals, edit and delete the
  intended interval, and keep the export order visible. Invalid text is preserved
  long enough to correct it rather than silently converted into a different time.
- Checked clips alone enter the export, in source-list order. Selection survives
  language changes and reload, including an explicitly empty selection. Bulk
  duplicate and delete affect the intended clips; copies are independent, and
  the twelve-clip limit prevents partial unannounced duplication. Deleting every
  clip leaves a usable empty state from which a new moment can be added. Legacy
  three-step drafts restore their old Export step as the new fourth step, and
  existing ranges default to selected when the legacy draft has no selection.
  Default export names retain their original list numbers when only clips 1
  and 3 are selected, including after language changes and job restoration.
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
- Laptop, desktop and tablet layouts keep the player, both handles, position
  markers, preview, precision disclosure and Save clip on the first viewport.
  The Clips step keeps its selection/actions, list and Continue accessible without
  needless document scrolling. Source opening
  and export/download controls also fit without unnecessary page scrolling. Twelve
  clips use a bounded desktop list; adding a moment reveals its edited row.
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
- Custom selectors expose combobox, listbox and option semantics. Arrow keys,
  Home/End, typeahead and Enter choose values; Escape and outside dismissal keep
  the current value and return focus appropriately. A popup opened in a native
  dialog remains inside that dialog and operable. Touch options remain on screen
  with adequate hit areas; native browser selection popups are not substituted
  for the site's selectors. I/O/Space inside menus and dialogs must not change
  media boundaries or start playback; editor shortcuts still work outside them.
- Saved export and zoom defaults survive reload and apply to the current and next
  source without changing selected intervals. MP3 always uses accurate mode.
- Each of the four owner-supplied donation addresses is shown once and copied
  exactly to the actual clipboard. Expected values come from the owner, not the
  app's constants; the tests never initiate a transaction.
- Separate browser sessions cannot read each other's sources, jobs, previews or
  downloads. User URLs cannot reach loopback, private networks, link-local cloud
  metadata, or unsafe destinations through redirects and media manifests.

## Design review principles

Keep each step focused on its actual task. Visual structure should explain the
source, current moment, clip selection and output; avoid decorative statistics, imaginary
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
- [W3C APG: combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
  — named popup triggers, expansion state, keyboard choice and dismissal.
- [W3C APG: listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/)
  — options and selection semantics; interactive clip cards instead use ordinary
  lists with separately named checkboxes and action buttons.
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
test seeks the actual native player to a distant position, marks 01:23:10–01:23:40,
verifies that moving the start beyond the old end preserves a usable interval,
checks useful collapsed and expanded timelines, and drags a handle through real
browser pointer input. The drag must follow the displayed sixty-second scale
with 100 ms rounding while the scale's tick labels stay fixed. The test then
probes the real exported 30-second MP4. Its duration is never mocked.
Deleting the edited clip also checks that the remaining distant interval is
visible on the collapsed scale when returning to Moment.

`CUTMY_E2E_YOUTUBE_ID` enables actual watch/share/Shorts metadata checks and a real
middle-of-video export. For example, `aqz-KE-bpKQ` is the public Big Buck Bunny
fixture used during development. This network-dependent check is opt-in and
uses actual provider metadata, never a fabricated duration.

`CUTMY_E2E_PLATFORM_SOURCE` and `CUTMY_E2E_PLATFORM_PROVIDER` enable a separate
website check against one real public provider. It verifies metadata and honest
preview availability, selects a three-second interval in the actual source's
middle, and exports/probes the real MP4. Run it separately for selected providers;
do not turn a recognised host, simulated response or blocked login into a claim
that its media was successfully extracted.
`CUTMY_E2E_PLATFORM_START_MS` selects a particular nonzero interval in a long
public recording when a stable middle section has already been identified.

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
orientation. Every size is measured on all four steps in both languages and
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

Direct public HTTPS sources are tested against the reusable core API and are
accepted as website inputs. The server's URL and network guards are authoritative;
the client does not restrict public sources to a decorative provider allowlist.

The expired-source regression substitutes only the source metadata response with
a 404. Its job and downloaded MP4 are created by the real backend. This exercises
the browser recovery path without inventing media, durations or successful jobs.

Session bootstrap checks hold a real response in flight while mount effects run,
assert one server request and one HttpOnly owner cookie, and verify that reload
keeps that cookie without issuing another one. A controlled rate-limit response
also checks that the visible reconnect action makes a fresh real request instead
of reusing a settled failure. Backend rate limits remain enabled.

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

## Recorded verification — 2026-10-03 session bootstrap

The unchanged surviving-download regression passed ten consecutive runs against
the fast local worker. An independent reproduction then confirmed that duplicate
concurrent bootstrap requests could block restoration even with a correctly saved
real completed job: the first session response succeeded, while a controlled 429
on the second left Export disabled and prevented the job restore request. This
reproduction did not substitute the export, job, cookie or downloaded media.

After sharing the pending bootstrap request, four focused checks passed in one
12-second invocation: one real request/cookie during mounting and reload, recovery
from a rate-limited attempt, saved earlier-step restoration, and the unchanged
expired-source case with a real completed MP4 download. Existing restoration
assertions and backend limits were preserved.

## Recorded verification — 2026-10-03 four-step workflow and public providers

The integrated functional evidence covers 38 successful scenarios: 37 passed
in the main 1.9-minute run, and the strict language/source/export case passed
in a focused 7.6-second run after the final source-validation and selector
localization fixes. Three network opt-ins were skipped in the main invocation;
selected public-provider checks ran separately below. These are combined
results rather than a claim of one completely green invocation.

The checks include exact multiple ranges, export of checked clips 1 and 3 with
their original default names after reload, independent bulk copies, the
twelve-clip limit, empty selection/collection recovery, real MP4 and MP3 outputs,
cancellation, session isolation, reconnect, completed and expired-source
restoration, and migration of a real legacy draft. Custom selectors passed
keyboard choice, typeahead, dismissal, touch and native-dialog focus checks.
Menu I/O/Space preserved boundaries and paused playback, while editor shortcuts
still changed the real player and selected interval outside menus. Both themes
passed computed text contrast on every step. Russian/English copy and exact
donation clipboard values were checked without substituting successful jobs.

The real 10,800-second fixture passed native position markers, a distant start
that moved its old end forward, a trusted handle drag matching the sixty-second
scale with 100 ms rounding and fixed tick labels, and a probed 30-second MP4 from
01:23:10–01:23:40. Deleting the edited clip restored the distant surviving
interval on the collapsed scale. Malformed URL authority and non-MP4 input were
rejected before source preparation, with the malformed field focused for repair.
Language changes refreshed selector options without changing the source, ranges
or real completed job; the strict body/accessible-label language checks passed.

The three responsive projects passed in Chromium, Firefox and Linux WebKit in
one 7.3-minute invocation. Each engine recorded 280 measured states: 224
four-step/language/theme/viewport combinations and 56 alternate MP4 chooser
states. All 840 measurements had zero horizontal document overflow, clipped
controls and touch targets below 44 CSS pixels. The report contains 177 original
screenshots. The bounded twelve-clip list revealed its edited row; primary
desktop controls fit in their first viewport, and phones retained natural
vertical flow. Desktop 1280×720 screens and phone dark-theme states were also
visually inspected.

Every engine decoded a real native preview, paused at the selected end, operated
keyboard and touch input, downloaded two actual 2.520-second H.264/AAC MP4s and
matched their first frames to the requested source positions. The results total
six separately probed browser exports plus touch downloads. This invocation
covers layout and actual media behavior; it does not establish physical Safari,
Mac, iPhone or Android hardware testing.

Two opt-in website checks also succeeded against actual public media:

- Rutube: the source duration was 80.320 seconds; 00:40–00:43 produced a
  3.000-second H.264/AAC MP4 of 275,635 bytes.
- Twitch: the recording duration was 32,268.186 seconds; 10,000–10,003 seconds
  produced a 3.003-second H.264/AAC MP4 of 1,457,601 bytes.

Both flows exposed honest unavailable-preview behavior, opened precise fields
automatically, linked to the original public video page, submitted the actual
middle interval and downloaded/probed a successful backend output. Thumbnail
owner-200 and stranger-404 assertions run only when the real source provides a
protected thumbnail; Twitch provided no thumbnail, so that endpoint was not
claimed as exercised for it. Provider recognition is not a claim that all
fifteen catalogued services imported or exported successfully in this run.

An initial unavailable local API run was stopped and retained separately as
infrastructure evidence. Subsequent QA corrections used stable DOM coordinates
for background elements hidden by an open Radix popup, while retaining role,
option, focus, keyboard and real media assertions. No retry, fabricated duration,
playback workaround or successful mocked export was introduced. Production
verification is a separate focused smoke test after release.

### Delayed source restoration follow-up

CI run 37139568333 passed 39 scenarios, including all three responsive projects,
and skipped four optional cases. Its one failure was the saved-defaults test:
the helper checked the input before source restoration completed, then clicked
the already expanded disclosure and hid the correctly restored 00:00:02.000
input. A real uploaded source reproduced the same failure when only its genuine
metadata response was delayed by 600 ms; no source metadata was substituted.

The helper now waits for the visible disclosure and reads `aria-expanded`
before opening it. The delayed-response regression retains the visible input,
exact boundary, saved MP3 format and timeline zoom assertions. Five focused
checks passed together in 27.4 seconds: language/source/export preservation,
delayed saved defaults, chosen-step restoration with a completed job, retained
downloads after source expiry, and legacy draft migration. Actual jobs and
download probes remained intact. This follow-up changed only QA files and did
not repeat the already passing 840-state matrix.
