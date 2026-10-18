#!/usr/bin/env python3
"""Owned PostgreSQL/media recovery for the actual schema009→010→009 boundary.

The older007/008 and008/009 drills remain independent historical witnesses.
Only this invocation's unique, labelled container and named volumes are touched.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

import deployment_external_audio_drill as previous
import deployment_restore_drill as historical
import operations
from database_access import APP_ROLE, DatabaseAccess, PsqlTransport, sql_literal
from deployment_snapshot import DeploymentSnapshot

PREVIOUS_COMMIT = "ca334380ef6f8a8aa9e336b2817eb183501528b6"
PREVIOUS_VERSION = "v1.5.0"
PREVIOUS_BUILD_TIME = "2026-10-18T00:22:14Z"
MIGRATION = ("010_20261018_poster_artifacts_v1.sql", "20261018-poster-artifacts-v1")
NEW_TABLES = {"image_artifacts", "artifact_readers"}


def migrations(core: Path) -> list[dict]:
    catalog = previous.migrations(core)
    path = core / "internal/app/migrations" / MIGRATION[0]
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size < 128 * 1024:
        raise RuntimeError("actual_010_migration_source_required")
    text = path.read_bytes().replace(b"\r\n", b"\n").decode("utf-8")
    return catalog + [{"version": MIGRATION[1], "sql": text, "sha256": hashlib.sha256(text.encode()).hexdigest()}]


def previous_binary(binary: Path, expected_sha256: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or binary.is_symlink() or not binary.is_file():
        raise RuntimeError("exact_schema009_binary_required")
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise RuntimeError("schema009_binary_checksum_mismatch")
    result = subprocess.run([str(binary), "version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    if result.returncode or len(result.stdout) > 65536:
        raise RuntimeError("schema009_binary_identity_unavailable")
    identity = json.loads(result.stdout)
    if not isinstance(identity, dict) or set(identity) != {"version", "commit", "build_time", "go_version", "os", "arch"} or identity.get("version") != PREVIOUS_VERSION or identity.get("commit") != PREVIOUS_COMMIT or identity.get("build_time") != PREVIOUS_BUILD_TIME or identity.get("go_version") != "go1.27.2" or identity.get("os") != "linux" or identity.get("arch") not in ("amd64", "arm64"):
        raise RuntimeError("schema009_binary_identity_mismatch")
    return {"sha256": digest, **identity}


def verify_upgrade_rows(before: dict, after: dict) -> None:
    """Preserve every old value and full ledger row, including applied_at."""
    if not isinstance(before, dict) or not isinstance(after, dict) or NEW_TABLES & set(before) or set(after) != set(before) | NEW_TABLES or not {"sources", "jobs", "artifacts", "app_schema_versions", "app_schema_migrations"} <= set(before):
        raise RuntimeError("upgrade_changed_application_tables")
    if any(after[table] != [] for table in NEW_TABLES):
        raise RuntimeError("upgrade_created_unrequested_poster_state")
    records = lambda snapshot: {table: sorted(json.dumps(row, sort_keys=True, separators=(",", ":")) for row in rows) for table, rows in snapshot.items()}
    legacy = {table: rows for table, rows in before.items() if table not in ("app_schema_migrations", "app_schema_versions")}
    current = {table: rows for table, rows in after.items() if table not in NEW_TABLES | {"app_schema_migrations", "app_schema_versions"}}
    if records(legacy) != records(current):
        raise RuntimeError("upgrade_changed_existing_application_rows")
    old_ledger, new_ledger = before["app_schema_migrations"], after["app_schema_migrations"]
    if len(old_ledger) != 9 or len(new_ledger) != 10 or records({"ledger": new_ledger[:9]}) != records({"ledger": old_ledger}):
        raise RuntimeError("upgrade_changed_historical_migration_ledger")
    added = new_ledger[-1]
    if set(added) != {"position", "version", "checksum", "applied_at"} or type(added["position"]) is not int or added["position"] != 10 or added["version"] != MIGRATION[1] or not isinstance(added["applied_at"], str) or not isinstance(added["checksum"], str) or not re.fullmatch(r"[0-9a-f]{64}", added["checksum"]):
        raise RuntimeError("upgrade_added_invalid_migration_ledger")
    try:
        applied = datetime.fromisoformat(added["applied_at"].replace("Z", "+00:00"))
        if applied.tzinfo is None:
            raise ValueError("timezone required")
    except ValueError as exc:
        raise RuntimeError("upgrade_added_invalid_migration_timestamp") from exc
    expected_versions = sorted([*before["app_schema_versions"], {"version": MIGRATION[1]}], key=lambda row: row["version"])
    if after["app_schema_versions"] != expected_versions:
        raise RuntimeError("upgrade_changed_schema_versions")


def media_files(helper: DeploymentSnapshot, root: Path) -> list[dict]:
    return helper.scan(root, hashes=True)


def media_command(command: list[str]) -> bytes:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
    if result.returncode or len(result.stdout) > 65536:
        raise RuntimeError("owned_drill_media_operation_failed")
    return result.stdout


def verify_image(media: Path, poster: dict) -> None:
    path = media / "artifacts/img-fixture.png"
    if path.is_symlink() or not path.is_file() or path.stat().st_size != poster["size_bytes"]:
        raise RuntimeError("restored_poster_bytes_unavailable")
    info = json.loads(media_command(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)]))
    streams = info.get("streams", [])
    if len(streams) != 1 or streams[0].get("codec_name") != "png" or streams[0].get("width") != poster["width"] or streams[0].get("height") != poster["height"]:
        raise RuntimeError("restored_poster_decode_shape_mismatch")
    media_command(["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-frames:v", "1", "-f", "null", "-"])


def assert_restored(transport, helper, media, rows, shape, inventory, volumes):
    if historical.application_rows(transport) != rows or historical.catalog_shape(transport) != shape:
        raise RuntimeError("coordinated_restore_changed_rows_or_catalog")
    if media_files(helper, media) != inventory or helper.volumes() != volumes:
        raise RuntimeError("coordinated_restore_changed_media_or_volume_identity")
    if transport.query(APP_ROLE, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_get_userbyid(c.relowner)<>'cutmy';") != "0":
        raise RuntimeError("coordinated_restore_changed_application_owner")


def run(image: str, core: Path, old_binary: Path, new_binary: Path, old_sha256: str) -> dict:
    old_identity = previous_binary(old_binary, old_sha256)
    if new_binary.is_symlink() or not new_binary.is_file():
        raise RuntimeError("actual_schema010_binary_required")
    catalog = migrations(core)
    identity = "cutmy-poster-drill-" + uuid.uuid4().hex[:12]
    project = identity.replace("-", "")
    started = False
    with tempfile.TemporaryDirectory(prefix=identity + "-") as temporary:
        root = Path(temporary)
        shared, deploy = root / "shared", root / "deploy"
        shared.mkdir(mode=0o700)
        deploy.mkdir(mode=0o700)
        environment = shared / "production.env"
        environment.write_text("RELEASE_TAG=" + "a" * 12 + "-" + "b" * 12 + "\n")
        environment.chmod(0o600)
        compose = {"name": project, "services": {"postgres": {"image": image, "pull_policy": "never", "network_mode": "none", "mem_limit": "256m", "memswap_limit": "256m", "cpus": 1, "pids_limit": 128, "command": ["postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=20"], "environment": {"POSTGRES_USER": "cutmy", "POSTGRES_DB": "cutmy", "POSTGRES_HOST_AUTH_METHOD": "trust", "POSTGRES_PASSWORD": "synthetic_drill_only"}, "volumes": ["database:/var/lib/postgresql/data", "media:/fixture-media"], "healthcheck": {"test": ["CMD", "pg_isready", "-U", "cutmy", "-d", "cutmy"], "interval": "1s", "timeout": "3s", "retries": 60}}}, "volumes": {"database": {"name": identity + "-database"}, "media": {"name": identity + "-media"}}}
        (deploy / "compose.yaml").write_text(json.dumps(compose))
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
            historical.apply_migrations(transport, catalog, 0, 9)
            previous.catalog_state(transport, catalog[:9])
            historical.server_probe(prefix, old_binary, "cutmy-schema009", compatible=True)
            with (shared / "deployment.lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                helper = DeploymentSnapshot(env, lock_fd=lock.fileno(), transport=transport)
                volumes = helper.volumes()
                media = Path(volumes["media"]["path"])
                for name in ("sources", "artifacts", "work"):
                    (media / name).mkdir(mode=0o750, exist_ok=True)
                source, output = media / "sources/source-a.mp4", media / "artifacts/clip-a.mp4"
                media_command(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:size=160x96:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", str(source)])
                media_command([str(old_binary), "clip", "--input", str(source), "--output", str(output), "--start", "1", "--end", "3", "--threads", "1"])
                media_command(["ffmpeg", "-v", "error", "-xerror", "-i", str(output), "-f", "null", "-"])
                files = {str(path.relative_to(media)): path.read_bytes() for path in (source, output)}
                for path in (source, output):
                    path.chmod(0o600)
                    os.chown(path, 65532, 65532)
                request = {"source_id": "source-a", "ranges": [{"start_ms": 1000, "end_ms": 3000, "label": "Original range"}], "format": "mp4", "quality": "best", "cut_mode": "accurate", "output_mode": "joined"}
                artifact = {"id": "artifact-a", "filename": "clip-a.mp4", "size_bytes": output.stat().st_size, "actual_start_ms": 1000, "actual_end_ms": 3000, "download_url": "/api/v1/artifacts/artifact-a/download"}
                items = [{"id": "item-a", "label": "Original range", "start_ms": 1000, "end_ms": 3000, "status": "succeeded", "artifact": artifact}]
                plan = {"version": 1, "clips": [{"id": "answer", "ranges": request["ranges"]}]}
                transport.query(APP_ROLE, "SET search_path=public; INSERT INTO sources(id,owner,title,duration_ms,kind,path,width,height) VALUES('source-a','owner-a','Original source',4000,'upload','/fixture-media/sources/source-a.mp4',160,96); INSERT INTO jobs(id,owner,source_id,request,items,status,stage,idempotency_key) VALUES('job-a','owner-a','source-a'," + sql_literal(json.dumps(request)) + "," + sql_literal(json.dumps(items)) + ",'succeeded','done','original-owner-key'); INSERT INTO artifacts(id,owner,job_id,path,filename,size_bytes,actual_start_ms,actual_end_ms,expires_at) VALUES('artifact-a','owner-a','job-a','/fixture-media/artifacts/clip-a.mp4','clip-a.mp4'," + str(output.stat().st_size) + ",1000,3000,clock_timestamp()+interval '1 day'); INSERT INTO agent_projects(id,owner,source_id,plan,source_snapshot,rendition,collection_key) VALUES('project-a','owner-a','source-a'," + sql_literal(json.dumps(plan)) + ",'{}','final','original-project-key'); INSERT INTO agent_project_jobs(project_id,job_id,clip_id) VALUES('project-a','job-a','answer'); INSERT INTO agent_project_handoffs(token_hash,project_id,recipient,redeemed_at) VALUES(repeat('a',64),'project-a','recipient-a',clock_timestamp()); INSERT INTO agent_project_grants(project_id,recipient) VALUES('project-a','recipient-a');")
                for name, resource, kind in [("sources/source-a.mp4", "source-a", "source"), ("artifacts/clip-a.mp4", "artifact-a", "artifact")]:
                    transport.query(APP_ROLE, "SET search_path=public; INSERT INTO public.storage_files(path,owner,resource_id,kind,size_bytes) VALUES(" + ",".join(sql_literal(value) for value in ("/fixture-media/" + name, "owner-a", resource, kind)) + "," + str(len(files[name])) + ");")
                fingerprint = {"kind": "content", "sha256": hashlib.sha256(files["sources/source-a.mp4"]).hexdigest(), "size_bytes": len(files["sources/source-a.mp4"])}
                transport.query(APP_ROLE, "INSERT INTO public.source_fingerprints(source_id,owner,fingerprint) VALUES('source-a','owner-a'," + sql_literal(json.dumps(fingerprint)) + ");")
                before, shape9 = historical.application_rows(transport), historical.catalog_shape(transport)
                inventory9 = media_files(helper, media)
                if NEW_TABLES & set(before) or before["storage_counters"][0]["stored_bytes"] != sum(map(len, files.values())) or before["sources"][0]["retention_job_pins"] != 1:
                    raise RuntimeError("actual_schema009_fixture_missing")
                packet9 = root / "snapshot009"
                packet9.mkdir(mode=0o700)
                receipt9 = helper.capture(packet9)
                # The actual current binary performs009→010, rather than the
                # driver substituting a hand-built lookalike catalog.
                historical.server_probe(prefix, new_binary, "cutmy-schema010", compatible=True)
                previous.catalog_state(transport, catalog)
                verify_upgrade_rows(before, historical.application_rows(transport))
                current, shape10 = historical.application_rows(transport), historical.catalog_shape(transport)
                historical.server_probe(prefix, old_binary, "cutmy-schema009", compatible=False)
                if historical.application_rows(transport) != current or historical.catalog_shape(transport) != shape10:
                    raise RuntimeError("schema009_refusal_changed010_database")
                image_path = media / "artifacts/img-fixture.png"
                poster = json.loads(media_command([str(new_binary), "poster", "--input", str(output), "--output", str(image_path), "--at", "0.500", "--format", "png", "--threads", "1"]))
                if poster.get("path") != str(image_path) or poster.get("timestamp_ms") != 500 or poster.get("format") != "png" or poster.get("width") != 160 or poster.get("height") != 96 or type(poster.get("size_bytes")) is not int or poster["size_bytes"] <= 0:
                    raise RuntimeError("actual_poster_cli_result_missing")
                image_path.chmod(0o600)
                os.chown(image_path, 65532, 65532)
                verify_image(media, poster)
                transport.query(APP_ROLE, "SET search_path=public; INSERT INTO image_artifacts(id,owner,parent_artifact_id,path,filename,format,size_bytes,width,height,timestamp_ms,expires_at) SELECT 'img-fixture',owner,id,'/fixture-media/artifacts/img-fixture.png','img-fixture.png','png'," + str(poster["size_bytes"]) + ",160,96,500,expires_at FROM artifacts WHERE id='artifact-a'; INSERT INTO storage_files(path,owner,resource_id,kind,size_bytes) VALUES('/fixture-media/artifacts/img-fixture.png','owner-a','img-fixture','image_artifact'," + str(poster["size_bytes"]) + "); INSERT INTO artifact_readers(id,artifact_id,expires_at) VALUES('img-pending','artifact-a',clock_timestamp()+interval '1 hour'); INSERT INTO storage_reservations(id,owner,kind,size_bytes,expires_at,job_id,token) VALUES('poster:img-pending','owner-a','poster',16777216,clock_timestamp()+interval '1 hour','artifact-a','png');")
                rows10, shape10 = historical.application_rows(transport), historical.catalog_shape(transport)
                inventory10 = media_files(helper, media)
                if len(rows10["image_artifacts"]) != 1 or len(rows10["artifact_readers"]) != 1:
                    raise RuntimeError("poster_snapshot_witness_empty")
                packet10 = root / "snapshot010"
                packet10.mkdir(mode=0o700)
                receipt10 = helper.capture(packet10)
                transport.query(APP_ROLE, "SET search_path=public; UPDATE sources SET owner='changed'; UPDATE jobs SET request='{}',items='[]',idempotency_key='changed'; UPDATE agent_projects SET plan='{}'; DELETE FROM agent_project_grants; UPDATE image_artifacts SET filename='changed.png'; DELETE FROM artifact_readers; DELETE FROM storage_reservations WHERE kind='poster';")
                source.write_bytes(b"changed source")
                output.unlink()
                image_path.unlink()
                (media / "unexpected.bin").write_bytes(b"must disappear")
                restored10 = helper.restore(packet10)
                assert_restored(transport, helper, media, rows10, shape10, inventory10, volumes)
                verify_image(media, poster)
                historical.server_probe(prefix, new_binary, "cutmy-schema010", compatible=True)
                assert_restored(transport, helper, media, rows10, shape10, inventory10, volumes)
                historical.server_probe(prefix, old_binary, "cutmy-schema009", compatible=False)
                assert_restored(transport, helper, media, rows10, shape10, inventory10, volumes)
                restored9 = helper.restore(packet9)
                assert_restored(transport, helper, media, before, shape9, inventory9, volumes)
                previous.catalog_state(transport, catalog[:9])
                historical.server_probe(prefix, old_binary, "cutmy-schema009", compatible=True)
                assert_restored(transport, helper, media, before, shape9, inventory9, volumes)
                historical.server_probe(prefix, new_binary, "cutmy-schema010", compatible=True)
                verify_upgrade_rows(before, historical.application_rows(transport))
                live_rows, live_shape = historical.application_rows(transport), historical.catalog_shape(transport)
                corrupt_controls = []
                for kind, member in (("media", "media/sources/source-a.mp4"), ("database", "database/database.sql.gz")):
                    corrupt = root / ("corrupt-" + kind)
                    shutil.copytree(packet9, corrupt)
                    (corrupt / member).write_bytes(b"corrupt private snapshot")
                    refused = False
                    try:
                        helper.restore(corrupt)
                    except RuntimeError:
                        refused = True
                    if not refused:
                        raise RuntimeError("corrupt_snapshot_was_accepted")
                    assert_restored(transport, helper, media, live_rows, live_shape, inventory9, volumes)
                    corrupt_controls.append(kind)
                return {"ok": True, "profile": "poster-009-to-010", "real_postgresql": True, "actual_immutable_migrations": True, "actual_current_binary_applies010": True, "migration_sha256": {str(i + 1).zfill(3): row["sha256"] for i, row in enumerate(catalog)}, "old_binary": old_identity, "new_binary_sha256": hashlib.sha256(new_binary.read_bytes()).hexdigest(), "legacy_rows_and_full_ledger_preserved": True, "old_core_refused010_without_mutation": True, "old_core_accepted_restored009": True, "current_core_accepted_restored010_without_writes": True, "schema010_rows_media_and_poster_restored": restored10["schema_restored"] and restored10["media_restored"], "schema010_to009_restored": restored9["schema_restored"] and restored9["media_restored"], "full_catalog_definitions_restored": True, "ordinary_application_owner": True, "persistent_volume_identities_preserved": True, "corrupt_snapshots_refused_before_mutation": corrupt_controls, "snapshots": {"009": receipt9, "010": receipt10}, "poster": {"format": "png", "width": poster["width"], "height": poster["height"], "timestamp_ms": poster["timestamp_ms"], "size_bytes": poster["size_bytes"], "sha256": hashlib.sha256((packet10 / "media/artifacts/img-fixture.png").read_bytes()).hexdigest()}, "media_sha256": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        finally:
            if started:
                for name in (identity + "-database", identity + "-media"):
                    existing = operations.command(["docker", "volume", "ls", "--format", "{{.Name}}", "--filter", "name=^" + name + "$"], stdout=subprocess.PIPE).stdout.decode().splitlines()
                    if existing:
                        rows = json.loads(operations.command(["docker", "volume", "inspect", name], stdout=subprocess.PIPE).stdout)
                        if len(rows) != 1 or rows[0].get("Name") != name or rows[0].get("Labels", {}).get("com.docker.compose.project") != project:
                            raise RuntimeError("owned_drill_volume_cleanup_refused")
                operations.command([*prefix, "down", "--volumes", "--timeout", "5"], timeout=30, stdout=subprocess.DEVNULL)


def main() -> int:
    os.umask(0o077)
    if os.geteuid() != 0:
        raise RuntimeError("Disposable named-volume ownership checks require root")
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default=operations.PG_IMAGE)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--core-dir", type=Path, required=True)
    parser.add_argument("--old-binary", type=Path, required=True)
    parser.add_argument("--old-binary-sha256", required=True)
    parser.add_argument("--new-binary", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.image, args.core_dir, args.old_binary, args.new_binary, args.old_binary_sha256)
    if args.output:
        operations.atomic_json(args.output, result)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        print("Disposable poster deployment restore drill failed; no production resources were used.", file=sys.stderr)
        raise SystemExit(1)
