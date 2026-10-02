# Editing workbench

The primary task is selecting short moments in long media, then obtaining real files. The screen starts with an actionable source form; no sample media, invented waveform, decorative analytics, or marketing hero.

## Design decisions

- Paper `#ffffff`, workspace `#f3f5f7`, ink `#172434`, quiet text `#536477`, selection blue `#2157d8`, trim amber `#bd6600`.
- Self-hosted Onest for readable Russian labels. Tabular numerals for editable timecodes, without a separate decorative monospace typeface.
- Persistent source form, wide player and timeline, compact export column. On mobile the reading order follows source → player → selection → export → results.
- Borders mark actual groups. One blue selection rail carries the visual identity. Avoid unrelated card grids, gradients, decorative motion, and fake media imagery.

The initial sketch was reviewed against the brief: a dashboard with statistic cards would add no value to trimming. Those elements were removed in favor of the player, range controls, and files. Typography and clear controls do the work.

## Interaction and accessibility

Range handles have stable tab order, bounded keyboard movement, accessible time values, and exact text fields as the touch/assistive-technology fallback. An overview and zoomed timeline make short selections possible in a multi-hour source. Labels and input remain visible when validation fails. The selected range does not silently trigger downloads. Export requires a deliberate action.

Job feedback uses actual server stages rather than invented percentages. Partial successful results remain downloadable. Cancelling and reloading must not lose the current job. Download links use same-origin session authorization.

## Primary references

- [W3C multi-thumb slider pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider-multithumb/): stable tab sequence and dynamic bounds.
- [W3C slider pattern](https://www.w3.org/WAI/ARIA/apg/patterns/slider/): keyboard movement and meaningful values.
- [GOV.UK error summary](https://design-system.service.gov.uk/components/error-summary/): visible field errors and recovery actions.
- [YouTube iframe API](https://developers.google.com/youtube/iframe_api_reference): current time, seek, and playback control for embedded sources.

Browser QA covers real upload/export, invalid input, multiple intervals, keyboard controls, reload, cancellation, source replacement, and narrow screens. YouTube embedding is an optional preview; errors leave manual timecode editing available.

## Navigation and language

The editor remains the primary screen. Examples/help, defaults, and support use native modal dialogs that preserve editing state, trap focus, close with Escape, and return focus to their trigger. The header becomes two compact rows on mobile.

Russian is the primary language. The same centralized catalog localizes the complete English editor, validation, job stages, accessible names, examples, settings, and support. Switching language never recreates the source or job. User titles and filenames remain unchanged. Preferences and language are stored locally; no video or credential is stored in these preferences.

Support displays the exact supplied addresses and copies them locally. Network names remain explicit, addresses wrap on narrow screens, and no transaction or external payment request is initiated.
