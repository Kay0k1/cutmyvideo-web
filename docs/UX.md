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

The tokens remain intentional and consistent: light page #f4f6f5, white surface #ffffff, ink #203431, muted text #5c7067, action #35645b and amber trim #eac389. Dark appearance uses page #18201f, surface #222c29, ink #e7eeea, muted text #a4b7ac and action #a8cbb9. Self-hosted Geologica Variable covers Cyrillic and Latin; restrained weights explain hierarchy, and timecodes use tabular numerals. Core text uses relative font units; supporting copy generally starts at14px, with16px text inputs to preserve comfortable phone editing. No new typeface, decorative hero or unrelated illustration is introduced.

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
