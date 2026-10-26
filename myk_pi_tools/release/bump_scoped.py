"""Scoped version bumping driven by the release plan.

Consumes ``release plan`` (issue #965): bumps ONLY the affected packages'
version-files, each to its own proposed version. The repo tag for the
release is the HIGHEST proposed version. No git operations — same
contract as ``bump-version``.

Without a release-map.toml this command refuses to run: the lockstep
flow (``bump-version`` with all detected files) is the default and stays
untouched.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from myk_pi_tools.logger import create_logger
from myk_pi_tools.release.bump_version import bump_version_files
from myk_pi_tools.release.plan import ReleasePlanner
from myk_pi_tools.release.release_map import (
    ReleaseMapError,
    find_release_map,
    load_release_map,
)

log = create_logger("myk_pi_tools.release.bump_scoped")


def _semver_key(version: str) -> tuple[int, int, int]:
    """Sort key for plain x.y.z versions (raises on non-semver)."""
    parts = version.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise RuntimeError(f"cannot compare non-semver version {version!r}")
    return (int(parts[0]), int(parts[1]), int(parts[2]))


def run(
    repo_root: Path,
    *,
    force_packages: tuple[str, ...] = (),
    version_override: str | None = None,
    as_json: bool = False,
) -> None:
    """CLI entry for ``myk-pi-tools release bump-scoped``.

    Requires a release-map.toml. Errored packages abort BEFORE any file is
    written (the plan must be clean; use ``release plan`` to diagnose).
    An explicit ``version_override`` sets every affected package to that
    version (the ``/release X.Y.Z`` escape hatch); the tag is then that
    version.
    """
    map_path = find_release_map(repo_root)
    if map_path is None:
        print(
            "error: no release-map.toml found — scoped bumping is not configured. "
            "Use `myk-pi-tools release bump-version` for the lockstep flow.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    try:
        release_map = load_release_map(repo_root)
    except ReleaseMapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    unknown_forced = [p for p in force_packages if p not in {x.name for x in release_map.packages}]
    if unknown_forced:
        print(f"error: --force-package names not in the map: {', '.join(unknown_forced)}", file=sys.stderr)
        raise SystemExit(1)

    planner = ReleasePlanner(repo_root, release_map, force_packages=force_packages)
    plans = planner.plan()

    # Gate on errors BEFORE writing anything: a partial plan must never
    # produce a partial bump (Qodo-style containment, phase 2 contract).
    errored = [p for p in plans if p.error]
    if errored:
        for p in errored:
            print(f"error: {p.name}: {p.error}", file=sys.stderr)
        print(
            "error: the release plan has errored packages — fix or exclude them "
            "before bumping (`myk-pi-tools release plan` to diagnose)",
            file=sys.stderr,
        )
        raise SystemExit(1)

    affected = [p for p in plans if p.affected]
    if not affected:
        if as_json:
            print(json.dumps({"status": "nothing-to-bump", "packages": [], "tag": None}))
        else:
            print("Nothing to bump — no package changed since its last publish.")
        return

    # Explicit version overrides every affected package's proposal.
    if version_override is not None:
        for p in affected:
            p.proposed_version = version_override

    tag = max((p.proposed_version for p in affected if p.proposed_version), key=_semver_key)

    # Pre-validate every affected package's version files against the
    # detector BEFORE the first write, so an unmapped/renamed file aborts
    # before any file changes (writes themselves stay atomic per file).
    from myk_pi_tools.release.detect_versions import detect_version_files

    detected_paths = {vf.path for vf in detect_version_files(repo_root)}
    entries = {pkg.name: pkg for pkg in release_map.packages}
    per_package_files: list[tuple[str, str, list[str]]] = []
    for p in affected:
        assert p.proposed_version is not None  # affected ⇒ proposed set
        files = list(entries[p.name].version_files)
        missing = [f for f in files if f not in detected_paths]
        if missing:
            print(
                f"error: {p.name}: version files not detected in the repository: {missing}",
                file=sys.stderr,
            )
            raise SystemExit(1)
        per_package_files.append((p.name, p.proposed_version, files))

    packages_out: list[dict[str, object]] = []
    updated_all: list[dict[str, str]] = []
    skipped_all: list[dict[str, str]] = []
    for name, new_version, files in per_package_files:
        result = bump_version_files(new_version=new_version, files=files, root=repo_root)
        if result.status == "failed":
            print(f"error: {name}: {result.error}", file=sys.stderr)
            print(
                "error: bump failed mid-way — previously written files remain on disk; "
                "restore them (git checkout -- .) before retrying",
                file=sys.stderr,
            )
            raise SystemExit(1)
        updated_all.extend(result.updated)
        skipped_all.extend(result.skipped)
        packages_out.append({
            "name": name,
            "version": new_version,
            "files": [u["path"] for u in result.updated],
        })
        log.info("scoped bump: %s -> %s (%d files)", name, new_version, len(result.updated))

    payload = {
        "status": "success",
        "tag": tag,
        "packages": packages_out,
        "updated": updated_all,
        "skipped": skipped_all,
    }
    if as_json:
        print(json.dumps(payload))
    else:
        print(f"Scoped bump — repo tag: {tag}")
        for name, new_version, files in per_package_files:
            print(f"  {name}  ->  {new_version}  ({len(files)} files)")
        for u in updated_all:
            print(f"  updated: {u['path']} ({u['old_version']} -> {u['new_version']})")
        for sk in skipped_all:
            print(f"  skipped: {sk['path']} ({sk['reason']})")
