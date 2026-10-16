#!/usr/bin/env python3
"""Private point-in-time database/media recovery while activation holds its lock.

This is separate from hourly database-only backups. No Docker volume is removed.
Writers and the edge must remain stopped until activation commits or restores.
"""
from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

import operations
from database_access import APP_ROLE, DatabaseAccess, PsqlTransport, operator_credentials

MEMBERS = {"database", "media", "manifest.json", "manifest.sha256", "production.env"}
MAX_MANIFEST = 64 * 1024 * 1024
VOLUME_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


class SnapshotError(RuntimeError):
    """Only fixed secret-free codes may leave this module's CLI."""


def require_lock(shared: Path, descriptor: int = 9) -> None:
    try:
        lock = (shared / "deployment.lock").lstat()
        held = os.fstat(descriptor)
        if (not stat.S_ISREG(lock.st_mode) or lock.st_uid != os.geteuid() or
                (lock.st_dev, lock.st_ino) != (held.st_dev, held.st_ino)):
            raise SnapshotError("deployment_lock_identity_invalid")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ValueError) as error:
        raise SnapshotError("deployment_lock_required") from error


def checked_directory(path: Path, private: bool = False) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink():
        raise SnapshotError("snapshot_directory_invalid")
    if private and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077):
        raise SnapshotError("snapshot_directory_not_private")


def digest_file(path: Path) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise SnapshotError("snapshot_file_identity_invalid")
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


def relative_path(value: object) -> Path:
    if not isinstance(value, str) or len(value) > 4096 or "\\" in value:
        raise SnapshotError("snapshot_path_invalid")
    path = Path(value)
    if path.is_absolute() or not value or any(part in ("", ".", "..") for part in value.split("/")):
        raise SnapshotError("snapshot_path_invalid")
    return path


def metadata(info: os.stat_result) -> dict:
    return {"mode": stat.S_IMODE(info.st_mode) & 0o777, "uid": info.st_uid, "gid": info.st_gid}


class DeploymentSnapshot:
    def __init__(self, env: dict[str, str], *, lock_fd: int = 9,
                 transport: PsqlTransport | None = None):
        self.env, self.lock_fd = env, lock_fd
        self.shared = Path(env.get("CUTMY_SHARED_DIR", "/opt/cutmy/shared"))
        self.transport = transport or PsqlTransport(Path(env.get("CUTMY_ENV_FILE", str(self.shared / "production.env"))), Path(env.get("CUTMY_DEPLOY_DIR", "/opt/cutmy/current/web/deploy")))
        self.limit_files = operations.number(env, "CUTMY_DEPLOY_SNAPSHOT_MAX_FILES", 200000)
        self.limit_bytes = operations.number(env, "CUTMY_DEPLOY_SNAPSHOT_MAX_BYTES", 128 * 1024**3)

    def stopped(self) -> None:
        require_lock(self.shared, self.lock_fd)
        result = operations.command([*operations.compose(self.env), "ps", "--all", "--format", "json"], timeout=30, stdout=subprocess.PIPE)
        text = result.stdout.decode().strip()
        rows = json.loads(text) if text.startswith("[") else [json.loads(line) for line in text.splitlines() if line]
        if not isinstance(rows, list) or any(row.get("Service") in {"edge", "api", "worker"} and row.get("State") not in {"exited", "dead", "created", "stopped"} for row in rows):
            raise SnapshotError("deployment_writers_must_be_stopped")

    def volumes(self) -> dict:
        result = operations.command([*operations.compose(self.env), "config", "--format", "json"], stdout=subprocess.PIPE)
        config = json.loads(result.stdout)
        result = {}
        for key in ("media", "database"):
            name = config.get("volumes", {}).get(key, {}).get("name")
            if not isinstance(name, str) or not VOLUME_NAME.fullmatch(name):
                raise SnapshotError("deployment_volume_name_invalid")
            inspected = operations.command(["docker", "volume", "inspect", name], stdout=subprocess.PIPE)
            rows = json.loads(inspected.stdout)
            if len(rows) != 1 or rows[0].get("Name") != name or rows[0].get("Driver") != "local":
                raise SnapshotError("deployment_volume_identity_invalid")
            path = Path(rows[0].get("Mountpoint", ""))
            if not path.is_absolute() or path.name != "_data" or path.parent.name != name:
                raise SnapshotError("deployment_volume_path_invalid")
            checked_directory(path)
            if path != path.resolve():
                raise SnapshotError("deployment_volume_path_invalid")
            info = path.stat()
            created = rows[0].get("CreatedAt")
            if not isinstance(created, str) or not 1 <= len(created) <= 128:
                raise SnapshotError("deployment_volume_identity_invalid")
            result[key] = {"name": name, "path": str(path), "created_at": created, "mount_dev": info.st_dev, "mount_ino": info.st_ino}
        return result

    def ledger(self) -> list:
        value = json.loads(self.transport.query(APP_ROLE, "SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)::text FROM (SELECT position,version,checksum FROM public.app_schema_migrations ORDER BY position) t;"))
        if not isinstance(value, list) or not 1 <= len(value) <= 128:
            raise SnapshotError("deployment_schema_identity_invalid")
        return value

    def scan(self, root: Path, *, hashes: bool) -> list[dict]:
        checked_directory(root)
        result, total = [], 0
        stack = [root]
        while stack:
            directory = stack.pop()
            for entry in directory.iterdir():
                info = entry.lstat()
                row = {"path": entry.relative_to(root).as_posix(), **metadata(info)}
                relative_path(row["path"])
                if stat.S_ISDIR(info.st_mode):
                    row["kind"] = "directory"
                    stack.append(entry)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    row.update(kind="file", size_bytes=info.st_size)
                    total += info.st_size
                    if hashes:
                        row["sha256"] = digest_file(entry)
                else:
                    raise SnapshotError("deployment_media_links_or_special_files")
                result.append(row)
                if len(result) > self.limit_files or total > self.limit_bytes:
                    raise SnapshotError("deployment_media_budget_exceeded")
        return sorted(result, key=lambda row: row["path"])

    def copy_file(self, source: Path, destination: Path, expected_size: int) -> str:
        descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            output_descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except BaseException:
            os.close(descriptor)
            raise
        with os.fdopen(descriptor, "rb") as input_file, os.fdopen(output_descriptor, "wb") as output:
            before = os.fstat(input_file.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != expected_size:
                raise SnapshotError("deployment_media_changed")
            digest, total = hashlib.sha256(), 0
            for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
                total += len(chunk)
                if total > expected_size:
                    raise SnapshotError("deployment_media_changed")
                digest.update(chunk)
                output.write(chunk)
            after = os.fstat(input_file.fileno())
            if total != expected_size or before.st_mtime_ns != after.st_mtime_ns or before.st_ino != after.st_ino:
                raise SnapshotError("deployment_media_changed")
            output.flush()
            os.fsync(output.fileno())
        return digest.hexdigest()

    def capture(self, directory: Path) -> dict:
        self.stopped()
        checked_directory(directory, private=True)
        if any(directory.iterdir()):
            raise SnapshotError("deployment_snapshot_not_empty")
        release = self.env.get("RELEASE_TAG", "")
        if not re.fullmatch(r"[0-9a-f]{12}-[0-9a-f]{12}", release):
            raise SnapshotError("deployment_release_identity_invalid")
        environment = Path(self.env.get("CUTMY_ENV_FILE", str(self.shared / "production.env")))
        if environment.stat().st_size > 256 * 1024:
            raise SnapshotError("deployment_environment_budget_exceeded")
        environment_digest = self.copy_file(environment, directory / "production.env", environment.stat().st_size)
        volumes = self.volumes()
        media = Path(volumes["media"]["path"])
        if directory.resolve().is_relative_to(media) or media.is_relative_to(directory.resolve()):
            raise SnapshotError("deployment_snapshot_overlaps_media")
        rows = self.scan(media, hashes=False)
        size = sum(row.get("size_bytes", 0) for row in rows)
        reserve = operations.number(self.env, "CUTMY_DEPLOY_SNAPSHOT_MIN_FREE_BYTES", 512 * 1024**2)
        if shutil.disk_usage(directory).free < size + reserve:
            raise SnapshotError("deployment_snapshot_insufficient_space")
        database = directory / "database"
        database.mkdir(mode=0o700)
        dump = database / "database.sql.gz"
        before = self.ledger()
        sql_size = operations.dump_gzip(self.env, dump)
        os.chmod(dump, 0o600)
        digest = digest_file(dump)
        now = time.time()
        operations.atomic_json(database / "manifest.json", {"format": 1, "created_unix": now, "size_bytes": dump.stat().st_size, "sql_size_bytes": sql_size, "sha256": digest, "media_included": False})
        (database / "checksum.sha256").write_text(digest + "  database.sql.gz\n")
        operations.validate_backup(database, self.env)
        if before != self.ledger():
            raise SnapshotError("deployment_schema_changed_during_snapshot")
        saved = directory / "media"
        saved.mkdir(mode=0o700)
        for row in rows:
            target = saved / row["path"]
            if row["kind"] == "directory":
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                row["sha256"] = self.copy_file(media / row["path"], target, row["size_bytes"])
        for row in sorted(rows, key=lambda row: len(Path(row["path"]).parts), reverse=True):
            if row["kind"] == "directory":
                operations.fsync_directory(saved / row["path"])
        operations.fsync_directory(saved)
        # Verify before the complete marker. Paths, hashes and file count are
        # checked again immediately before a rollback can destroy new data.
        self.stopped()
        manifest = {"format": 1, "media_included": True, "complete": True, "created_unix": now, "release": release, "environment_sha256": environment_digest, "volumes": volumes, "media_root": metadata(media.stat()), "media": rows, "media_size_bytes": size, "schema": before, "database_sha256": digest}
        encoded = json.dumps(manifest, sort_keys=True).encode()
        if len(encoded) > MAX_MANIFEST:
            raise SnapshotError("deployment_manifest_budget_exceeded")
        operations.atomic_json(directory / "manifest.json", manifest)
        (directory / "manifest.sha256").write_text(digest_file(directory / "manifest.json") + "\n")
        for path in (database / "checksum.sha256", directory / "manifest.sha256"):
            with path.open("rb") as file:
                os.fsync(file.fileno())
        for path in (database, saved, directory):
            operations.fsync_directory(path)
        self.verify(directory)
        return {"ok": True, "media_included": True, "files": sum(row["kind"] == "file" for row in rows), "media_size_bytes": size, "database_sha256": digest}

    def verify(self, directory: Path) -> dict:
        checked_directory(directory, private=True)
        if {path.name for path in directory.iterdir()} != MEMBERS:
            raise SnapshotError("deployment_snapshot_members_invalid")
        checked_directory(directory / "database", private=True)
        checked_directory(directory / "media", private=True)
        checksum = directory / "manifest.sha256"
        info = checksum.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != 65:
            raise SnapshotError("deployment_manifest_checksum_invalid")
        path = directory / "manifest.json"
        if path.stat().st_size > MAX_MANIFEST or (directory / "manifest.sha256").read_text() != digest_file(path) + "\n":
            raise SnapshotError("deployment_manifest_checksum_mismatch")
        manifest = json.loads(path.read_text())
        if manifest.get("format") != 1 or manifest.get("media_included") is not True or manifest.get("complete") is not True:
            raise SnapshotError("deployment_snapshot_incomplete")
        if manifest.get("volumes") != self.volumes():
            raise SnapshotError("deployment_snapshot_volume_changed")
        if not re.fullmatch(r"[0-9a-f]{12}-[0-9a-f]{12}", manifest.get("release", "")) or digest_file(directory / "production.env") != manifest.get("environment_sha256"):
            raise SnapshotError("deployment_environment_checksum_mismatch")
        backup = operations.validate_backup(directory / "database", self.env)
        if backup["sha256"] != manifest.get("database_sha256"):
            raise SnapshotError("deployment_database_checksum_mismatch")
        rows = manifest.get("media")
        if not isinstance(rows, list) or len(rows) > self.limit_files:
            raise SnapshotError("deployment_manifest_media_invalid")
        actual = self.scan(directory / "media", hashes=True)
        expected = []
        for row in rows:
            if not isinstance(row, dict):
                raise SnapshotError("deployment_manifest_media_invalid")
            relative_path(row.get("path"))
            if any(type(row.get(key)) is not int or row[key] < 0 for key in ("uid", "gid", "mode")) or row["mode"] > 0o777:
                raise SnapshotError("deployment_manifest_media_invalid")
            expected.append({key: value for key, value in row.items() if key not in {"uid", "gid", "mode"}})
        stripped = [{key: value for key, value in row.items() if key not in {"uid", "gid", "mode"}} for row in actual]
        if stripped != expected or sum(row.get("size_bytes", 0) for row in actual) != manifest.get("media_size_bytes"):
            raise SnapshotError("deployment_media_checksum_mismatch")
        root = manifest.get("media_root")
        if not isinstance(root, dict) or set(root) != {"uid", "gid", "mode"} or any(type(root[key]) is not int or root[key] < 0 for key in root) or root["mode"] > 0o777:
            raise SnapshotError("deployment_media_metadata_invalid")
        return manifest

    def restore_database(self, directory: Path) -> None:
        # Read or create the same private operator identity used by activation;
        # no password, SQL text or PostgreSQL stderr is allowed in diagnostics.
        operator_credentials(self.shared)
        access = DatabaseAccess(self.shared, self.transport)
        actor = next((role for role in ("cutmy_operator", APP_ROLE, "postgres") if access.role_is_admin(role)), None)
        if actor is None:
            raise SnapshotError("deployment_database_admin_unavailable")
        with tempfile.TemporaryDirectory(prefix=".deployment-restore-", dir=self.shared) as temporary:
            sql = Path(temporary) / "database.sql"
            schema_created = False
            tail = b""
            with gzip.open(directory / "database/database.sql.gz", "rb") as source, sql.open("wb") as output:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    schema_created = schema_created or b"\nCREATE SCHEMA public;\n" in tail + chunk
                    tail = chunk[-128:]
                    output.write(chunk)
            script = Path(temporary) / "restore.sql"
            with script.open("wb") as output:
                output.write(b"DROP SCHEMA public CASCADE;\n")
                if not schema_created:
                    output.write(b"CREATE SCHEMA public AUTHORIZATION cutmy;\n")
                output.write(b"SET ROLE cutmy;\n")
                with sql.open("rb") as source:
                    shutil.copyfileobj(source, output, 1024 * 1024)
            with script.open("rb") as source:
                operations.command([*self.transport.prefix, "psql", "-X", "-q", "-h", "/var/run/postgresql", "-U", actor, "-d", "cutmy", "-v", "ON_ERROR_STOP=1", "--single-transaction"], timeout=operations.number(self.env, "CUTMY_RESTORE_TIMEOUT", 600), stdin=source, stdout=subprocess.DEVNULL)

    def restore(self, directory: Path) -> dict:
        self.stopped()
        manifest = self.verify(directory)
        media = Path(manifest["volumes"]["media"]["path"])
        self.restore_database(directory)
        if self.ledger() != manifest["schema"]:
            raise SnapshotError("deployment_restored_schema_mismatch")
        self.stopped()
        # Keep the named volume and its mountpoint. Only its contents return to
        # the verified pre-migration point while every writer remains stopped.
        for entry in media.iterdir():
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        for row in manifest["media"]:
            target = media / row["path"]
            if row["kind"] == "directory":
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                if self.copy_file(directory / "media" / row["path"], target, row["size_bytes"]) != row["sha256"]:
                    raise SnapshotError("deployment_restored_media_mismatch")
        for row in reversed(manifest["media"]):
            target = media / row["path"]
            os.chown(target, row["uid"], row["gid"], follow_symlinks=False)
            os.chmod(target, row["mode"], follow_symlinks=False)
            if row["kind"] == "directory":
                operations.fsync_directory(target)
            else:
                with target.open("rb") as file:
                    os.fsync(file.fileno())
        root = manifest["media_root"]
        os.chown(media, root["uid"], root["gid"])
        os.chmod(media, root["mode"])
        restored = self.scan(media, hashes=True)
        if restored != manifest["media"]:
            raise SnapshotError("deployment_restored_media_mismatch")
        operations.fsync_directory(media)
        self.stopped()
        return {"ok": True, "media_restored": True, "schema_restored": True, "media_size_bytes": manifest["media_size_bytes"]}


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("capture", "restore", "verify"))
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    env = dict(os.environ)
    helper = DeploymentSnapshot(env)
    require_lock(helper.shared)
    with operations.wall_deadline(operations.number(env, "CUTMY_DEPLOY_SNAPSHOT_TIMEOUT", 1200)):
        result = getattr(helper, arguments.action)(arguments.directory)
    print(json.dumps(result if arguments.action != "verify" else {"ok": True, "media_included": True}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        print("Coordinated deployment snapshot failed; writers must remain stopped until recovery is verified.", file=sys.stderr)
        sys.exit(1)
