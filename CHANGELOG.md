# Changelog

Notable product changes are recorded here.

## Unreleased

### Added
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
- Distinguish failed exports with no files from partial success, and preserve original clip numbering in partial downloads.
- Pin the Node.js 22 builder and maintained stable Nginx image by digest for reproducible deployment.
- Keep invalid source links in the editor and show the selected language's actionable validation message.
- Preserve fractional seconds in saved-range summaries, fit selected boundaries into the timeline, and name short-source zoom accurately.
- Separate source resolution and duration on mobile, preserve keyboard skip navigation, and keep trim targets at least 24 pixels wide.
