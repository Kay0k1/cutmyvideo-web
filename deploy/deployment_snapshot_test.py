"""Bounded filesystem/lock controls; the real PostgreSQL drill is a separate gate."""
import fcntl
import gzip
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import deployment_snapshot as snapshot


class Fixture(snapshot.DeploymentSnapshot):
    def __init__(self, env, descriptor, volumes):
        super().__init__(env, lock_fd=descriptor)
        self.fixture_volumes = volumes
        self.schema = [{"position": 7, "version": "007", "checksum": "a" * 64}]
        self.writer = False
        self.restores = 0

    def stopped(self):
        snapshot.require_lock(self.shared, self.lock_fd)
        if self.writer:
            raise snapshot.SnapshotError("deployment_writers_must_be_stopped")

    def volumes(self):
        return self.fixture_volumes

    def ledger(self):
        return self.schema

    def restore_database(self, directory):
        self.restores += 1
        self.schema = json.loads((directory / "manifest.json").read_text())["schema"]


def fake_dump(_env, path):
    sql = b"-- PostgreSQL database dump\nCREATE TABLE example(id int);\n-- PostgreSQL database dump complete\n"
    with gzip.open(path, "wb") as output:
        output.write(sql)
    return len(sql)


class DeploymentSnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cutmy-snapshot-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.shared = self.root / "shared"
        self.shared.mkdir(mode=0o700)
        self.lock = (self.shared / "deployment.lock").open("w")
        self.addCleanup(self.lock.close)
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        environment = self.shared / "production.env"
        environment.write_text("POSTGRES_PASSWORD=synthetic-private-value\n")
        environment.chmod(0o600)
        volumes = {}
        for key in ("media", "database"):
            name = "fixture-" + key
            path = self.root / name / "_data"
            path.mkdir(parents=True)
            volumes[key] = {"name": name, "path": str(path)}
        self.media = Path(volumes["media"]["path"])
        self.packet = self.root / "snapshot"
        self.packet.mkdir(mode=0o700)
        self.helper = Fixture({"CUTMY_SHARED_DIR": str(self.shared), "CUTMY_ENV_FILE": str(environment), "RELEASE_TAG": "a" * 12 + "-" + "b" * 12, "CUTMY_DEPLOY_SNAPSHOT_MIN_FREE_BYTES": "1"}, self.lock.fileno(), volumes)
        self.patch = mock.patch.object(snapshot.operations, "dump_gzip", side_effect=fake_dump)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.mask = os.umask(0o077)
        self.addCleanup(os.umask, self.mask)

    def test_restores_exact_bytes_directories_modes_and_volume_identity(self):
        (self.media / "source").mkdir(mode=0o750)
        (self.media / "source").chmod(0o750)
        original = b"private synthetic media\x00\xff"
        (self.media / "source/original.bin").write_bytes(original)
        (self.media / "source/original.bin").chmod(0o640)
        (self.media / "empty").mkdir(mode=0o700)
        before = self.helper.volumes()
        result = self.helper.capture(self.packet)
        self.assertTrue(result["media_included"])
        self.assertEqual((self.packet / "production.env").stat().st_mode & 0o777, 0o600)
        (self.media / "source/original.bin").unlink()
        (self.media / "new.bin").write_bytes(b"new generation")
        self.helper.schema = [{"position": 8, "version": "008", "checksum": "b" * 64}]
        self.assertTrue(self.helper.restore(self.packet)["schema_restored"])
        self.assertEqual((self.media / "source/original.bin").read_bytes(), original)
        self.assertEqual((self.media / "source/original.bin").stat().st_mode & 0o777, 0o640)
        self.assertEqual((self.media / "source").stat().st_mode & 0o777, 0o750)
        self.assertTrue((self.media / "empty").is_dir())
        self.assertFalse((self.media / "new.bin").exists())
        self.assertEqual(self.helper.volumes(), before)

    def test_media_corruption_is_rejected_before_database_or_live_media_changes(self):
        (self.media / "a.bin").write_bytes(b"original")
        self.helper.capture(self.packet)
        (self.packet / "media/a.bin").write_bytes(b"corrupt!")
        (self.media / "a.bin").write_bytes(b"new live")
        with self.assertRaisesRegex(snapshot.SnapshotError, "checksum"):
            self.helper.restore(self.packet)
        self.assertEqual(self.helper.restores, 0)
        self.assertEqual((self.media / "a.bin").read_bytes(), b"new live")

    def test_database_corruption_or_wrong_volume_prevents_destructive_restore(self):
        self.helper.capture(self.packet)
        (self.packet / "database/database.sql.gz").write_bytes(b"corrupt")
        with self.assertRaises(RuntimeError):
            self.helper.restore(self.packet)
        self.assertEqual(self.helper.restores, 0)
        self.helper.fixture_volumes = {**self.helper.fixture_volumes, "media": {"name": "other", "path": str(self.media)}}
        with self.assertRaisesRegex(snapshot.SnapshotError, "volume_changed"):
            self.helper.restore(self.packet)

    def test_private_environment_corruption_prevents_database_restore(self):
        self.helper.capture(self.packet)
        (self.packet / "production.env").write_text("changed private configuration\n")
        with self.assertRaisesRegex(snapshot.SnapshotError, "environment_checksum"):
            self.helper.restore(self.packet)
        self.assertEqual(self.helper.restores, 0)

    def test_restore_without_dump_schema_creation_still_creates_app_owned_schema_in_one_transaction(self):
        self.helper.capture(self.packet)
        calls = []
        def capture(argv, **options):
            calls.append((argv, options["stdin"].read()))
        with mock.patch.object(snapshot.DatabaseAccess, "role_is_admin", return_value=True), mock.patch.object(snapshot.operations, "command", side_effect=capture):
            snapshot.DeploymentSnapshot.restore_database(self.helper, self.packet)
        argv, sql = calls[0]
        self.assertIn("--single-transaction", argv)
        self.assertIn(b"DROP SCHEMA public CASCADE;\nCREATE SCHEMA public AUTHORIZATION cutmy;\nSET ROLE cutmy;\n", sql)

    def test_media_symlinks_and_mutable_hardlinks_are_not_snapshotted(self):
        outside = self.root / "outside"
        outside.write_bytes(b"must not read")
        (self.media / "link").symlink_to(outside)
        with self.assertRaisesRegex(snapshot.SnapshotError, "links"):
            self.helper.capture(self.packet)
        self.assertEqual(outside.read_bytes(), b"must not read")
        (self.media / "link").unlink()
        os.link(outside, self.media / "hardlink")
        with self.assertRaisesRegex(snapshot.SnapshotError, "links"):
            self.helper.scan(self.media, hashes=True)

    def test_running_writers_or_wrong_lock_cannot_capture_or_restore(self):
        self.helper.writer = True
        with self.assertRaisesRegex(snapshot.SnapshotError, "writers"):
            self.helper.capture(self.packet)
        self.assertEqual(list(self.packet.iterdir()), [])
        with (self.root / "wrong.lock").open("w") as wrong:
            with self.assertRaises(snapshot.SnapshotError):
                snapshot.require_lock(self.shared, wrong.fileno())

    def test_manifest_path_escape_and_incomplete_or_public_packet_are_refused(self):
        for value in ("../outside", "/absolute", "a/../outside", "a\\outside", "", "./a"):
            with self.assertRaises(snapshot.SnapshotError):
                snapshot.relative_path(value)
        with self.assertRaises(snapshot.SnapshotError):
            self.helper.verify(self.packet)
        self.packet.chmod(0o755)
        with self.assertRaisesRegex(snapshot.SnapshotError, "not_private"):
            self.helper.capture(self.packet)


if __name__ == "__main__":
    unittest.main()
