# cutmyvideo-web

[Русский](README.md) · English

[![Product checks](https://github.com/Kay0k1/cutmyvideo-web/actions/workflows/checks.yml/badge.svg)](https://github.com/Kay0k1/cutmyvideo-web/actions/workflows/checks.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The [cutmy.video](https://cutmy.video) product browser interface for selecting moments from video and exporting MP4/MP3 and MKV in copy mode. Accepts uploaded files and accessible public links. The interface source is open under the MIT license. Media processing, the HTTP API and persistent job queue live in the open-source MIT [cutmyvideo-core](https://github.com/Kay0k1/cutmyvideo-core).

The core **1.5.0** integration provides silence analysis with editable plans, loudness measurement and normalization, output dimensions with canvas padding, CSV/FFmetadata chapter interchange, scene-change and black-interval detection, and separate audio replacement with an explicit offset through Go, CLI, HTTP API and Python/TypeScript SDKs. These tools are invoked programmatically; the manual browser controls are described below. [Core examples and limits](https://github.com/Kay0k1/cutmyvideo-core/blob/v1.5.0/docs/media-analysis-and-rendering.md) · [Integration gates and database upgrade](docs/QA.md#core-150-integration).

[Usage](#usage) · [Collections](#collections-and-agent-review) · [Local development](#local-development) · [Checks](#checks) · [Deployment](#deployment) · [Contributing](#contributing-and-license)

## Usage

1. **Open a video.** Paste a public video, stream recording or clip URL, or choose an MP4, MOV, MKV or WebM file. A failed import preserves the previous video and draft.
2. **Trim and download.** The player, timeline boundaries, clip collection and export share one workspace. Drag the boundaries or mark the player position, preview the cut and press **Cut a clip**. A normal MP4 needs no visit to export settings.

Desktop editing follows the browser viewport height. The player, timeline and export remain visible without page scrolling in windows at least 1100×620 CSS pixels. Long clip lists scroll inside their panel. During and after an export, the sidebar switches between **Clips** and **Ready files** while the same player stays in place. Small windows, phones and browser zoom reflow with accessible ordinary scrolling.

**Exact time and timeline** or clicking a timecode reveals precise inputs, supporting seconds (`15`), minutes (`83:10`) and hours with milliseconds (`01:23:10.250`). **Frames and audio** prepares thumbnails and the waveform only on request. **Tools** contains boundary checks, ±0.1 s adjustments, zoom and shortcuts. Add, rename, select and reorder clips beside the video; deletion and duplication live in action menus.

**Export settings** opens an optional dialog for quality, audio selection, source copying, joined files, compatible subtitles and source cleanup. Audio selection applies to both playback and export. Processing continues while another video is opened; **Exports and files** lists recent jobs, cancellation and retained results.

**Exact boundaries** re-encode video to H.264/AAC or audio to MP3. **Original quality** preserves compatible MP4/MKV streams without re-encoding; the start can move to a preceding keyframe. Each result shows its actual boundaries. Successful files remain downloadable when another clip fails.

Light, dark and system appearance, complete Russian/English copy, keyboard controls, labelled sliders and visible focus work on desktop and mobile. Each video has its own browser project: clips, order, output settings, player position and timeline view survive switching and reload. The legacy shared draft migrates automatically. Language, appearance and defaults are also stored in the browser. Server-file access belongs to the current session: a saved local draft cannot recover access after cookies are cleared.

The timeline shows frames from the current 30-second area; select a frame to jump to it. Six 160×90 thumbnails prepare after seeking settles, yield to playback and share the server cache resource limits. The browser keeps up to eight strips / 8 MiB and releases them when the source changes. Check start/end plays 1.5 seconds on both sides of the boundary and stops, shortened at the recording edges. Exact controls include ±0.1 s buttons. Arrow keys outside fields seek by 0.1 s, or 1 s with Shift; I/O mark boundaries and Space toggles playback. Unfinished exact time entry survives reload. If a source expires, named clips and exact boundaries remain in the draft: reopen the same recording and explicitly enable clip restoration. A shorter replacement cannot discard saved boundaries.

## Collections and agent review

Version 0.6.0 adds a separate Collections workspace. Each clip has a stable ID, output settings and crop; multiple source ranges join in the chosen order. Edits support undo/redo. Import native core plans/requests or download a portable project without secrets or server access rights.

An agent invitation opens one server project, its source and results under the browser's ordinary session. The token lasts 10 minutes and recipient access lasts 24 hours. Within the same project, exporting two edited clips reuses the other accepted jobs. Failed, cancelled or expired clips require explicit retry, with the attempt key saved before submission. Importing JSON alone does not transfer the agent's key or jobs.

Supplied UTF-8 SRT/VTT can be retimed through the ready clip's actual segment map and downloaded as a sidecar. The source subtitle file stays in browser storage and is excluded from invitations and portable JSON. A project does not extend media retention or override the existing original-cleanup setting. See the [collection guide](docs/COLLECTIONS.md) for the full workflow, source fingerprint checks and limitations.

## Sources and limits

Recognizes YouTube, Twitch, Rutube, TikTok, Instagram, Vimeo, Dailymotion, VK Video, Facebook, X/Twitter, Reddit, Odnoklassniki, Bilibili, Streamable and Rumble, plus public HTTPS files/pages supported by the core. The server resolves short links.

Provider recognition does not guarantee access to every video. Privacy, authentication, regional restrictions and platform changes can prevent import. Channels, playlists, DRM and ongoing live streams are not imported. Ordinary HTTPS media-file links are downloaded in full before processing; supported platform recordings allow selected intervals and decoder context to be fetched. See the [core provider catalogue](https://github.com/Kay0k1/cutmyvideo-core/blob/main/docs/providers.md) for verified providers and restrictions.

Compatible files play directly in the browser; YouTube can also use its embed. For other supported sources and browser-incompatible codecs, the server prepares 30-second preview windows while retaining the complete recording timeline. Recently visited windows remain within a browser cache of 8 windows / 64 MiB; the next window is prefetched. The server reuses prepared windows after a reload, with a 512 MiB / 64-window cap and cleanup after 30 minutes without access. A new position still needs preparation. Manual time entry remains available when playback is unavailable.

The operator configures limits and the interface reads them from the API. This repository's deployment configuration allows 32 GiB per source and platform fetch per job, 12 hours per range, 24 hours and 32 clips per export, and 16 GiB per output. The local example uses smaller file/storage limits. **Exports and files** lists up to 30 recent jobs, with active work first. Large downloads support HTTP Range and long connections. Delete source after export is enabled by default on the website. After a completely successful export and completion of already accepted operations, the original media, previews, thumbnails and waveform are removed. Browser projects and completed clips remain; their existing output retention does not change. A partial failure or cancellation does not trigger this cleanup. Turn off Delete source after export to use ordinary server retention, normally 24 hours with extensions for data still in use. The interface shows server-reported expiry; reopen the recording to make new cuts after its media is removed.

Audio selection follows the source preview and export. Source default chooses the first default-marked audio stream, or the lowest audio index. Uploaded files and direct links expose stream index, language, title, codec, channels and sample rate; platforms require uploading the original file for track selection, while no-sound export also works by link. Export each clip separately or join selected clips in list order. Video copy mode offers MKV for every supported source. Compatible text-subtitle preservation requires an uploaded file or direct link in copy mode; subtitles are clipped and rebased for each segment, with simplified styling. ASS, SSA and image subtitles cannot be preserved. The export summary and downloaded result list identify included and omitted tracks and actual segment boundaries. Incompatible settings never silently change mode or quality.

A lost export acknowledgement can be recovered by retrying the saved request even after source cleanup: the server returns its accepted job under the original key instead of creating a duplicate. Pending retries from 0.3 preserve their exact body and original keep-source policy; new videos still default to cleanup.

## Frame and waveform

**Frame** starts collapsed. Expand it for original proportions or 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 4:5, 5:4 and 21:9 presets. Custom aspect ratio accepts positive width and height. Move and resize the area on the video, with buttons or the keyboard; the image keeps its proportions. The ordinary editor applies one frame setting to every clip; collections support a separate crop per clip. Cropping requires accurate MP4; incompatible export settings explain the conflict and offer an explicit mode choice or frame reset.

The waveform follows the selected audio track and original source time. The detail view helps find speech and pauses; the overview gradually fills with sections you explore. Each request covers at most 30 seconds of source time, waits for seeking to settle and yields to playback. The browser keeps at most 256 windows for the current audio track; the server has its own resource budgets, caching and cleanup. Data-saving mode skips waveform requests. Missing audio or an unavailable waveform leaves manual cutting usable.

## Projects and edit history

Open **My projects** on the open-video screen to resume a previous edit. Projects are saved in this browser without registration. Removing original server media preserves clip boundaries, names and settings. Reopen the same recording and explicitly enable restoration to continue. SHA-256 and byte size confirm matching content; a title or duration alone does not. Missing content verification or a different fingerprint requires confirmation before rebinding. Server media always requires the current owner's session.

**Download plan** saves selected clips in list order using the core's strict plan v1 schema, with no server resource IDs or authenticated URLs. For the local CLI, set `input` to the media path. The browser can import the same JSON and then open the corresponding recording. Importing into an open project asks before replacing its cuts and supports undo.

Up/down controls preserve the order used by joining and plans. Undo/Redo change, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y cover bounds, names, addition, duplication, deletion, order and crop settings. One drag or name edit is one action; text fields keep normal text-editing shortcuts. Each project has up to 50 actions in the current tab. A reload preserves edited results and starts a new history.

Browser storage supports up to 100 projects, with a 4,194,304-character JSON cap; the actual quota depends on the browser. If storage is unavailable or full, download a plan; switching videos is blocked until the current work can be saved. Remove an unused project before opening a new video when the index is full. Removing a browser project leaves server media and completed files intact. A saved plan does not restore access after session cookies are cleared.

## Local development

Requires Node.js 22.12 or later, Docker with Compose, and Git. Keep both repositories beside one another. These commands run isolated local PostgreSQL, API and worker services, then the website at `http://localhost:5173`.

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

The core revision is pinned in [core.version](core.version). The production image records that revision’s version, commit and build time.

## Deployment

[DEPLOYMENT.md](docs/DEPLOYMENT.md) covers HTTPS, internal networking, limits, backups, monitoring, updates and rollback. Production Compose differs from the local example. The Dockerfile builds static assets; an external reverse proxy routes `/api` to the core. The release helper requires clean repositories and a matching `core.version`, builds from Git archives and checks service health. Before migration, it stops access and writers and saves a coordinated database/media snapshot. A failure before opening access restores verified data before starting the old image. After opening is attempted, new data is retained and writers stop for inspection. Persistent volumes are not recreated. Running the helper updates its configured server; a source version change alone does not mean publication or successful deployment.

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
