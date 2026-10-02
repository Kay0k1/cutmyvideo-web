#!/usr/bin/env bash
set -euo pipefail
umask 077

deploy_dir="${CUTMY_DEPLOY_DIR:-/opt/cutmy/current/web/deploy}"
env_file="${CUTMY_ENV_FILE:-/opt/cutmy/shared/production.env}"
backup_dir="${CUTMY_BACKUP_DIR:-/opt/cutmy/backups}"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
partial="$backup_dir/database-$stamp.sql.gz.partial"
trap 'rm -f "$partial"' EXIT
docker compose --env-file "$env_file" -f "$deploy_dir/compose.yaml" exec -T postgres pg_dump -U cutmy -d cutmy | gzip > "$partial"
mv "$partial" "${partial%.partial}"
find "$backup_dir" -type f -name 'database-*.sql.gz' -mtime +7 -delete
