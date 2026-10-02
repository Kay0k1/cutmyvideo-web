# Changelog

Notable product changes are recorded here.

## Unreleased

### Added
- Three-stage website workflow: choose a source, edit moments, then export and download; previous steps preserve ranges, player position, and completed files.
- Restrained light/dark/system appearance, persistent theme choice, CSP-compatible initialization before first paint, and self-hosted Geologica Variable with Cyrillic.
- Website-specific YouTube/MP4 inputs with strict canonical sharing-link validation, upload type/container checks, and rejection of MP4 files without video while preserving the existing draft.
- Stage-aware document titles, larger 44-pixel controls, complete RU/EN step copy, and a YouTube example consistent with the current website scope.
- React and TypeScript editing workbench foundation, pinned dependencies, and reproducible builds.
- UX decisions grounded in W3C slider accessibility and GOV.UK form-error guidance.
- Manual editing: source links and uploads, native/YouTube preview, millisecond timecodes, zoomed trim range, keyboard controls, and multiple labelled fragments.
- MP4/MP3 export with quality and cut-mode settings, real job polling, cancellation, partial downloads, and browser-local draft restoration.
- Responsive Russian interface with actionable errors, honest quality descriptions, and self-hosted fonts.
- Production static-web container and immutable asset caching.
- Complete Russian/English interface with stored language choice, localized errors/statuses/accessibility labels, and state-preserving switches.
- Compact navigation with examples and help, persistent default settings, and a support dialog with four supplied network addresses.
- Direct links to support and optional language selection; copy feedback without payment transactions.
- Russian primary README and separate English documentation.
- Integration coverage for real exports, long-source timing, keyboard editing, reload, cancellation, source replacement, mobile layout, and session isolation.
- HTTPS deployment with an internal API/database, persistent volumes, resource limits, reproducible release archives, and daily database backups with seven-day local retention.
- GitHub checks against a pinned public-core revision, with real media and browser integration tests.

### Fixed
- Fit the desktop editing controls and Continue action into standard laptop/desktop viewports, including 1280×720, through compact chrome and a two-column workspace.
- Keep long clip lists bounded, reveal newly added/selected rows without scrolling the page, and retain visibility after viewport resizing.
- Place ready downloads beside export settings on desktop; preserve natural phone layout and 44-pixel touch targets for header/footer actions.
- Keep the narrow header within 320 CSS pixels and retain 44-pixel phone hit areas when the primary pointer changes.
- Fit both initial source choices into a 360×640 phone viewport without removing input hints or actions.
- Build the shared core image once for API and worker, avoiding concurrent exports to the same release tag.
- Align website YouTube parsing with the public core's canonical URL rules; pin production releases to core revision fe2f46e with safe private process-failure diagnostics.
- Honor the saved editing step after retrieving a previous job; retain status and downloads when its source has expired.
- Keep light input borders distinguishable from their surface and distribute the font copyright/license with self-hosted assets.
- Pause playback when leaving the Moments step, keep the player mounted while hidden, and restore saved playback position after readiness.
- Apply theme colors without a transient control-background flash and keep the browser theme color aligned before first paint.
- Describe retained jobs without implying files exist when an expired-source job has no artifacts.
- Clarify the lossless copy choice as Original quality with its explicit boundary warning.
- Authenticate the platform extractor consistently in the production container through the updated public core.
- Distinguish failed exports with no files from partial success, and preserve original clip numbering in partial downloads.
- Pin the Node.js 22 builder and maintained stable Nginx image by digest for reproducible deployment.
- Keep invalid source links in the editor and show the selected language's actionable validation message.
- Preserve fractional seconds in saved-range summaries, fit selected boundaries into the timeline, and name short-source zoom accurately.
- Separate source resolution and duration on mobile, preserve keyboard skip navigation, and keep trim targets at least 24 pixels wide.
