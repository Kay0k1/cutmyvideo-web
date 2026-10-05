#!/usr/bin/env python3
"""Snapshot/install/restore our two boot units without starting any service."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

UNITS = ("cutmy-egress.service", "cutmy-stack.service")


def publish(source, destination):
    temporary = destination.with_name("." + destination.name + "." + uuid.uuid4().hex)
    try:
        shutil.copy2(source, temporary, follow_symlinks=False)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def control(*args, capture=False):
    result = subprocess.run(["systemctl", *args], stdout=subprocess.PIPE if capture else subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    if not capture and result.returncode:
        raise RuntimeError("Service configuration command failed")
    return result


def main():
    os.umask(0o077)
    action, directory = sys.argv[1:]
    directory = Path(directory)
    target = Path(os.getenv("CUTMY_SYSTEMD_DIR", "/etc/systemd/system"))
    if action == "snapshot":
        state = {}
        for name in UNITS:
            path = target / name
            exists = path.exists() or path.is_symlink()
            if exists:
                shutil.copy2(path, directory / name, follow_symlinks=False)
            enabled = control("is-enabled", name, capture=True).stdout.decode().strip()
            if enabled not in ("enabled", "disabled", "static", "not-found", "enabled-runtime"):
                raise RuntimeError("Existing service configuration cannot be safely changed")
            state[name] = {"exists": exists, "enabled": enabled}
        (directory / "state.json").write_text(json.dumps(state))
    elif action == "install":
        target.mkdir(parents=True, exist_ok=True)
        for name in UNITS:
            path = target / name
            publish(directory / name, path)
        control("daemon-reload")
        control("enable", *UNITS)
    elif action == "restore":
        state = json.loads((directory / "state.json").read_text())
        for name in UNITS:
            # Only links belonging to these units are modified by systemctl.
            path = target / name
            if path.exists() or path.is_symlink():
                control("disable", name)
            path.unlink(missing_ok=True)
            if state[name]["exists"]:
                publish(directory / name, path)
        control("daemon-reload")
        for name in UNITS:
            if state[name]["enabled"] == "enabled":
                control("enable", name)
            elif state[name]["enabled"] == "enabled-runtime":
                control("enable", "--runtime", name)
    else:
        raise RuntimeError("Invalid service configuration action")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        print("Service configuration failed; inspect private rollout snapshot", file=sys.stderr)
        sys.exit(1)
