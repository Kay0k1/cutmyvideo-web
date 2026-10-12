# cutmyvideo-web

[Русский](README.md) · English

[![Product checks](https://github.com/Kay0k1/cutmyvideo-web/actions/workflows/checks.yml/badge.svg)](https://github.com/Kay0k1/cutmyvideo-web/actions/workflows/checks.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The [cutmy.video](https://cutmy.video) product browser interface for selecting moments from video and exporting MP4/MP3 and MKV in copy mode. Accepts uploaded files and accessible public links. The interface source is open under the MIT license. Media processing, the HTTP API and persistent job queue live in the open-source MIT [cutmyvideo-core](https://github.com/Kay0k1/cutmyvideo-core).

[Usage](#usage) · [Local development](#local-development) · [Checks](#checks) · [Deployment](#deployment) · [Contributing](#contributing-and-license)

## Usage

1. **Video.** Paste a public link to a video, completed recording or clip, or choose an MP4, MOV, MKV or WebM file. The interface shows the actual title, duration, provider and limits returned by the API. A failed import preserves the previous video and draft.
2. **Moment.** Choose an audio track by index, language and title, or No sound; the same choice applies to preview and export. Set start/end on the timeline, mark boundaries at the player position and preview the range. Precise time fields and zoom are available separately. Seconds (`15`), total minutes (`83:10`) and hours with milliseconds (`01:23:10.250`) are accepted.
3. **Clips, if needed.** Add and name several moments, then check those to export. Select all, duplicate, delete and undo the last deletion are available. A single moment can go straight to export.
4. **Export.** Choose MP4 or MP3, quality and cut mode, then save separate files or one joined file in the selected list order. Video copy mode offers MP4/MKV for every supported source, including platform links; uploaded files and direct links also offer compatible text-subtitle preservation. The summary shows included and omitted tracks; results show actual boundaries and track details. Jobs continue when another video opens; **Exports and files** lists recent jobs, cancellation and retained results.

**Exact boundaries** re-encode video to H.264/AAC or audio to MP3. **Original quality** preserves compatible MP4/MKV streams without re-encoding; the start can move to a preceding keyframe. Each result shows its actual boundaries. Successful files remain downloadable when another clip fails.

Light, dark and system appearance, complete Russian/English copy, keyboard controls, labelled sliders and visible focus work on desktop and mobile. Drafts, stage, language, appearance and defaults are stored in the browser. Server-file access belongs to the current session: a saved local draft cannot recover access after cookies are cleared.

## Sources and limits

Recognizes YouTube, Twitch, Rutube, TikTok, Instagram, Vimeo, Dailymotion, VK Video, Facebook, X/Twitter, Reddit, Odnoklassniki, Bilibili, Streamable and Rumble, plus public HTTPS files/pages supported by the core. The server resolves short links.

Provider recognition does not guarantee access to every video. Privacy, authentication, regional restrictions and platform changes can prevent import. Channels, playlists, DRM and ongoing live streams are not imported. Ordinary HTTPS media-file links are downloaded in full before processing; supported platform recordings allow selected intervals and decoder context to be fetched. See the [core provider catalogue](https://github.com/Kay0k1/cutmyvideo-core/blob/main/docs/providers.md) for verified providers and restrictions.

Compatible files play directly in the browser; YouTube can also use its embed. For other supported sources and browser-incompatible codecs, the server prepares 30-second preview windows while retaining the complete recording timeline. Recently visited windows remain within a browser cache of 8 windows / 64 MiB; the next window is prefetched. The server reuses prepared windows after a reload, with a 512 MiB / 64-window cap and cleanup after 30 minutes without access. A new position still needs preparation. Manual time entry remains available when playback is unavailable.

The operator configures limits and the interface reads them from the API. This repository's deployment configuration allows 32 GiB per source and platform fetch per job, 12 hours per range, 24 hours and 32 clips per export, and 16 GiB per output. The local example uses smaller file/storage limits. **Exports and files** lists up to 30 recent jobs, with active work first. Large downloads support HTTP Range and long connections. Sources and results normally expire after 24 hours; active jobs and retained results can keep source media longer. The interface displays the expiry returned by the server.

Audio selection follows the source preview and export. Source default chooses the first default-marked audio stream, or the lowest audio index. Uploaded files and direct links expose stream index, language, title, codec, channels and sample rate; platforms require uploading the original file for track selection, while no-sound export also works by link. Export each clip separately or join selected clips in list order. Video copy mode offers MKV for every supported source. Compatible text-subtitle preservation requires an uploaded file or direct link in copy mode; subtitles are clipped and rebased for each segment, with simplified styling. ASS, SSA and image subtitles cannot be preserved. The export summary and downloaded result list identify included and omitted tracks and actual segment boundaries. Incompatible settings never silently change mode or quality.

## Local development

Requires Node.js 22 (minimum 20.19), Docker with Compose, and Git. Keep both repositories beside one another. These commands run isolated local PostgreSQL, API and worker services, then the website at `http://localhost:5173`.

```sh
git clone https://github.com/Kay0k1/cutmyvideo-core.git core
git clone https://github.com/Kay0k1/cutmyvideo-web.git web
cd web
git -C ../core checkout "$(cat core.version)"
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
chmod 600 .env
npm ci
docker compose --env-file .env -f deploy/compose.dev.yaml up --build -d --wait
npm run dev
```

Settings are listed in [.env.example](.env.example). If opening the website at `http://127.0.0.1:5173`, set that exact `PUBLIC_ORIGIN` in `.env` and recreate the local API/worker. Vite proxies `/api` to `127.0.0.1:8080`; the website, player and downloads share one origin. The local database has no published port and the API binds to loopback only. Check readiness with:

```sh
curl --fail http://127.0.0.1:8080/readyz
docker compose --env-file .env -f deploy/compose.dev.yaml ps
```

Stop the services while preserving database/media volumes:

```sh
docker compose --env-file .env -f deploy/compose.dev.yaml down
```

If the core already runs manually, both `cutmy server` and `cutmy worker` need the same database/`DATA_DIR` and the website's `PUBLIC_ORIGIN`. When developing the core, keep your modified checkout: `core.version` pins CI, while local checks may exercise your changes.

## Checks

```sh
npm test
npm run build
npm run test:deploy
```

The build includes TypeScript validation. Browser tests use the actual core and FFmpeg, generate synthetic media, export/decode real MP4/MP3, and verify recovery, cancellation, sessions, keyboard operation and responsive layout. Use a disposable database and media directory with the documented [fixture limits](docs/QA.md#running-the-integrated-checks); the complete suite is not intended for a normal working database.

```sh
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e -- --project=desktop --project=mobile
```

CI runs unit/build/deployment checks and the complete npm dependency audit, tests PostgreSQL privileges against the actual core, then verifies integration/usability in Chromium/Firefox on Linux and WebKit on macOS. [core.version](core.version) pins the backend; dependencies and images are pinned. CI saves a distributable website build. Linux WebKit has a known GTK/GStreamer seeking instability; the complete CI media matrix runs on macOS. Additional network providers and the three-hour fixture are opt-in. See [QA](docs/QA.md) for evidence and limitations.

The website pins stable [cutmyvideo-core v1.0.2](https://github.com/Kay0k1/cutmyvideo-core/releases/tag/v1.0.2), commit `4e34a17`. The production image records the release version, commit and build timestamp.

## Deployment

[DEPLOYMENT.md](docs/DEPLOYMENT.md) covers HTTPS, internal networking, limits, backups, monitoring, updates and rollback. Production Compose differs from the local example. The Dockerfile builds static assets; an external reverse proxy routes `/api` to the core. The release helper requires clean repositories and a matching `core.version`, builds from Git archives, verifies service health and rolls back unsuccessful activation while retaining persistent volumes. Running that helper updates its configured server.

## Structure

| Directory | Purpose |
|---|---|
| `src/` | Editor, player, timeline, API, translations and preferences |
| `public/` | Icon, initial appearance and font license |
| `e2e/` | Real-media browser integration |
| `deploy/` | Local development and production operations |
| `docs/` | QA, UX, deployment and measured audits |
| `.github/` | CI, dependency updates and contribution templates |

## Contributing and license

Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md), [issues](https://github.com/Kay0k1/cutmyvideo-web/issues), [CHANGELOG.md](CHANGELOG.md). Report vulnerabilities through [SECURITY.md](SECURITY.md). Website code uses [MIT](LICENSE); Geologica keeps its separate [SIL Open Font License](public/licenses/geologica.txt).

TRON, Solana, Ethereum and Bitcoin addresses are available in [Support](https://cutmy.video/?panel=support&lang=en). The website copies addresses; transfers happen in your wallet.
