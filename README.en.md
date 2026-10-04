# cutmyvideo web

[Русский](README.md) · English

The editing interface for [cutmy.video](https://cutmy.video): choose moments from a linked video or an uploaded MP4 and download them as MP4 video or MP3 audio. This repository is private. Media processing lives in the open-source [cutmyvideo-core](https://github.com/Kay0k1/cutmyvideo-core).

[Using the editor](#using-the-editor) · [Features](#mvp-features) · [Development](#development) · [Structure](#structure) · [Support](#supporting-development)

## Using the editor

Work is divided into four steps. Going back keeps your selected moments.

1. **Video.** Paste a public link to one video, stream recording or clip, or choose an MP4 from your device (up to 1 GiB). The website identifies the service; the core returns the actual title, duration and available preview.
2. **Moment.** Choose the start and end on the timeline, mark boundaries at the player position and preview the clip. Precise time fields and zoom are available in a separate disclosure. Seconds (`15`), total minutes (`83:10`) and hours with milliseconds (`01:23:10.250`) are supported.
3. **Clips.** Add up to twelve moments, name and edit them. Check the clips to export; select all, duplicate and delete actions apply to the checked clips.
4. **Export.** Choose MP4 or MP3, quality and cut mode. Wait for processing and download the results. Each checked moment becomes a separate file. Files from the last export remain available while changing the next selection.

The website recognizes fifteen services: YouTube (including Shorts), Twitch (recordings and clips), Rutube, TikTok, Instagram (including Reels), Vimeo, Dailymotion, VK Video, Facebook, X/Twitter, Reddit, Odnoklassniki, Bilibili, Streamable and Rumble. Public HTTPS video-file links and pages supported by the core are accepted too. Short links are resolved safely on the server.

Service support does not guarantee access to every video: privacy, sign-in requirements, geographic restrictions and website changes can prevent import. The interface reports an actionable error and offers MP4 upload. Channels, playlists, DRM and ongoing live streams are not imported.

Exact boundaries re-encode media. Original quality avoids re-encoding, but boundaries may shift and codecs must be compatible. Actual boundaries are shown next to each ready file. Preview depends on the source and browser; manual timecode editing remains available.

Changing videos replaces the old moments only after the new source opens successfully. A rejected file or link keeps the existing draft. MP4 inputs must contain video; renaming a file does not change its format.

## MVP features

- Four separate steps preserving the draft, current stage and checked clips on return and reload.
- Light, dark, and system appearance; self-hosted Geologica with Cyrillic support.
- A dedicated stage for selecting several intervals and bulk actions; precise time fields, overview and zoomed timelines, and keyboard controls.
- Custom quality, cut-mode and zoom menus with keyboard navigation, typeahead, correct focus and theme support.
- A native player for compatible files and embedded YouTube playback, without invented media or demo data.
- MP4/MP3 export through the shared core, background jobs, cancellation, and downloads for successful clips from partially failed jobs.
- Draft and latest-job restoration within the same browser session.
- Russian by default and a complete English interface; switching language preserves selections.
- Examples, help, and persistent defaults for format, quality, cut mode, and timeline zoom.
- Support section with four wallet addresses and copy actions. The application does not perform transfers.
- Compact desktop workspace: select one moment without a clip list or export settings on the same screen; ready files appear beside export settings.
- The initial screen fits a small phone; mobile editing follows a natural order with comfortable touch targets. Long desktop lists scroll within their own area.
- Visible focus, labelled sliders, and actionable errors.

Preferences, language and appearance are stored in the browser. The server defines media retention and processing limits. Sources without a controllable preview provide the original link and manual timecodes; the website does not simulate an unavailable player.

Compact slider grips retain separate touch targets. The exact boundary time appears while dragging, and keyboard navigation keeps the focused boundary visible. Failed exports explain the cause and recovery action; retrying retains the selected moments.

## Development

Node.js 22 is recommended; the minimum supported version is 20.19. Both the core HTTP API on `127.0.0.1:8080` and its worker must run.

```sh
npm ci
npm run dev
```

Vite uses port `5173` and proxies `/api` to the backend. The site, API, media player, and downloads share one origin and an authorized server session.

```sh
npm run typecheck
npm test
npm run build
```

Browser checks use the actual core and synthetic test videos:

```sh
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
```

CI retains all five projects: Chromium and Firefox checks run on Linux, and the complete WebKit matrix runs on macOS 15. [Playwright recommends macOS for video playback closest to Safari](https://playwright.dev/docs/browsers#webkit). The same Linux project remains available with `xvfb-run -a --server-args='-screen 0 2560x1440x24' npm run test:e2e -- --project=layout-webkit --headed`: the GTK/GStreamer stall after seeking remains unresolved, despite verified complete MP4 and byte-range delivery. Moving CI does not fix that Linux issue.

The disposable macOS CI environment enables Keyboard Navigation (`AppleKeyboardUIMode=2`) only for `org.webkit.Playwright`, then restores the previous value. This preserves the real Tab-to-slider focus assertion without changing the website. [Apple keyboard-navigation setting](https://support.apple.com/en-my/guide/mac-help/mchlc06d1059/mac), [macOS WebKit behavior in Playwright](https://github.com/microsoft/playwright/issues/41808).

Run options and verified scenarios are in [docs/QA.md](docs/QA.md). Server deployment and updates are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The Dockerfile builds static files; a reverse proxy routes `/api` to the core.

## Structure

- `src/` — editor, player, timeline, API client, translations, and preferences.
- `docs/UX.md` — interface decisions and primary W3C/GOV.UK guidance.
- `e2e/` — browser integration checks.
- `deploy/` — product deployment.
- `CHANGELOG.md` — change history.

This repository contains the product website. Universal processing operations are developed in the public core.

## Supporting development

TRON, Solana, Ethereum, and Bitcoin addresses are available in [Support](https://cutmy.video/?panel=support&lang=en). Copy the address for the intended network and make the transfer in your wallet.
