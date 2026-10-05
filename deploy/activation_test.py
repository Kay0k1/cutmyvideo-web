"""Exercise release success and partial failures without Docker or production data."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ACTIVATE = Path(__file__).with_name("activate.sh").resolve()
CORE = "a" * 40
WEB = "b" * 40
NEW = CORE[:12] + "-" + WEB[:12]
OLD = "1" * 12 + "-" + "2" * 12


class ActivationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cutmy-activation-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "shared").mkdir()
        self.env_file = self.root / "shared/production.env"
        self.original = "POSTGRES_PASSWORD=fixture-private-value\nDOMAIN=cutmy.video\nRELEASE_TAG=" + OLD + "\n"
        self.env_file.write_text(self.original)
        self.env_file.chmod(0o600)
        for tag in (OLD, NEW):
            deploy = self.root / "releases" / tag / "web/deploy"
            deploy.mkdir(parents=True)
            (deploy / "compose.yaml").write_text("name: cutmy\n")
            (deploy / "backup.cron").write_text(tag + " cron\n")
            (deploy / "monitor.cron").write_text(tag + " monitor\n")
            (deploy / "service-control.py").write_text('''import pathlib,sys,os
root=pathlib.Path(os.environ["CUTMY_TEST_ROOT"])
with (root/"service-events").open("a") as f: f.write(sys.argv[1]+"\\n")
if sys.argv[1]=="install" and os.environ["CUTMY_TEST_MODE"]=="service-failure": sys.exit(77)
''')
            (deploy / "database_access.py").write_text('''import sys,os
if os.environ["CUTMY_TEST_MODE"]=="database-access-failure": sys.exit(78)
print('{"ok":true,"restart_required":'+('true' if os.environ["CUTMY_TEST_MODE"]=="database-bootstrap-changed" else 'false')+'}')
''')
            self.mock(deploy / "egress.sh", '''#!/usr/bin/env bash
set -eu
printf '%s %s\\n' "${PWD##*/}" "$1" >> "$CUTMY_TEST_ROOT/egress-events"
if [[ "$CUTMY_TEST_MODE" == egress-failure && "$1" == apply && ! -e "$CUTMY_TEST_ROOT/egress-failed" ]]; then touch "$CUTMY_TEST_ROOT/egress-failed"; exit 76; fi
''')
        self.current = self.root / "current"
        self.current.symlink_to(self.root / "releases" / OLD)
        self.cron = self.root / "backup.cron"
        self.cron.write_text(OLD + " cron\n")
        self.monitor_cron = self.root / "monitor.cron"
        self.monitor_cron.write_text("operator-specific monitor\n")
        self.state = self.root / "running-release"
        self.state.write_text(OLD)
        bindir = self.root / "bin"
        bindir.mkdir()
        self.mock(bindir / "docker", r'''#!/usr/bin/env bash
set -eu
if [[ " $* " == *" config "* ]]; then printf '{"services":{"api":{"environment":{"MAX_SOURCE_BYTES":"1073741824"}}}}'; exit 0; fi
if [[ " $* " == *" build "* ]]; then
  [[ "$CUTMY_TEST_MODE" != build-failure ]] || exit 71
  exit 0
fi
if [[ " $* " == *" stop "* ]]; then printf 'stopped' > "$CUTMY_TEST_ROOT/running-release"; exit 0; fi
if [[ " $* " == *" restart "* ]]; then printf 'restarted' > "$CUTMY_TEST_ROOT/role-restart"; exit 0; fi
if [[ " $* " == *" exec "* ]]; then
 [[ "$CUTMY_TEST_MODE" != post-role-health-failure ]] || exit 79
 exit 0
fi
[[ " $* " == *" up "* ]] || exit 90
printf '%s' "$RELEASE_TAG" > "$CUTMY_TEST_ROOT/running-release"
if [[ "$CUTMY_TEST_MODE" == rollback-failure ]]; then exit 73; fi
if [[ "$CUTMY_TEST_MODE" == health-failure && "$RELEASE_TAG" == "$CUTMY_TEST_NEW" ]]; then exit 72; fi
exit 0
''')
        self.mock(bindir / "mv", r'''#!/usr/bin/env bash
set -eu
if [[ "$CUTMY_TEST_MODE" == commit-failure && "${!#}" == "$CUTMY_TEST_ROOT/current" && ! -e "$CUTMY_TEST_ROOT/move-failed" ]]; then
  touch "$CUTMY_TEST_ROOT/move-failed"
  exit 74
fi
exec /bin/mv "$@"
''')
        self.env = os.environ | {
            "PATH": str(bindir) + os.pathsep + os.environ["PATH"],
            "CUTMY_INSTALL_DIR": str(self.root),
            "CUTMY_CRON_FILE": str(self.cron),
            "CUTMY_MONITOR_CRON_FILE": str(self.monitor_cron),
            "CUTMY_TEST_ROOT": str(self.root),
            "CUTMY_TEST_NEW": NEW,
        }

    @staticmethod
    def mock(path, body):
        path.write_text(body)
        path.chmod(0o700)

    def run_activation(self, mode):
        result = subprocess.run(
            ["bash", str(ACTIVATE), NEW, CORE, WEB],
            env=self.env | {"CUTMY_TEST_MODE": mode},
            capture_output=True, text=True, timeout=15,
        )
        self.assertNotIn("fixture-private-value", result.stdout + result.stderr)
        self.assertEqual(self.env_file.stat().st_mode & 0o777, 0o600)
        return result

    def assert_old_release(self):
        self.assertEqual(self.env_file.read_text(), self.original)
        self.assertEqual(self.current.resolve(), self.root / "releases" / OLD)
        self.assertEqual(self.state.read_text(), OLD)
        self.assertEqual(self.cron.read_text(), OLD + " cron\n")
        self.assertEqual(self.monitor_cron.read_text(), "operator-specific monitor\n")

    def assert_no_snapshots(self):
        self.assertEqual(list((self.root / "shared").glob("production.env.*")), [])

    def test_success_switches_images_environment_and_release_record(self):
        result = self.run_activation("success")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.resolve(), self.root / "releases" / NEW)
        self.assertEqual(self.state.read_text(), NEW)
        self.assertIn("RELEASE_TAG=" + NEW + "\n", self.env_file.read_text())
        self.assertIn("POSTGRES_PASSWORD=fixture-private-value\n", self.env_file.read_text())
        self.assertEqual(self.cron.read_text(), NEW + " cron\n")
        self.assertEqual(self.monitor_cron.read_text(), NEW + " monitor\n")
        self.assertEqual((self.current / "release.env").read_text(), "CORE_COMMIT=" + CORE + "\nWEB_COMMIT=" + WEB + "\n")
        self.assert_no_snapshots()

    def test_build_failure_keeps_previous_installation(self):
        result = self.run_activation("build-failure")
        self.assertEqual(result.returncode, 71)
        self.assert_old_release()
        self.assert_no_snapshots()

    def test_unhealthy_new_stack_restores_previous_installation(self):
        result = self.run_activation("health-failure")
        self.assertEqual(result.returncode, 72)
        self.assert_old_release()
        self.assertIn("Previous release restored and healthy", result.stderr)
        self.assert_no_snapshots()

    def test_failure_after_environment_switch_restores_previous_installation(self):
        result = self.run_activation("commit-failure")
        self.assertEqual(result.returncode, 74)
        self.assert_old_release()
        self.assert_no_snapshots()

    def test_failed_rollback_retains_private_recovery_snapshot(self):
        result = self.run_activation("rollback-failure")
        self.assertEqual(result.returncode, 73)
        self.assertIn("Automatic rollback did not finish", result.stderr)
        snapshots = list((self.root / "shared").glob("production.env.rollback.*"))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].read_text(), self.original)
        self.assertEqual(snapshots[0].stat().st_mode & 0o777, 0o600)

    def test_first_release_does_not_require_previous_symlink(self):
        self.current.unlink()
        result = self.run_activation("success")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.current.resolve(), self.root / "releases" / NEW)
        self.assert_no_snapshots()

    def test_first_release_failure_keeps_configuration_uncommitted(self):
        self.current.unlink()
        result = self.run_activation("health-failure")
        self.assertEqual(result.returncode, 72)
        self.assertFalse(self.current.exists())
        self.assertEqual(self.env_file.read_text(), self.original)
        self.assertIn("no previous release exists", result.stderr)
        self.assert_no_snapshots()
        self.assertEqual(self.state.read_text(), "stopped")

    def test_actual_operator_cron_is_restored_not_old_release_template(self):
        self.cron.write_text("operator changed backup schedule\n")
        result = self.run_activation("commit-failure")
        self.assertEqual(result.returncode, 74)
        self.assertEqual(self.cron.read_text(), "operator changed backup schedule\n")
        self.assertEqual(self.monitor_cron.read_text(), "operator-specific monitor\n")

    def test_egress_failure_does_not_start_new_containers(self):
        result = self.run_activation("egress-failure")
        self.assertEqual(result.returncode, 76)
        self.assert_old_release()
        self.assert_no_snapshots()

    def test_service_enable_failure_restores_release_and_unit_snapshot(self):
        result = self.run_activation("service-failure")
        self.assertEqual(result.returncode, 77)
        self.assert_old_release()
        self.assertEqual((self.root / "service-events").read_text(), "snapshot\ninstall\nrestore\n")
        self.assert_no_snapshots()

    def test_database_role_setup_failure_rolls_back_before_release_commit(self):
        result = self.run_activation("database-access-failure")
        self.assertEqual(result.returncode, 78)
        self.assert_old_release()
        self.assert_no_snapshots()

    def test_bootstrap_role_switch_restarts_media_containers_and_checks_readiness(self):
        result = self.run_activation("database-bootstrap-changed")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "role-restart").read_text(), "restarted")

    def test_post_role_readiness_failure_restores_previous_release(self):
        result = self.run_activation("post-role-health-failure")
        self.assertEqual(result.returncode, 79)
        self.assert_old_release()
        self.assert_no_snapshots()

    def test_concurrent_rollout_is_rejected_before_snapshot_or_build(self):
        import fcntl
        with (self.root / "shared/deployment.lock").open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            result = self.run_activation("success")
        self.assertEqual(result.returncode, 75)
        self.assert_old_release()
        self.assert_no_snapshots()

    def test_first_release_restores_absent_cron_files(self):
        self.current.unlink()
        self.cron.unlink()
        self.monitor_cron.unlink()
        result = self.run_activation("commit-failure")
        self.assertEqual(result.returncode, 74)
        self.assertFalse(self.cron.exists())
        self.assertFalse(self.monitor_cron.exists())
        self.assertEqual(self.state.read_text(), "stopped")


if __name__ == "__main__":
    unittest.main()
