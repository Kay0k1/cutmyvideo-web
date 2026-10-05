# Deployment and operation

The product lives in this private repository. The reusable processing engine is
in the public `Kay0k1/cutmyvideo-core` repository. No deployment passwords, SSH keys,
GitHub credentials, or production environment files belong in either checkout.

## Layout

Each release has sibling `core/` and `web/` directories under
`/opt/cutmy/releases/<release>/`. `/opt/cutmy/current` points to the active release.
Persistent Docker volumes have explicit names, so replacing a release does not
replace the database, result files, or TLS certificates.

Operator configuration lives at `/opt/cutmy/shared/production.env` with mode 0600.
Set `POSTGRES_PASSWORD` to a random value, `DOMAIN` to the domain, and
`RELEASE_TAG` to the release identifier. Do not print the expanded Compose config
into public logs; it contains the database connection password.

Since 5 October 2026 the active production host is `2.26.124.119` (Ubuntu 24.04,
6 CPUs, 12 GB RAM, 150 GB disk). From the operator workspace use
`ssh cutmy-production`; release settings are outside Git in
`/root/.config/cutmy/deploy.env`. Both development checkouts are also available
at `/root/video_cut` on that host. The previous host, `192.144.78.45`, retains
the migration snapshot with its API and worker stopped; its HTTPS edge forwards
requests to the new host while old DNS records expire. Future releases target
the new host.

## Start and verify

```sh
docker compose --env-file /opt/cutmy/shared/production.env \
  -f /opt/cutmy/current/web/deploy/compose.yaml up -d --build
curl --fail https://cutmy.video/healthz
curl --fail https://cutmy.video/readyz
```

Caddy obtains HTTPS certificates automatically. Only the edge publishes ports;
PostgreSQL, media workers, and the API remain on the internal Compose network.
The API and worker share the media volume. Resource limits prevent processing
from using all of the machine's available CPU and memory.
Both media services drop all Linux capabilities, have a read-only root filesystem
and a 256-process ceiling, and use a private 128 MiB temporary filesystem with
`noexec,nosuid,nodev`. Extractor caches live under that temporary filesystem;
sources, exports and processing workspaces use the media volume.
The API builds the core image once; the worker uses that same image without a
second build targeting the same image tag.

Compose checks all five services before accepting a release. API readiness checks
PostgreSQL. Worker readiness uses `cutmy worker-healthcheck`: a private marker in
that worker's temporary filesystem must show successful queue or lease access
within thirty seconds. An idle worker refreshes it after a successful queue check;
a busy worker refreshes it after a successful job heartbeat. Startup alone does not
mark a worker healthy. The web check fetches its local HTML and the edge check
queries its local configuration endpoint. These local checks do not replace an
external HTTPS request or a real export and download after deployment.

## Anonymous sessions and operating limits

The owner cookie is a random bearer capability, not an account. It is Secure,
HttpOnly and SameSite=Lax in production, with a seven-day lifetime. Sources, jobs,
previews, thumbnails and downloads check the owner; another session receives 404
without learning whether the resource exists. Clearing the cookie loses access to
that owner's files. Browser draft storage alone cannot recover ownership.

Current production defaults allow twelve ranges, ten minutes per range, one hour
of selected material per job, three active jobs per owner and thirty-two active
jobs globally. Source preparation has four global slots and one slot per owner.
Mutation admission is twenty requests per minute per client IP, including uploads,
source imports, exports and cancellation. Shared networks also share that IP limit.
All authenticated requests additionally share a 1,200-per-minute IP ceiling;
the 180-per-minute per-owner ceiling still applies. Cookie rotation does not
bypass IP admission or allocate owner entries for rejected mutations. JSON
metadata must finish arriving within ten seconds; uploads retain their separate
source preparation timeout.

Sources and results have a 24-hour retention target. Cleanup runs in the worker
every five minutes; active jobs pin their required resources. This is not an exact
deletion deadline. Owner storage admission covers staged sources and thumbnails
(2 GiB by default); exported files count toward the global media admission
limit configured by `MAX_STORAGE_BYTES` (10 GiB by default, 80 GiB on the new
production host). Source and individual output limits are 1 GiB. These are application
admission limits for one API and one worker, not a filesystem quota or a guarantee
that the operating-system disk cannot fill. Keep capacity for database files,
rotated logs, images and backups outside the media budget.

An import does not promise that a provider will still make the stream available
when the job starts. Public access, a completed recording, extractor compatibility
and a supported unencrypted stream are required. Provider recognition is separate
from successful media processing; uploaded MP4 remains a useful fallback.

## Release and rollback

`deploy/release.sh` uploads clean, committed source archives and records the exact
core and product commits. Set `CUTMY_SSH_TARGET`, `CUTMY_SSH_KEY`, and optionally
`CUTMY_CORE_DIR`; it does not need GitHub credentials on the server.
The core checkout must match `core.version`, the revision verified by product CI.

Build and test both repositories before updating the active release. Upload
source archives, not local credentials or `.git` directories. Record both commit
SHAs in the release record. `deploy/activate.sh` builds before changing the running
stack, keeps a private snapshot of the previous environment, then waits for all
configured service health checks. Only after those checks pass does it commit the
active environment and release symlink. If activation partially fails, it restores
the previous environment, symlink, image tag, containers and backup schedule. A
failed rollback keeps the private recovery snapshot and reports the need for an
operator to inspect the stack. The helper also accepts a first installation with
no previous release; that case has no older stack to restore.

The activation fault checks use synthetic files and a Docker stub. They cover
successful activation, failed build, unhealthy rollout, failure after the
environment switch, a failed rollback and success/failure of the first release.
Run `npm run test:deploy` before changing the release helper. These checks prove
the recovery branches without deliberately breaking the production service.

For a deliberate rollback, review the previous `release.env` and database
migration compatibility, then invoke the current activation helper with that
release's exact core and web commits:

```sh
rollback_tag='<previous 12-character core SHA>-<previous 12-character web SHA>'
rollback_dir="/opt/cutmy/releases/$rollback_tag"
core_commit="$(sed -n 's/^CORE_COMMIT=//p' "$rollback_dir/release.env")"
web_commit="$(sed -n 's/^WEB_COMMIT=//p' "$rollback_dir/release.env")"
bash /opt/cutmy/current/web/deploy/activate.sh \
  "$rollback_tag" "$core_commit" "$web_commit"
```

Container changes are not an atomic, zero-downtime operation. Run external HTTPS,
real export and download checks before announcing a deployment. Reverting an
image does not undo database migrations or restore deleted/expired media. The
current additions to source metadata are additive; future schema changes still
need an explicit compatibility review.

## Backups

`deploy/backup.sh` creates a compressed PostgreSQL dump with seven-day local
retention. The release script installs `deploy/backup.cron` for a daily backup at
03:17 in the server's timezone; the server must have cron running. Run the backup
script once after first deployment and verify the compressed dump before relying
on the schedule. Files in the media volume are temporary results, not permanent user
storage. A local backup does not survive loss of the server; off-server backups
can be configured when choosing the hosting provider's backup service.

Restore into a separate database and verify sources/jobs before replacing the
active database. Never run `docker compose down -v` during a normal deployment.

The new production server uses `Europe/Moscow`, so its daily backup runs at
03:17 Moscow time. The migration restored the database with PostgreSQL error
checking enabled and matched all 14 copied media files by SHA-256 before starting
the API and worker. Private migration evidence is at
`/opt/cutmy/migration-20261005`; an off-server snapshot is retained in the operator
workspace outside Git.

On the previous server inspected on 4 October 2026, the timezone was `Europe/Warsaw`.
The cron expression therefore runs at 04:17 Moscow time while Warsaw uses summer
time, and 05:17 Moscow time during winter time. Check `timedatectl show -p Timezone`
before interpreting a missing scheduled backup. The inspection confirmed cron was
active and the two retained dumps passed `gzip -t`; it did not perform a database
restore on the production server or prove an off-server copy exists.

A separate restore drill on the same date copied the newest retained dump into a
new, isolated PostgreSQL 17 container with no network or published ports. With
`ON_ERROR_STOP` enabled, it restored 16 sources, 13 jobs and 18 artifacts. Checks
found no foreign-key or owner inconsistencies. Starting the actual engine against
that copied database applied the additive source metadata migration, preserved
those counts and passed API readiness. The disposable database/container was
removed afterward; the active database and local development database were not
modified. This verifies that sampled database dump, not a full server recovery or
recovery of the temporary media files.

## Read-only operational inspection

These commands inspect the active installation without restarting containers,
creating exports or printing production credentials:

```sh
readlink -f /opt/cutmy/current
docker ps --format '{{.Names}} {{.Status}}'
docker inspect cutmy-worker-1 --format \
  'status={{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}'
curl --fail --silent https://cutmy.video/healthz
curl --fail --silent https://cutmy.video/readyz
df -h /
systemctl is-active cron
find /opt/cutmy/backups -maxdepth 1 -type f -name 'database-*.sql.gz' \
  -printf '%f %s bytes\n'
```

Containers use rotated JSON logs, limited to three 10 MiB files each. Investigate
failed exports through the safe job/item diagnostic and bounded operator logs;
do not expose raw extractor output, signed media addresses, cookies or database
connection strings in public errors or reports. Container restart counters,
health, disk usage, oldest queued job and backup age are useful operator signals.
This deployment has no established automatic off-server alerting or completed
full server recovery drill; passing browser checks does not establish either.

## Checks before release

- Frontend build, timecode, source parsing and localization tests.
- Core tests, race checks, and PostgreSQL integration tests.
- Real upload → manual ranges → MP4 and MP3 export → download.
- Independent browser session cannot access another session's files.
- Source → moments → export navigation, restored work and light/dark preferences.
- Responsive and keyboard controls at desktop and mobile widths.
- HTTPS, health endpoints, restart behavior, TTL cleanup and disk capacity.

The source providers have independent limits. Do not describe an untested video
platform as supported merely because yt-dlp recognizes its URL.
