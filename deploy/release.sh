#!/usr/bin/env bash
set -euo pipefail
umask 077

web_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
core_dir="${CUTMY_CORE_DIR:-$(dirname "$web_dir")/core}"
ssh_target="${CUTMY_SSH_TARGET:?Set CUTMY_SSH_TARGET}"
ssh_key="${CUTMY_SSH_KEY:?Set CUTMY_SSH_KEY}"

for repo in "$core_dir" "$web_dir"; do
  git -C "$repo" diff --quiet
  git -C "$repo" diff --cached --quiet
  if [[ -n "$(git -C "$repo" ls-files --others --exclude-standard)" ]]; then
    printf 'Commit or remove untracked files before release: %s\n' "$repo" >&2
    exit 1
  fi
done

core_sha="$(git -C "$core_dir" rev-parse HEAD)"
web_sha="$(git -C "$web_dir" rev-parse HEAD)"
release="${core_sha:0:12}-${web_sha:0:12}"
archive_dir="$(mktemp -d)"
trap 'rm -rf "$archive_dir"' EXIT
git -C "$core_dir" archive --format=tar.gz HEAD > "$archive_dir/core.tar.gz"
git -C "$web_dir" archive --format=tar.gz HEAD > "$archive_dir/web.tar.gz"

ssh_args=(-i "$ssh_key" -o BatchMode=yes -o ConnectTimeout=15)
ssh "${ssh_args[@]}" "$ssh_target" "mkdir -p /opt/cutmy/releases/$release/core /opt/cutmy/releases/$release/web"
scp "${ssh_args[@]}" "$archive_dir/core.tar.gz" "$archive_dir/web.tar.gz" "$ssh_target:/opt/cutmy/releases/$release/"

ssh "${ssh_args[@]}" "$ssh_target" bash -s -- "$release" "$core_sha" "$web_sha" <<'REMOTE'
set -euo pipefail
release="$1"
release_dir="/opt/cutmy/releases/$release"
cd "$release_dir"
tar -xzf core.tar.gz -C core
tar -xzf web.tar.gz -C web
rm core.tar.gz web.tar.gz
printf 'CORE_COMMIT=%s\nWEB_COMMIT=%s\n' "$2" "$3" > release.env
export RELEASE_TAG="$release"
docker compose --env-file /opt/cutmy/shared/production.env -f web/deploy/compose.yaml build
docker compose --env-file /opt/cutmy/shared/production.env -f web/deploy/compose.yaml up -d --wait --wait-timeout 120
# Keep later restarts and backups on the same image tags as this release.
env_next="$(mktemp /opt/cutmy/shared/production.env.XXXXXX)"
sed '/^RELEASE_TAG=/d' /opt/cutmy/shared/production.env > "$env_next"
printf 'RELEASE_TAG=%s\n' "$release" >> "$env_next"
chmod 600 "$env_next"
mv "$env_next" /opt/cutmy/shared/production.env
ln -sfn "$release_dir" /opt/cutmy/current.next
mv -Tf /opt/cutmy/current.next /opt/cutmy/current
install -m 0644 web/deploy/backup.cron /etc/cron.d/cutmyvideo-backup
printf 'Deployed release %s\n' "$release"
REMOTE
