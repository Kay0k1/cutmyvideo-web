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

## Release and rollback

`deploy/release.sh` uploads clean, committed source archives and records the exact
core and product commits. Set `CUTMY_SSH_TARGET`, `CUTMY_SSH_KEY`, and optionally
`CUTMY_CORE_DIR`; it does not need GitHub credentials on the server.

Build and test both repositories before updating the active release. Upload
source archives, not local credentials or `.git` directories. Record both commit
SHAs in the release record. Run the migrations and health checks before announcing
the site. Rollback means restoring the previous release symlink and running its
Compose configuration with the previous release image tag. Review database
migration compatibility before rollback; reverting an image does not undo data
migrations.

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

## Checks before release

- Frontend build and timecode tests.
- Core tests, race checks, and PostgreSQL integration tests.
- Real upload → manual ranges → MP4 and MP3 export → download.
- Independent browser session cannot access another session's files.
- Responsive and keyboard controls at desktop and mobile widths.
- HTTPS, health endpoints, restart behavior, TTL cleanup and disk capacity.

The source providers have independent limits. Do not describe an untested video
platform as supported merely because yt-dlp recognizes its URL.
