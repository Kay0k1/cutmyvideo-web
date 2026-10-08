"""Retention safety: preserve current/rollback/container images and all volumes."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import housekeeping as h


class HousekeepingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "releases").mkdir()
        (self.root / "shared").mkdir()
        self.tags = [str(i) * 12 + "-" + str(i) * 12 for i in range(1, 5)]
        for i, tag in enumerate(self.tags):
            path = self.root / "releases" / tag
            path.mkdir()
            (path / "release.env").write_text("completed test release")
            import os
            os.utime(path, (100 + i, 100 + i))
        (self.root / "current").symlink_to(self.root / "releases" / self.tags[0])
        (self.root / "shared/production.env").write_text("RELEASE_TAG=" + self.tags[0] + "\n")
        self.images = {f"{repo}:{tag}": {} for repo in h.PROJECT_IMAGES for tag in self.tags}
        self.env = {"CUTMY_INSTALL_DIR": str(self.root)}
        self.now = 10**9
        self.created = patch.object(h, "output", return_value=json.dumps("2000-01-01T00:00:00Z"))
        self.created.start()
        self.addCleanup(self.created.stop)

    def plan(self, used=(), env=None):
        return h.plan(self.root, self.images, set(used), self.env | (env or {}), self.now)

    def test_preserves_current_and_latest_complete_rollback(self):
        p = self.plan()
        self.assertEqual(p["kept_releases"], [self.tags[0], self.tags[3]])
        self.assertEqual(p["remove_releases"], self.tags[1:3])
        self.assertEqual(len(p["remove_image_tags"]), 4)

    def test_container_reference_pins_release_and_image(self):
        ref = "cutmy-core:" + self.tags[1]
        p = self.plan([ref])
        self.assertNotIn(ref, p["remove_image_tags"])
        self.assertNotIn(self.tags[1], p["remove_releases"])

    def test_incomplete_rollback_does_not_displace_usable_one(self):
        del self.images["cutmy-web:" + self.tags[3]]
        self.assertIn(self.tags[2], self.plan()["kept_releases"])

    def test_exact_previous_release_takes_priority_over_newer_failed_build(self):
        (self.root / "previous").symlink_to(self.root / "releases" / self.tags[1])
        self.assertEqual(self.plan()["kept_releases"], self.tags[:2])

    def test_rejects_previous_symlink_outside_managed_releases(self):
        (self.root / "previous").symlink_to(self.root / "shared")
        with self.assertRaisesRegex(RuntimeError, "Previous release"):
            self.plan()

    def test_young_release_and_image_are_preserved(self):
        import os
        os.utime(self.root / "releases" / self.tags[1], (self.now, self.now))
        with patch.object(h, "output", return_value=json.dumps("2001-09-09T01:46:40Z")):
            p = self.plan()
        self.assertNotIn(self.tags[1], p["remove_releases"])
        self.assertEqual(p["remove_image_tags"], [])

    def test_retains_at_least_two_releases(self):
        with self.assertRaises(RuntimeError):
            self.plan(env={"CUTMY_RELEASES_KEEP": "1"})

    def test_rejects_mismatched_environment(self):
        (self.root / "shared/production.env").write_text("RELEASE_TAG=other\n")
        with self.assertRaisesRegex(RuntimeError, "disagree"):
            self.plan()

    def test_rejects_current_outside_release_directory(self):
        (self.root / "current").unlink()
        (self.root / "current").symlink_to(self.root / "shared")
        with self.assertRaisesRegex(RuntimeError, "outside"):
            self.plan()

    def test_skips_symlink_and_unmanaged_directories(self):
        extra = self.root / "releases" / ("a" * 12 + "-" + "b" * 12)
        extra.symlink_to(self.root / "shared")
        (self.root / "releases" / "migration-evidence").mkdir()
        self.assertEqual(self.plan()["remove_releases"], self.tags[1:3])

    def test_dry_run_does_not_delete_or_prune(self):
        with patch.object(h, "inventory", return_value=(self.images, set())), patch.object(h, "command") as command:
            p = h.housekeeping(self.env)
        command.assert_not_called()
        self.assertFalse(p["applied"])
        self.assertEqual(len(list((self.root / "releases").iterdir())), 4)

    def test_apply_only_removes_planned_tags_dirs_and_bounds_cache(self):
        with patch.object(h, "inventory", return_value=(self.images, set())), patch.object(h, "command") as command:
            p = h.housekeeping(self.env, True)
        self.assertTrue(p["applied"])
        self.assertTrue((self.root / "shared/housekeeping-status.json").exists())
        self.assertEqual({p.name for p in (self.root / "releases").iterdir()}, {self.tags[0], self.tags[3]})
        calls = [call.args[0] for call in command.call_args_list]
        self.assertEqual(calls[-1], ["docker", "buildx", "prune", "--force", "--all", "--reserved-space", "0", "--max-used-space", "536870912"])
        self.assertTrue(all(call[:3] == ["docker", "image", "rm"] for call in calls[:-1]))
        self.assertNotIn("--force", str(calls[:-1]))
        self.assertNotIn("volume", str(calls))

    def test_inventory_is_scoped_to_project_images(self):
        self.created.stop()
        image_id = "sha256:" + "a" * 64
        rows = [{"Repository": "cutmy-core", "Tag": self.tags[0], "ID": image_id}, {"Repository": "other-service", "Tag": "latest"}, {"Repository": "cutmy-audit-load", "Tag": "test-20261008", "ID": "sha256:" + "b" * 64}, {"Repository": "postgres", "Tag": "17-alpine"}, {"Repository": "cutmy-core", "Tag": "local"}]
        with patch.object(h, "output", side_effect=["\n".join(json.dumps(r) for r in rows), "a" * 12, image_id + " " + image_id]):
            images, used = h.inventory()
        self.assertEqual(set(images), {"cutmy-core:" + self.tags[0], "cutmy-audit-load:test-20261008"})
        self.assertEqual(used, {"cutmy-core:" + self.tags[0], image_id})
