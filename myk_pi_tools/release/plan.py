"""Scoped-release plan: which packages changed since their last publish.

Read-only detection engine behind ``myk-pi-tools release plan``
(issue #965). For each package in release-map.toml:

1. Last published version from the REGISTRY (npm view / PyPI JSON API) —
   ground truth that cannot drift from tags.
2. Anchor commit: the newest commit that touched one of the package's
   version-files AND left it at the published version (the bump commit).
   The diff window is therefore PER-PACKAGE — a package skipped for N
   releases reaches back to its own last publish.
3. ``git diff --name-only anchor..HEAD`` filtered through the map's
   paths/excludes → non-empty = affected.
4. Proposed bump from a conventional-commit scan over commits touching
   those paths (feat → minor, fix → patch, BREAKING/``!`` → major,
   default patch).

The engine never writes anything. Repos without release-map.toml stay in
lockstep mode and never reach this code path.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from myk_pi_tools.logger import create_logger
from myk_pi_tools.release.release_map import PackageEntry, ReleaseMap, _path_under_any

log = create_logger("myk_pi_tools.release.plan")

REGISTRY_TIMEOUT_SECONDS = 30
GIT_TIMEOUT_SECONDS = 60

_PY_VERSION_RE = re.compile(r'^__version__\s*=\s*["\']([^"\']+)["\']', re.MULTILINE)


@dataclass
class PackagePlan:
    """Detection result for one package."""

    name: str
    registry: str
    affected: bool = False
    forced: bool = False
    published_version: str | None = None
    anchor: str | None = None
    changed_files: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "registry": self.registry,
            "affected": self.affected,
            "forced": self.forced,
            "published_version": self.published_version,
            "anchor": self.anchor,
            "changed_files": self.changed_files,
            "error": self.error,
        }


def _git(repo_root: Path, args: list[str], timeout: int = GIT_TIMEOUT_SECONDS) -> str:
    """Run git in the repo; raise RuntimeError with context on failure."""
    cmd = ["git", "-C", str(repo_root), *args]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"git timed out: {' '.join(args[:3])}…") from exc
    if result.returncode != 0:
        raise RuntimeError(f"git failed ({' '.join(args[:3])}…): {result.stderr.strip() or result.returncode}")
    return result.stdout.strip()


def _npm_version(package: str) -> str:
    """Last published version from the npm registry."""
    try:
        result = subprocess.run(
            ["npm", "view", package, "version", "--json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=REGISTRY_TIMEOUT_SECONDS,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        # A missing npm binary or a timed-out view must surface as a
        # per-package error, not abort the whole plan (Qodo PR #966).
        raise RuntimeError(f"npm view {package} failed: {exc}") from exc
    if result.returncode != 0:
        raise RuntimeError(f"npm view {package} failed: {result.stderr.strip()[:200]}")
    version = json.loads(result.stdout)
    # A never-published name returns "null" as JSON text in some npm versions.
    if version is None or (isinstance(version, str) and version == "null"):
        raise RuntimeError(f"npm registry has no version for {package}")
    if isinstance(version, list):  # multiple tags — take the latest entry
        version = version[-1]
    if not isinstance(version, str):
        raise RuntimeError(f"npm view {package} returned unexpected payload")
    return version


def _pypi_version(package: str) -> str:
    """Last published version from PyPI's JSON API (no extra deps)."""
    url = f"https://pypi.org/pypi/{package}/json"
    try:
        with urllib.request.urlopen(url, timeout=REGISTRY_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise RuntimeError(f"PyPI has no project {package}") from exc
        raise RuntimeError(f"PyPI lookup for {package} failed: HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"PyPI lookup for {package} failed: {exc}") from exc
    version = data.get("info", {}).get("version")
    if not version:
        raise RuntimeError(f"PyPI project {package} has no version")
    return version


def registry_version(registry: str, package: str) -> str:
    """Last published version for a (registry, package-name) pair."""
    if registry == "npm":
        return _npm_version(package)
    if registry == "pypi":
        return _pypi_version(package)
    raise RuntimeError(f"unknown registry {registry!r}")


def _extract_version(content: str, file_name: str) -> str:
    """Read the version string out of a version file's content."""
    if file_name.endswith("package.json"):
        version = json.loads(content).get("version")
        if not version:
            raise RuntimeError(f"{file_name}: no .version field")
        return version
    if file_name.endswith(".py"):
        match = _PY_VERSION_RE.search(content)
        if not match:
            raise RuntimeError(f"{file_name}: no __version__ assignment")
        return match.group(1)
    if file_name.endswith(".toml"):
        try:
            import tomllib
        except ModuleNotFoundError:  # pragma: no cover
            import tomli as tomllib  # type: ignore[no-redef]
        parsed = tomllib.loads(content)
        version = parsed.get("project", {}).get("version")
        if not version:
            raise RuntimeError(f"{file_name}: no [project].version")
        return version
    raise RuntimeError(f"unsupported version file type: {file_name}")


def _find_anchor(repo_root: Path, version_files: tuple[str, ...], published: str) -> str:
    """Newest commit that touched a version file and left it at ``published``.

    ``git log -- <file>`` lists only commits that touched the file, so
    unrelated commits cannot masquerade as anchors. The first entry
    (newest-first) whose file content equals the registry version is the
    bump commit — the per-package diff origin.
    """
    for version_file in version_files:
        log_shas = _git(repo_root, ["log", "--format=%H", "--", version_file]).splitlines()
        for sha in (s for s in log_shas if s):
            try:
                content = _git(repo_root, ["show", f"{sha}:{version_file}"])
            except RuntimeError:
                continue  # file did not exist at that commit (renamed/added later)
            try:
                if _extract_version(content, version_file) == published:
                    return sha
            except RuntimeError:
                continue
    raise RuntimeError(
        f"no commit found where {list(version_files)} held published version {published!r} "
        "— registry state and git history disagree (rewritten history or foreign publish?)"
    )


class ReleasePlanner:
    """Compute the affected-package plan for a repo with a release map."""

    def __init__(
        self,
        repo_root: Path,
        release_map: ReleaseMap,
        *,
        force_packages: tuple[str, ...] = (),
        registry_lookup: Callable[[str, str], str] | None = None,
    ) -> None:
        self.repo_root = repo_root
        self.release_map = release_map
        self.force_packages = force_packages
        # Late-bound so tests can monkeypatch plan.registry_version and
        # have run()-level (Click command) tests exercise the real default
        # (Qodo PR #966 round 3 — a bound default arg ignored patches).
        self._registry_lookup = registry_lookup or registry_version

    def plan(self) -> list[PackagePlan]:
        plans: list[PackagePlan] = []
        for pkg in self.release_map.packages:
            plans.append(self._plan_package(pkg))
        return plans

    def container_rebuild(self, plans: list[PackagePlan]) -> dict[str, object]:
        """Container rebuild decision (Qodo PR #966).

        The image is not a versioned package: it rebuilds whenever ANY
        package ships, or when a rebuild-path (Dockerfile, entrypoints)
        changed since the last repo tag — the repo-level anchor, since the
        container has no per-package version history of its own.
        """
        if not self.release_map.container_rebuild_paths:
            return {"rebuild": False, "reason": "no rebuild paths configured"}
        any_affected = any(p.affected for p in plans)
        changed_paths: list[str] = []
        git_error: str | None = None
        last_tag = ""
        try:
            last_tag = _git(self.repo_root, ["describe", "--abbrev=0", "--tags"])
            changed = _git(self.repo_root, ["diff", "--name-only", f"{last_tag}..HEAD"]).splitlines()
            changed_paths = [c for c in changed if c and _path_under_any(c, self.release_map.container_rebuild_paths)]
        except RuntimeError as exc:
            # No tag yet, or git failed. Either way the rebuild-path check
            # could not run — a confident "no rebuild" here could skip an
            # image rebuild after a Dockerfile change, so the decision is
            # conservative: rebuild unless a package ships anyway (which
            # already forces a rebuild) and always report why (Qodo PR #966
            # round 3 — this used to be silently swallowed).
            git_error = str(exc)
        rebuild = any_affected or bool(changed_paths) or git_error is not None
        if any_affected:
            why = "a package ships"
        elif changed_paths:
            why = f"rebuild paths changed since {last_tag}: {changed_paths}"
        elif git_error is not None:
            why = (
                f"could not determine rebuild-path changes ({git_error}) — "
                "no repo tag or git failure; being conservative"
            )
        else:
            why = "no trigger"
        return {
            "rebuild": rebuild,
            "changed_rebuild_paths": changed_paths,
            "reason": why,
            "indeterminate": git_error is not None,
        }

    def _plan_package(self, pkg: PackageEntry) -> PackagePlan:
        result = PackagePlan(name=pkg.name, registry=pkg.registry)
        forced = pkg.name in self.force_packages
        if forced:
            result.forced = True

        # 1. Registry ground truth for the last published version. For
        #    multi-registry packages (npm+pypi) EVERY registry is queried:
        #    the artifacts share one version, so a divergence is an error
        #    on the package — not a silent npm-only answer (Qodo PR #966).
        published: str | None = None
        errors: list[str] = []
        for registry, name in pkg.registry_names():
            try:
                version = self._registry_lookup(registry, name)
            except RuntimeError as exc:
                errors.append(f"{registry}:{name}: {exc}")
                continue
            if published is None:
                published = version
            elif version != published:
                result.error = (
                    f"registry divergence: {pkg.registry_names()[0][1]} is {published!r} "
                    f"but {name} is {version!r} — the artifacts must share one version"
                )
                log.warning("release plan: %s: %s", pkg.name, result.error)
                return result
        if published is None:
            # All lookups failed (or none configured). For a read-only plan
            # this is reportable, not fatal — the package shows as errored.
            result.error = "; ".join(errors) or "no registry configured"
            log.warning("release plan: registry lookup failed for %s: %s", pkg.name, result.error)
            return result
        if errors:
            # A partial registry failure leaves the cross-registry version
            # agreement unverified. Planning from the successful registry
            # alone would hide a divergence, so the package is reported as
            # errored instead (Qodo PR #966 round 3).
            result.error = (
                f"registry lookup failed ({'; '.join(errors)}) — cross-registry "
                f"version agreement for {pkg.registry_names()} is unverified"
            )
            log.warning("release plan: %s: %s", pkg.name, result.error)
            return result
        result.published_version = published

        # 2-4 are individually error-contained: a git failure on one
        # package must not abort the plan for the others (Qodo PR #966).
        try:
            return self._plan_from_anchor(pkg, result, published, forced)
        except RuntimeError as exc:
            result.error = str(exc)
            log.warning("release plan: git operation failed for %s: %s", pkg.name, exc)
            # Forced or not: an errored package has no proposed version, so
            # it never enters the affected/shipping output (Qodo PR #966
            # round 3 — forced errored packages used to appear in both
            # lists without a usable version).
            result.affected = False
            return result

    def _plan_from_anchor(
        self,
        pkg: PackageEntry,
        result: PackagePlan,
        published: str,
        forced: bool,
    ) -> PackagePlan:
        # 2. Per-package anchor commit (the bump that produced `published`).
        anchor = _find_anchor(self.repo_root, pkg.version_files, published)
        result.anchor = anchor

        # 3. Changed paths since the anchor. GLOBAL excludes apply before
        #    any package match: tests and generated docs never trigger a
        #    release by themselves (Qodo PR #966 — the planner previously
        #    bypassed the map's global excludes for per-package matching).
        changed = _git(self.repo_root, ["diff", "--name-only", f"{anchor}..HEAD"]).splitlines()
        changed = [c for c in changed if c and not _path_under_any(c, self.release_map.global_excludes)]
        hits = [c for c in changed if pkg.affects(c)]
        result.changed_files = hits
        result.affected = bool(hits) or forced

        return result


def run(
    repo_root: Path,
    *,
    force_packages: tuple[str, ...] = (),
    as_json: bool = False,
) -> None:
    """CLI entry for ``myk-pi-tools release plan``.

    No release-map.toml → lockstep mode message, exit 0 (generic repos
    keep the default behavior; issue #965). Invalid map → hard error.
    """
    from myk_pi_tools.release.release_map import (
        ReleaseMapError,
        find_release_map,
        load_release_map,
    )

    map_path = find_release_map(repo_root)
    if map_path is None:
        if as_json:
            click_echo_json({"mode": "lockstep", "affected": []})
        else:
            print("No release-map.toml found — lockstep mode (all version files bump together).")
            print("Nothing to plan. See issue #965 for the scoped-release opt-in.")
        return

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
    container = planner.container_rebuild(plans)

    if as_json:
        click_echo_json({
            "mode": "scoped",
            "map": str(map_path),
            "affected": [p.to_dict() for p in plans if p.affected and not p.error],
            "skipped": [p.to_dict() for p in plans if not p.affected and not p.error],
            "errored": [p.to_dict() for p in plans if p.error],
            "container": container,
        })
        return

    affected = [p for p in plans if p.affected and not p.error]
    errored = [p for p in plans if p.error]
    skipped = [p for p in plans if not p.affected and not p.error]
    print(f"Scoped release plan ({release_map.mode} mode, map: {map_path.name})")
    print()
    if affected:
        print(f"Affected packages ({len(affected)} of {len(plans)}):")
        for p in affected:
            tag = " [forced]" if p.forced else ""
            print(
                f"  {p.name}  (published {p.published_version};"
                f" {len(p.changed_files)} changed files"
                f" since {(p.anchor or '?')[:8]}){tag}"
            )
    else:
        print("No affected packages — nothing to release.")
    if errored:
        # Errored packages are NOT silently "unchanged" — the operator
        # must see them (Qodo PR #966).
        print()
        print(f"Errored — registry/history could not be resolved ({len(errored)}):")
        for p in errored:
            print(f"  {p.name}: {p.error}")
    if skipped:
        print()
        print(f"Unchanged (skipped): {', '.join(p.name for p in skipped)}")
    print()
    if container.get("rebuild"):
        print(f"Container image: REBUILD — {container.get('reason')}")
    else:
        print(f"Container image: no rebuild — {container.get('reason')}")


def click_echo_json(payload: dict[str, object]) -> None:
    """Print JSON without importing click here (CLI layer owns click)."""
    print(json.dumps(payload, indent=2))
