#!/usr/bin/env python3
"""Build and package a Wheel Tracker Windows release.

The script checks that every version file agrees, optionally runs the offline
validation suite, builds the NSIS installer, then writes the SHA-256 sidecar
and a release manifest under dist/release/. It never touches the user ledger.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "ui"
APP = ROOT / "crates" / "wheel-app"
INSTALLERS = ROOT / "target" / "release" / "bundle" / "nsis"
DIST = ROOT / "dist" / "release"


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def workspace_version() -> str:
    text = read(ROOT / "Cargo.toml")
    block = re.search(r"\[workspace\.package\](.*?)(?=\n\[|\Z)", text, re.S)
    if not block:
        fail("Cargo.toml has no [workspace.package] section")
    match = re.search(r'^version\s*=\s*"([^"]+)"', block.group(1), re.M)
    if not match:
        fail("Cargo.toml has no workspace version")
    return match.group(1)


def lock_version(name: str) -> str | None:
    text = read(ROOT / "Cargo.lock")
    match = re.search(
        rf'\[\[package\]\]\s*\nname = "{re.escape(name)}"\s*\nversion = "([^"]+)"',
        text,
    )
    return match.group(1) if match else None


def check_versions() -> str:
    version = workspace_version()
    problems: list[str] = []

    app_cargo = read(APP / "Cargo.toml")
    if not re.search(r"^version\.workspace\s*=\s*true", app_cargo, re.M):
        problems.append("crates/wheel-app/Cargo.toml must inherit version.workspace = true")

    tauri = json.loads(read(APP / "tauri.conf.json"))
    if tauri.get("version") != version:
        problems.append(f"tauri.conf.json is {tauri.get('version')}, expected {version}")

    package = json.loads(read(UI / "package.json"))
    if package.get("version") != version:
        problems.append(f"ui/package.json is {package.get('version')}, expected {version}")

    lock = json.loads(read(UI / "package-lock.json"))
    if lock.get("version") != version:
        problems.append(f"ui/package-lock.json is {lock.get('version')}, expected {version}")
    packages = lock.get("packages") or {}
    root_package = packages.get("") or {}
    if root_package.get("version") != version:
        problems.append("ui/package-lock.json packages[''] version differs")

    for crate in ("wheel-app", "wheel-core"):
        found = lock_version(crate)
        if found != version:
            problems.append(f"Cargo.lock has {crate} {found}, expected {version}")

    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        raise SystemExit(1)

    print(f"version: {version}")
    return version


def run(command: list[str], env: dict[str, str] | None = None) -> None:
    print("+ " + " ".join(command))
    # npm is a .cmd shim on Windows; CreateProcess needs cmd.exe to launch it.
    if os.name == "nt" and command[0] == "npm":
        command = [os.environ.get("ComSpec", "cmd.exe"), "/c", *command]
    subprocess.run(command, cwd=ROOT, env=env, check=True)


def validate() -> None:
    run(["cargo", "test", "--offline", "--workspace"])
    run(["cargo", "clippy", "--offline", "-p", "wheel-app", "--no-deps", "--", "-D", "warnings"])
    run(["npm", "--prefix", "ui", "run", "build"])


def build() -> None:
    env = dict(os.environ)
    env["CARGO_NET_OFFLINE"] = "true"
    run(["npm", "--prefix", "ui", "run", "desktop:build", "--", "--bundles", "nsis"], env=env)


def installer(version: str) -> Path:
    expected = INSTALLERS / f"Wheel Tracker_{version}_x64-setup.exe"
    if expected.exists():
        return expected
    found = sorted(INSTALLERS.glob("*.exe"))
    if not found:
        fail(f"no installer under {INSTALLERS}; run without --no-build first")
    if len(found) > 1:
        fail(f"no installer named {expected.name}; found {len(found)} others under {INSTALLERS}")
    return found[0]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def rust_target() -> str:
    try:
        result = subprocess.run(
            ["rustc", "-vV"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        for line in result.stdout.splitlines():
            if line.startswith("host:"):
                return line.split(":", 1)[1].strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    return "unknown"


def updater_manifest(version: str, path: Path, built_at: str) -> Path | None:
    signature_path = path.with_name(path.name + ".sig")
    if not signature_path.exists():
        print(f"warning: {signature_path.name} missing; updater manifest not written")
        return None

    signature = signature_path.read_text(encoding="utf-8").strip()
    if not signature:
        fail(f"{signature_path} is empty")

    # GitHub replaces spaces in asset names with dots; the updater downloads
    # through the release asset URL, so mirror that name exactly.
    asset_name = path.name.replace(" ", ".")
    url = (
        f"https://github.com/yixin8875/wheeltracker/releases/download/"
        f"v{version}/{asset_name}"
    )
    document = {
        "version": version,
        "notes": f"Wheel Tracker v{version}",
        "pub_date": built_at,
        "platforms": {
            "windows-x86_64": {
                "signature": signature,
                "url": url,
            }
        },
    }
    path_out = DIST / "latest.json"
    path_out.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return path_out


def package(version: str) -> None:
    path = installer(version)
    digest = sha256(path)
    built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    DIST.mkdir(parents=True, exist_ok=True)

    sidecar = DIST / f"{path.name}.sha256"
    sidecar.write_text(f"{digest}  {path.name}\n", encoding="utf-8")

    updater_path = updater_manifest(version, path, built_at)
    manifest = {
        "product": "Wheel Tracker",
        "version": version,
        "gitCommit": git_commit(),
        "builtAt": built_at,
        "target": rust_target(),
        "installer": {
            "fileName": path.name,
            "sizeBytes": path.stat().st_size,
            "sha256": digest,
        },
        "signing": "unsigned",
        "updater": "tauri-v2-signed" if updater_path else "not-configured",
    }
    manifest_path = DIST / "release-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"installer: {path}")
    print(f"sha256:    {digest}")
    print(f"sidecar:   {sidecar}")
    print(f"manifest:  {manifest_path}")
    if updater_path:
        print(f"updater:   {updater_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build and package Wheel Tracker.")
    parser.add_argument("--skip-tests", action="store_true", help="skip cargo tests, clippy and the UI build")
    parser.add_argument("--no-build", action="store_true", help="reuse the existing NSIS installer")
    args = parser.parse_args()

    version = check_versions()
    if not args.skip_tests:
        validate()
    if not args.no_build:
        build()
    package(version)


if __name__ == "__main__":
    main()
