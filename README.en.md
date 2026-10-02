# cutmyvideo web

[Русский](README.md) · English

The editing interface for [cutmy.video](https://cutmy.video): select and export moments from video or audio manually. This repository is private. Media processing lives in the open-source [cutmyvideo-core](https://github.com/Kay0k1/cutmyvideo-core).

## Using the editor

1. Paste a public HTTPS URL or upload a file. The Examples section provides a short sample video.
2. Choose the start and end on the timeline or enter exact times. Seconds (`15`), total minutes (`83:10`), and hours with milliseconds (`01:23:10.250`) are supported.
3. Add more clips and optional names. Preview the selected interval separately.
4. Choose MP4 or MP3, quality, and cut mode. Each clip is exported as a separate file.
5. Select Cut, wait for processing, and download the results.

Exact boundaries re-encode media. Preserve streams avoids re-encoding, but boundaries may shift and codecs must be compatible. Actual boundaries are shown next to each ready file. Preview depends on the source and browser; manual timecode editing remains available.

## MVP features

- Multiple intervals, precise time fields, overview and zoomed timelines, and keyboard controls.
- A native player for compatible files and embedded YouTube playback, without invented media or demo data.
- MP4/MP3 export through the shared core, background jobs, cancellation, and downloads for successful clips from partially failed jobs.
- Draft and latest-job restoration within the same browser session.
- Russian by default and a complete English interface; switching language preserves selections.
- Examples, help, and persistent defaults for format, quality, cut mode, and timeline zoom.
- Support section with four wallet addresses and copy actions. The application does not perform transfers.
- Responsive layout, visible focus, labelled sliders, and actionable errors.

Preferences and language are stored in the browser. The server defines media retention and processing limits. Some platforms restrict server access or require login; uploading a file is the fallback.

## Development

Requires Node.js 20.19+ and the core HTTP API on `127.0.0.1:8080`. Both the API and worker must run.

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
npx playwright install chromium
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
