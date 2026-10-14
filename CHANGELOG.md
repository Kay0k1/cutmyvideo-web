# Changelog

Notable product changes are recorded here.

## Unreleased

### Added
- Save and add the next clip, previous/next clip navigation and input-safe shortcuts beside the player; compact controls remain accessible on phones.
- Draft playback of the selected sequence in list order, with boundary seek feedback, selected audio and read-only crop framing.
- Download all ready clips as a streaming ZIP and retry only failed intervals, retaining earlier successes across navigation, cleanup and reload.

### Changed
- Production pins core 1.3.0 and its exact source/build metadata, enabling editable clip collections and distinct draft/final assemblies through the engine API. Database schema remains 007.
- Projects use per-record compare-and-save under browser locks, independent tab views, deletion tombstones and explicit same-project conflict recovery. Legacy projects migrate without overwriting their original records.
- Short foreground preview windows load first, while bounded background windows retain ordinary playback and revisit coverage.

### Fixed
- Playback in a stale tab can no longer erase another tab's projects or resurrect deleted work.
- Optimistic seeks and delayed external-player clocks cannot prematurely advance a draft sequence.


## 0.4.0 — 2026-10-12

### Added
- Independent per-video browser projects with legacy draft migration, source-reconnection checks and strict core-v1 plan import/export. Projects survive original-media cleanup; retained outputs remain available under their existing retention policy.
- Touch/keyboard clip reordering and bounded per-project undo/redo, with one drag or completed name edit recorded as one action.
- Progressive selected-audio waveform detail and overview. Visited sections fill gradually, with bounded browser/server caches and background priority.
- A collapsed Frame editor with popular aspect ratios, custom width/height, draggable/resizable crop and keyboard controls. Accurate MP4 exports apply the same source-image geometry without stretching.
- Default-on Delete source after export. Full success cleans original media and its derived previews after active operations finish, preserving browser projects and ready clips. An explicit opt-out retains the original under normal server retention; failed/cancelled exports do not trigger successful-completion cleanup.

### Fixed
- Cancelled project reads cannot overwrite a later source or attach an old job.
- Export retry identity is persisted in the active project before submission and restored when returning to that project. Accepted work can be recovered after media removal with the same request/key; pending 0.3 retries preserve their original keep-source policy without changing new-video defaults.
- Intentionally empty projects preserve source metadata and output/crop settings after media removal.
- Full or unavailable browser storage prevents source switches that would discard unsaved work; full project indexes reject new media creation until space is freed.

## 0.3.0 — 2026-10-12

### Added
- Choose a source audio track by index, language and title, or export without sound; preview and export share the selection, and source-specific choices never become defaults for another video.
- Export selected named clips as separate files or join them in list order through the existing workflow.
- Offer MP4/MKV for video copy exports from every supported source; local copy also supports compatible text-subtitle preservation, with clear inclusion/exclusion summaries and actual result segment/track details.
- Russian and English controls, keyboard interaction, mobile layout and actionable diagnostics for platform tracks and unsupported subtitles.

### Changed
- Open the MIT website source and contributor documentation; report vulnerabilities through private security advisories.
- Keep full database and Chromium/Firefox/native WebKit checks for code pull requests, tags and manual runs; main pushes run frontend/image verification without repeating the full matrix. Documentation-only pull requests retain frontend checks.
- Publish static build artifacts only for tags/manual runs and retain CI artifacts for three days.

## 0.2.2 — 2026-10-12

### Fixed
- Include database test support modules in the production Docker build and verify that image in CI.
- Wait for the PostgreSQL TCP listener rather than its temporary initialization socket in local, production and disposable CI health checks.
- Deploy stable core v1.0.2 with matching binary version, source commit and build timestamp; check actual database-timeout responses, explicit retries and retained export identity in browser integration.
- Explain temporary database unavailability and storage initialization in Russian and English, respect the server's retry delay, and ask users to check recent exports before resubmitting a request with an uncertain result.

## 0.2.1 — 2026-10-10

### Fixed
- Keep whole-video selection and retained export downloads at least 44 pixels tall for touch interaction.
- Allow the timeline zoom label to wrap on narrow screens with text enlarged to 200%, verified across browser engines.
- Pin the core patch correcting initial MKV keyframes and HLS continuity handling across FFmpeg versions.

## 0.2.0 — 2026-10-10

### Added
- MIT license, contributor/security policies, bilingual issue forms and pull request guidance.
- Reproducible local database/API/worker Compose stack with the website origin and isolated volumes.
- CI concurrency, bounded jobs, distributable build artifacts, local Compose validation, and explicit fixture storage limits.
- Parallel background exports and an owner-protected recent-job browser with cancellation, retained files and expiry notices.
- Long-recording limits obtained from the API; MP4, MOV, MKV and WebM uploads, bounded 30-second preview windows, browser prefetch/cache and reusable server previews.

### Fixed
- Exercise the server-advertised clip limit in real browser collection checks instead of assuming twelve clips, verify that background exports keep source entry usable, and check the current preview fallback when the YouTube SDK fails.

### Changed
- Document the working product, collaborator development, source restrictions, current preview/retention behavior and the private website/public MIT core boundary in both languages.
- Record website version and license metadata for the private 0.2.0 release.

## Initial development

The entries below describe development before the first tagged website release.

### Added
- Restore the last clip deletion with original order, labels, selection and boundaries; explain bulk-copy limits and associate upload errors with the chooser.
- Compact, theme-aware encoding progress measured from actual processed media time, weighted across selected clips, with accessible labels, retry resets and backward compatibility for older jobs.
- Show specific export failure reasons in Russian and English, with a retry action that retains the selected source and intervals.
- Compact trim and overview controls with separate 44-pixel hit regions, boundary-time hints and keyboard navigation that reveals the focused boundary.
- Service health checks and automatic recovery to the previous release after a failed activation, verified through deployment fault injection.
- Recognize fifteen video services and accept generic public HTTPS links; show the actual provider and source identity instead of limiting the source form to YouTube.
- Separate the editing workflow into Video, Moment, Clips and Export; keep precision controls behind a disclosure and move clip management to its own stage.
- Select individual clips for export, select all, duplicate and delete selections while preserving checked clips in the draft.
- Theme-aware custom menus for zoom, export and defaults, with keyboard navigation, typeahead and focus management through Radix Select.
- Provider-aware preview fallback with an original-page link and owner-protected source thumbnails.
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
- Isolate playback updates to the timeline, coalesce draft persistence with lifecycle flushes, retain one keyboard listener, and stop unused player polling and obsolete reads.
- Keep source type controls consistent with an active import/export and localize request-body timeout feedback.
- Harden API/worker deployment with a read-only root, dropped capabilities, bounded temporary storage and PID limits.
- Validate saved clips independently and normalize restored export settings; malformed drafts no longer discard a usable source or submit invalid MP3/copy requests.
- Reuse an unacknowledged export's idempotency key across retries and reloads, preventing duplicate jobs after a lost response.
- Stop polling missing or expired jobs and release the export controls; retry the YouTube player library after a failed load.
- Show distinct source preparation, storage and server-capacity errors in Russian and English.
- Pin the core that fences expired worker leases and applies the source timeout to quota admission, upload/download transfer and inspection.
- Avoid case-insensitive module-resolution collisions between the progress component and its time-aggregation helper on macOS.
- Pin the optimized core with private inspection caching, faster CPU encoding, bounded memory/network maintenance and atomic, recoverable publication of completed fragments.
- Enable app-scoped Keyboard Navigation in disposable macOS CI, restore the previous preference afterward, and retain the actual Tab-to-slider focus assertion.
- Accept metadata-only preload before the browser preview action, verify duration in both contexts, and retain the subsequent real playback and decoded-file assertions.
- Run the unchanged full WebKit media/layout matrix on native macOS, while retaining all other Linux projects and the documented Linux GTK playback reproducer.
- Give the exhaustive headed WebKit viewport check a measured total runtime budget while retaining every assertion, native interaction and real download check.
- Read diagnostic seekable ranges only after valid media metadata exists, preventing the test observer from changing WebKit's duration during startup.
- Attach bounded playback events and media state when a native browser preview check fails, without recording URLs or session data or changing playback assertions.
- Navigate after each emulated phone viewport change in browser checks, retaining the real saved work and downloads while checking the exact requested dimensions and every layout assertion.
- Run browser integration checks in a pinned official Playwright container runtime with matching bundled browsers, a virtual display, and a home directory owned by the container user.
- Wait for YouTube player readiness before playback commands, retain the latest seek and pause requested while loading, and keep navigation usable when a player is replaced or fails.
- Pin the core that removes unused caption URL matrices before bounded source inspection, fixing import and export preparation for recordings with large automatic-subtitle metadata.
- Keep source-error messages within the known localized vocabulary; unknown and inherited object-property codes use safe fallback copy instead of breaking the interface or exposing provider diagnostics.
- Use the normal foreground for transparent trim controls and verify visible boundary hints in both themes; wait for the selected menu option's actual keyboard focus before confirming it in browser checks.
- Pin the core that selects compatible video/audio pairs before ranking quality, fixing accurate 1080p exports when a separate HLS rendition hides usable progressive streams.
- Preserve millisecond boundaries when grabbing the timeline handles away from their visible grips, keep the drag scale stable, and make very short intervals independently selectable.
- Send uncapped original-quality requests for local stream-copy exports while retaining the user's quality preference for precise exports.
- Explain missing audio and other safe worker diagnostics instead of recommending precise mode for an already precise export; preserve successful files from partially failed jobs.
- Recover interrupted processing and publishing after worker shutdown, and keep cancellation results consistent when cancellation races with an error.
- Remove the current-video/resume panel from the initial source screen; saved work remains accessible through stage navigation.
- Keep editor shortcuts out of custom menus and dialogs, and recenter the timeline when deleting the edited clip selects another moment.
- Reject whitespace in a pasted URL's authority before browser parsing, retaining local validation and field focus without rejecting video filenames or signed query strings.
- Refresh custom menu option labels when switching Russian and English while retaining selected values and the existing player.
- Share concurrent session initialization requests, preventing duplicate cookie handshakes and avoidable rate-limit failures before saved jobs restore; fresh connections and retries still revalidate the session.
- Fit the desktop editing controls and Continue action into standard laptop/desktop viewports, including 1280×720, through compact chrome and a two-column workspace.
- Keep long clip lists bounded, reveal newly added/selected rows without scrolling the page, and retain visibility after viewport resizing.
- Place ready downloads beside export settings on desktop; preserve natural phone layout and 44-pixel touch targets for header/footer actions.
- Bound short phone-landscape previews to 180–240 pixels while preserving native controls, video proportions, and portrait sizing.
- Keep the narrow header within 320 CSS pixels and retain 44-pixel portrait and landscape phone hit areas when the primary pointer changes.
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
