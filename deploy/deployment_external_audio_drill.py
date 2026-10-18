#!/usr/bin/env python3
"""Disposable schema 008 -> 009 -> 008 database/media deployment proof.

The separate deployment_restore_drill.py retains the historical 007/008 proof.
Only this invocation's labelled PostgreSQL container and volumes are touched.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

import deployment_restore_drill as historical
import operations
from database_access import APP_ROLE, DatabaseAccess, PsqlTransport, sql_literal
from deployment_snapshot import DeploymentSnapshot, SnapshotError

PREVIOUS_COMMIT = "106d0d2d7887540768cc21e3bd4e2c71629af6c4"
PREVIOUS_VERSION = "v1.4.2"
PREVIOUS_BUILD_TIME = "2026-10-17T21:57:14Z"
MIGRATION = ("009_20261018_external_audio_refs_v1.sql", "20261018-external-audio-refs-v1")


def migrations(core: Path) -> list[dict]:
    catalog = historical.migrations(core)
    path = core / "internal/app/migrations" / MIGRATION[0]
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size < 128 * 1024:
        raise RuntimeError("actual_009_migration_source_required")
    text = path.read_bytes().replace(b"\r\n", b"\n").decode("utf-8")
    return catalog + [{"version": MIGRATION[1], "sql": text, "sha256": hashlib.sha256(text.encode()).hexdigest()}]


def previous_binary(binary: Path, expected_sha256: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or binary.is_symlink() or not binary.is_file():
        raise RuntimeError("exact_schema008_binary_required")
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if digest != expected_sha256:
        raise RuntimeError("schema008_binary_checksum_mismatch")
    result = subprocess.run([str(binary), "version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    if result.returncode or len(result.stdout) > 65536:
        raise RuntimeError("schema008_binary_identity_unavailable")
    identity = json.loads(result.stdout)
    if not isinstance(identity, dict) or set(identity) != {"version", "commit", "build_time", "go_version", "os", "arch"} or identity.get("version") != PREVIOUS_VERSION or identity.get("commit") != PREVIOUS_COMMIT or identity.get("build_time") != PREVIOUS_BUILD_TIME or identity.get("go_version") != "go1.27.2" or identity.get("os") != "linux" or identity.get("arch") not in ("amd64", "arm64"):
        raise RuntimeError("schema008_binary_identity_mismatch")
    return {"sha256": digest, **identity}


def catalog_state(transport: PsqlTransport, catalog: list[dict]) -> None:
    actual = json.loads(transport.query(APP_ROLE, "SELECT json_build_object('versions',(SELECT json_agg(version ORDER BY version) FROM public.app_schema_versions),'ledger',(SELECT json_agg(json_build_object('position',position,'version',version,'checksum',checksum) ORDER BY position) FROM public.app_schema_migrations));"))
    expected = {"versions": sorted(row["version"] for row in catalog), "ledger": [{"position": index + 1, "version": row["version"], "checksum": row["sha256"]} for index, row in enumerate(catalog)]}
    if actual != expected:
        raise RuntimeError("actual_schema_catalog_does_not_match_profile")


def verify_upgrade_rows(before: dict, after: dict) -> None:
    """Only one NULL job column and the ninth migration ledger may be added."""
    if set(before) != set(after) or not {"jobs", "sources", "app_schema_migrations", "app_schema_versions"} <= set(before):
        raise RuntimeError("upgrade_changed_application_tables")
    if any("audio_source_id" in row for row in before["jobs"]):
        raise RuntimeError("schema008_fixture_already_contains_009")
    projected = copy.deepcopy(after)
    for row in projected["jobs"]:
        if "audio_source_id" not in row or row["audio_source_id"] is not None:
            raise RuntimeError("upgrade_changed_legacy_audio_references")
        del row["audio_source_id"]
    projected.pop("app_schema_migrations")
    projected.pop("app_schema_versions")
    legacy = {table: rows for table, rows in before.items() if table not in ("app_schema_migrations", "app_schema_versions")}
    records = lambda snapshot: {table: sorted(json.dumps(row, sort_keys=True, separators=(",", ":")) for row in rows) for table, rows in snapshot.items()}
    if records(legacy) != records(projected):
        raise RuntimeError("upgrade_changed_existing_application_rows")
    old_ledger, new_ledger = before["app_schema_migrations"], after["app_schema_migrations"]
    if len(old_ledger) != 8 or len(new_ledger) != 9 or new_ledger[:8] != old_ledger:
        raise RuntimeError("upgrade_changed_historical_migration_ledger")
    if set(new_ledger[-1]) != {"position", "version", "checksum", "applied_at"} or new_ledger[-1]["position"] != 9 or new_ledger[-1]["version"] != MIGRATION[1] or not isinstance(new_ledger[-1]["applied_at"], str) or not re.fullmatch(r"[0-9a-f]{64}", new_ledger[-1]["checksum"]):
        raise RuntimeError("upgrade_added_invalid_migration_ledger")
    try:
        applied = datetime.fromisoformat(new_ledger[-1]["applied_at"].replace("Z", "+00:00"))
        if applied.tzinfo is None:
            raise ValueError("timezone required")
    except ValueError as exc:
        raise RuntimeError("upgrade_added_invalid_migration_timestamp") from exc
    if after["app_schema_versions"] != sorted([*before["app_schema_versions"], {"version": MIGRATION[1]}], key=lambda row: row["version"]):
        raise RuntimeError("upgrade_changed_schema_versions")


def run(image: str, core: Path, old_binary: Path, new_binary: Path, old_sha256: str) -> dict:
    old_identity = previous_binary(old_binary, old_sha256)
    catalog = migrations(core)
    identity = "cutmy-audio-drill-" + uuid.uuid4().hex[:12]
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
        (deploy / "compose.yaml").write_text(json.dumps({"name": project, "services": {"postgres": {"image": image, "pull_policy": "never", "network_mode": "none", "environment": {"POSTGRES_USER": "cutmy", "POSTGRES_DB": "cutmy", "POSTGRES_HOST_AUTH_METHOD": "trust", "POSTGRES_PASSWORD": "synthetic_drill_only"}, "volumes": ["database:/var/lib/postgresql/data", "media:/fixture-media"], "healthcheck": {"test": ["CMD", "pg_isready", "-U", "cutmy", "-d", "cutmy"], "interval": "1s", "timeout": "3s", "retries": 60}}}, "volumes": {"database": {"name": identity + "-database"}, "media": {"name": identity + "-media"}}}))
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
            historical.apply_migrations(transport, catalog, 0, 8)
            catalog_state(transport, catalog[:8])
            historical.server_probe(prefix, old_binary, "cutmy-schema008", compatible=True)
            lock = (shared / "deployment.lock").open("w")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX)
                helper = DeploymentSnapshot(env, lock_fd=lock.fileno(), transport=transport)
                volumes = helper.volumes()
                media = Path(volumes["media"]["path"])
                (media / "sources").mkdir(mode=0o750, exist_ok=True)
                (media / "outputs").mkdir(mode=0o700, exist_ok=True)
                files = {"sources/source-a.bin": b"original source\x00\xff" * 4096, "sources/recorder-a.bin": b"separate recorder\x00\xfe" * 4096, "outputs/clip-a.bin": b"original result" * 2048}
                for name, data in files.items():
                    path = media / name
                    path.write_bytes(data)
                    path.chmod(0o600)
                    os.chown(path, 65532, 65532)
                request = {"source_id": "source-a", "ranges": [{"start_ms": 1000, "end_ms": 3000, "label": "Original range"}], "format": "mp4", "quality": "720p", "cut_mode": "accurate", "output_mode": "joined"}
                artifact = {"id": "artifact-a", "filename": "clip-a.bin", "size_bytes": len(files["outputs/clip-a.bin"]), "actual_start_ms": 1000, "actual_end_ms": 3000, "download_url": "/api/v1/artifacts/artifact-a/download"}
                items = [{"id": "item-a", "label": "Original range", "start_ms": 1000, "end_ms": 3000, "status": "succeeded", "artifact": artifact}]
                plan = {"version": 1, "clips": [{"id": "answer", "ranges": request["ranges"]}]}
                transport.query(APP_ROLE, """SET search_path=public;
INSERT INTO sources(id,owner,title,duration_ms,kind,path,width,height) VALUES('source-a','owner-a','Original source',10000,'upload','/fixture-media/sources/source-a.bin',640,360),('recorder-a','owner-a','Separate recording',10000,'upload','/fixture-media/sources/recorder-a.bin',0,0);
INSERT INTO jobs(id,owner,source_id,request,items,status,stage,idempotency_key) VALUES('job-a','owner-a','source-a',""" + sql_literal(json.dumps(request)) + "," + sql_literal(json.dumps(items)) + """,'succeeded','done','original-owner-key');
INSERT INTO artifacts(id,owner,job_id,path,filename,size_bytes,actual_start_ms,actual_end_ms,expires_at) VALUES('artifact-a','owner-a','job-a','/fixture-media/outputs/clip-a.bin','clip-a.bin',""" + str(len(files["outputs/clip-a.bin"])) + """,1000,3000,clock_timestamp()+interval '1 day');
INSERT INTO agent_projects(id,owner,source_id,plan,source_snapshot,rendition,collection_key) VALUES('project-a','owner-a','source-a',""" + sql_literal(json.dumps(plan)) + """,'{"id":"source-a"}','final','drill-project-key');
INSERT INTO agent_project_jobs(project_id,job_id,clip_id) VALUES('project-a','job-a','answer');
INSERT INTO agent_project_handoffs(token_hash,project_id,recipient,redeemed_at) VALUES(repeat('a',64),'project-a','recipient-a',clock_timestamp());
INSERT INTO agent_project_grants(project_id,recipient) VALUES('project-a','recipient-a');
""")
                for name, resource, kind in [("sources/source-a.bin", "source-a", "source"), ("sources/recorder-a.bin", "recorder-a", "source"), ("outputs/clip-a.bin", "artifact-a", "artifact")]:
                    transport.query(APP_ROLE, "SET search_path=public; INSERT INTO public.storage_files(path,owner,resource_id,kind,size_bytes) VALUES(" + ",".join(sql_literal(value) for value in ("/fixture-media/" + name, "owner-a", resource, kind)) + "," + str(len(files[name])) + ");")
                fingerprint = {"kind": "content", "sha256": hashlib.sha256(files["sources/source-a.bin"]).hexdigest(), "size_bytes": len(files["sources/source-a.bin"])}
                transport.query(APP_ROLE, "INSERT INTO public.source_fingerprints(source_id,owner,fingerprint) VALUES('source-a','owner-a'," + sql_literal(json.dumps(fingerprint)) + ");")
                before = historical.application_rows(transport)
                shape_before = historical.catalog_shape(transport)
                if before["storage_counters"][0]["stored_bytes"] != sum(map(len, files.values())) or {row["id"]: row["retention_job_pins"] for row in before["sources"]} != {"source-a": 1, "recorder-a": 0}:
                    raise RuntimeError("actual_schema008_triggers_not_present")
                packet = root / "snapshot"
                packet.mkdir(mode=0o700)
                receipt = helper.capture(packet)
                historical.apply_migrations(transport, catalog, 8, 9)
                catalog_state(transport, catalog)
                verify_upgrade_rows(before, historical.application_rows(transport))
                request["audio_replace"] = {"source_id": "recorder-a", "audio_track": 0, "offset_ms": 250}
                transport.query(APP_ROLE, "SET search_path=public; UPDATE public.jobs SET request=" + sql_literal(json.dumps(request)) + " WHERE id='job-a';")
                if transport.query(APP_ROLE, "SELECT audio_source_id FROM public.jobs WHERE id='job-a';") != "recorder-a" or transport.query(APP_ROLE, "SELECT retention_job_pins FROM public.sources WHERE id='recorder-a';") != "1":
                    raise RuntimeError("actual_schema009_derived_reference_not_present")
                historical.server_probe(prefix, new_binary, "cutmy-schema009", compatible=True)
                catalog_state(transport, catalog)
                actual009, shape009 = historical.application_rows(transport), historical.catalog_shape(transport)
                historical.server_probe(prefix, old_binary, "cutmy-schema008", compatible=False)
                if historical.application_rows(transport) != actual009 or historical.catalog_shape(transport) != shape009:
                    raise RuntimeError("schema008_refusal_changed_database")
                transport.query(APP_ROLE, "SET search_path=public; UPDATE public.sources SET owner='changed'; UPDATE public.jobs SET request='{}',items='[]',idempotency_key='changed-key'; UPDATE public.artifacts SET filename='changed.bin'; UPDATE public.agent_projects SET plan='{}'; DELETE FROM public.agent_project_grants;")
                (media / "sources/source-a.bin").write_bytes(b"changed after migration")
                (media / "sources/recorder-a.bin").unlink()
                (media / "outputs/clip-a.bin").unlink()
                (media / "new-artifact.bin").write_bytes(b"post-migration data")
                restored = helper.restore(packet)
                wrong_owner = transport.query(APP_ROLE, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_get_userbyid(c.relowner)<>'cutmy';")
                if historical.application_rows(transport) != before or historical.catalog_shape(transport) != shape_before or wrong_owner != "0":
                    raise RuntimeError("schema008_database_restore_did_not_match")
                if any((media / name).read_bytes() != data or (media / name).stat().st_uid != 65532 for name, data in files.items()) or (media / "new-artifact.bin").exists() or helper.volumes() != volumes:
                    raise RuntimeError("schema008_media_identity_restore_did_not_match")
                catalog_state(transport, catalog[:8])
                historical.server_probe(prefix, old_binary, "cutmy-schema008", compatible=True)
                if historical.application_rows(transport) != before or historical.catalog_shape(transport) != shape_before:
                    raise RuntimeError("restored_schema008_startup_changed_application_data")
                historical.apply_migrations(transport, catalog, 8, 9)
                live_rows, live_shape = historical.application_rows(transport), historical.catalog_shape(transport)
                (packet / "media/sources/source-a.bin").write_bytes(b"corrupt private snapshot")
                refused = False
                try:
                    helper.restore(packet)
                except SnapshotError:
                    refused = True
                if not refused or historical.application_rows(transport) != live_rows or historical.catalog_shape(transport) != live_shape or any((media / name).read_bytes() != data for name, data in files.items()) or helper.volumes() != volumes:
                    raise RuntimeError("corrupt_snapshot_not_refused_before_mutation")
                return {"ok": True, "profile": "external-audio-008-to-009", "real_postgresql": True, "actual_immutable_migrations": True, "migration_sha256": {str(index + 1).zfill(3): row["sha256"] for index, row in enumerate(catalog)}, "old_binary": old_identity, "new_binary_sha256": hashlib.sha256(new_binary.read_bytes()).hexdigest(), "legacy_rows_preserved_by_upgrade": True, "old_core_refused_009_without_mutation": True, "old_core_accepted_restored_008": True, "application_rows_restored": True, "project_grants_restored": True, "catalog_definitions_restored": True, "ordinary_application_owner": True, "schema_009_to_008_restored": restored["schema_restored"], "new_schema_objects_removed": True, "media_restored": restored["media_restored"], "persistent_volume_identities_preserved": True, "corrupt_snapshot_refused_before_mutation": True, "files": receipt["files"], "media_size_bytes": receipt["media_size_bytes"], "media_sha256": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
            finally:
                lock.close()
        finally:
            if started:
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
        print("Disposable external-audio deployment restore drill failed; no production resources were used.", file=sys.stderr)
        raise SystemExit(1)
