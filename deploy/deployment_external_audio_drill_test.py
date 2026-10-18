"""Adversarial controls for the separate current deployment recovery proof."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import deployment_external_audio_drill as drill


class ExternalAudioDrillTest(unittest.TestCase):
    def setUp(self):
        self.before = {
            "jobs": [{"id": "job-a", "request": {"ranges": [{"start_ms": 100, "end_ms": 900}], "no_audio": False}, "items": [{"id": "item-a"}]}],
            "sources": [{"id": "source-a", "retention_job_pins": 1, "retention_pins_valid": True}],
            "agent_project_grants": [{"project_id": "project-a", "recipient": "recipient-a"}],
            "source_fingerprints": [{"source_id": "source-a", "fingerprint": {"sha256": "a" * 64}}],
            "storage_files": [{"path": "/source-a", "size_bytes": 10}],
            "storage_reservations": [{"id": "reservation-a", "size_bytes": 20}],
            "app_schema_versions": [{"version": version} for _, version in drill.historical.MIGRATIONS],
            "app_schema_migrations": [{"position": i + 1, "version": version, "checksum": "a" * 64, "applied_at": "2026-10-17T00:00:00+00:00"} for i, (_, version) in enumerate(drill.historical.MIGRATIONS)],
        }
        self.after = copy.deepcopy(self.before)
        self.after["jobs"][0]["audio_source_id"] = None
        self.after["app_schema_versions"].append({"version": drill.MIGRATION[1]})
        self.before["app_schema_versions"].sort(key=lambda row: row["version"])
        self.after["app_schema_versions"].sort(key=lambda row: row["version"])
        self.after["app_schema_migrations"].append({"position": 9, "version": drill.MIGRATION[1], "checksum": "9" * 64, "applied_at": "2026-10-18T00:00:00+00:00"})

    def reject(self, change):
        after = copy.deepcopy(self.after)
        change(after)
        with self.assertRaises(RuntimeError):
            drill.verify_upgrade_rows(self.before, after)

    def test_exact_upgrade_and_reordered_complete_records(self):
        self.before["jobs"].append(copy.deepcopy(self.before["jobs"][0]))
        self.after["jobs"].append(copy.deepcopy(self.after["jobs"][0]))
        drill.verify_upgrade_rows(self.before, self.after)
        self.after["jobs"].reverse()
        drill.verify_upgrade_rows(self.before, self.after)

    def test_only_explicit_null_external_reference_is_accepted(self):
        self.reject(lambda s: s["jobs"][0].pop("audio_source_id"))
        for value in ("source-a", "", 0, False, {}, []):
            with self.subTest(value=value):
                self.reject(lambda s: s["jobs"][0].update(audio_source_id=value))
        self.before["jobs"][0]["audio_source_id"] = None
        with self.assertRaises(RuntimeError):
            drill.verify_upgrade_rows(self.before, self.after)

    def test_existing_rows_nested_values_unknown_fields_and_types_remain_strict(self):
        changes = [
            lambda s: s["jobs"][0]["request"]["ranges"][0].update(end_ms=901),
            lambda s: s["jobs"][0]["request"].update(no_audio=0),
            lambda s: s["jobs"][0]["items"].clear(),
            lambda s: s["jobs"][0].update(unexpected=None),
            lambda s: s["sources"][0].update(retention_pins_valid=1),
            lambda s: s["source_fingerprints"][0]["fingerprint"].update(sha256="b" * 64),
            lambda s: s["storage_files"][0].update(size_bytes=11),
            lambda s: s["storage_reservations"][0].update(size_bytes=21),
            lambda s: s["agent_project_grants"].clear(),
            lambda s: s["jobs"].append(copy.deepcopy(s["jobs"][0])),
            lambda s: s["jobs"].clear(),
            lambda s: s.pop("source_fingerprints"),
            lambda s: s.update(unexpected_table=[]),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.reject(change)

    def test_migration_history_and_new_row_are_exact(self):
        changes = [
            lambda s: s["app_schema_migrations"][0].update(checksum="b" * 64),
            lambda s: s["app_schema_migrations"][0].update(applied_at="2026-10-18T00:00:00Z"),
            lambda s: s["app_schema_migrations"].pop(),
            lambda s: s["app_schema_migrations"].append(copy.deepcopy(s["app_schema_migrations"][-1])),
            lambda s: s["app_schema_migrations"][-1].update(position=10),
            lambda s: s["app_schema_migrations"][-1].update(version="unknown"),
            lambda s: s["app_schema_migrations"][-1].update(checksum="invalid"),
            lambda s: s["app_schema_migrations"][-1].update(extra=None),
            lambda s: s["app_schema_migrations"][-1].update(applied_at=None),
            lambda s: s["app_schema_migrations"][-1].update(applied_at=""),
            lambda s: s["app_schema_migrations"][-1].update(applied_at="2026-10-18T00:00:00"),
            lambda s: s["app_schema_versions"].pop(),
            lambda s: s["app_schema_versions"].append({"version": drill.MIGRATION[1]}),
            lambda s: s["app_schema_versions"][-1].update(version="unknown"),
        ]
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                self.reject(change)

    def test_catalog_cannot_mislabel_009_as_008(self):
        catalog = [{"version": "schema-" + str(i + 1), "sha256": str(i + 1) * 64} for i in range(9)]
        state = {"versions": sorted(row["version"] for row in catalog), "ledger": [{"position": i + 1, "version": row["version"], "checksum": row["sha256"]} for i, row in enumerate(catalog)]}
        transport = mock.Mock()
        transport.query.return_value = json.dumps(state)
        drill.catalog_state(transport, catalog)
        with self.assertRaises(RuntimeError):
            drill.catalog_state(transport, catalog[:8])
        for change in [lambda s: s["ledger"].pop(), lambda s: s["ledger"].append(s["ledger"][-1]), lambda s: s["ledger"][-1].update(checksum="0" * 64), lambda s: s["versions"].append("unknown"), lambda s: s.update(extra=[]), lambda s: s["ledger"][-1].update(extra=None)]:
            with self.subTest(change=change):
                bad = copy.deepcopy(state)
                change(bad)
                transport.query.return_value = json.dumps(bad)
                with self.assertRaises(RuntimeError):
                    drill.catalog_state(transport, catalog)

    def test_exact_previous_binary_digest_and_metadata(self):
        identity = {"version": "v1.4.2", "commit": "106d0d2d7887540768cc21e3bd4e2c71629af6c4", "build_time": "2026-10-17T21:57:14Z", "go_version": "go1.27.2", "os": "linux", "arch": "amd64"}
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "cutmy"
            binary.write_bytes(b"owned binary fixture")
            checksum = hashlib.sha256(binary.read_bytes()).hexdigest()
            completed = subprocess.CompletedProcess([], 0, json.dumps(identity).encode(), b"")
            with mock.patch.object(drill.subprocess, "run", return_value=completed) as command:
                self.assertEqual(drill.previous_binary(binary, checksum)["commit"], identity["commit"])
                for bad in ("", "0" * 64, checksum.upper(), "bad"):
                    with self.subTest(checksum=bad), self.assertRaises(RuntimeError):
                        drill.previous_binary(binary, bad)
                command.assert_called_once()
            for field, value in [("version", "v1.4.1"), ("commit", "0" * 40), ("build_time", "unknown"), ("go_version", "go1.26.9"), ("os", "darwin"), ("extra", True)]:
                bad = dict(identity, **{field: value})
                completed = subprocess.CompletedProcess([], 0, json.dumps(bad).encode(), b"")
                with self.subTest(field=field), mock.patch.object(drill.subprocess, "run", return_value=completed), self.assertRaises(RuntimeError):
                    drill.previous_binary(binary, checksum)
            link = Path(temporary) / "link"
            link.symlink_to(binary)
            with self.assertRaises(RuntimeError):
                drill.previous_binary(link, checksum)

    def test_ninth_migration_is_bounded_and_canonical(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "internal/app/migrations"
            directory.mkdir(parents=True)
            for filename, _ in drill.historical.MIGRATIONS:
                (directory / filename).write_bytes(b"SELECT 1;\n")
            path = directory / drill.MIGRATION[0]
            with self.assertRaises(RuntimeError):
                drill.migrations(root)
            path.write_bytes(b"SELECT 9;\r\n")
            catalog = drill.migrations(root)
            self.assertEqual(len(catalog), 9)
            self.assertEqual(catalog[-1]["sql"], "SELECT 9;\n")
            self.assertEqual(catalog[-1]["sha256"], hashlib.sha256(b"SELECT 9;\n").hexdigest())
            for data in (b"", b"x" * (128 * 1024)):
                path.write_bytes(data)
                with self.assertRaises(RuntimeError):
                    drill.migrations(root)
            path.unlink()
            path.symlink_to(directory / drill.historical.MIGRATIONS[0][0])
            with self.assertRaises(RuntimeError):
                drill.migrations(root)


if __name__ == "__main__":
    unittest.main()
