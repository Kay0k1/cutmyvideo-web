# Editing flow

The website helps someone take a few moments out of a long video. The current website accepts a YouTube video link or an uploaded MP4 containing video, up to the production upload limit of 1 GiB. The reusable public engine supports broader media operations; those capabilities are not presented as website inputs.

## Plan → critique → build

The earlier all-at-once workbench exposed a source form, empty player, timeline, clip list, and export controls before a video existed. Although functional, it asked a new visitor to understand too many controls. Simply rounding the existing layout would leave that problem in place.

The chosen design uses three actual stages: **Video → Moments → Export**. The first screen offers one source choice and one action. A loaded source moves to the editing stage. Export has its own summary and settings. Numbered progress, a stage heading, and a stage-aware document title explain where the user is. Backward navigation preserves the source, selected intervals, playhead, and completed downloads. Replacing the video is explicit and only replaces the old draft after validation succeeds.

Critique of the proposed design ruled out decorative hero copy, media thumbnails without a source, waveform imitations, statistics, and a separate card for every field. The visual direction stays quiet: generous spacing around the first action, a single workspace for editing, and borders only where they explain real groups. The final implementation was inspected using actual uploaded media in both themes and at phone widths.

## Compact layout review

The staged workflow still stacked a large player, the whole timeline, time fields, and the clip list vertically. The resulting desktop page was approximately 1,768 pixels tall. The current layout uses the available width before adding height:

```text
Source title and duration
┌───────────────────────┬─────────────────────────┐
│ Player                │ Overview and trim range │
│ Clip list             │ Exact start / end       │
│ Selected clip name    │ Preview and fit range   │
└───────────────────────┴─────────────────────────┘
Keyboard help                              Continue
```

The plan preserves the existing soft palette, Geologica, themes, copy, and three stages. Its critique rejected a fixed-height page with hidden overflow: that could cut off validation, keyboard focus, or zoomed text. Instead, the page keeps natural height, the desktop player scales within sensible limits, and only potentially long clip/result lists have bounded overflow. Selecting or adding a clip adjusts that list's scroll position; resizing keeps the selected row visible without scrolling the whole document.

The header, progress, headings, and unnecessary gaps are smaller on desktop. Primary editing controls fit the tested standard desktop viewports, including 1280×720 and 1366×768. Export puts the selected moments and ready downloads beside its settings. Short files or clips are actual data; no display-only filler is introduced to occupy spare space.

Phones keep the logical player → boundaries → moments flow with natural vertical scrolling. On short landscape phone screens, the preview canvas stays between 180 and 240 pixels high with the video contained at its original proportions; portrait preview sizing is unchanged. Both initial source choices fit a 360×640 screen. All enabled touch controls, including language/theme actions and header/footer links, retain at least 44×44 CSS-pixel hit areas. Browser zoom and validation can increase page height; controls remain in normal flow.

See [QA.md](QA.md) for the viewport, browser-engine, locale, and theme matrix. Browser emulation checks logical screen sizes and touch interaction rather than claiming tests on particular physical phone or Mac hardware.

## Typography and themes

- Self-hosted **Geologica Variable**, including Cyrillic and Latin, uses one family with restrained weight differences. Timecodes use tabular numerals. The pinned Fontsource package provides the font; its unmodified SIL Open Font License and copyright are distributed at `/licenses/geologica.txt`.
- Light: page `#f4f6f5`, surface `#ffffff`, ink `#203431`, secondary text `#5c7067`, action `#35645b`, selected range `#e3efe8`.
- Dark: page `#18201f`, surface `#222c29`, ink `#e7eeea`, secondary text `#a4b7ac`, action `#a8cbb9`, selected range `#344d40`.
- Amber trim handles distinguish editable boundaries from the green playback/selection controls. Handles and primary touch actions provide at least 44 CSS pixels of target area.
- The header switches directly between light and dark. System appearance is a named option in Settings and responds to system changes. The preference survives reloads.
- An early external same-origin script sets appearance before first paint, compatible with the production CSP that prohibits inline scripts. Native inputs, selects, dialogs, focus outlines, and media surrounds follow the same theme tokens.
- Reduced motion removes transitions and the spinner animation. Focus remains visible in both themes. Muted text on the page was darkened after contrast review.

## Interaction and accessibility

Range handles have stable tab order, dynamic opposite-boundary limits, arrow/Home/End/Page key support, and accessible time values. Exact text fields provide a touch and assistive-technology alternative. The overview plus a zoomed timeline lets someone find a 15-second selection inside a multi-hour video. Invalid fields keep their entered text, show a localized explanation, and receive focus when advancing to export.

The player stays mounted when its stage is hidden, leaves the accessibility and tab order through the native `hidden` attribute, and pauses when leaving Moments. Returning preserves playback position; reload restores the saved position after the player becomes ready. If a source cannot be previewed, timecode editing and export remain available.

YouTube sharing, Shorts, live, and embed URLs normalize to a genuine YouTube video identity. Ambiguous paths, duplicate video IDs, lookalike hosts, credentials, and custom ports are rejected. MP4 validation checks extension, MIME, a structurally valid container header, and server-probed video dimensions. Changing a filename cannot turn another container or an audio-only file into a supported video. Rejected replacements preserve the old source and intervals.

The copy mode is named **Original quality** in the interface. The explanation states that it avoids re-encoding, may shift start/end boundaries, and needs compatible codecs. Exact boundaries re-encode the video. The UI never promises a higher quality than the source.

Job feedback uses actual server stages rather than invented percentages. Successful files remain downloadable when another interval fails. Cancellation and reload retain the current job. Downloads use same-origin session authorization and do not load whole files into browser memory.

## Navigation and language

Examples/help, defaults, and support use native dialogs with an explicit focus loop, Escape dismissal, and focus returned to the trigger. Dialogs preserve the editing stage and draft. Mobile navigation uses two compact rows and long wallet addresses wrap within a scrollable dialog.

Russian is primary. One catalog covers the full English workflow, source validation, statuses, accessible names, keyboard hints, examples, settings, and support. Switching language does not recreate the player, source, or job. User titles and filenames remain unchanged. Preferences, language, and theme are browser-local; credentials are not placed in local storage.

Support displays exactly the supplied TRON, Solana, Ethereum, and Bitcoin addresses and copies them locally. Network names are explicit; no transfer or external payment request is initiated.

## Primary references

- [W3C multi-page forms](https://www.w3.org/WAI/tutorials/forms/multi-page/): logical stages, progress, meaningful titles, and preserving data when returning.
- [W3C multi-thumb slider pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider-multithumb/): stable tab sequence and dynamic bounds.
- [W3C slider pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/): keyboard movement and meaningful values.
- [W3C target size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html): 44-pixel touch targets.
- [W3C switch pattern](https://www.w3.org/WAI/ARIA/apg/patterns/switch/): a binary theme action must have a clear meaning. The header uses an action button with the next appearance in its accessible name; System is a separate preference.
- [GOV.UK error summary](https://design-system.service.gov.uk/components/error-summary/): visible field errors and recovery actions.
- [YouTube iframe API](https://developers.google.com/youtube/iframe_api_reference): current time, seek, and playback control for embedded sources.

Browser QA uses the real engine and covers uploads, precise multiple exports, long sources, stage navigation, playback preservation, rejected replacements, keyboard controls, reload, cancellation, themes, complete localization, clipboard addresses, and narrow screens. See [QA.md](QA.md) for executed checks and results.
