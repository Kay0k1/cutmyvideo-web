#!/usr/bin/env python3
"""Private bounded backup, restore and monitor tools, using only Python stdlib."""
import argparse
import contextlib
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

PG_IMAGE = "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
NAME = re.compile(r"database-\d{8}T\d{6}Z-[0-9a-f]{8}$")


def config():
    values = dict(os.environ)
    path = Path(values.get("CUTMY_OPERATIONS_ENV", "/opt/cutmy/shared/operations.env"))
    if path.exists():
        if path.stat().st_mode & 0o077:
            raise RuntimeError("Operations configuration must have mode 0600")
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, sep, value = line.partition("=")
            if not sep or not re.fullmatch(r"CUTMY_[A-Z0-9_]+", key):
                raise RuntimeError("Invalid operations configuration")
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values.setdefault(key, value)
    return values


def number(env, key, default, minimum=1):
    value = int(env.get(key, default))
    if value < minimum:
        raise RuntimeError("Invalid numeric operations setting: " + key)
    return value


def command(argv, timeout=120, **kwargs):
    # Tool stderr may contain passwords, signed media URLs or private dump SQL.
    try:
        result = subprocess.run(argv, timeout=timeout, stderr=subprocess.DEVNULL, **kwargs)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Operator command exceeded its deadline") from error
    if result.returncode:
        raise RuntimeError("Operator command failed: " + argv[0])
    return result


@contextlib.contextmanager
def wall_deadline(seconds):
    """Interrupt an inflater that consumes empty gzip members without yielding."""
    previous_handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()
    def expired(_signal, _frame):
        raise RuntimeError("Backup verification exceeded its deadline")
    signal.signal(signal.SIGALRM, expired)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, max(.001, seconds))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, max(.001, previous_timer[0] - (time.monotonic()-started)), previous_timer[1])


@contextlib.contextmanager
def lock(path, shared=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(handle, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another release or operator task holds the lock") from error
        yield


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def backup_manifest(directory, env):
    """Check small publisher metadata; full gzip verification is separate."""
    directory = Path(directory)
    dump = directory / "database.sql.gz"
    manifest_path = directory / "manifest.json"
    members = {"manifest.json", "database.sql.gz", "checksum.sha256"}
    if directory.is_symlink() or any((directory/name).is_symlink() for name in members):
        raise RuntimeError("Backup symlinks are not accepted")
    if {path.name for path in directory.iterdir()} != members or not all((directory/name).is_file() for name in members):
        raise RuntimeError("Invalid backup members")
    if manifest_path.stat().st_size > 16384:
        raise RuntimeError("Oversized backup manifest")
    manifest = json.loads(manifest_path.read_text())
    if not isinstance(manifest, dict) or manifest.get("format") != 1 or type(manifest.get("size_bytes")) is not int or manifest["size_bytes"] < 1 or manifest["size_bytes"] != dump.stat().st_size:
        raise RuntimeError("Backup manifest or size mismatch")
    maximum = manifest.get("sql_size_bytes")
    if type(maximum) is not int or maximum < 1 or maximum > number(env, "CUTMY_BACKUP_MAX_SQL_BYTES", 2 * 1024**3):
        raise RuntimeError("Invalid uncompressed backup size")
    if not isinstance(manifest.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["sha256"]):
        raise RuntimeError("Invalid backup checksum")
    checksum = directory / "checksum.sha256"
    if checksum.stat().st_size > 128 or checksum.read_text() != manifest["sha256"] + "  database.sql.gz\n":
        raise RuntimeError("Backup checksum metadata mismatch")
    if type(manifest.get("created_unix")) not in (int, float) or not math.isfinite(manifest["created_unix"]) or manifest["created_unix"] < 0 or manifest["created_unix"] > time.time() + 300:
        raise RuntimeError("Invalid backup timestamp")
    return manifest


def validate_backup(directory, env=None, deadline=None):
    env = env or {}
    deadline = deadline or time.monotonic() + number(env, "CUTMY_BACKUP_VERIFY_TIMEOUT", 60)
    with wall_deadline(deadline-time.monotonic()):
        return validate_backup_contents(directory, env, deadline)


def validate_backup_contents(directory, env, deadline):
    directory = Path(directory)
    manifest = backup_manifest(directory, env)
    dump = directory / "database.sql.gz"
    maximum = manifest["sql_size_bytes"]
    digest = hashlib.sha256()
    with dump.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            if time.monotonic() > deadline:
                raise RuntimeError("Backup verification exceeded its deadline")
            digest.update(chunk)
    if digest.hexdigest() != manifest.get("sha256"):
        raise RuntimeError("Backup checksum mismatch")
    total, first, last = 0, b"", b""
    with gzip.open(dump, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            if time.monotonic() > deadline:
                raise RuntimeError("Backup verification exceeded its deadline")
            total += len(chunk)
            if total > maximum:
                raise RuntimeError("Backup expansion exceeds its manifest")
            if not first:
                first = chunk[:4096]
            last = (last + chunk)[-4096:]
    if total != maximum or b"-- PostgreSQL database dump" not in first or b"-- PostgreSQL database dump complete" not in last:
        raise RuntimeError("Incomplete PostgreSQL dump")
    return manifest


def compose(env):
    directory = env.get("CUTMY_DEPLOY_DIR", "/opt/cutmy/current/web/deploy")
    return ["docker", "compose", "--env-file", env.get("CUTMY_ENV_FILE", "/opt/cutmy/shared/production.env"), "-f", str(Path(directory) / "compose.yaml")]


def dump_gzip(env, dump):
    maximum = number(env, "CUTMY_BACKUP_MAX_SQL_BYTES", 2 * 1024**3)
    deadline = time.monotonic() + number(env, "CUTMY_BACKUP_TIMEOUT", 600)
    argv = [*compose(env), "exec", "-T", "postgres", "pg_dump", "-U", "cutmy", "-d", "cutmy", "--no-owner", "--no-acl"]
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    total = 0
    try:
        with selectors.DefaultSelector() as selector, dump.open("wb") as raw:
            selector.register(process.stdout, selectors.EVENT_READ)
            with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as output:
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(timeout=remaining):
                        raise RuntimeError("Database dump exceeded its deadline")
                    chunk = os.read(process.stdout.fileno(), 1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > maximum:
                        raise RuntimeError("Database dump exceeds its byte budget")
                    output.write(chunk)
                try:
                    status = process.wait(timeout=max(0.1, deadline - time.monotonic()))
                except subprocess.TimeoutExpired as error:
                    raise RuntimeError("Database dump exceeded its deadline") from error
                if status:
                    raise RuntimeError("Database dump failed")
            raw.flush()
            os.fsync(raw.fileno())
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
    return total


def retain(directory, env):
    with wall_deadline(number(env, "CUTMY_BACKUP_VERIFY_TIMEOUT", 60)):
        retain_contents(directory, env)


def retain_contents(directory, env):
    maximum_count = number(env, "CUTMY_BACKUP_MAX_COPIES", 168)
    maximum_bytes = number(env, "CUTMY_BACKUP_MAX_BYTES", 4 * 1024**3)
    maximum_age = number(env, "CUTMY_BACKUP_RETENTION_DAYS", 7) * 86400
    backups = []
    deadline = time.monotonic() + number(env, "CUTMY_BACKUP_VERIFY_TIMEOUT", 60)
    for index, entry in enumerate(directory.iterdir()):
        if index >= 1024 or time.monotonic() > deadline:
            raise RuntimeError("Retention scan exceeded its safe bounds")
        if NAME.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink():
            try:
                # Each copy was fully verified before publication. Retention
                # reads the small publisher manifest instead of re-inflating
                # seven days of hourly dumps on every hour. Restore still
                # verifies the full digest/CRC/completeness under a deadline.
                info = backup_manifest(entry, env)
                backups.append((info["created_unix"], entry, info["size_bytes"]))
            except (OSError, ValueError, RuntimeError):
                continue  # Never delete unrecognised or corrupt operator files.
    backups.sort(reverse=True)
    total = 0
    for index, (created, entry, size) in enumerate(backups):
        total += size
        if index and (index >= maximum_count or total > maximum_bytes or created < time.time() - maximum_age):
            shutil.rmtree(entry)
    fsync_directory(directory)


def remote_copy(directory, env):
    target = env.get("CUTMY_BACKUP_REMOTE_TARGET", "")
    remote_dir = env.get("CUTMY_BACKUP_REMOTE_DIR", "")
    if not target and not remote_dir:
        return False
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+", target) or not re.fullmatch(r"/[a-zA-Z0-9_./-]+", remote_dir) or ".." in remote_dir.split("/"):
        raise RuntimeError("Invalid remote backup destination")
    key = env.get("CUTMY_BACKUP_SSH_KEY", "")
    if not key or not Path(key).is_file():
        raise RuntimeError("Remote backup identity is missing")
    import shlex
    ssh = ["ssh", "-i", key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15"]
    incoming = remote_dir.rstrip("/") + "/.incoming-" + directory.name
    destination = remote_dir.rstrip("/") + "/" + directory.name
    command(["rsync", "--archive", "--protect-args", "--delay-updates", "--timeout=60", "-e", shlex.join(ssh), str(directory) + "/", target + ":" + incoming + "/"], timeout=number(env, "CUTMY_BACKUP_REMOTE_TIMEOUT", 300), stdout=subprocess.DEVNULL)
    digest = validate_backup(directory, env)["sha256"]
    command([*ssh, target, "cd " + incoming + " && printf '%s  database.sql.gz\\n' " + digest + " | sha256sum --check && test ! -e " + destination + " && mv " + incoming + " " + destination], timeout=60, stdout=subprocess.DEVNULL)
    return True


def backup(env):
    directory = Path(env.get("CUTMY_BACKUP_DIR", "/opt/cutmy/backups"))
    shared = Path(env.get("CUTMY_SHARED_DIR", "/opt/cutmy/shared"))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with lock(shared / "backup.lock"):
        for stale in directory.glob(".partial-*"):
            if stale.is_dir() and not stale.is_symlink() and re.fullmatch(r"\.partial-[a-z0-9_]{8}", stale.name):
                shutil.rmtree(stale)
        with lock(shared / "deployment.lock", shared=True):
            temporary = Path(tempfile.mkdtemp(prefix=".partial-", dir=directory))
            try:
                dump = temporary / "database.sql.gz"
                sql_size = dump_gzip(env, dump)
                with dump.open("rb") as handle:
                    hasher = hashlib.sha256()
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        hasher.update(chunk)
                    digest = hasher.hexdigest()
                now = time.time()
                manifest = {"format": 1, "created_unix": now, "created_at": dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(), "size_bytes": dump.stat().st_size, "sql_size_bytes": sql_size, "sha256": digest, "media_included": False}
                atomic_json(temporary / "manifest.json", manifest)
                with (temporary / "checksum.sha256").open("w") as checksum:
                    checksum.write(digest + "  database.sql.gz\n")
                    checksum.flush()
                    os.fsync(checksum.fileno())
                validate_backup(temporary, env)
                stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                published = directory / ("database-" + stamp + "-" + uuid.uuid4().hex[:8])
                os.rename(temporary, published)
                fsync_directory(directory)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        # A remote outage must not discard a successful local snapshot.
        retain(directory, env)
        atomic_json(shared / "backup-status.json", {"local_created_unix": now, "remote_verified_unix": None, "remote_configured": bool(env.get("CUTMY_BACKUP_REMOTE_TARGET")), "backup": published.name})
        remote = remote_copy(published, env)
        atomic_json(shared / "backup-status.json", {"local_created_unix": now, "remote_verified_unix": time.time() if remote else None, "remote_configured": bool(env.get("CUTMY_BACKUP_REMOTE_TARGET")), "backup": published.name})
        print(json.dumps({"backup": published.name, "sha256": digest, "remote_verified": remote}))


def verify_restore(directory, env, simulate_media_loss=False):
    started = time.monotonic()
    manifest = validate_backup(directory, env)
    identity = uuid.uuid4().hex
    name = "cutmy-restore-drill-" + identity[:12]
    try:
        command(["docker", "run", "-d", "--name", name, "--label", "cutmy.restore-drill=" + identity, "--network", "none", "--memory", "768m", "--cpus", "1", "--pids-limit", "128", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_USER=cutmy", "-e", "POSTGRES_DB=cutmy", PG_IMAGE], stdout=subprocess.DEVNULL)
        for _ in range(60):
            result = subprocess.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "cutmy", "-d", "cutmy"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if result.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Restore database did not become ready")
        with tempfile.TemporaryDirectory(prefix="cutmy-restore-") as temporary:
            sql = Path(temporary) / "database.sql"
            with gzip.open(Path(directory) / "database.sql.gz", "rb") as source, sql.open("wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            with sql.open("rb") as source:
                command(["docker", "exec", "-i", name, "psql", "-U", "cutmy", "-d", "cutmy", "-v", "ON_ERROR_STOP=1", "-q"], timeout=number(env, "CUTMY_RESTORE_TIMEOUT", 600), stdin=source, stdout=subprocess.DEVNULL)
        query = "SELECT json_build_object('sources',(SELECT count(*) FROM sources),'jobs',(SELECT count(*) FROM jobs),'artifacts',(SELECT count(*) FROM artifacts),'invalid_owners',(SELECT count(*) FROM jobs j JOIN sources s ON j.source_id=s.id WHERE j.owner<>s.owner)+(SELECT count(*) FROM artifacts a JOIN jobs j ON a.job_id=j.id WHERE a.owner<>j.owner));"
        result = command(["docker", "exec", name, "psql", "-U", "cutmy", "-d", "cutmy", "-At", "-v", "ON_ERROR_STOP=1", "-c", query], stdout=subprocess.PIPE)
        counts = json.loads(result.stdout)
        if counts["invalid_owners"]:
            raise RuntimeError("Restored ownership consistency check failed")
        report = {"sha256": manifest["sha256"], "counts": counts, "restore_seconds": round(time.monotonic() - started, 3), "media_restored": False}
        if simulate_media_loss:
            sql = Path(__file__).with_name("recover-database-only.sql").read_bytes()
            command(["docker", "exec", "-i", name, "psql", "-U", "cutmy", "-d", "cutmy", "-v", "ON_ERROR_STOP=1", "-q"], timeout=60, input=sql, stdout=subprocess.DEVNULL)
            check = "SELECT json_build_object('remaining_sources',(SELECT count(*) FROM sources),'remaining_jobs',(SELECT count(*) FROM jobs),'invalid_sources',(SELECT count(*) FROM sources WHERE kind NOT IN ('platform','youtube') OR path<>'' OR thumbnail_path<>''),'artifacts',(SELECT count(*) FROM artifacts),'active_jobs',(SELECT count(*) FROM jobs WHERE status IN ('queued','waiting_storage','running')));"
            result = command(["docker", "exec", name, "psql", "-U", "cutmy", "-d", "cutmy", "-At", "-c", check], stdout=subprocess.PIPE)
            recovered = json.loads(result.stdout)
            if recovered["invalid_sources"] or recovered["artifacts"] or recovered["active_jobs"]:
                raise RuntimeError("Database-only recovery left unavailable resources")
            report["database_only_recovery"] = recovered
            report["recovery_total_seconds"] = round(time.monotonic() - started, 3)
        print(json.dumps(report))
        return report
    finally:
        inspected = subprocess.run(["docker", "inspect", name, "--format", '{{ index .Config.Labels "cutmy.restore-drill" }}'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        if inspected.returncode == 0 and inspected.stdout.decode().strip() == identity:
            removed = subprocess.run(["docker", "rm", "-f", "-v", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            if removed.returncode:
                raise RuntimeError("Owned restore database cleanup failed")


def snapshot(env):
    query = "SELECT json_build_object('queued',(SELECT count(*) FROM jobs WHERE status='queued'),'waiting_storage',(SELECT count(*) FROM jobs WHERE status='waiting_storage'),'running',(SELECT count(*) FROM jobs WHERE status='running'),'oldest_queue_seconds',coalesce((SELECT extract(epoch FROM now()-min(created_at)) FROM jobs WHERE status IN ('queued','waiting_storage')),0),'expired_storage_waits',(SELECT count(*) FROM jobs WHERE status IN ('queued','waiting_storage') AND storage_wait_until<=now()),'expired_leases',(SELECT count(*) FROM jobs WHERE status='running' AND lease_until<now()));"
    result = command([*compose(env), "exec", "-T", "postgres", "psql", "-U", "cutmy", "-d", "cutmy", "-At", "-c", query], timeout=15, stdout=subprocess.PIPE)
    value = json.loads(result.stdout)
    result = command([*compose(env), "ps", "--format", "json"], timeout=15, stdout=subprocess.PIPE)
    text = result.stdout.decode().strip()
    services = json.loads(text) if text.startswith("[") else [json.loads(line) for line in text.splitlines() if line]
    unhealthy = {row.get("Service", "unknown") for row in services if row.get("State") != "running" or row.get("Health") not in ("healthy", "")}
    required = {"postgres", "api", "worker", "web", "edge"}
    value["unhealthy_services"] = sorted(unhealthy | (required - {row.get("Service") for row in services}))
    filesystem = os.statvfs(env.get("CUTMY_MEDIA_PATH", "/var/lib/docker/volumes/cutmy-media/_data"))
    value["free_bytes"] = filesystem.f_bavail * filesystem.f_frsize
    value["disk_used_percent"] = round(100 * (1 - filesystem.f_bavail / filesystem.f_blocks), 2) if filesystem.f_blocks else 100
    backup_dir = Path(env.get("CUTMY_BACKUP_DIR", "/opt/cutmy/backups"))
    latest = None
    if backup_dir.exists():
        deadline = time.monotonic() + number(env, "CUTMY_BACKUP_VERIFY_TIMEOUT", 60)
        for index, entry in enumerate(backup_dir.iterdir()):
            if index >= 1024 or time.monotonic() > deadline:
                raise RuntimeError("Backup age inspection exceeded its safe bounds")
            if NAME.fullmatch(entry.name) and not entry.is_symlink():
                try:
                    manifest = backup_manifest(entry, env)
                    latest = max(latest or 0, manifest["created_unix"])
                except (OSError, ValueError, RuntimeError):
                    pass
    value["backup_age_seconds"] = time.time() - latest if latest else None
    status = Path(env.get("CUTMY_SHARED_DIR", "/opt/cutmy/shared")) / "backup-status.json"
    if env.get("CUTMY_BACKUP_REMOTE_TARGET"):
        try:
            verified = json.loads(status.read_text()).get("remote_verified_unix")
        except (OSError, ValueError):
            verified = None
        value["remote_backup_age_seconds"] = time.time() - verified if verified else None
    return value


def alert_keys(value, env):
    alerts = []
    if value.get("inspection_error"):
        return ["inspection_failed"]
    if value["unhealthy_services"]:
        alerts.append("unhealthy_services:" + ",".join(value["unhealthy_services"]))
    if value["free_bytes"] < number(env, "CUTMY_ALERT_MIN_FREE_BYTES", 10 * 1024**3) or value["disk_used_percent"] >= number(env, "CUTMY_ALERT_DISK_PERCENT", 85):
        alerts.append("disk_pressure")
    if value["oldest_queue_seconds"] > number(env, "CUTMY_ALERT_QUEUE_SECONDS", 600):
        alerts.append("queue_delay")
    if value["expired_leases"]:
        alerts.append("expired_worker_lease")
    if value.get("waiting_storage", 0):
        alerts.append("storage_waiting")
    if value.get("expired_storage_waits", 0):
        alerts.append("storage_wait_deadline")
    limit = number(env, "CUTMY_ALERT_BACKUP_SECONDS", 2 * 3600)
    if value["backup_age_seconds"] is None or value["backup_age_seconds"] > limit:
        alerts.append("backup_stale")
    if "remote_backup_age_seconds" in value and (value["remote_backup_age_seconds"] is None or value["remote_backup_age_seconds"] > limit):
        alerts.append("remote_backup_stale")
    return sorted(alerts)


def monitor(env):
    shared = Path(env.get("CUTMY_SHARED_DIR", "/opt/cutmy/shared"))
    with lock(shared / "monitor.lock"), lock(shared / "deployment.lock", shared=True):
        try:
            value = snapshot(env)
        except (RuntimeError, OSError, ValueError):
            value = {"inspection_error": True}
        alerts = alert_keys(value, env)
        state_path = shared / "monitor-state.json"
        try:
            previous = json.loads(state_path.read_text())
        except (OSError, ValueError):
            previous = {"alerts": []}
        if not isinstance(previous, dict) or not isinstance(previous.get("alerts"), list):
            previous = {"alerts": []}
        event = {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "alerts": alerts, "previous_alerts": previous.get("alerts", []), "metrics": value}
        changed = alerts != previous.get("alerts", [])
        if changed:
            hook = env.get("CUTMY_ALERT_HOOK", "")
            if hook:
                if not Path(hook).is_absolute() or not os.access(hook, os.X_OK):
                    raise RuntimeError("Alert adapter must be an absolute executable")
                command([hook], timeout=15, input=json.dumps(event).encode(), stdout=subprocess.DEVNULL)
            with (shared / "monitor-events.jsonl").open("a") as output:
                output.write(json.dumps(event) + "\n")
            events = shared / "monitor-events.jsonl"
            if events.stat().st_size > 1024 * 1024:
                os.replace(events, shared / "monitor-events.previous.jsonl")
        # If notification fails, leave previous state intact and retry later.
        atomic_json(state_path, {"alerts": alerts, "metrics": value, "checked_unix": time.time()})
        if changed:
            print(json.dumps(event))
        return 1 if alerts else 0


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("backup", "verify-backup", "verify-restore", "monitor", "maintain"))
    parser.add_argument("directory", nargs="?")
    parser.add_argument("--simulate-media-loss", action="store_true", help="Exercise missing-media recovery in the disposable restored database")
    args = parser.parse_args()
    env = config()
    if args.action == "backup":
        backup(env)
    elif args.action == "monitor":
        return monitor(env)
    elif args.action == "maintain":
        maintain(env)
    else:
        if not args.directory:
            parser.error("directory is required")
        if args.action == "verify-backup":
            print(json.dumps(validate_backup(args.directory, env)))
        else:
            verify_restore(args.directory, env, args.simulate_media_loss)
    return 0


def maintain(env):
    shared = Path(env.get("CUTMY_SHARED_DIR", "/opt/cutmy/shared"))
    with lock(shared / "maintenance.lock"), lock(shared / "deployment.lock", shared=True):
        command([*compose(env), "exec", "-T", "api", "/usr/local/bin/cutmy", "maintenance"], timeout=20, stdout=subprocess.DEVNULL)
        atomic_json(shared / "maintenance-status.json", {"completed_unix": time.time()})


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise RuntimeError("Operator task interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(str(error) if isinstance(error, RuntimeError) else "Operator task failed validation or I/O", file=sys.stderr)
        sys.exit(1)
