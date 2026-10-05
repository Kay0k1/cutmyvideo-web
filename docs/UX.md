# Editing flow

cutmyvideo helps someone take a few moments out of a long video. Inputs are public video links and uploaded MP4 files containing video, up to the production limit of 1 GiB. The interface recognizes fifteen video services and accepts public HTTPS links for the core's generic extraction. It identifies the provider before submission and displays the real title, duration and available preview after import.

## Plan, critique and structure

The compact three-stage workbench still mixed watching a video, editing exact boundaries, managing a list and naming clips. This update gives each screen one primary task: **Video → Moment → Clips → Export**. The first screen offers a link or an MP4 file, with the provider catalog behind an explicit disclosure. The Moment screen holds the player, the trim rail and preview. Precision fields, keyboard hints and zoom are disclosed only when requested; sources without a controllable preview expose manual timing directly. The Clips screen manages labels and export selection. Export holds format, quality, cut mode and actual files.

The critique rejected moving every old control to a new full-height card. Adding one step is useful only if the Moment screen actually removes the list, clip-name field and export settings. It also rejected decorative controls that mimic a waveform or unavailable player. The defining visual remains the trim rail: amber boundary handles clearly differ from green playback controls, while surrounding controls stay quiet and use the existing soft theme.

```text
Video        Moment               Clips                 Export
Link / MP4 → Player + trim rail  → Checked clip list    → Format + quality
             Preview              Edit / add / rename   Actual job status
             Precision disclosure Bulk actions          Download each file
```

The tokens remain intentional and consistent: light page #f4f6f5, white surface #ffffff, ink #203431, muted text #5c7067, action #35645b and amber trim #eac389. Dark appearance uses page #18201f, surface #222c29, ink #e7eeea, muted text #a4b7ac and action #a8cbb9. Self-hosted Geologica Variable covers Cyrillic and Latin; restrained weights explain hierarchy, and timecodes use tabular numerals. No new typeface, decorative hero or unrelated illustration is introduced.

## Selection and state

A checkbox means that a clip is included in export. Editing a clip is a separate action and does not silently change which clips will be exported. Select all reflects the actual checked subset; duplicate and delete act on that subset. Added and duplicated clips receive new IDs and respect the server's twelve-range limit. An empty list offers Add clip and prevents export with a clear reason.

Backward navigation retains the source, ranges, checked IDs, playhead and completed downloads. The draft records its schema version so the previous three-stage Export screen restores as the fourth stage rather than becoming Clips. Saved IDs are intersected with valid ranges; an old draft without explicit selection includes all its ranges. A replacement source is committed only after it opens successfully, preserving the old draft on rejected files or links.

Files from the previous job are labelled as the last export, so changing checkboxes cannot make those files appear to correspond to a new selection. Submission sends only checked clips in their displayed order. Cancellation, refresh and partial failure retain the available downloads. Feedback uses actual server stages without fabricated percentages.

## Controls and accessibility

Menus use Radix Select for managed keyboard focus, arrow/Home/End navigation, typeahead, Escape and dismissal. Styling belongs to cutmyvideo: the same surface, selection, border and focus tokens appear in both themes. Menu content is constrained to the available viewport and rendered inside a native dialog when opened from Settings, so it remains in the dialog's top layer and focus scope.

Trim handles keep a stable tab sequence, enforce opposite-boundary limits and expose meaningful time values. Pointer capture supports dragging beyond a handle's starting area. Exact text fields provide a touch and assistive-technology alternative, accept millisecond precision, and preserve invalid input while explaining the correction. The overview and zoomed timeline remain useful for finding short moments inside long recordings.

The player stays mounted while its stage is hidden, leaves the accessibility and tab order through the native hidden attribute, and pauses when leaving Moment. Returning preserves position. Reload restores the saved position after player readiness. YouTube has a controllable embed; compatible files use native media controls. Other sources show their genuine metadata, owner-protected thumbnail where available, an original-page link and manual timing when there is no controllable preview.

Primary phone controls retain at least 44×44 CSS-pixel hit areas. Desktop layouts use width before adding height; long clip and result lists scroll within bounded areas. Phone editing keeps natural vertical flow and short landscape previews remain capped. The page never hides global overflow to conceal a layout defect. Validation, large text and browser zoom can add height without clipping controls. Reduced motion removes nonessential transitions; keyboard focus remains visible.

## Source boundaries

YouTube share, Shorts and recorded-stream links normalize to a genuine video identity. Other recognized platforms keep the identifiers and query data needed to resolve their video. Generic HTTPS URLs preserve signed query strings. Frontend recognition is a display hint, while the core remains responsible for actual media inspection, redirect and network validation, storage limits and safe errors. A recognized domain never guarantees access to every video.

Twitch inputs are stream recordings and clips. Ongoing live streams, channels, playlists, login-only videos and DRM are outside this workflow. Website changes, geographic restrictions and anti-bot checks can prevent access; errors explain the next action rather than exposing private extractor output. MP4 validation checks extension, MIME, container structure and server-probed video streams. Renaming a file does not change its format.

Original quality avoids re-encoding but may shift boundaries and requires compatible codecs. Exact boundaries re-encode media. Actual exported boundaries are shown beside each file; the interface never promises quality above the source.

## Navigation and language

Progress, headings and document titles identify all four stages. Examples, defaults and support preserve the editing draft. Native dialogs provide Escape dismissal, a focus loop and focus returned to the trigger. Long wallet addresses wrap within the support dialog. The four supplied network addresses remain unchanged; copy is local and no transfer is initiated.

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
until the next collection edit or departure from Clips; it never replaces a
new source or overwrites later label/selection changes. Feedback is available in
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
