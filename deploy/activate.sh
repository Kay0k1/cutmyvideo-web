#!/usr/bin/env bash
set -euo pipefail
umask 077

# This runs on the server after committed archives have been extracted.
install_dir="${CUTMY_INSTALL_DIR:-/opt/cutmy}"
cron_file="${CUTMY_CRON_FILE:-/etc/cron.d/cutmyvideo-backup}"
release="${1:?Set the release tag}"
core_sha="${2:?Set the core commit}"
web_sha="${3:?Set the website commit}"
if [[ ! "$core_sha" =~ ^[0-9a-f]{40}$ || ! "$web_sha" =~ ^[0-9a-f]{40}$ || "$release" != "${core_sha:0:12}-${web_sha:0:12}" ]]; then
  printf 'Invalid release identity.\n' >&2
  exit 1
fi
release_dir="$install_dir/releases/$release"
env_file="$install_dir/shared/production.env"
current_link="$install_dir/current"
previous_dir=""
if [[ -e "$current_link" || -L "$current_link" ]]; then
  previous_dir="$(readlink -f "$current_link")"
fi
previous_release=""
if [[ -n "$previous_dir" ]]; then
  previous_release="${previous_dir##*/}"
  if [[ "$previous_dir" != "$install_dir/releases/$previous_release" || ! "$previous_release" =~ ^[0-9a-f]{12}-[0-9a-f]{12}$ || ! -f "$previous_dir/web/deploy/compose.yaml" ]]; then
    printf 'The previous release cannot be safely restored.\n' >&2
    exit 1
  fi
fi

env_snapshot="$(mktemp "$install_dir/shared/production.env.rollback.XXXXXX")"
env_next=""
rollout_started=false
finished=false
keep_snapshot=false
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$status" != 0 && "$rollout_started" == true && "$finished" != true ]]; then
    if [[ -n "$previous_release" ]]; then
      printf 'Release failed; restoring %s.\n' "$previous_release" >&2
      local restore_file
      restore_file="$(mktemp "$install_dir/shared/production.env.restore.XXXXXX")"
      cp "$env_snapshot" "$restore_file" && chmod 600 "$restore_file" && mv "$restore_file" "$env_file"
      local env_status=$?
      ln -sfn "$previous_dir" "$current_link.next" && mv -Tf "$current_link.next" "$current_link"
      local link_status=$?
      RELEASE_TAG="$previous_release" docker compose --env-file "$env_snapshot" -f "$previous_dir/web/deploy/compose.yaml" up -d --wait --wait-timeout 120
      local stack_status=$?
      install -m 0644 "$previous_dir/web/deploy/backup.cron" "$cron_file"
      local cron_status=$?
      if (( env_status == 0 && link_status == 0 && stack_status == 0 && cron_status == 0 )); then
        printf 'Previous release restored and healthy.\n' >&2
      else
        keep_snapshot=true
        printf 'Automatic rollback did not finish; inspect the previous release and container health.\n' >&2
        printf 'Private environment snapshot retained at %s.\n' "$env_snapshot" >&2
      fi
    else
      printf 'Release failed; no previous release exists for automatic rollback.\n' >&2
    fi
  fi
  if [[ "$keep_snapshot" != true ]]; then rm -f "$env_snapshot"; fi
  [[ -z "$env_next" ]] || rm -f "$env_next"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp "$env_file" "$env_snapshot"
chmod 600 "$env_snapshot"
env_next="$(mktemp "$install_dir/shared/production.env.next.XXXXXX")"
sed '/^RELEASE_TAG=/d' "$env_file" > "$env_next"
printf 'RELEASE_TAG=%s\n' "$release" >> "$env_next"
chmod 600 "$env_next"

cd "$release_dir"
printf 'CORE_COMMIT=%s\nWEB_COMMIT=%s\n' "$core_sha" "$web_sha" > release.env
export RELEASE_TAG="$release"
docker compose --env-file "$env_next" -f web/deploy/compose.yaml build
rollout_started=true
docker compose --env-file "$env_next" -f web/deploy/compose.yaml up -d --wait --wait-timeout 120
install -m 0644 web/deploy/backup.cron "$cron_file"
mv "$env_next" "$env_file"
ln -sfn "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
finished=true
printf 'Deployed release %s\n' "$release"
