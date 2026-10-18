"""Adversarial admission controls for the separate009→010 recovery witness."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import deployment_poster_drill as drill


class PosterDrillTest(unittest.TestCase):
    def setUp(self):
        history = [*drill.historical.MIGRATIONS, drill.previous.MIGRATION]
        self.before = {
            "sources": [{"id": "source-a", "retention_job_pins": 1, "retention_pins_valid": True}],
            "jobs": [{"id": "job-a", "audio_source_id": None, "request": {"ranges": [{"start_ms": 100, "end_ms": 900}], "no_audio": False}, "items": [{"id": "item-a"}]}],
            "artifacts": [{"id": "artifact-a", "owner": "owner", "size_bytes": 10}],
            "agent_project_grants": [{"project_id": "project-a", "recipient": "recipient-a"}],
            "storage_files": [{"path": "/source-a", "size_bytes": 10}],
            "storage_reservations": [{"id": "reservation-a", "size_bytes": 20}],
            "app_schema_versions": sorted([{"version": version} for _, version in history], key=lambda row: row["version"]),
            "app_schema_migrations": [{"position": i + 1, "version": version, "checksum": "a" * 64, "applied_at": "2026-10-18T00:00:00+00:00"} for i, (_, version) in enumerate(history)],
        }
        self.after = dict(copy.deepcopy(self.before), image_artifacts=[], artifact_readers=[])
        self.after["app_schema_versions"].append({"version": drill.MIGRATION[1]})
        self.after["app_schema_versions"].sort(key=lambda row: row["version"])
        self.after["app_schema_migrations"].append({"position": 10, "version": drill.MIGRATION[1], "checksum": "b" * 64, "applied_at": "2026-10-18T01:00:00+00:00"})

    def reject(self, change):
        after = copy.deepcopy(self.after)
        change(after)
        with self.assertRaises(RuntimeError):
            drill.verify_upgrade_rows(self.before, after)

    def test_additive_upgrade_preserves_complete_old_records(self):
        self.before["jobs"].append(dict(copy.deepcopy(self.before["jobs"][0]), id="job-b"))
        self.after["jobs"].append(dict(copy.deepcopy(self.after["jobs"][0]), id="job-b"))
        self.after["jobs"].reverse()
        drill.verify_upgrade_rows(self.before, self.after)

    def test_only_two_empty_tables_may_be_added(self):
        for change in [lambda s: s.pop("image_artifacts"), lambda s: s.pop("artifact_readers"), lambda s: s.update(extra=[]), lambda s: s["image_artifacts"].append({"id": "unexpected"}), lambda s: s["artifact_readers"].append({"id": "unexpected"})]:
            with self.subTest(change=change):
                self.reject(change)
        self.before["image_artifacts"] = []
        with self.assertRaises(RuntimeError):
            drill.verify_upgrade_rows(self.before, self.after)

    def test_old_nested_fields_boolean_types_and_membership_are_exact(self):
        for change in [lambda s: s["jobs"][0]["request"]["ranges"][0].update(end_ms=901), lambda s: s["jobs"][0]["request"].update(no_audio=0), lambda s: s["jobs"][0].update(audio_source_id="removed"), lambda s: s["jobs"][0]["items"].clear(), lambda s: s["sources"][0].update(retention_pins_valid=1), lambda s: s["storage_files"][0].update(size_bytes=11), lambda s: s["storage_reservations"][0].update(size_bytes=21), lambda s: s["agent_project_grants"].clear(), lambda s: s["jobs"].append(copy.deepcopy(s["jobs"][0]))]:
            with self.subTest(change=change):
                self.reject(change)

    def test_full_ledger_prefix_and_new_applied_timestamp_are_exact(self):
        for change in [lambda s: s["app_schema_migrations"][0].update(applied_at="2026-10-19T00:00:00Z"), lambda s: s["app_schema_migrations"][0].update(position=True), lambda s: s["app_schema_migrations"][0].update(checksum="c" * 64), lambda s: s["app_schema_migrations"].pop(), lambda s: s["app_schema_migrations"][-1].update(position=9), lambda s: s["app_schema_migrations"][-1].update(version="unknown"), lambda s: s["app_schema_migrations"][-1].update(checksum=True), lambda s: s["app_schema_migrations"][-1].update(extra=None), lambda s: s["app_schema_migrations"][-1].update(applied_at=None), lambda s: s["app_schema_migrations"][-1].update(applied_at="2026-10-18T01:00:00"), lambda s: s["app_schema_versions"].pop(), lambda s: s["app_schema_versions"].append({"version": drill.MIGRATION[1]})]:
            with self.subTest(change=change):
                self.reject(change)

    def test_catalog_cannot_mislabel010_as009(self):
        catalog = [{"version": "schema-" + str(i + 1), "sha256": "a" * 64} for i in range(10)]
        state = {"versions": sorted(row["version"] for row in catalog), "ledger": [{"position": i + 1, "version": row["version"], "checksum": row["sha256"]} for i, row in enumerate(catalog)]}
        transport = mock.Mock()
        transport.query.return_value = json.dumps(state)
        drill.previous.catalog_state(transport, catalog)
        with self.assertRaises(RuntimeError):
            drill.previous.catalog_state(transport, catalog[:9])

    def test_previous_binary_checksum_full_identity_and_symlinks(self):
        identity = {"version": drill.PREVIOUS_VERSION, "commit": drill.PREVIOUS_COMMIT, "build_time": drill.PREVIOUS_BUILD_TIME, "go_version": "go1.27.2", "os": "linux", "arch": "amd64"}
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "cutmy"
            binary.write_bytes(b"owned fixture")
            checksum = hashlib.sha256(binary.read_bytes()).hexdigest()
            completed = subprocess.CompletedProcess([], 0, json.dumps(identity).encode(), b"")
            with mock.patch.object(drill.subprocess, "run", return_value=completed) as command:
                self.assertEqual(drill.previous_binary(binary, checksum)["commit"], drill.PREVIOUS_COMMIT)
                for invalid in ("", "0" * 64, checksum.upper(), "bad"):
                    with self.subTest(checksum=invalid), self.assertRaises(RuntimeError):
                        drill.previous_binary(binary, invalid)
                link = Path(directory) / "link"
                link.symlink_to(binary)
                with self.assertRaises(RuntimeError):
                    drill.previous_binary(link, checksum)
                command.assert_called_once()
            for key, value in [("version", "v1.4.2"), ("commit", "0" * 40), ("build_time", "unknown"), ("go_version", "go1.26.0"), ("os", "darwin"), ("extra", None)]:
                result = subprocess.CompletedProcess([], 0, json.dumps(dict(identity, **{key: value})).encode(), b"")
                with self.subTest(key=key), mock.patch.object(drill.subprocess, "run", return_value=result), self.assertRaises(RuntimeError):
                    drill.previous_binary(binary, checksum)

    def test_migrations_require010_and_canonicalize_only_crlf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "internal/app/migrations"
            target.mkdir(parents=True)
            for name, _ in (*drill.historical.MIGRATIONS, drill.previous.MIGRATION):
                (target / name).write_bytes(b"SELECT 1;\r\n")
            with self.assertRaises(RuntimeError):
                drill.migrations(root)
            (target / drill.MIGRATION[0]).write_bytes(b"SELECT 10;\r\n")
            result = drill.migrations(root)
            self.assertEqual(len(result), 10)
            self.assertEqual(result[-1]["sql"], "SELECT 10;\n")
            self.assertEqual(result[-1]["sha256"], hashlib.sha256(b"SELECT 10;\n").hexdigest())

    def test_restore_comparison_rejects_changed_rows_catalog_media_volumes_owner(self):
        transport, helper = mock.Mock(), mock.Mock()
        transport.query.return_value = "0"
        helper.scan.return_value = [{"path": "image.png", "sha256": "a" * 64}]
        helper.volumes.return_value = {"media": "owned-volume"}
        with mock.patch.object(drill.historical, "application_rows", return_value=self.after), mock.patch.object(drill.historical, "catalog_shape", return_value={"actual": "catalog"}):
            args = [transport, helper, Path("/owned"), self.after, {"actual": "catalog"}, helper.scan.return_value, helper.volumes.return_value]
            drill.assert_restored(*args)
            for index, invalid in [(3, self.before), (4, {}), (5, []), (6, {"media": "foreign"})]:
                changed = list(args)
                changed[index] = invalid
                with self.subTest(index=index), self.assertRaises(RuntimeError):
                    drill.assert_restored(*changed)
            transport.query.return_value = "1"
            with self.assertRaises(RuntimeError):
                drill.assert_restored(*args)


if __name__ == "__main__":
    unittest.main()
