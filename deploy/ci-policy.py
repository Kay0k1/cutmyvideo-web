#!/usr/bin/env python3
"""Choose CI scope without dropping checks for unfamiliar source changes."""
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess


def documentation_only(paths):
    def documentation(path):
        p = PurePosixPath(path)
        return ((p.suffix == ".md" and (len(p.parts) == 1 or p.parts[0] == "docs" or
                 path == ".github/PULL_REQUEST_TEMPLATE.md")) or path == "LICENSE" or
                path.startswith(".github/ISSUE_TEMPLATE/"))
    return bool(paths) and all(documentation(path) for path in paths)


def scope(event, ref, paths):
    if event == "workflow_dispatch" or ref.startswith("refs/tags/"):
        return {"full": True, "image": True}
    if event == "push" and ref == "refs/heads/main":
        return {"full": False, "image": True}
    # Unknown events, missing diffs and non-documentation paths run every check.
    full = event != "pull_request" or not documentation_only(paths)
    return {"full": full, "image": full}


def main():
    event = os.environ["GITHUB_EVENT_NAME"]
    ref = os.environ["GITHUB_REF"]
    paths = []
    if event == "pull_request":
        payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        base = payload["pull_request"]["base"]["sha"]
        if not re.fullmatch(r"[0-9a-f]{40}", base):
            raise ValueError("Invalid pull-request base revision")
        subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", base], check=True)
        diff = subprocess.check_output(["git", "diff", "--name-only", "--no-renames", "-z", base, "HEAD"])
        paths = [p.decode("utf-8", "surrogateescape") for p in diff.split(b"\0") if p]
    selected = scope(event, ref, paths)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for key, value in selected.items():
            output.write(f"{key}={str(value).lower()}\n")
    print(json.dumps({"event": event, "full": selected["full"], "image": selected["image"],
                      "documentation_only": documentation_only(paths)}))


if __name__ == "__main__":
    main()
