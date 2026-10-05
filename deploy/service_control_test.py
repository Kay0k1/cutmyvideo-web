"""Check unit snapshots against a synthetic systemd, never real host units."""
import json
import os
from pathlib import Path
import subprocess
import shlex
import tempfile
import unittest

CONTROL = Path(__file__).with_name("service-control.py").resolve()
UNITS = ("cutmy-egress.service", "cutmy-stack.service")


class ServiceControlTest(unittest.TestCase):
    def test_stack_units_serialize_start_stop_with_activation_and_bound_waits(self):
        contents=Path(__file__).with_name('cutmy-stack.service').read_text()
        commands={line.split('=',1)[0]:shlex.split(line.split('=',1)[1]) for line in contents.splitlines() if line.startswith(('ExecStart=','ExecStop='))}
        for key,wait in (('ExecStart','300'),('ExecStop','30')):
            self.assertEqual(commands[key][:5],['/usr/bin/flock','--exclusive','--wait',wait,'/opt/cutmy/shared/deployment.lock'])
            self.assertEqual(commands[key][5],'/usr/bin/docker')
        self.assertIn('TimeoutStartSec=480',contents)
        self.assertIn('TimeoutStopSec=60',contents)
        self.assertEqual(commands['ExecStop'][-5:],['stop','--timeout','20','api','worker'])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cutmy-service-control-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "units"
        self.target.mkdir()
        self.snapshot = self.root / "snapshot"
        self.snapshot.mkdir()
        self.templates = self.root / "templates"
        self.templates.mkdir()
        for name in UNITS:
            (self.templates / name).write_text("new " + name)
        self.binaries = self.root / "bin"
        self.binaries.mkdir()
        tool = self.binaries / "systemctl"
        tool.write_text('''#!/usr/bin/env python3
import os,json,sys
from pathlib import Path
root=Path(os.environ["CUTMY_TEST_SERVICE_ROOT"])
state=json.loads((root/"state.json").read_text())
args=sys.argv[1:]
with (root/"calls.jsonl").open("a") as f: f.write(json.dumps(args)+"\\n")
if args[0]=="is-enabled":
 print(state.get(args[1],"not-found"));sys.exit(0)
if args[0] in ("enable","disable"):
 for name in args[1:]:
  if not name.startswith("--"): state[name]="enabled" if args[0]=="enable" else "disabled"
 (root/"state.json").write_text(json.dumps(state))
''')
        tool.chmod(0o700)
        (self.root / "state.json").write_text(json.dumps({}))
        self.env = os.environ | {"PATH": str(self.binaries) + os.pathsep + os.environ["PATH"], "CUTMY_SYSTEMD_DIR": str(self.target), "CUTMY_TEST_SERVICE_ROOT": str(self.root)}

    def run_control(self, action, directory):
        result = subprocess.run(["python3", str(CONTROL), action, str(directory)], env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_existing_unit_and_enabled_state_restore_exactly_without_starting(self):
        original = self.target / UNITS[0]
        original.write_text("custom operator policy")
        original.chmod(0o600)
        (self.root / "state.json").write_text(json.dumps({UNITS[0]: "enabled", UNITS[1]: "not-found"}))
        self.run_control("snapshot", self.snapshot)
        self.run_control("install", self.templates)
        self.assertTrue(all((self.target / name).read_text().startswith("new") for name in UNITS))
        self.run_control("restore", self.snapshot)
        self.assertEqual(original.read_text(), "custom operator policy")
        self.assertEqual(original.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.target / UNITS[1]).exists())
        self.assertEqual(json.loads((self.root / "state.json").read_text())[UNITS[0]], "enabled")
        calls = [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]
        self.assertFalse(any(args[0] in ("start", "restart", "stop") for args in calls))

    def test_first_installation_failure_can_restore_absent_units(self):
        self.run_control("snapshot", self.snapshot)
        self.run_control("install", self.templates)
        self.run_control("restore", self.snapshot)
        self.assertFalse(any((self.target / name).exists() for name in UNITS))

    def test_masked_operator_unit_is_rejected_before_mutation(self):
        path = self.target / UNITS[0]
        path.symlink_to("/dev/null")
        (self.root / "state.json").write_text(json.dumps({UNITS[0]: "masked"}))
        result = subprocess.run(["python3", str(CONTROL), "snapshot", str(self.snapshot)], env=self.env, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.readlink(path), "/dev/null")


if __name__ == "__main__":
    unittest.main()
