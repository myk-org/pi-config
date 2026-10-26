"""Scoped version bumping driven by the release plan.

Consumes ``release plan`` (issue #965): bumps ONLY the affected packages'
version-files, each to its own proposed version. Tags are PER PACKAGE
(``<name>@<version>``) — each package versions from its own registry
history, so versions are never forced past the repo's global tag
sequence (no 4.18.0 → 4.23.0 jumps for a skipped package). No git
operations — same contract as ``bump-version``.

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


def _validate_semver(version: str, where: str) -> tuple[int, int, int]:
    """Validate a strict x.y.z version and return its sort key.

    Rejects malformed versions (``1.2``) and leading-zero components
    (``01.2.3``) with a controlled error (Qodo PR #967).
    """
    parts = version.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError(f"{where}: {version!r} is not a valid x.y.z version")
    if any(len(p) > 1 and p.startswith("0") for p in parts):
        raise ValueError(f"{where}: {version!r} has a leading-zero component")
    return (int(parts[0]), int(parts[1]), int(parts[2]))


def _parse_set_values(set_values: tuple[str, ...]) -> dict[str, str]:
    """Parse ``--set name=version`` arguments into a dict."""
    result: dict[str, str] = {}
    for raw in set_values:
        name, sep, version = raw.partition("=")
        if not sep or not name.strip() or not version.strip():
            raise SystemExit(f"error: --set expects NAME=VERSION, got {raw!r}")
        result[name.strip()] = version.strip()
    return result


def run(
    repo_root: Path,
    *,
    force_packages: tuple[str, ...] = (),
    version_override: str | None = None,
    set_versions: dict[str, str] | None = None,
    as_json: bool = False,
) -> None:
    """CLI entry for ``myk-pi-tools release bump-scoped``.

    Requires a release-map.toml. Errored packages abort BEFORE any file is
    written (the plan must be clean; use ``release plan`` to diagnose).

    Versions are ALWAYS explicit — the plan detects WHAT changed, the
    next version is a human/LLM decision, never a mechanical one
    (issue #965 phase 2):

    - ``set_versions`` (``--set name=version``): the per-package versions
      decided in the ``/release`` flow. Every affected package must have
      one.
    - ``version_override`` (``--version X.Y.Z``): one version for every
      affected package (the ``/release X.Y.Z`` escape hatch).
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

    # Validate explicit --set names against the map (typo safety) before
    # anything else runs.
    if set_versions:
        known = {x.name for x in release_map.packages}
        unknown_set = [n for n in set_versions if n not in known]
        if unknown_set:
            print(
                f"error: --set names not in the map: {', '.join(sorted(unknown_set))}",
                file=sys.stderr,
            )
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

    # A --set for a package the plan did not mark affected is a decision
    # conflict — it needs an explicit --force-package to proceed.
    if set_versions:
        not_affected = [n for n in set_versions if n not in {p.name for p in affected}]
        if not_affected:
            print(
                f"error: --set names not in the affected set: {', '.join(sorted(not_affected))} "
                "(use --force-package to include them)",
                file=sys.stderr,
            )
            raise SystemExit(1)

    if not affected:
        if as_json:
            print(json.dumps({"status": "nothing-to-bump", "packages": []}))
        else:
            print("Nothing to bump — no package changed since its last publish.")
        return

    # Version decision: explicit, always. No mechanical fallback — the
    # LLM and user decide the versions; this command only writes them.
    # Per package, --set wins over the global --version (documented
    # priority — Qodo PR #967: the old if/elif let --version silently
    # discard every --set choice).
    versions: dict[str, str] = {}
    for p in affected:
        v = (set_versions or {}).get(p.name, version_override)
        if v is None:
            print(
                f"error: no version for {p.name} — pass --set NAME=VERSION per "
                "affected package (or --version for all); the plan does not "
                "propose versions",
                file=sys.stderr,
            )
            raise SystemExit(1)
        versions[p.name] = v

    # Validate every explicit version BEFORE any write: strict x.y.z, no
    # leading zeros (Qodo PR #967), and strictly greater than the
    # package's PUBLISHED version — each package versions from its own
    # registry history only. There is deliberately NO global repo-tag
    # guard: per-package tags (``name@version``) cannot collide, and a
    # package skipped for N releases must not be forced past the global
    # tag sequence (issue #965 — no 4.18.0 → 4.23.0 jumps).
    for p in affected:
        try:
            key = _validate_semver(versions[p.name], f"version for {p.name}")
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc
        published_key = None
        if p.published_version:
            try:
                published_key = _validate_semver(p.published_version, f"published version of {p.name}")
            except ValueError:
                published_key = None  # registry published something exotic; skip the guard
        if published_key is not None and key <= published_key:
            print(
                f"error: version for {p.name} is {versions[p.name]!r} but the registry "
                f"already has {p.published_version!r} — a release must be greater",
                file=sys.stderr,
            )
            raise SystemExit(1)

    # Pre-validate every affected package's version files against the
    # detector BEFORE the first write, so an unmapped/renamed file aborts
    # before any file changes (writes themselves stay atomic per file).
    # The detected list is passed through to bump_version_files so the
    # scan runs ONCE for the whole bump, not once per package.
    from myk_pi_tools.release.detect_versions import detect_version_files

    detected_files = detect_version_files(repo_root)
    detected_paths = {vf.path for vf in detected_files}
    entries = {pkg.name: pkg for pkg in release_map.packages}
    per_package_files: list[tuple[str, str, list[str]]] = []
    for p in affected:
        files = list(entries[p.name].version_files)
        missing = [f for f in files if f not in detected_paths]
        if missing:
            print(
                f"error: {p.name}: version files not detected in the repository: {missing}",
                file=sys.stderr,
            )
            raise SystemExit(1)
        per_package_files.append((p.name, versions[p.name], files))

    packages_out: list[dict[str, object]] = []
    updated_all: list[dict[str, str]] = []
    skipped_all: list[dict[str, str]] = []
    for name, new_version, files in per_package_files:
        result = bump_version_files(
            new_version=new_version,
            files=files,
            root=repo_root,
            detected=detected_files,
            quiet=True,
        )
        if result.status == "failed":
            print(f"error: {name}: {result.error}", file=sys.stderr)
            print(
                "error: bump failed mid-way — previously written files remain on disk; "
                "restore them (git checkout -- .) before retrying",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if result.skipped:
            # A package with multiple manifests must move them TOGETHER —
            # a partial update ships mismatched versions (Qodo PR #967).
            print(
                f"error: {name}: some version files could not be updated: "
                f"{[sk['path'] for sk in result.skipped]} — aborting; previously "
                "written files remain on disk (git checkout -- . to restore)",
                file=sys.stderr,
            )
            raise SystemExit(1)
        updated_all.extend(result.updated)
        skipped_all.extend(result.skipped)
        packages_out.append({
            "name": name,
            "version": new_version,
            "tag": f"{name}@{new_version}",
            "files": [u["path"] for u in result.updated],
        })
        log.info("scoped bump: %s -> %s (%d files)", name, new_version, len(result.updated))

    payload = {
        "status": "success",
        "packages": packages_out,
        "updated": updated_all,
        "skipped": skipped_all,
    }
    if as_json:
        print(json.dumps(payload))
    else:
        print("Scoped bump — per-package tags:")
        for pkg in packages_out:
            print(f"  {pkg['name']}  ->  {pkg['version']}  (tag {pkg['tag']})")
        for u in updated_all:
            print(f"  updated: {u['path']} ({u['old_version']} -> {u['new_version']})")
        for sk in skipped_all:
            print(f"  skipped: {sk['path']} ({sk['reason']})")
