# Editing flow

cutmyvideo helps someone take a few moments out of a long video. Inputs are public video links and uploaded MP4 files containing video, up to the production limit of 1 GiB. The interface recognizes fifteen video services and accepts public HTTPS links for the core's generic extraction. It identifies the provider before submission and displays the real title, duration and available preview after import.

## Plan, critique and structure

The main path is **Video → Moment → Export**, with an optional **Clips** screen for several moments. The first screen offers a link or an MP4 file, with the provider catalog behind an explicit disclosure. Moment holds the real player, trim rail and preview. Its primary Continue to download action includes the current moment; Clip list validates the edit and opens the existing collection without changing export selection. Time values can be tapped to edit; precision fields and zoom remain available in their disclosure, and sources without a controllable preview expose manual timing directly. Clips manages labels and checked export selection. Export begins with video/audio choice and the cut action; quality and precision use a native details disclosure. Completed files lead the Export screen.

The visual critique rejected shrinking text to force every control above the fold. Readable type, clear groups and ordinary scrolling take priority. A single editing surface and separators explain real groups; decorative card shadows and obsolete competing CSS rules were removed. Amber boundary handles clearly differ from green playback controls. The same quiet identity works on a phone and a large monitor without fabricated waveforms or unavailable players.

```text
Video        Moment                       Export
Link / MP4 → Player + trim rail          → Video / audio + Cut
             Preview + editable time      Quality / precision disclosure
             Optional Clip list           Job status + Download
```

Colors, type and radii are listed in the token table of the timeline editor section. Self-hosted Geologica Variable covers Cyrillic and Latin; restrained weights explain hierarchy, and timecodes use tabular numerals. Core text uses relative font units, with 16px text inputs to preserve comfortable phone editing. No decorative hero or unrelated illustration is introduced.

## Timeline editor — 10 November 2026

The editor is one centered column up to 1120 px wide, without a sidebar. From top
to bottom: the player, a thin overview of the whole video, the timeline ribbon, the
label row, the action row and the clip strip with secondary tools.

```text
header: mark · title 0:52 ………… ↶ ↷ [Change video]   RU EN ◐ ≡
┌────────────────────────── player ──────────────────────────┐
└────────────────────────────────────────────────────────────┘
(overview of the whole video: when the ribbon shows part of it, or Exact time is open)
┌──────────── ribbon: frames · waveform · selection · grips ────────────┐
└───────────────────────────────────────────────────────────────────────┘
0:00            [30 s]                            0:52     − + Entire section
[▶ Clip] [Start 0:00 | I] [End 0:30 | O] 30 s       [MP4|MP3] [⚙] [Cut a clip · 30 s]
                                   one file MP4 · Up to 1080p · Source deleted after export
[☑ Clip 1 0:00 — 0:30 ···] With selected ▾ + Another clip   Exact time ▸ Frame Tools
```

### Window and column

On a desktop (900 px and wider with a fine pointer) the editor fills the window
without page scrolling from 1920×1080 down to 900×500. The header is one 56 px
row: the mark, the video title with its duration, Undo, Redo and Change video,
then RU / EN, the theme toggle and Menu (Examples, Settings, Collections,
Support, the open core on GitHub). The player takes the remaining height but
keeps at least min(240 px, 42 % of the window); on short windows the frames
shrink to 44 px and the waveform band gives way below about 620 px of height.
The column, the player and the ribbon keep one size while the cutting form, a
running job, one ready file or the form after Cut another is shown. A list of
several files, partial failures and long warnings take extra height in the row
and scroll inside it (the list up to 40 % of the window height). Enlarged text
switches the desktop canvas to ordinary page flow.

### Timeline ribbon

The ribbon (`.trim-track`) spans the column: frames (84 px) above the waveform
band (24 px) on the soft background, radius 14. Each frame covers its own five
seconds; a wider cell repeats it, a narrower cell shows its middle, and cells
under 20 px are left empty. Frames come from 30-second storyboard windows and
the waveform from the same windows of audio. Only windows crossing the visible
part are prepared, nearest to the playhead first and at most four, with one
background request at a time for frames and waveform together. Requests wait
700 ms (frames) and 1 s (waveform) after the view settles, are cancelled when
the view moves away, retry server-busy answers and are not made with Save-Data
or 2G, in a hidden tab, or while a dialog covers the editor. Until a window is
ready its cells are even placeholders of the same geometry, so nothing moves
when frames arrive. Without audio the band is a flat line, and the existing
waveform status stays available to assistive technology.

The selection is framed in yellow; outside it frames and waveform are dimmed.
The 16 px yellow grips stand outside the selection and have 44 px hit areas;
when the boundaries are close, both hit areas move fully outside so they never
overlap. The grip shows its time while hovered, focused or dragged. Other clips
appear as a thin outline; double-clicking one makes it the edited clip. The
playhead is a 2 px line across the ribbon. Clicking or dragging the ribbon
seeks, the wheel and pinch zoom around the pointer, and a sideways gesture
pans. While a job runs, a thin yellow bar under the selection shows the real
encoding percentage, or moves without a value when the server reports none.

The label row under the ribbon shows the start and end of the visible part at
its edges and the selection length under the middle of the selection, kept
between the two edge times. Zoom out, Zoom in and Entire section (Zoom
to boundaries when the grips are close) sit at its right end. On phones narrower
than the full row, zoom takes its own row.

### Action row and cutting

The left side holds the moment: Clip (preview the selection; Stop while
playing), the Start and End pills and the selection length. A pill shows the
time, which turns into a text field when pressed, and a marker button that sets
the boundary at the player position; its key, I or O, is printed on it. Exact
time shows both fields at once with millisecond precision.

The right side is the cutting form, always visible: MP4 | MP3, the export
settings button (opens the Export settings dialog) and the main button. Its
visible label is the action and the length that will be cut ("Cut a clip · 30 s";
several clips add their count). The accessible name stays the action; count and
length are its description. One quiet line under the button states the result:
one file or separate files, format, quality, sound and crop, and that the source
is deleted after export. Reasons why cutting is unavailable (no clip selected,
limits, track, crop or enhancement conflicts, a pending request to recover)
appear under the inactive button with their corrective actions.

A job replaces the form in the same place. While it runs: the real stage in
words, its description, the encoding progress where the server reports one,
Cancel processing and the option to open another video meanwhile. One ready
file is one row: Cut another and Download, with the name, size, actual
boundaries, retention date and Result boundaries and tracks on the quiet line
below.
Several files form a list with Download all ZIP and Cut another. Partial
results, per-clip failures and their retry live in this area too. Cut another
returns the form; Ready files N among the secondary tools switches back to the
files (`aria-pressed`), and is unavailable while a job runs. Focus moves to the
results heading when files become ready.

### Clip strip and secondary tools

Each clip is a chip: a checkbox (included in export), its editable name, its
times (a button that makes it the edited clip) and the ··· menu with move up,
move down and delete. Another clip ends the strip. With two clips or more the
strip adds Select all with the selected count and With selected ▾ (Duplicate
selected, Delete selected), which opens as a small panel and closes on Escape,
outside clicks and after an action. On a desktop the strip wraps up to two rows
(one row on windows up to 760 px tall), scrolls inside and keeps the edited chip
in view. The secondary tools follow on the right: Exact time, Frame (crop),
Tools (analysis and helper dialog), Preview selection for two clips or more and
Ready files N after a job.

### Phones and touch screens

Below 900 px or with touch input the page scrolls naturally. Under the header a
row holds the title, duration, Undo, Redo and Change video. Then come the
player, the ribbon with its label row, three buttons in a row (preview, Start
with `[`, End with `]`), the chips — each spanning the row with its times on one
line — the strip actions, the secondary tools and the job area. The cutting form
(format, settings, "Cut · 30 s") is pinned to the bottom of the window with the
safe-area inset. It is the last item of the editor, so scrolling to the end
leaves every control above it. Touch targets are at least 44×44 px. On 390×844
the player, the ribbon and the main button are visible on the first screen.

### Keyboard

Every control is reachable with Tab in visual order. The ribbon exposes three
sliders: Player position and the Start and End grips. Arrows move by 0.1 s,
Shift with an arrow by 1 s, Page Up and Page Down by 5 s, Home and End go to the
limits. Outside text fields,
I and O set the start and end at the player position, N saves the clip and adds
the next one, [ and ] move to the previous and next clip, and Space plays or
pauses. The header menu opens with Enter, Space or the arrows, moves with the
arrows, Home and End, and closes with Escape, returning focus to its button.
Dialogs keep focus inside and return it to their trigger. Focus is a 3 px ring in
the focus color with a 2 px offset. Reduced motion stops the optional
animations, including the ribbon progress bar.

### Tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--page` | `#F4F5F3` | `#131415` | page |
| `--surface` | `#FFFFFF` | `#1C1E20` | menus, dialogs, fields, pills |
| `--soft` | `#E9EBE7` | `#232628` | ribbon background, calm fills |
| `--ink` | `#17191B` | `#F1F2F0` | text, main action background |
| `--muted` | `#62686D` | `#A0A6AB` | secondary text |
| `--line` | `#E0E2DE` | `#2C2F32` | dividers |
| `--strong-line` | `#868C91` | `#6F767C` | field and button borders (3:1) |
| `--trim` | `#FFC400` | `#FFD23F` | selection frame and grips only |
| `--trim-line` | `#B88A00` | `#FFD23F` | grip outline, other clips |
| `--focus` | `#2B6BE4` | `#7FB0FF` | focus ring |
| `--error` | `#B3261E` | `#FF9E91` | errors |

Color appears only on the ribbon selection, the focus ring and errors; links
and text buttons use the text color with an underline on hover. The typeface is
self-hosted Geologica: interface text 15/22 at weight 380, buttons 500,
timecodes 500 with tabular numerals. The player and ribbon have a 14 px radius,
fields and panels 12 px, buttons are 44 px pills. Only menus and dialogs cast a
shadow. Text keeps 4.5:1 and controls 3:1 contrast in both themes.

## Optional helpers in 0.7.0

The primary editor retains its existing open, trim and export controls. Three
collapsed rows inside Tools hold pauses, visual transitions and cut-list
exchange. Export settings has one collapsed More: sound and size row with
three subordinate sections. Active export enhancements remain listed outside
these disclosures, with a clear note that the player remains the original.

The current light palette uses page #f2f4f7, surface #ffffff, ink #202832,
muted #5d6977 and action #08736c. Existing dark tokens and self-hosted Geologica
remain authoritative; no extra palette, font, panel or motion system is added.
Quiet divider rows express the helper hierarchy. Native disclosures, 44px
controls, wrapping layouts and ordinary dialog scrolling work on phones.

Analysis describes the exact selected source window. It proposes editable cuts;
append preserves current selection and replace requires confirmation. Both are
one undoable edit. Seeking closes the dialog so the user can inspect the video.
Closing restores keyboard focus to the opener. Errors and compatibility actions
appear beside the affected tool, including when the dialog has been scrolled.

Output-only adjustments never silently rewrite the format. A single nearby
compatibility action explains and applies the required settings. Audio source
references survive only in their project, and pending work cannot cross a
source or project change. Closing cancels analysis/uploads; completed owned
uploads remain discoverable in server files. Missing audio offers reconnection
without deleting the primary recording or its edits. Known export requests can
be recovered with their original identity even if a secondary file later expires.
Source-clock CSV/chapters and output-clock chapters use distinct labels.

## Selection and state

A checkbox means that a clip is included in export. Editing a clip and opening Clip list do not change export selection. Continue to download explicitly includes the moment being edited while preserving other checked clips. Select all reflects the actual checked subset; duplicate and delete act on that subset. Added and duplicated clips receive new IDs and respect the server's twelve-range limit. An empty list offers Add clip and prevents export with a clear reason.

Backward navigation retains the source, ranges, checked IDs, playhead and completed downloads. The draft records its schema version so the previous three-stage Export screen restores as the fourth stage rather than becoming Clips. Saved IDs are intersected with valid ranges; an old draft without explicit selection includes all its ranges. A replacement source is committed only after it opens successfully, preserving the old draft on rejected files or links.

Files from the previous job are labelled as the last export, so changing checkboxes cannot make those files appear to correspond to a new selection. Submission sends only checked clips in their displayed order. Cancellation, refresh and partial failure retain the available downloads. Feedback uses actual server stages without fabricated percentages.

## Controls and accessibility

Menus use Radix Select for managed keyboard focus, arrow/Home/End navigation, typeahead, Escape and dismissal. Styling belongs to cutmyvideo: the same surface, selection, border and focus tokens appear in both themes. Menu content is constrained to the available viewport and rendered inside a native dialog when opened from Settings, so it remains in the dialog's top layer and focus scope.

The main trim track is a separate keyboard slider, so both boundary handles remain independently accessible. Tapping or dragging seeks within the actual zoom window; vertical touch gestures scroll the page without seeking. Trim handles keep a stable tab sequence, enforce opposite-boundary limits and expose meaningful time values. Pointer capture supports dragging beyond a handle's starting area. Exact text fields provide a touch and assistive-technology alternative, accept millisecond precision, and preserve invalid input while explaining the correction. The overview and zoomed timeline remain useful for finding short moments inside long recordings.

The player stays mounted while its stage is hidden, leaves the accessibility and tab order through the native hidden attribute, and pauses when leaving Moment. Returning preserves position. Reload restores the saved position after player readiness. YouTube has a controllable embed; compatible files use native media controls. Other sources show their genuine metadata, owner-protected thumbnail where available, an original-page link and manual timing when there is no controllable preview.

Primary phone controls retain at least 44×44 CSS-pixel hit areas. Desktop layouts use width before adding height; long clip and result lists scroll within bounded areas. Phone editing keeps natural vertical flow and short landscape previews remain capped. The page never hides global overflow to conceal a layout defect. Validation, large text and browser zoom can add height without clipping controls. Reduced motion removes nonessential transitions; keyboard focus remains visible.

## Source boundaries

YouTube share, Shorts and recorded-stream links normalize to a genuine video identity. Other recognized platforms keep the identifiers and query data needed to resolve their video. Generic HTTPS URLs preserve signed query strings. Frontend recognition is a display hint, while the core remains responsible for actual media inspection, redirect and network validation, storage limits and safe errors. A recognized domain never guarantees access to every video.

Twitch inputs are stream recordings and clips. Ongoing live streams, channels, playlists, login-only videos and DRM are outside this workflow. Website changes, geographic restrictions and anti-bot checks can prevent access; errors explain the next action rather than exposing private extractor output. MP4 validation checks extension, MIME, container structure and server-probed video streams. Renaming a file does not change its format.

Original quality avoids re-encoding but may shift boundaries and requires compatible codecs. Exact boundaries re-encode media. Actual exported boundaries are shown beside each file; the interface never promises quality above the source.

## Navigation and language

Progress, headings and document titles identify all four stages. Browser Back and Forward move between stages and dialogs while preserving the editing draft. The first visit keeps the ordinary browser exit; opening a dialog adds an entry and closing it returns to its editor entry. A directly opened or refreshed dialog closes in place. Invalid timing stays visible for correction, and expired sources or empty collections cannot restore an unavailable stage. History stores bounded stage and panel metadata without media IDs or owner state; language changes preserve it.

Examples, defaults and support preserve the editing draft. Native dialogs provide Escape dismissal, a focus loop and focus returned to the trigger. Their sticky header keeps Close reachable on short screens. Settings hold appearance and other defaults in one draft; Save applies everything, closing cancels unsaved changes, and Reset includes system appearance. Long wallet addresses wrap within the support dialog. The four supplied network addresses remain unchanged; copy is local and no transfer is initiated.

Russian is primary. English covers visible copy, errors, accessible names, provider labels and help. Changing language or theme does not recreate the source or job. User titles and filenames stay unchanged. Preferences, language and appearance are browser-local; server credentials are not stored there. Appearance initializes before first paint using a same-origin script compatible with the production CSP.

## Primary references

- [W3C multi-page forms](https://www.w3.org/WAI/tutorials/forms/multi-page/): meaningful stages, progress and preservation on return.
- [W3C multi-thumb slider](https://www.w3.org/WAI/ARIA/apg/patterns/slider-multithumb/): stable tab order and dynamic bounds.
- [W3C slider](https://www.w3.org/WAI/ARIA/apg/patterns/slider/): keyboard movement and accessible values.
- [W3C checkbox](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/): independent selection and a mixed select-all state.
- [Radix Select](https://www.radix-ui.com/primitives/docs/components/select): focus, keyboard navigation, typeahead and viewport constraints.
- [W3C target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html): comfortable 44-pixel targets.
- [GOV.UK error summary](https://design-system.service.gov.uk/components/error-summary/): visible errors with corrective actions.
- [YouTube iframe API](https://developers.google.com/youtube/iframe_api_reference): actual seek and playback control.
- [yt-dlp supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md): extractor availability is distinct from verified runtime access.

Executed browser checks and physical-device limitations are recorded in [QA.md](QA.md). Emulation checks browser behavior, viewport sizes and touch input; it does not claim access to physical Mac or phone hardware.

## Audit refinements — 5 October 2026

Deleting one or several clips now offers a visible, keyboard-accessible Restore
clips action. It restores the exact previous order, names, selected clips and
active interval. The bounded snapshot holds at most twelve ranges and lasts
until the next collection content edit or departure from Clips; it never replaces a
new source or overwrites later label changes. Checkbox changes preserve Undo;
restoration keeps the current selection of surviving clips. Feedback is available in
both languages and announced as a status message. After restoration keyboard
focus returns to Select all, whose mixed state reflects the restored selection.

When a bulk duplicate would exceed twelve clips, the interface explains how to
proceed by selecting fewer clips. Source type controls stay fixed while import
or export is active, keeping the displayed operation consistent with the actual
request. File selection associates its format hint and any error with the
visible chooser button.

These changes apply [Nielsen's user control, error prevention and system-status
heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) and
[W3C form feedback guidance](https://www.w3.org/WAI/tutorials/forms/notifications/).
The checks cover browser semantics and keyboard behavior, not certification of
all assistive technologies.

## Resource lifecycle and recovery — 5 October 2026

Uploads use native XMLHttpRequest with the original File inside FormData. The
browser reads only the existing 4 KiB container-validation slice in JavaScript;
it does not create a complete ArrayBuffer or Blob copy for transfer. The progress
bar reports transmitted bytes. Reaching its end changes the copy to server
inspection; it does not claim that processing is complete. Percentage updates are
coalesced, avoiding a React update for every network callback. Cancel aborts the
request and invalidates late progress/results from that attempt.

The Video step exposes a bounded list of the current session's twenty retained
sources. The list can reopen an earlier video after a fresh owner-protected metadata read; resuming the current video preserves its intervals and playhead. Replacing a source does not make old uploads and results impossible to
remove. A user can free older sources while another job is waiting for storage.
Deletion always requires a native confirmation that explicitly includes the
source, all its jobs and output files. Active work cannot be deleted; the core
returns a conflict with a corrective explanation. Empty successful HTTP 204
responses are accepted, and retrying a lost deletion response handles 404 safely.

Source cleanup targets and result download deadlines come from server timestamps,
formatted in the browser's timezone. A retained source explains that referencing
jobs and results postpone deletion. Nullable deadlines are not replaced by an
invented expiry. The storage-wait stage remains an active, cancellable job and
shows its server-provided deadline. Upload progress is separate from encoding
progress and storage waiting.

Hidden tabs abort status reads and stop timers; returning starts a fresh read
immediately. Generation checks reject an old response even when a transport
ignores cancellation. Cancelling a job disposes polling before issuing the
mutation, so a late running status cannot overwrite cancellation. Transient
failures back off, and stalled JSON/status requests abort after thirty seconds.
Source preparation keeps its longer two-and-a-half-minute HTTP deadline. Native
and embedded players pause when the page becomes hidden; YouTube position timers
also stop until the editor is visible again. Returning never silently starts
playback.

Persisted JSON is bounded before parsing (256 KiB for the workbench, 4 KiB for
preferences). Source/job IDs and retry header keys accept only bounded safe
identifiers; clip bounds, unique IDs and UTF-8 label sizes are checked before
restoration. A temporary network failure while restoring does not overwrite the
saved workbench with an empty draft. Completed results can remain restorable even
when their source has expired. Same-fingerprint retries retain the export's
idempotency key; successfully opening another source clears that pending attempt.

Public session limits now drive upload byte checks, clip counts, individual range
duration and total selected duration. Older or malformed responses retain safe
defaults; valid client state is bounded to 128 ranges. Lowered limits do not
discard already saved ranges or downloads: the editor explains which new export
violates the current policy. New default ranges fit both duration budgets. Every
included range is checked, including a restored range that is not being edited.
Pending retry fingerprints are bounded to 128 KiB so the allowed larger range
collection retains idempotency across reload. Control characters in saved labels
are rejected. Cleanup dates that have already passed explicitly say that deletion
may happen at any time, without promising future availability.

## Batch audio and original-quality exports — 12 October 2026

Moment and Export share the same audio selection. Track options show absolute stream index, language, title, codec, channel count and sample rate. The default follows the core: lowest default-marked audio stream, otherwise lowest audio index. Sources with several audio tracks use bounded server previews even with the default choice, because native browser defaults differ. Explicit track selection and no-sound preview always use those same server preview parameters. Switching selection clears its preview cache while retaining the source position. Source-specific audio choices survive a draft reload but are excluded from saved global defaults and reset for another source.

Separate files remains the export default. Joining uses selected-list order, which is stated beside the control and preserved in the request. It produces one downloadable file whose expanded details show source boundaries and output positions for every segment. Audio defaults and subtitle omission remain compatible with older requests. Known-field request serialization preserves the retry identity across restored property order and equivalent defaults.

The primary export view exposes audio and output grouping; quality and original preservation remain in the existing disclosure. MKV appears in video copy mode for every supported source, including platform links. Local copy keeps its original-quality normalization; platform copy retains the explicitly selected quality ceiling. Compatible text-subtitle preservation remains local-specific and appears when inspected subtitles are present; unsupported ASS, SSA and bitmap tracks leave preservation disabled and explain the limitation. Selecting an exact MP4 or audio export explicitly omits subtitles. Restored incompatible settings receive a corrective message and block export until corrected. MP3 is disabled when no sound is selected. Source-track and result-track summaries distinguish included and omitted tracks; data and attachment streams are omitted.

The added controls use existing selectors, visible labels and descriptions, focus behavior, touch sizing and Russian/English translations. The four-step workflow and visual design are retained.
