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
# Register the healthy stack after release.sh activation has exited.
systemctl start cutmy-egress.service cutmy-stack.service
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

Media services use fixed addresses on the dedicated `cutmy-processing-v1`
network (`172.30.240.0/24`): API `.10`, worker `.11`, PostgreSQL `.12`.
`deploy/egress.sh` applies a targeted `DOCKER-USER` chain before a rollout starts.
It allows existing reply connections, PostgreSQL `.12:5432`, public DNS and
public HTTPS on TCP 443; private, link-local, metadata, CGNAT, multicast and
other ports are rejected. Separate source-scoped `CUTMY-HOST` INPUT hooks reject
new connections to the Docker host itself, including its gateway and public IP;
forwarding rules alone cannot cover that path. IPv6 is disabled for media containers. The helper
does not flush unrelated Docker or host firewall rules. Verify this subnet is
not already used by another network before first activation. Public HTTP 80 is
unavailable to media processes, matching the HTTPS-only URL API.
API/worker use `on-failure:5`, so Docker does not start them before boot-time
restrictions exist. `cutmy-stack.service` starts the stack after
`cutmy-egress.service`; both are tied to the Docker service. Activation snapshots
unit files/enabled states, installs/enables units without starting them under
the deployment lock, and restores them during rollback. After activation exits,
run `systemctl start cutmy-egress.service cutmy-stack.service`. Kernel tests use
a disposable network namespace and preserve unrelated firewall chains. Unit
start/stop acquires the same exclusive deployment lock, with bounded waits,
so a Docker restart or manual unit action cannot run Compose against a partly
switched current link/environment. Start allows 300 seconds for the lock and
120 seconds for Compose health; stop allows thirty seconds plus twenty seconds
for media containers to exit. A forced daemon stop can still interrupt work;
failed activation retains its private recovery snapshot.
See [Docker's restart policy documentation](https://docs.docker.com/engine/containers/start-containers-automatically/) for the daemon-start distinction.

Compose checks all five services before accepting a release. API readiness checks
PostgreSQL. Worker readiness uses `cutmy worker-healthcheck`: a private marker in
that worker's temporary filesystem must show successful queue or lease access
within thirty seconds. An idle worker refreshes it after a successful queue check;
a busy worker refreshes it after a successful job heartbeat. Startup alone does not
mark a worker healthy. The web check fetches its local HTML and the edge check
queries its local configuration endpoint. These local checks do not replace an
external HTTPS request or a real export and download after deployment.

Activation also separates database privileges. The `cutmy` application role owns
the project database and schema objects, but cannot create roles/databases, bypass
row security, replicate, or run superuser-only operations. A separate operator
role is stored in private `shared/postgres-admin.env` (0600). PostgreSQL's original
bootstrap role cannot be demoted, so the first hardening renames it to
`cutmy_bootstrap`, disables login, and creates an ordinary application role.
The helper sends secret SQL through stdin and never prints credentials. It
terminates old bootstrap sessions; activation restarts API/worker when requested
and repeats readiness before accepting the release. Role hardening persists
across image rollback; project ownership remains compatible with app migrations.

## Anonymous sessions and operating limits

The owner cookie is a random bearer capability, not an account. It is Secure,
HttpOnly and SameSite=Lax in production, with a seven-day lifetime. Sources, jobs,
previews, thumbnails and downloads check the owner; another session receives 404
without learning whether the resource exists. Clearing the cookie loses access to
that owner's files. Browser draft storage alone cannot recover ownership.

Current defaults allow twelve ranges, ten minutes per range, one hour
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
every five minutes; independent cron also calls `cutmy maintenance` inside API
when the worker is unavailable. Active jobs pin resources. This is not an exact
deletion deadline. Owner storage admission covers staged sources and thumbnails
(2 GiB by default); exported files count toward the global media admission
limit configured by `MAX_STORAGE_BYTES` (10 GiB by default, 80 GiB on the new
production host). Source and individual output limits are 1 GiB. Shared database
reservations coordinate admission/publication/claims across processes. Jobs
waiting for disk enter `waiting_storage`, bounded by `STORAGE_WAIT_TIMEOUT`
(30 minutes). Waiting jobs count toward owner/global active caps. Claims rotate
owners; `WORKER_CONCURRENCY` defaults to one and should be measured under the
worker's 3 CPU/4 GiB limit before increasing. `STORAGE_SAFETY_BYTES` sets a
physical safety floor (512 MiB). Activation derives the edge upload cap from
`MAX_SOURCE_BYTES + 2 MiB`. These are application limits, not a filesystem quota or a guarantee
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

`deploy/backup.sh` creates a streamed gzip SQL dump hourly at minute 17. The target
database RPO is about one hour when the schedule succeeds; this is not a storage
durability guarantee. Backups are bounded by seven days, 168 copies and 4 GiB,
keeping at least the latest valid copy. Large dumps can therefore reduce history
below seven days. Every dump has SHA-256, compressed/expanded sizes and timestamp
in a manifest. CRC/completeness/digest verification precedes atomic publication
of the whole directory. A failed dump never becomes an apparent successful copy.
Dump creation has a 600-second deadline and 2 GiB expanded-SQL budget; verification
has a separate 60-second deadline. No plaintext SQL copy is kept during backup.

An exclusive backup lock prevents duplicate writers; a shared deployment lock
protects the snapshot, then releases before remote transfer. Concurrent rollout
is rejected rather than exposing a partly switched release. Retention reads the
small publisher manifests instead of repeatedly inflating a week's hourly dumps.
Existing flat migration dumps are preserved separately. Install the supplied
`operations.logrotate` if the host has logrotate, to bound the operator backup log.
Scheduling can be overridden with `CUTMY_BACKUP_CRON_SOURCE` during activation.

Settings are in private `/opt/cutmy/shared/operations.env` (0600), copied from
`deploy/operations.env.example`. Shell expressions are never evaluated. Optional
`CUTMY_BACKUP_REMOTE_TARGET`, `CUTMY_BACKUP_REMOTE_DIR`, and
`CUTMY_BACKUP_SSH_KEY` enable rsync over pinned-host-key SSH. Provision a backup-only
account/directory first. Transfer goes to `.incoming-...`; remote SHA-256 is
compared to the locally verified digest before atomic directory rename. A remote
outage preserves the successful local copy, returns failure and exposes stale
remote status. Receiver retention is configured independently. Without those
settings, remote copying remains disabled. A local copy cannot survive host loss.

Verify a copy with `python3 deploy/operations.py verify-backup <backup-directory>`.
`verify-restore <backup-directory>` restores into an owned disposable PostgreSQL17
container with no network, ports or production volumes and validates schema,
foreign keys and owner consistency with `ON_ERROR_STOP=1`. It reports the measured
database restore duration; that duration excludes host provisioning, deployment,
TLS, DNS and media, so it is not full-service RTO. Cleanup checks the owned label
and removes that container and its anonymous volume even on a failed restore.

Database backups contain no video bytes. `verify-restore --simulate-media-loss`
also exercises `recover-database-only.sql` solely inside the isolated clone:
unavailable upload/direct sources/results are removed, public platform sources
remain available for a fresh export, old jobs are marked failed, and signed
metadata/reservations are cleared. For actual recovery, preserve the original
database, restore a separate inactive DB, perform the same policy if media is
lost, then check readiness plus upload/export/download before changing traffic.
Never apply that cleanup to the live DB, or run `docker compose down -v` during
normal deployment. Recovery cannot reconstruct expired upload bytes from SQL.

The new production server uses `Europe/Moscow`; hourly copies run at :17 Moscow
time. The earlier migration used daily 03:17. It restored the database with error
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

## Monitoring and independent maintenance

`monitor.cron` checks services, physical disk space, queued/running/storage-waiting
jobs, oldest queue age, expired worker leases, storage-wait deadlines and local
backup age every minute. Defaults alert at 85% disk use or below 10 GiB free,
queue age above ten minutes, or no successful local backup for two hours.
Configured remote backups also have a separate freshness check. Inspection
failure is an alert condition, rather than an apparent healthy empty queue.

State is atomically stored under `shared/monitor-state.json`; bounded
`monitor-events.jsonl` records changes and recovery. Unchanged conditions do not
emit repeated notifications. An optional absolute executable `CUTMY_ALERT_HOOK`
receives one safe JSON event on stdin; failed delivery preserves pending state
for retry. No external channel is enabled without a configured adapter. The
monitor does not include owner cookies, SQL, signed URLs or environment contents
in events. Locks prevent overlapping checks and protect release consistency.

Every five minutes, the independent maintenance command executes
`cutmy maintenance` inside the API with a twenty-second deadline. It shares the
deployment lock and has its own exclusive lock. Expiry cleanup therefore still
runs when the worker is stopped, without a permanent sixth service. Inspect
`shared/maintenance-status.json` for the last completed invocation.

## Isolated performance measurements

`scripts/load-profile.py` creates its own Docker network, PostgreSQL instance,
temporary media directory, API bound to an ephemeral loopback port, and worker.
It accepts no production database, volume or API URL. The API has one CPU/512 MiB;
the worker has three CPUs/4 GiB, with two FFmpeg threads. Use a core image built
from the exact revision being evaluated, and an unused private output directory:

```sh
python3 scripts/load-profile.py --image '<verified-core-image>' \
  --core-commit '<40-character-core-commit>' \
  --output /root/.cache/cutmy-load/concurrency-2 \
  --users 4 --worker-concurrency 2 --duration 30 --export-duration 6 \
  --fps 30 --size 1920x1080 --cgroup-limits
```

Each client uploads a generated 1080p/30 fps H.264/AAC source and requests copy,
accurate MP4 and MP3 exports. Download size and independently probed duration are
validated; probing runs after the measured workload in a separate owned container.
Reports identify the exact commit, immutable image ID, binary SHA-256 and FFmpeg version.
The report includes throughput, p50/p95 queue and total server duration, sampled
process RSS, cgroup memory peak (including page cache), CPU/throttling, I/O and
rejection codes. Queue timestamps use a tiny trigger installed only in the
disposable database; its overhead is included. Fixture generation, PostgreSQL
and the measurement controller are outside reported worker resource totals.
Cleanup removes only owned containers, their anonymous volumes and the owned
network; `cleanup.json` records its result even if the measurement fails.

Repeat concurrency 1/2/3 under identical image/workload conditions. A separate
`--users 12 --burst-admission` run holds the worker until 36 job submissions have
finished, making the 32-job admission ceiling observable. Optional
`--hls-test-binary` runs the real MPEG-TS/fMP4 HLS engine regression and saves Go
CPU/heap profiles. That uses a small controlled fixture and transport, separately
from the 1080p API workload; Go profiles exclude FFmpeg child CPU. These short
cohorts establish behavior for the measured workload, not a simultaneous-user
capacity guarantee for arbitrary providers, video sizes or bot traffic.

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
find /opt/cutmy/backups -maxdepth 2 -type f -name 'manifest.json' \
  -printf '%h\n'
```

Containers use rotated JSON logs, limited to three 10 MiB files each. Investigate
failed exports through the safe job/item diagnostic and bounded operator logs;
do not expose raw extractor output, signed media addresses, cookies or database
connection strings in public errors or reports. Container restart counters,
health, disk usage, oldest queued job and backup age are useful operator signals.
Off-server copying and notification adapters exist, but remain disabled until
their destination/channel is configured and delivery is verified. Database
restore drills do not establish a full-host recovery time or recover media bytes.

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

## Retired releases and bounded build cache

Successful activation records the exact previously active release in
`/opt/cutmy/previous`. Daily housekeeping at 04:37 in the server's timezone keeps
that version and the current release. It removes older managed release folders
and only retired `cutmy-core`, `cutmy-web`, and `cutmy-audit-load` image tags after
24 hours. Every existing container, including stopped containers and images
started by ID or another alias, pins its project release. Unmanaged folders,
media, database, certificates, migration evidence, and backups are excluded.
Image removal never uses force, and no volume or container pruning occurs.

Preview the plan with `python3 deploy/housekeeping.py`; apply it with `--apply`.
The helper takes the exclusive deployment lock, validates the current link
against the private operator configuration, and records successful cleanup in
`shared/housekeeping-status.json`. Before the first activation that creates the
previous link, it retains the newest complete release with both image tags as
its additional rollback candidate. `CUTMY_RELEASES_KEEP` (minimum two),
`CUTMY_CLEANUP_GRACE_HOURS`, and `CUTMY_BUILD_CACHE_MAX_BYTES` can be configured in
the private operations file.

The dedicated production host uses Docker's default builder for this project.
Housekeeping applies `docker buildx prune --all --reserved-space=0 --max-used-space`
with a default 512 MiB target to that builder. The explicit zero removes a
reserved-cache floor. It verifies private reclaimable bytes after pruning and
retries newly unreferenced ancestors up to four times within two minutes, stopping
when no progress is possible. This covers the builder's reclaimable cache, not
just a release, and requires a Docker Buildx version supporting that option.
Live images and in-use cache may keep the reported total above the target.
Retained releases remain available for local rollback; another build may need to
download dependencies again after cache eviction. See
[Docker Buildx cache retention](https://docs.docker.com/reference/cli/docker/buildx/prune/).
