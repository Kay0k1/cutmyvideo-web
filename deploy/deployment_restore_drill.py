#!/usr/bin/env python3
"""Real PostgreSQL + named-volume recovery gate, using only owned synthetic data.

Creates a unique Compose project with no network/ports; verifies ownership before
removing only that project's disposable container and volumes. No production
configuration, connection or media is read. No test is skipped when invoked.
"""
from __future__ import annotations
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid

import operations
from database_access import APP_ROLE, DatabaseAccess, PsqlTransport, sql_literal
from deployment_snapshot import DeploymentSnapshot, SnapshotError


MIGRATIONS = (
    ("001_20261005_storage_queue_v3.sql", "20261005-storage-queue-v3"),
    ("002_20261010_ordered_migrations_v1.sql", "20261010-ordered-migrations-v1"),
    ("003_20261010_storage_maintenance_v1.sql", "20261010-storage-maintenance-v1"),
    ("004_20261010_cache_retention_v1.sql", "20261010-cache-retention-v1"),
    ("005_20261011_source_retention_v1.sql", "20261011-source-retention-v1"),
    ("006_20261012_source_media_cleanup_v1.sql", "20261012-source-media-cleanup-v1"),
    ("007_20261014_metadata_resolution_leases_v1.sql", "20261014-metadata-resolution-leases-v1"),
    ("008_20261016_agent_projects_v1.sql", "20261016-agent-projects-v1"),
)


def migrations(core: Path) -> list[dict]:
    directory = core / "internal/app/migrations"
    result = []
    for filename, version in MIGRATIONS:
        path = directory / filename
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size < 128 * 1024:
            raise RuntimeError("actual_migration_source_required")
        # Matches canonicalMigrationSQL in core, including native CRLF archives.
        text = path.read_bytes().replace(b"\r\n", b"\n").decode("utf-8")
        result.append({"version": version, "sql": text, "sha256": hashlib.sha256(text.encode()).hexdigest()})
    return result


def apply_migrations(transport: PsqlTransport, catalog: list[dict], start: int, end: int) -> None:
    statements = ["BEGIN; SET search_path=public;"]
    if start == 0:
        statements.append("CREATE TABLE app_schema_versions(version text PRIMARY KEY);")
    for index in range(start, end):
        row = catalog[index]
        statements.extend([row["sql"], "INSERT INTO app_schema_versions VALUES(" + sql_literal(row["version"]) + ");"])
        if index >= 1:
            for position in range(0 if index == 1 else index, index + 1):
                recorded = catalog[position]
                statements.append("INSERT INTO app_schema_migrations(position,version,checksum) VALUES(" + str(position + 1) + "," + sql_literal(recorded["version"]) + "," + sql_literal(recorded["sha256"]) + ");")
    statements.append("COMMIT;")
    transport.query(APP_ROLE, "\n".join(statements))


def application_rows(transport: PsqlTransport) -> dict:
    tables = json.loads(transport.query(APP_ROLE, "SELECT json_agg(c.relname ORDER BY c.relname)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p');"))
    result = {}
    for table in tables:
        if not isinstance(table, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", table):
            raise RuntimeError("unexpected_application_table_identifier")
        # Enumerate every application table, including migration008 grants and
        # reservations. Compare logical values: restore legitimately changes OIDs.
        result[table] = json.loads(transport.query(APP_ROLE, "SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(t) AS row FROM public." + table + " t) q;"))
    return result


def catalog_shape(transport: PsqlTransport) -> dict:
    expressions = {
        "columns": "SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS default_expression FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped",
        "constraints": "SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'",
        "indexes": "SELECT c.relname,pg_get_indexdef(c.oid) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i'",
        "triggers": "SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal",
        "functions": "SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'",
    }
    return {name: json.loads(transport.query(APP_ROLE, "SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb)::text FROM (SELECT to_jsonb(t) AS row FROM (" + sql + ") t) q;")) for name, sql in expressions.items()}


def server_probe(prefix: list[str], binary: Path, name: str, *, compatible: bool) -> None:
    if binary.is_symlink() or not binary.is_file():
        raise RuntimeError("actual_core_binary_required")
    operations.command([*prefix, "cp", str(binary), "postgres:/tmp/" + name], stdout=subprocess.DEVNULL)
    script = """set -eu
export DATABASE_URL="postgres://cutmy:${POSTGRES_PASSWORD}@127.0.0.1:5432/cutmy?sslmode=disable"
export DATA_DIR=/fixture-media
export STORAGE_SAFETY_BYTES=1048576
export LISTEN_ADDR=127.0.0.1:18081
printf '%s\\n' "$$" > /tmp/""" + name + ".pid\nexec /tmp/" + name + " server\n"
    command = [*prefix, "exec", "-T", "postgres", "sh"]
    if not compatible:
        result = subprocess.run(command, input=script.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if result.returncode == 0 or b"database schema is incompatible with this binary" not in result.stderr:
            raise RuntimeError("old_core_did_not_refuse_actual_008")
        return
    with tempfile.TemporaryFile() as diagnostics:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=diagnostics)
        assert process.stdin is not None
        process.stdin.write(script.encode())
        process.stdin.close()
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("actual_compatible_core_refused_schema")
                check = subprocess.run([*prefix, "exec", "-T", "-e", "LISTEN_ADDR=127.0.0.1:18081", "postgres", "/tmp/" + name, "healthcheck"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
                if check.returncode == 0:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("actual_compatible_core_readiness_failed")
        finally:
            if process.poll() is None:
                result = operations.command([*prefix, "exec", "-T", "postgres", "cat", "/tmp/" + name + ".pid"], stdout=subprocess.PIPE)
                pid = result.stdout.decode().strip()
                if not re.fullmatch(r"[1-9][0-9]{0,8}", pid):
                    raise RuntimeError("owned_drill_core_pid_invalid")
                operations.command([*prefix, "exec", "-T", "postgres", "sh", "-c", 'kill -TERM "$1"', "drill-stop", pid], stdout=subprocess.DEVNULL)
            process.wait(timeout=10)


def run(image: str, core: Path, old_binary: Path, new_binary: Path) -> dict:
    catalog = migrations(core)
    identity = "cutmy-snapshot-drill-" + uuid.uuid4().hex[:12]
    project = identity.replace("-", "")
    started = False
    with tempfile.TemporaryDirectory(prefix=identity + "-") as temporary:
        root = Path(temporary)
        shared = root / "shared"
        shared.mkdir(mode=0o700)
        environment = shared / "production.env"
        environment.write_text("RELEASE_TAG=" + "a" * 12 + "-" + "b" * 12 + "\n")
        environment.chmod(0o600)
        deploy = root / "deploy"
        deploy.mkdir()
        compose_path = deploy / "compose.yaml"
        # JSON is valid YAML. The selected image must already be available
        # locally for manual drills; CI has just used this same pinned image.
        compose_path.write_text(json.dumps({"name": project, "services": {"postgres": {"image": image, "pull_policy": "never", "network_mode": "none", "environment": {"POSTGRES_USER": "cutmy", "POSTGRES_DB": "cutmy", "POSTGRES_HOST_AUTH_METHOD": "trust", "POSTGRES_PASSWORD": "synthetic_drill_only"}, "volumes": ["database:/var/lib/postgresql/data", "media:/fixture-media"], "healthcheck": {"test": ["CMD", "pg_isready", "-U", "cutmy", "-d", "cutmy"], "interval": "1s", "timeout": "3s", "retries": 60}}}, "volumes": {"database": {"name": identity + "-database"}, "media": {"name": identity + "-media"}}}))
        env = dict(os.environ) | {"CUTMY_SHARED_DIR": str(shared), "CUTMY_ENV_FILE": str(environment), "CUTMY_DEPLOY_DIR": str(deploy), "RELEASE_TAG": "a" * 12 + "-" + "b" * 12, "CUTMY_DEPLOY_SNAPSHOT_MIN_FREE_BYTES": "1048576", "CUTMY_BACKUP_MAX_SQL_BYTES": "67108864"}
        prefix = operations.compose(env)
        try:
            started = True
            operations.command([*prefix, "up", "-d", "--wait", "--wait-timeout", "90", "postgres"], timeout=100, stdout=subprocess.DEVNULL)
            transport = PsqlTransport(environment, deploy)
            access = DatabaseAccess(shared, transport)
            access.run()
            if access.role_state().get("privileged"):
                raise RuntimeError("synthetic_application_role_not_hardened")
            apply_migrations(transport, catalog, 0, 7)
            server_probe(prefix, old_binary, "cutmy-schema007", compatible=True)
            lock = (shared / "deployment.lock").open("w")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX)
                helper = DeploymentSnapshot(env, lock_fd=lock.fileno(), transport=transport)
                volumes = helper.volumes()
                media = Path(volumes["media"]["path"])
                (media / "sources").mkdir(mode=0o750, exist_ok=True)
                (media / "outputs").mkdir(mode=0o700, exist_ok=True)
                source_bytes, artifact_bytes = b"original synthetic source\x00\xff" * 4096, b"original synthetic result" * 2048
                (media / "sources/source-a.bin").write_bytes(source_bytes)
                (media / "outputs/clip-a.bin").write_bytes(artifact_bytes)
                for path in [media / "sources/source-a.bin", media / "outputs/clip-a.bin"]:
                    path.chmod(0o600)
                    os.chown(path, 65532, 65532)
                request = {"source_id": "source-a", "ranges": [{"start_ms": 1000, "end_ms": 3000, "label": "Original range"}], "format": "mp4", "quality": "720p", "cut_mode": "accurate", "output_mode": "joined"}
                artifact = {"id": "artifact-a", "filename": "clip-a.bin", "size_bytes": len(artifact_bytes), "actual_start_ms": 1000, "actual_end_ms": 3000, "download_url": "/api/v1/artifacts/artifact-a/download"}
                items = [{"id": "item-a", "label": "Original range", "start_ms": 1000, "end_ms": 3000, "status": "succeeded", "artifact": artifact}]
                transport.query(APP_ROLE, """SET search_path=public;
INSERT INTO sources(id,owner,title,duration_ms,kind,path,width,height) VALUES('source-a','owner-a','Original source',10000,'upload','/fixture-media/sources/source-a.bin',640,360);
INSERT INTO jobs(id,owner,source_id,request,items,status,stage,idempotency_key) VALUES('job-a','owner-a','source-a',""" + sql_literal(json.dumps(request)) + "," + sql_literal(json.dumps(items)) + """,'succeeded','done','original-owner-key');
INSERT INTO artifacts(id,owner,job_id,path,filename,size_bytes,actual_start_ms,actual_end_ms,expires_at) VALUES('artifact-a','owner-a','job-a','/fixture-media/outputs/clip-a.bin','clip-a.bin',""" + str(len(artifact_bytes)) + """,1000,3000,clock_timestamp()+interval '1 day');
INSERT INTO storage_files(path,owner,resource_id,kind,size_bytes) VALUES('/fixture-media/sources/source-a.bin','owner-a','source-a','source',""" + str(len(source_bytes)) + "),('/fixture-media/outputs/clip-a.bin','owner-a','artifact-a','artifact'," + str(len(artifact_bytes)) + ");")
                before = application_rows(transport)
                shape_before = catalog_shape(transport)
                if before["storage_counters"][0]["stored_bytes"] != len(source_bytes) + len(artifact_bytes) or before["sources"][0]["retention_job_pins"] != 1:
                    raise RuntimeError("actual_application_triggers_not_present")
                packet = root / "snapshot"
                packet.mkdir(mode=0o700)
                receipt = helper.capture(packet)
                apply_migrations(transport, catalog, 7, 8)
                transport.query(APP_ROLE, """SET search_path=public;
INSERT INTO agent_projects(id,owner,source_id,plan,source_snapshot,rendition,collection_key) VALUES('project-a','owner-a','source-a','{"version":1,"clips":[{"id":"answer","ranges":[{"start_ms":1000,"end_ms":3000}]}]}','{"id":"source-a"}','final','drill-project-key');
INSERT INTO agent_project_jobs(project_id,job_id,clip_id) VALUES('project-a','job-a','answer');
INSERT INTO agent_project_handoffs(token_hash,project_id,recipient,redeemed_at) VALUES(repeat('a',64),'project-a','recipient-a',clock_timestamp());
INSERT INTO agent_project_grants(project_id,recipient) VALUES('project-a','recipient-a');
""")
                fingerprint = {"kind": "content", "sha256": hashlib.sha256(source_bytes).hexdigest(), "size_bytes": len(source_bytes)}
                transport.query(APP_ROLE, "INSERT INTO public.source_fingerprints(source_id,owner,fingerprint) VALUES('source-a','owner-a'," + sql_literal(json.dumps(fingerprint)) + ");")
                server_probe(prefix, new_binary, "cutmy-schema008", compatible=True)
                actual008 = application_rows(transport)
                shape008 = catalog_shape(transport)
                server_probe(prefix, old_binary, "cutmy-schema007", compatible=False)
                if application_rows(transport) != actual008 or catalog_shape(transport) != shape008:
                    raise RuntimeError("old_binary_refusal_changed_database")
                transport.query(APP_ROLE, "UPDATE public.sources SET owner='changed'; UPDATE public.jobs SET request='{}',items='[]',idempotency_key='changed-key'; UPDATE public.artifacts SET filename='changed.bin';")
                (media / "sources/source-a.bin").write_bytes(b"changed after migration")
                (media / "outputs/clip-a.bin").unlink()
                (media / "new-artifact.bin").write_bytes(b"post-migration data")
                restored = helper.restore(packet)
                leftover = transport.query(APP_ROLE, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (c.relname LIKE 'agent_project%' OR c.relname IN ('source_preparations','source_fingerprints'));")
                wrong_owner = transport.query(APP_ROLE, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_get_userbyid(c.relowner)<>'cutmy';")
                if application_rows(transport) != before or catalog_shape(transport) != shape_before or leftover != "0" or wrong_owner != "0":
                    raise RuntimeError("synthetic_database_restore_did_not_match")
                if (media / "sources/source-a.bin").read_bytes() != source_bytes or (media / "outputs/clip-a.bin").read_bytes() != artifact_bytes or (media / "new-artifact.bin").exists():
                    raise RuntimeError("synthetic_media_restore_did_not_match")
                if (media / "sources/source-a.bin").stat().st_uid != 65532 or helper.volumes() != volumes:
                    raise RuntimeError("synthetic_media_identity_did_not_match")
                server_probe(prefix, old_binary, "cutmy-schema007", compatible=True)
                if application_rows(transport) != before or catalog_shape(transport) != shape_before:
                    raise RuntimeError("restored_core_startup_changed_application_data")
                apply_migrations(transport, catalog, 7, 8)
                (packet / "media/sources/source-a.bin").write_bytes(b"corrupt private snapshot")
                refused = False
                try:
                    helper.restore(packet)
                except SnapshotError:
                    refused = True
                if not refused or transport.query(APP_ROLE, "SELECT count(*) FROM public.app_schema_migrations;") != "8" or (media / "sources/source-a.bin").read_bytes() != source_bytes:
                    raise RuntimeError("corrupt_snapshot_not_refused_before_mutation")
                return {"ok": True, "real_postgresql": True, "actual_immutable_migrations": True, "migration_sha256": {str(index + 1).zfill(3): row["sha256"] for index, row in enumerate(catalog)}, "old_binary_sha256": hashlib.sha256(old_binary.read_bytes()).hexdigest(), "new_binary_sha256": hashlib.sha256(new_binary.read_bytes()).hexdigest(), "old_core_refused_008_without_mutation": True, "old_core_accepted_restored_007": True, "application_rows_restored": True, "catalog_definitions_restored": True, "ordinary_application_owner": True, "schema_008_to_007_restored": restored["schema_restored"], "new_schema_objects_removed": True, "media_restored": restored["media_restored"], "persistent_volume_identities_preserved": True, "corrupt_snapshot_refused_before_mutation": True, "files": receipt["files"], "media_size_bytes": receipt["media_size_bytes"], "source_sha256": hashlib.sha256(source_bytes).hexdigest(), "artifact_sha256": hashlib.sha256(artifact_bytes).hexdigest()}
            finally:
                lock.close()
        finally:
            if started:
                # Only the unique project generated above can be removed.
                for name in (identity + "-database", identity + "-media"):
                    inspected = operations.command(["docker", "volume", "inspect", name], stdout=subprocess.PIPE)
                    rows = json.loads(inspected.stdout)
                    if len(rows) != 1 or rows[0].get("Labels", {}).get("com.docker.compose.project") != project:
                        raise RuntimeError("owned_drill_volume_cleanup_refused")
                operations.command([*prefix, "down", "--volumes", "--timeout", "5"], timeout=30, stdout=subprocess.DEVNULL)


def main() -> int:
    os.umask(0o077)
    if os.geteuid() != 0:
        raise RuntimeError("Disposable named-volume ownership checks require root")
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default=operations.PG_IMAGE)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--core-dir", type=Path, default=Path(os.environ.get("CUTMY_CORE_DIR", str(Path(__file__).resolve().parents[2] / "core"))))
    parser.add_argument("--old-binary", type=Path, required=True)
    parser.add_argument("--new-binary", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.image, args.core_dir, args.old_binary, args.new_binary)
    if args.output:
        operations.atomic_json(args.output, result)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        print("Disposable deployment restore drill failed; no production resources were used.", file=sys.stderr)
        raise SystemExit(1)
