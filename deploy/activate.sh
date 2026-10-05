#!/usr/bin/env bash
set -euo pipefail
umask 077

# This runs on the server after committed archives have been extracted.
install_dir="${CUTMY_INSTALL_DIR:-/opt/cutmy}"
cron_file="${CUTMY_CRON_FILE:-/etc/cron.d/cutmyvideo-backup}"
monitor_cron_file="${CUTMY_MONITOR_CRON_FILE:-/etc/cron.d/cutmyvideo-monitor}"
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
# Exclude another rollout and backups from observing a half-switched release.
exec 9>"$install_dir/shared/deployment.lock"
flock -n 9 || { printf 'Another release or backup is running.\n' >&2; exit 75; }
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
cron_snapshot="$(mktemp "$install_dir/shared/backup.cron.rollback.XXXXXX")"
cron_existed=false
monitor_snapshot="$(mktemp "$install_dir/shared/monitor.cron.rollback.XXXXXX")"
monitor_existed=false
service_snapshot="$(mktemp -d "$install_dir/shared/services.rollback.XXXXXX")"
services_changed=false
if [[ -f "$cron_file" ]]; then
  cp "$cron_file" "$cron_snapshot"
  cron_existed=true
fi
if [[ -f "$monitor_cron_file" ]]; then
  cp "$monitor_cron_file" "$monitor_snapshot"
  monitor_existed=true
fi
env_next=""
rollout_started=false
finished=false
keep_snapshot=false
egress_changed=false
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
      if [[ "$cron_existed" == true ]]; then
        install -m 0644 "$cron_snapshot" "$cron_file"
      else
        rm -f "$cron_file"
      fi
      local cron_status=$?
      if [[ "$monitor_existed" == true ]]; then install -m 0644 "$monitor_snapshot" "$monitor_cron_file"; else rm -f "$monitor_cron_file"; fi
      local monitor_status=$?
      if (( env_status == 0 && link_status == 0 && stack_status == 0 && cron_status == 0 && monitor_status == 0 )); then
        printf 'Previous release restored and healthy.\n' >&2
      else
        keep_snapshot=true
        printf 'Automatic rollback did not finish; inspect the previous release and container health.\n' >&2
        printf 'Private environment snapshot retained at %s.\n' "$env_snapshot" >&2
      fi
    else
      # A failed first installation must not leave new workers consuming jobs.
      docker compose --env-file "$env_snapshot" -f "$release_dir/web/deploy/compose.yaml" stop
      local first_stack_status=$?
      cp "$env_snapshot" "$env_file" && chmod 600 "$env_file"
      local first_env_status=$?
      if [[ "$cron_existed" == true ]]; then install -m 0644 "$cron_snapshot" "$cron_file"; else rm -f "$cron_file"; fi
      local first_cron_status=$?
      if [[ "$monitor_existed" == true ]]; then install -m 0644 "$monitor_snapshot" "$monitor_cron_file"; else rm -f "$monitor_cron_file"; fi
      local first_monitor_status=$?
      rm -f "$current_link" "$current_link.next"
      if (( first_stack_status != 0 || first_env_status != 0 || first_cron_status != 0 || first_monitor_status != 0 )); then keep_snapshot=true; fi
      printf 'Release failed; no previous release exists for automatic rollback.\n' >&2
    fi
  fi
  if [[ "$status" != 0 && "$egress_changed" == true && "$keep_snapshot" != true ]]; then
    if [[ -n "$previous_dir" && -f "$previous_dir/web/deploy/egress.sh" ]]; then
      bash "$previous_dir/web/deploy/egress.sh" apply || keep_snapshot=true
    else
      bash "$release_dir/web/deploy/egress.sh" remove || keep_snapshot=true
    fi
  fi
  if [[ "$status" != 0 && "$services_changed" == true ]]; then
    python3 "$release_dir/web/deploy/service-control.py" restore "$service_snapshot" || keep_snapshot=true
  fi
  if [[ "$keep_snapshot" != true ]]; then rm -f "$env_snapshot" "$cron_snapshot" "$monitor_snapshot"; rm -rf "$service_snapshot"; fi
  [[ -z "$env_next" ]] || rm -f "$env_next"
  rm -f "$current_link.next"
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
# Resolve the source cap through Compose without printing its private config.
# Keep the edge's multipart cap aligned when an operator changes source size.
max_upload="$(docker compose --env-file "$env_next" -f web/deploy/compose.yaml config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); n=int(c["services"]["api"]["environment"]["MAX_SOURCE_BYTES"]); assert 0<n<2**63-2**21; print(n+2**21)')"
sed -i '/^MAX_UPLOAD_BODY_BYTES=/d' "$env_next"
printf 'MAX_UPLOAD_BODY_BYTES=%s\n' "$max_upload" >> "$env_next"
docker compose --env-file "$env_next" -f web/deploy/compose.yaml build
python3 web/deploy/service-control.py snapshot "$service_snapshot"
# Install restrictions before any new media container starts. If this fails,
# activation aborts without creating a less restricted processing service.
egress_changed=true
bash web/deploy/egress.sh apply
rollout_started=true
docker compose --env-file "$env_next" -f web/deploy/compose.yaml up -d --wait --wait-timeout 120
# Keep database administration separate from the application's bearer role.
# The helper uses private persistent operator credentials and SQL on stdin.
database_result="$(CUTMY_SHARED_DIR="$install_dir/shared" CUTMY_ENV_FILE="$env_next" CUTMY_DEPLOY_DIR="$release_dir/web/deploy" python3 web/deploy/database_access.py)"
restart_required="$(python3 -c 'import json,sys; c=json.load(sys.stdin); assert c.get("ok") is True and type(c.get("restart_required")) is bool; print("true" if c["restart_required"] else "false")' <<< "$database_result")"
if [[ "$restart_required" == true ]]; then
  docker compose --env-file "$env_next" -f web/deploy/compose.yaml restart api worker
fi
# Re-check fresh role connections after bootstrap sessions were terminated.
docker compose --env-file "$env_next" -f web/deploy/compose.yaml up -d --wait --wait-timeout 120
docker compose --env-file "$env_next" -f web/deploy/compose.yaml exec -T api /usr/local/bin/cutmy healthcheck
install -m 0644 "${CUTMY_BACKUP_CRON_SOURCE:-web/deploy/backup.cron}" "$cron_file"
install -m 0644 web/deploy/monitor.cron "$monitor_cron_file"
mv "$env_next" "$env_file"
ln -sfn "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
services_changed=true
python3 web/deploy/service-control.py install "$release_dir/web/deploy"
# Units are enabled but never started while deployment.lock is held. Docker
# restarts start the stack after egress; the operator can start units after this
# helper exits to register the already running healthy stack with systemd.
finished=true
printf 'Deployed release %s\n' "$release"
