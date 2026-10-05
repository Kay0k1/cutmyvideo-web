"""Fault-oriented operations checks; no production data, network or Docker."""
import contextlib
import fcntl
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("operations", Path(__file__).with_name("operations.py"))
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)
SQL = b"-- PostgreSQL database dump\nSELECT 1;\n-- PostgreSQL database dump complete\n"


class OperationsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cutmy-operations-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.shared = self.root / "shared"
        self.shared.mkdir()
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.env = {"CUTMY_SHARED_DIR": str(self.shared), "CUTMY_BACKUP_DIR": str(self.backups)}

    def make_backup(self, index=0, data=SQL, age=0):
        directory = self.backups / ("database-20261005T000000Z-" + f"{index:08x}")
        directory.mkdir()
        compressed = gzip.compress(data)
        (directory / "database.sql.gz").write_bytes(compressed)
        manifest = {"format": 1, "created_unix": time.time() - age, "size_bytes": len(compressed), "sql_size_bytes": len(data), "sha256": hashlib.sha256(compressed).hexdigest()}
        (directory / "manifest.json").write_text(json.dumps(manifest))
        (directory / "checksum.sha256").write_text(manifest["sha256"] + "  database.sql.gz\n")
        return directory

    def fake_dump(self, env, path):
        path.write_bytes(gzip.compress(SQL))
        return len(SQL)

    def run_backup(self, dump=None):
        with patch.object(ops, "dump_gzip", side_effect=dump or self.fake_dump), contextlib.redirect_stdout(io.StringIO()):
            ops.backup(self.env)

    def test_backup_publishes_verified_pair_and_private_status_atomically(self):
        self.run_backup()
        directories = list(self.backups.iterdir())
        self.assertEqual(len(directories), 1)
        manifest = ops.validate_backup(directories[0])
        self.assertEqual(manifest["sql_size_bytes"], len(SQL))
        self.assertFalse(manifest["media_included"])
        self.assertEqual(directories[0].stat().st_mode & 0o777, 0o700)
        self.assertIsNone(json.loads((self.shared / "backup-status.json").read_text())["remote_verified_unix"])

    def test_failed_or_truncated_dump_never_publishes_backup(self):
        def fail(env, path):
            path.write_bytes(SQL[:20])
            raise RuntimeError("synthetic failure")
        with self.assertRaises(RuntimeError):
            self.run_backup(fail)
        self.assertEqual(list(self.backups.iterdir()), [])
        def incomplete(env, path):
            path.write_bytes(gzip.compress(SQL[:30]))
            return 30
        with self.assertRaisesRegex(RuntimeError, "Incomplete"):
            self.run_backup(incomplete)
        self.assertEqual(list(self.backups.iterdir()), [])

    def test_concurrent_backup_and_deployment_locks_reject_before_dump(self):
        for filename in ("backup.lock", "deployment.lock"):
            with (self.shared / filename).open("a") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX)
                with self.assertRaisesRegex(RuntimeError, "lock"):
                    self.run_backup()
        self.assertEqual(list(self.backups.iterdir()), [])

    def test_checksum_corruption_and_gzip_crc_are_detected(self):
        directory = self.make_backup()
        dump = directory / "database.sql.gz"
        raw = bytearray(dump.read_bytes())
        raw[-7] ^= 1
        dump.write_bytes(raw)
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            ops.validate_backup(directory)
        manifest = json.loads((directory / "manifest.json").read_text())
        manifest["sha256"] = hashlib.sha256(raw).hexdigest()
        (directory / "manifest.json").write_text(json.dumps(manifest))
        (directory / "checksum.sha256").write_text(manifest["sha256"] + "  database.sql.gz\n")
        with self.assertRaises((gzip.BadGzipFile, OSError)):
            ops.validate_backup(directory)

    def test_corrupt_publisher_metadata_is_rejected_and_preserved_by_retention(self):
        directory = self.make_backup()
        original = json.loads((directory / "manifest.json").read_text())
        for invalid in ([], original | {"sha256": []}, original | {"created_unix": "invalid"}, original | {"created_unix": time.time()+3600}):
            (directory / "manifest.json").write_text(json.dumps(invalid))
            with self.assertRaises(RuntimeError):
                ops.validate_backup(directory)
            ops.retain(self.backups, self.env)
            self.assertTrue(directory.exists())

    def test_expansion_bound_and_symlinks_are_rejected(self):
        directory = self.make_backup()
        manifest = json.loads((directory / "manifest.json").read_text())
        manifest["sql_size_bytes"] = 1
        (directory / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "expansion"):
            ops.validate_backup(directory)
        link = self.backups / "symlink"
        link.symlink_to(directory)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            ops.validate_backup(link)

    def test_configured_sql_limit_and_verify_deadline_are_enforced(self):
        directory = self.make_backup()
        with self.assertRaisesRegex(RuntimeError, "uncompressed"):
            ops.validate_backup(directory, {"CUTMY_BACKUP_MAX_SQL_BYTES": "1"})
        with self.assertRaisesRegex(RuntimeError, "deadline"):
            ops.validate_backup(directory, deadline=time.monotonic() - 1)

    def test_wall_deadline_interrupts_an_inflater_that_never_yields_a_chunk(self):
        directory = self.make_backup()
        class StalledInflater:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size):
                time.sleep(5)
        started=time.monotonic()
        with patch.object(ops.gzip, 'open', return_value=StalledInflater()):
            with self.assertRaisesRegex(RuntimeError,'deadline'):
                ops.validate_backup(directory,deadline=time.monotonic()+.05)
        self.assertLess(time.monotonic()-started,1)
        self.assertEqual(ops.signal.getitimer(ops.signal.ITIMER_REAL)[0],0)

    def test_retention_bounds_count_age_and_bytes_preserving_newest_copy(self):
        self.make_backup(1, age=10 * 86400)
        self.make_backup(2, age=600)
        newest = self.make_backup(3)
        external = self.backups / "do-not-remove.txt"
        external.write_text("operator file")
        ops.retain(self.backups, self.env | {"CUTMY_BACKUP_MAX_COPIES": "1", "CUTMY_BACKUP_MAX_BYTES": "1"})
        self.assertTrue(newest.exists())
        self.assertTrue(external.exists())
        self.assertEqual(len(list(self.backups.glob("database-*"))), 1)

    def test_remote_outage_keeps_local_valid_copy_and_records_pending_remote(self):
        self.env["CUTMY_BACKUP_REMOTE_TARGET"] = "backup@example.com"
        with patch.object(ops, "remote_copy", side_effect=RuntimeError("synthetic delivery failure")):
            with self.assertRaises(RuntimeError):
                self.run_backup()
        self.assertEqual(len(list(self.backups.iterdir())), 1)
        status = json.loads((self.shared / "backup-status.json").read_text())
        self.assertTrue(status["remote_configured"])
        self.assertIsNone(status["remote_verified_unix"])

    def test_remote_destination_is_literal_and_publication_follows_verification(self):
        directory = self.make_backup()
        key = self.root / "key"
        key.touch()
        env = self.env | {"CUTMY_BACKUP_REMOTE_TARGET": "backup@example.com", "CUTMY_BACKUP_REMOTE_DIR": "/srv/backup", "CUTMY_BACKUP_SSH_KEY": str(key)}
        calls = []
        with patch.object(ops, "command", side_effect=lambda argv, **kw: calls.append(argv)):
            self.assertTrue(ops.remote_copy(directory, env))
        self.assertIn(".incoming-", calls[0][-1])
        self.assertIn("StrictHostKeyChecking=yes", calls[1])
        self.assertIn("sha256sum --check", calls[1][-1])
        self.assertIn("&& mv", calls[1][-1])
        with self.assertRaises(RuntimeError):
            ops.remote_copy(directory, env | {"CUTMY_BACKUP_REMOTE_DIR": "/tmp/$(touch-secret)"})

    def test_failed_restore_removes_only_owned_disposable_container(self):
        directory = self.make_backup()
        calls = []
        def fake(argv, **kwargs):
            calls.append(argv)
            if "psql" in argv:
                self.assertIn("ON_ERROR_STOP=1", argv)
                raise RuntimeError("synthetic invalid SQL")
        def subprocess_stub(argv, **kwargs):
            identity = next(value.split("=", 1)[1] for value in calls[0] if value.startswith("cutmy.restore-drill="))
            return subprocess.CompletedProcess(argv, 0, stdout=(identity + "\n").encode())
        with patch.object(ops, "command", side_effect=fake), patch.object(ops.subprocess, "run", side_effect=subprocess_stub) as run:
            with self.assertRaises(RuntimeError):
                ops.verify_restore(directory, self.env)
        self.assertIn("none", calls[0])
        removed = run.call_args.args[0]
        self.assertEqual(removed[:4], ["docker", "rm", "-f", "-v"])
        self.assertTrue(removed[4].startswith("cutmy-restore-drill-"))

    def metrics(self, **kwargs):
        return {"unhealthy_services": [], "free_bytes": 100 * 1024**3, "disk_used_percent": 10, "oldest_queue_seconds": 0, "expired_leases": 0, "backup_age_seconds": 100} | kwargs

    def monitor(self, value):
        with patch.object(ops, "snapshot", return_value=value), contextlib.redirect_stdout(io.StringIO()) as output:
            status = ops.monitor(self.env)
            return status, output.getvalue()

    def test_monitor_notifies_changes_and_recovery_only(self):
        self.assertEqual(self.monitor(self.metrics()), (0, ""))
        status, event = self.monitor(self.metrics(oldest_queue_seconds=601))
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(event)["alerts"], ["queue_delay"])
        self.assertEqual(self.monitor(self.metrics(oldest_queue_seconds=999)), (1, ""))
        status, event = self.monitor(self.metrics())
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(event)["previous_alerts"], ["queue_delay"])

    def test_alert_delivery_failure_does_not_acknowledge_pending_event(self):
        hook = self.root / "hook"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o700)
        self.env["CUTMY_ALERT_HOOK"] = str(hook)
        self.monitor(self.metrics())
        before = (self.shared / "monitor-state.json").read_text()
        with self.assertRaises(RuntimeError):
            self.monitor(self.metrics(expired_leases=1))
        self.assertEqual((self.shared / "monitor-state.json").read_text(), before)

    def test_missing_backups_remote_backups_and_worker_trigger_independent_alerts(self):
        alerts = ops.alert_keys(self.metrics(backup_age_seconds=None, remote_backup_age_seconds=None, unhealthy_services=["worker"]), self.env)
        self.assertEqual(alerts, ["backup_stale", "remote_backup_stale", "unhealthy_services:worker"])

    def test_storage_wait_deadline_and_independent_maintenance_are_observed(self):
        self.assertIn("storage_waiting", ops.alert_keys(self.metrics(waiting_storage=1), self.env))
        self.assertIn("storage_wait_deadline", ops.alert_keys(self.metrics(expired_storage_waits=1), self.env))
        with patch.object(ops, "command") as command:
            ops.maintain(self.env)
        self.assertIn("maintenance", command.call_args.args[0])
        self.assertEqual(command.call_args.kwargs["timeout"], 20)
        self.assertTrue((self.shared / "maintenance-status.json").exists())
        with (self.shared / "deployment.lock").open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            with self.assertRaisesRegex(RuntimeError, "lock"):
                ops.maintain(self.env)

    def test_operations_env_is_not_executable_and_requires_private_permissions(self):
        path = self.root / "operations.env"
        path.write_text("CUTMY_ALERT_HOOK=$(touch /never-run-this)\n")
        path.chmod(0o600)
        with patch.dict(os.environ, {"CUTMY_OPERATIONS_ENV": str(path)}, clear=True):
            self.assertEqual(ops.config()["CUTMY_ALERT_HOOK"], "$(touch /never-run-this)")
        path.chmod(0o644)
        with patch.dict(os.environ, {"CUTMY_OPERATIONS_ENV": str(path)}, clear=True), self.assertRaisesRegex(RuntimeError, "0600"):
            ops.config()

    def test_streaming_dump_has_deadline_and_byte_bound_without_plaintext_file(self):
        executable = self.root / "docker"
        executable.write_text("#!/usr/bin/env python3\nimport sys\nsys.stdout.buffer.write(b'x'*65536)\n")
        executable.chmod(0o700)
        env = self.env | {"CUTMY_BACKUP_MAX_SQL_BYTES": "1024"}
        with patch.dict(os.environ, {"PATH": str(self.root) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(RuntimeError, "byte budget"):
                ops.dump_gzip(env, self.root / "dump.gz")
        executable.write_text("#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n")
        began = time.monotonic()
        with patch.dict(os.environ, {"PATH": str(self.root) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(RuntimeError, "deadline"):
                ops.dump_gzip(self.env | {"CUTMY_BACKUP_TIMEOUT": "1"}, self.root / "stall.gz")
        self.assertLess(time.monotonic() - began, 5)
        self.assertFalse((self.root / "database.sql").exists())


if __name__ == "__main__":
    unittest.main()
