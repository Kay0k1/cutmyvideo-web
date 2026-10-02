# cutmyvideo web

[Русский](README.md) · English

The editing interface for [cutmy.video](https://cutmy.video): choose moments from a YouTube video or an uploaded MP4 and download them as MP4 video or MP3 audio. This repository is private. Media processing lives in the open-source [cutmyvideo-core](https://github.com/Kay0k1/cutmyvideo-core).

[Using the editor](#using-the-editor) · [Features](#mvp-features) · [Development](#development) · [Structure](#structure) · [Support](#supporting-development)

## Using the editor

Work is divided into three steps. Going back keeps your selected moments.

1. **Video.** Paste a YouTube link or choose an MP4 from your device (up to 1 GiB). Regular, Share, Shorts, and live links are accepted. Other sites and input formats are not available on the website yet. Examples includes a Blender film on YouTube.
2. **Moments.** Choose the start and end on the timeline or enter exact times. Seconds (`15`), total minutes (`83:10`), and hours with milliseconds (`01:23:10.250`) are supported. Add up to ten moments, name them, and preview a selected clip separately. Continue with Export settings.
3. **Export.** Choose MP4 or MP3, quality, and cut mode. Select Cut, wait for processing, and download the results. Each moment becomes a separate file.

Exact boundaries re-encode media. Original quality avoids re-encoding, but boundaries may shift and codecs must be compatible. Actual boundaries are shown next to each ready file. Preview depends on the source and browser; manual timecode editing remains available.

Changing videos replaces the old moments only after the new source opens successfully. A rejected file or link keeps the existing draft. MP4 inputs must contain video; renaming a file does not change its format.

## MVP features

- Three separate steps with draft preservation when returning.
- Light, dark, and system appearance; self-hosted Geologica with Cyrillic support.
- Multiple intervals, precise time fields, overview and zoomed timelines, and keyboard controls.
- A native player for compatible files and embedded YouTube playback, without invented media or demo data.
- MP4/MP3 export through the shared core, background jobs, cancellation, and downloads for successful clips from partially failed jobs.
- Draft and latest-job restoration within the same browser session.
- Russian by default and a complete English interface; switching language preserves selections.
- Examples, help, and persistent defaults for format, quality, cut mode, and timeline zoom.
- Support section with four wallet addresses and copy actions. The application does not perform transfers.
- Compact desktop workspace: player and moments beside the timeline and exact times, with ready downloads beside export settings.
- The initial screen fits a small phone; mobile editing follows a natural order with comfortable touch targets. Long desktop lists scroll within their own area.
- Visible focus, labelled sliders, and actionable errors.

Preferences, language, and appearance are stored in the browser. The server defines media retention and processing limits. YouTube can restrict server access or require login; uploading an MP4 is the fallback.

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
