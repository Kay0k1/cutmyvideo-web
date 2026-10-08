#!/usr/bin/env python3
"""Bound retired cutmy releases/images and build cache; default is a dry run."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

from operations import atomic_json, command, config, lock, number

RELEASE = re.compile(r"[0-9a-f]{12}-[0-9a-f]{12}")
PROJECT_IMAGES = {"cutmy-core", "cutmy-web"}


def output(argv):
    return command(argv, stdout=subprocess.PIPE).stdout.decode().strip()


def inventory():
    images = {}
    for line in output(["docker", "image", "ls", "--no-trunc", "--format", "{{json .}}"]).splitlines():
        row = json.loads(line)
        if row["Repository"] in PROJECT_IMAGES and RELEASE.fullmatch(row["Tag"]):
            images[row["Repository"] + ":" + row["Tag"]] = row
        elif row["Repository"] == "cutmy-audit-load" and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", row["Tag"]):
            images[row["Repository"] + ":" + row["Tag"]] = row
    # Include stopped containers: they may be deliberately retained for recovery.
    containers = output(["docker", "container", "ls", "--all", "--quiet"]).splitlines()
    used, used_ids = set(), set()
    if containers:
        if not all(re.fullmatch(r"[0-9a-f]{12,64}", value) for value in containers):
            raise RuntimeError("Invalid container inventory")
        for row in output(["docker", "container", "inspect", "--format", "{{.Image}} {{.Config.Image}}", *containers]).splitlines():
            image_id, ref = row.split()
            used_ids.add(image_id)
            used.add(ref)
    # An image ID or a different alias still pins every matching project tag.
    used.update(ref for ref, row in images.items() if row["ID"] in used_ids)
    return images, used


def plan(install, images, used, env, now):
    install = Path(install).resolve()
    releases = install / "releases"
    link = install / "current"
    if not link.is_symlink():
        raise RuntimeError("Housekeeping requires an active release symlink")
    current = link.resolve(strict=True)
    if current.parent != releases or not RELEASE.fullmatch(current.name):
        raise RuntimeError("Active release is outside the managed releases directory")
    env_path = Path(env.get("CUTMY_ENV_FILE", str(install / "shared/production.env")))
    tag = [line.partition("=")[2].strip().strip("\"'") for line in env_path.read_text().splitlines() if line.startswith("RELEASE_TAG=")]
    if tag != [current.name]:
        raise RuntimeError("Release link and operator configuration disagree")
    count = number(env, "CUTMY_RELEASES_KEEP", 2, minimum=2)
    grace = number(env, "CUTMY_CLEANUP_GRACE_HOURS", 24) * 3600
    candidates = [p for p in releases.iterdir() if RELEASE.fullmatch(p.name) and p.is_dir() and not p.is_symlink()]
    # Preserve only complete rollback candidates (both images are available).
    # Current always stays, independent of directory age or image inventory.
    rollback = sorted((p for p in candidates if p != current and (p / "release.env").is_file()
                       and all(f"{repo}:{p.name}" in images for repo in PROJECT_IMAGES)),
                      key=lambda p: p.stat().st_mtime, reverse=True)
    keep = {current.name}
    previous_link = install / "previous"
    if previous_link.is_symlink():
        previous = previous_link.resolve(strict=True)
        if previous.parent != releases or not RELEASE.fullmatch(previous.name):
            raise RuntimeError("Previous release is outside the managed releases directory")
        keep.add(previous.name)
    for candidate in rollback:
        if len(keep) >= count:
            break
        keep.add(candidate.name)
    # Any container's release also pins its code, including running load tests.
    keep.update(ref.split(":", 1)[1] for ref in used if ref.split(":", 1)[0] in PROJECT_IMAGES and ":" in ref)
    removed = [p.name for p in candidates if p.name not in keep and now - p.stat().st_mtime >= grace]
    protected = {f"{repo}:{tag}" for repo in PROJECT_IMAGES for tag in keep}
    image_removals = []
    for ref in sorted(images):
        if ref in protected or ref in used:
            continue
        created = dt.datetime.fromisoformat(json.loads(output(["docker", "image", "inspect", ref, "--format", "{{json .Created}}"])).replace("Z", "+00:00")).timestamp()
        if now - created >= grace:
            image_removals.append(ref)
    return {"kept_releases": sorted(keep), "remove_releases": sorted(removed), "remove_image_tags": image_removals,
            "build_cache_max_bytes": number(env, "CUTMY_BUILD_CACHE_MAX_BYTES", 512 * 1024**2)}


def housekeeping(env, apply=False):
    install = Path(env.get("CUTMY_INSTALL_DIR", "/opt/cutmy")).resolve()
    shared = Path(env.get("CUTMY_SHARED_DIR", str(install / "shared")))
    with lock(shared / "deployment.lock"):
        images, used = inventory()
        result = plan(install, images, used, env, time.time())
        result["applied"] = apply
        if apply:
            # No force, container removal, volume pruning, or database/media paths.
            for ref in result["remove_image_tags"]:
                command(["docker", "image", "rm", ref], stdout=subprocess.DEVNULL)
            for name in result["remove_releases"]:
                path = install / "releases" / name
                if path.is_symlink() or path.resolve().parent != install / "releases":
                    raise RuntimeError("Release path changed during housekeeping")
                shutil.rmtree(path)
            command(["docker", "buildx", "prune", "--force", "--all", "--max-used-space", str(result["build_cache_max_bytes"])],
                    timeout=300, stdout=subprocess.DEVNULL)
            result["completed_unix"] = time.time()
            atomic_json(shared / "housekeeping-status.json", result)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply the reviewed retention plan")
    args = parser.parse_args()
    print(json.dumps(housekeeping(config(), args.apply), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        raise SystemExit(str(error) if isinstance(error, RuntimeError) else "Housekeeping failed validation or I/O")
