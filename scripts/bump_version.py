#!/usr/bin/env python3
"""Bump the workspace patch version in every release manifest.

Prints the new version to stdout so a workflow can capture it.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def next_patch(version: str) -> str:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    if not match:
        fail(f"workspace version {version!r} is not X.Y.Z")
    major, minor, patch = match.groups()
    return f"{major}.{minor}.{int(patch) + 1}"


def main() -> None:
    cargo_path = ROOT / "Cargo.toml"
    cargo = read(cargo_path)
    block = re.search(r"\[workspace\.package\](.*?)(?=\n\[|\Z)", cargo, re.S)
    if not block:
        fail("Cargo.toml has no [workspace.package] section")
    version_match = re.search(r'^version\s*=\s*"([^"]+)"', block.group(1), re.M)
    if not version_match:
        fail("Cargo.toml has no workspace version")

    current = version_match.group(1)
    new = next_patch(current)

    cargo = cargo.replace(f'version = "{current}"', f'version = "{new}"', 1)

    lock_path = ROOT / "Cargo.lock"
    lock = read(lock_path)
    for crate in ("wheel-app", "wheel-core"):
        pattern = re.compile(
            rf'(\[\[package\]\]\s*\nname = "{re.escape(crate)}"\s*\nversion = ")[^"]+(")'
        )
        lock, count = pattern.subn(rf"\g<1>{new}\g<2>", lock)
        if count != 1:
            fail(f"Cargo.lock has {count} entries for {crate}, expected 1")

    tauri_path = ROOT / "crates" / "wheel-app" / "tauri.conf.json"
    tauri = read(tauri_path)
    tauri, count = re.subn(r'("version"\s*:\s*")[^"]+(")', rf"\g<1>{new}\g<2>", tauri, count=1)
    if count != 1:
        fail("tauri.conf.json has no version field")

    package_path = ROOT / "ui" / "package.json"
    package = read(package_path)
    package, count = re.subn(r'("version"\s*:\s*")[^"]+(")', rf"\g<1>{new}\g<2>", package, count=1)
    if count != 1:
        fail("ui/package.json has no version field")

    lock_package_path = ROOT / "ui" / "package-lock.json"
    package_lock = read(lock_package_path)
    package_lock, count = re.subn(
        r'("version"\s*:\s*")[^"]+(")', rf"\g<1>{new}\g<2>", package_lock, count=2
    )
    if count != 2:
        fail("ui/package-lock.json must contain root and packages[''] versions")

    cargo_path.write_text(cargo, encoding="utf-8")
    lock_path.write_text(lock, encoding="utf-8")
    tauri_path.write_text(tauri, encoding="utf-8")
    package_path.write_text(package, encoding="utf-8")
    lock_package_path.write_text(package_lock, encoding="utf-8")

    print(new)


if __name__ == "__main__":
    main()
