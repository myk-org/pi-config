"""Scoped-release map: per-repo package map for affected-only releases.

A repo opts into scoped releases by committing a ``release-map.toml`` at
its root. Presence of the file is the switch; absence keeps the generic
lockstep release behavior untouched (issue #965). This module only PARSES
and validates the map — the detection engine lives in ``plan.py``.

Schema (see the pi-config repo root for a live example)::

    [release]
    mode = "scoped"                      # only "scoped" is meaningful today
    exclude-paths = ["tests/"]           # global excludes, fnmatch globs ok

    [[package]]
    name = "pi-orchestrator-config"      # display + registry lookup name
    registry = "npm"                     # npm | pypi | npm+pypi
    version-files = ["package.json"]     # bump targets + git-history anchors
    paths = ["extensions/"]              # source paths affecting the artifact
    exclude-paths = ["scripts/x/"]       # carved out of paths

    [container]
    rebuild-paths = ["Dockerfile"]       # non-versioned; reported only
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from pathlib import Path

from myk_pi_tools.logger import create_logger

log = create_logger("myk_pi_tools.release.map")

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - py<3.11 fallback
    import tomli as tomllib  # type: ignore[no-redef]

RELEASE_MAP_FILENAME = "release-map.toml"

VALID_REGISTRIES = frozenset({"npm", "pypi", "npm+pypi"})


class ReleaseMapError(Exception):
    """Raised when release-map.toml is present but invalid.

    A present-but-invalid map must FAIL LOUD, not fall back silently to
    lockstep: the repo declared scoped releases, and quietly ignoring that
    declaration would republish (or skip) packages against the operator's
    intent.
    """


@dataclass(frozen=True)
class PackageEntry:
    """One versioned package in the release map."""

    name: str
    registry: str
    version_files: tuple[str, ...]
    paths: tuple[str, ...]
    exclude_paths: tuple[str, ...] = ()
    npm_name: str | None = None
    pypi_name: str | None = None

    def registry_names(self) -> list[tuple[str, str]]:
        """(registry, package-name) pairs to query for the last published
        version, in priority order. The map ``name`` is the default
        registry name; npm-name / pypi-name override it (scoped npm
        packages, renamed PyPI distributions)."""
        pairs: list[tuple[str, str]] = []
        if "npm" in self.registry:
            pairs.append(("npm", self.npm_name or self.name))
        if "pypi" in self.registry:
            pairs.append(("pypi", self.pypi_name or self.name))
        return pairs

    def affects(self, changed_path: str) -> bool:
        """True when a changed repo path affects this package.

        A path matches when it falls under one of ``paths`` (prefix match
        on path segments, so ``extensions/`` covers
        ``extensions/orchestrator/x.ts``) AND under none of the package's
        or the map's excludes (fnmatch globs allowed, same prefix
        semantics). Over-inclusion is the accepted failure mode: an
        ambiguous path maps to every plausible package.
        """
        if not _path_under_any(changed_path, self.paths):
            return False
        if _path_under_any(changed_path, self.exclude_paths):
            return False
        return True


@dataclass(frozen=True)
class ReleaseMap:
    """Parsed release-map.toml."""

    mode: str
    packages: tuple[PackageEntry, ...]
    global_excludes: tuple[str, ...] = ()
    container_rebuild_paths: tuple[str, ...] = field(default=())

    def affected_packages(self, changed_paths: list[str]) -> list[PackageEntry]:
        """Packages whose artifact content changed for the given paths."""
        # Global excludes apply before any package match: tests and
        # generated docs never trigger a release by themselves.
        effective = [p for p in changed_paths if not _path_under_any(p, self.global_excludes)]
        return [pkg for pkg in self.packages if any(pkg.affects(p) for p in effective)]


def _segments(value: str) -> list[str]:
    return [seg for seg in value.split("/") if seg]


def _glob_segments_match(path_segs: list[str], pattern_segs: list[str]) -> bool:
    """fnmatch per path SEGMENT — a ``*`` in one segment never consumes
    ``/`` (Qodo PR #966: full-path fnmatch let ``packages/*/tests/`` also
    exclude the deeper ``packages/a/b/tests/``). The pattern is a
    DIRECTORY prefix: files under it match, so the path may be deeper
    than the pattern but never shallower."""
    if len(path_segs) < len(pattern_segs):
        return False
    return all(fnmatch.fnmatch(p, pat) for p, pat in zip(path_segs, pattern_segs, strict=False))


def _path_under_any(path: str, prefixes: tuple[str, ...]) -> bool:
    """Prefix-or-glob membership with path-segment semantics.

    ``extensions/`` matches ``extensions/x.ts`` and ``extensions/`` itself
    but not ``extensions-foo/``. A prefix containing glob metacharacters
    (``packages/*/tests/``) matches exactly that segment depth.
    """
    path_segs = _segments(path)
    for prefix in prefixes:
        if any(ch in prefix for ch in "*?["):
            if _glob_segments_match(path_segs, _segments(prefix.rstrip("/"))):
                return True
            continue
        norm = prefix.rstrip("/")
        if path == norm or path.startswith(norm + "/"):
            return True
    return False


def find_release_map(repo_root: Path) -> Path | None:
    """Return the release-map.toml path, or None (lockstep mode)."""
    candidate = repo_root / RELEASE_MAP_FILENAME
    return candidate if candidate.is_file() else None


def load_release_map(repo_root: Path) -> ReleaseMap:
    """Parse and validate release-map.toml under ``repo_root``.

    Raises ReleaseMapError on any schema violation. Callers treat a
    missing file as lockstep (use find_release_map first) and an invalid
    file as a hard error (see ReleaseMapError).
    """
    map_path = find_release_map(repo_root)
    if map_path is None:
        raise ReleaseMapError(f"no {RELEASE_MAP_FILENAME} under {repo_root}")

    try:
        raw = tomllib.loads(map_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise ReleaseMapError(f"{RELEASE_MAP_FILENAME} is not valid TOML: {exc}") from exc

    release_section = raw.get("release")
    if not isinstance(release_section, dict):
        raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: missing [release] section")

    mode = release_section.get("mode", "scoped")
    if not isinstance(mode, str) or not mode:
        raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: [release].mode must be a string")
    if mode != "scoped":
        # Only "scoped" is a meaningful mode today — anything else would
        # silently still run the scoped planner (Qodo PR #966).
        raise ReleaseMapError(
            f"{RELEASE_MAP_FILENAME}: [release].mode must be 'scoped' (got {mode!r}); "
            "remove the file for lockstep releases"
        )

    global_excludes = _string_tuple(release_section, "exclude-paths", "[release]")

    packages: list[PackageEntry] = []
    seen_names: set[str] = set()
    seen_version_files: dict[str, str] = {}
    for i, entry in enumerate(raw.get("package", [])):
        where = f"[[package]] #{i + 1}"
        if not isinstance(entry, dict):
            raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: {where} must be a table")
        for key in ("name", "registry"):
            value = entry.get(key)
            if not isinstance(value, str) or not value:
                raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: {where}.{key} is required")
        name = entry["name"]
        registry = entry["registry"]
        if name in seen_names:
            raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: duplicate package name {name!r}")
        seen_names.add(name)
        if registry not in VALID_REGISTRIES:
            raise ReleaseMapError(
                f"{RELEASE_MAP_FILENAME}: {where}.registry {registry!r} not in {sorted(VALID_REGISTRIES)}"
            )
        version_files = _string_tuple(entry, "version-files", where)
        if not version_files:
            raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: {where}.version-files is required (bump targets)")
        for vf in version_files:
            if vf in seen_version_files:
                raise ReleaseMapError(
                    f"{RELEASE_MAP_FILENAME}: version file {vf!r} belongs to both "
                    f"{seen_version_files[vf]!r} and {name!r}"
                )
            seen_version_files[vf] = name
        paths = _string_tuple(entry, "paths", where)
        if not paths:
            raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: {where}.paths is required")
        exclude = _string_tuple(entry, "exclude-paths", where)
        npm_name = entry.get("npm-name")
        pypi_name = entry.get("pypi-name")
        for label, value in (("npm-name", npm_name), ("pypi-name", pypi_name)):
            if value is not None and (not isinstance(value, str) or not value):
                raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: {where}.{label} must be a string")
        if npm_name and "npm" not in registry:
            raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: {where}.npm-name set but registry is {registry!r}")
        if pypi_name and "pypi" not in registry:
            raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: {where}.pypi-name set but registry is {registry!r}")
        packages.append(
            PackageEntry(
                name=name,
                registry=registry,
                version_files=version_files,
                paths=paths,
                exclude_paths=exclude,
                npm_name=npm_name,
                pypi_name=pypi_name,
            )
        )

    if not packages:
        raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: no [[package]] entries")

    container = raw.get("container", {})
    if not isinstance(container, dict):
        raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: [container] must be a table")
    rebuild_paths = _string_tuple(container, "rebuild-paths", "[container]")

    log.debug(
        "release map loaded: %d packages, %d global excludes",
        len(packages),
        len(global_excludes),
    )
    return ReleaseMap(
        mode=mode,
        packages=tuple(packages),
        global_excludes=global_excludes,
        container_rebuild_paths=rebuild_paths,
    )


def _string_tuple(entry: dict, key: str, where: str) -> tuple[str, ...]:
    """Read a required-or-optional string-list field as a tuple."""
    value = entry.get(key, [])
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        raise ReleaseMapError(f"{RELEASE_MAP_FILENAME}: {where}.{key} must be a list of strings")
    return tuple(value)
