"""Detect version files in a repository.

Scans for well-known version file patterns across common ecosystems
(Python, Node.js, Rust, Java/Kotlin) and returns found files with
their current version strings.
"""

from __future__ import annotations

import configparser
import glob
import json
import os
import re
import sys
import tomllib
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from myk_pi_tools.release._common import (
    extract_json_version,
    extract_py_version,
    extract_toml_version,
)

EXCLUDED_DIRS = frozenset({
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    ".env",
    "env",
    "node_modules",
    "__pycache__",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "dist",
    "build",
    ".eggs",
    "site-packages",
    "target",
})


@dataclass
class VersionFile:
    """A detected version file."""

    path: str
    current_version: str
    file_type: str

    def to_dict(self) -> dict[str, str]:
        """Convert to dictionary for JSON output."""
        return {
            "path": self.path,
            "current_version": self.current_version,
            "type": self.file_type,
        }


def _parse_pyproject_toml(filepath: Path) -> str | None:
    """Parse version from pyproject.toml using tomllib."""
    try:
        with filepath.open("rb") as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    return extract_toml_version(data, "project")


def _parse_package_json(filepath: Path) -> str | None:
    """Parse version from package.json."""
    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return extract_json_version(data)


def _parse_setup_cfg(filepath: Path) -> str | None:
    """Parse version from setup.cfg using configparser."""
    config = configparser.ConfigParser()
    try:
        content = filepath.read_text(encoding="utf-8")
        config.read_string(content)
    except (OSError, configparser.Error):
        return None
    try:
        version = config.get("metadata", "version")
    except (configparser.NoSectionError, configparser.NoOptionError):
        return None
    version = version.strip().strip("\"'")
    # Skip dynamic version directives (attr:, file:)
    if version.lower().startswith(("attr:", "file:")):
        return None
    return version


def _parse_cargo_toml(filepath: Path) -> str | None:
    """Parse version from Cargo.toml using tomllib."""
    try:
        with filepath.open("rb") as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    return extract_toml_version(data, "package")


def _parse_gradle(filepath: Path) -> str | None:
    """Parse version from build.gradle or build.gradle.kts."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"""^\s*version\s*=?\s*['"]([^'"]+)['"]""", content, re.MULTILINE)
    return match.group(1) if match else None


def _parse_python_version(filepath: Path) -> str | None:
    """Parse __version__ from a Python file."""
    try:
        content = filepath.read_text(encoding="utf-8")
    except OSError:
        return None
    return extract_py_version(content)


def _should_skip_dir(dir_name: str) -> bool:
    """Check if a directory should be skipped during scanning."""
    return dir_name in EXCLUDED_DIRS or dir_name.startswith(".")


def _find_python_version_files(root: Path) -> list[VersionFile]:
    """Find Python files containing __version__ assignments."""
    results: list[VersionFile] = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune excluded directories in-place to prevent traversal
        dirnames[:] = [d for d in dirnames if not _should_skip_dir(d)]
        for name in filenames:
            if name not in ("__init__.py", "version.py"):
                continue
            filepath = Path(dirpath) / name
            version = _parse_python_version(filepath)
            if version:
                results.append(
                    VersionFile(
                        path=filepath.relative_to(root).as_posix(),
                        current_version=version,
                        file_type="python_version",
                    )
                )
    return results


_ROOT_SCANNERS: list[tuple[str, Callable[[Path], str | None], str]] = [
    ("pyproject.toml", _parse_pyproject_toml, "pyproject"),
    ("package.json", _parse_package_json, "package_json"),
    ("setup.cfg", _parse_setup_cfg, "setup_cfg"),
    ("Cargo.toml", _parse_cargo_toml, "cargo"),
    ("build.gradle", _parse_gradle, "gradle"),
    ("build.gradle.kts", _parse_gradle, "gradle"),
]


def _uv_members(data: dict) -> object:
    """Dig out tool.uv.workspace.members without assuming a shape.

    A syntactically valid manifest can put a scalar at any of those levels --
    `tool = "value"` parses fine -- and chained .get() then raises
    AttributeError and aborts detection, losing every other scan. Return the raw
    value and let the caller decide.
    """
    current: object = data
    for key in ("tool", "uv", "workspace"):
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    if not isinstance(current, dict):
        return None
    return current.get("members")


_UNSET: object = object()


def _load_root_pyproject(pyproject: Path) -> dict[str, Any] | None:
    """Load root pyproject.toml once; warn on parse/read error and return None."""
    if not pyproject.is_file():
        return None
    try:
        with pyproject.open("rb") as fh:
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        # Not fatal: the other scans still run. Say so, because a silently
        # skipped uv workspace is how a member's version stopped tracking a
        # release in the first place.
        print(f"Could not read {pyproject} for uv workspace members: {exc}", file=sys.stderr)
        return None


def _load_root_package_json(package_json: Path) -> dict[str, Any] | None:
    """Load root package.json once; return None if absent or invalid."""
    if not package_json.is_file():
        return None
    try:
        data = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _find_uv_workspace_members(root: Path, *, pyproject_data: object = _UNSET) -> list[Path]:
    """Directories declared as uv workspace members in the root pyproject.toml.

    uv workspaces are separate from npm's, and this repo has one: pi-docsite is
    a uv member and not an npm workspace, so the npm scan below never saw its
    pyproject.toml and its version silently stopped tracking the release.
    """
    pyproject = root / "pyproject.toml"
    data = _load_root_pyproject(pyproject) if pyproject_data is _UNSET else pyproject_data
    if not isinstance(data, dict):
        return []
    members = _uv_members(data)
    if members is None:
        return []
    if not isinstance(members, list):
        print(
            f"Ignoring [tool.uv.workspace] members in {pyproject}: expected a list, got {type(members).__name__}",
            file=sys.stderr,
        )
        return []
    found: list[Path] = []
    for pattern in members:
        if not isinstance(pattern, str):
            print(f"Ignoring non-string uv workspace member in {pyproject}: {pattern!r}", file=sys.stderr)
            continue
        for match in sorted(glob.glob(str(root / pattern))):
            if Path(match).is_dir():
                found.append(Path(match))
    return found


def detect_version_files(root: Path | None = None, *, quiet: bool = False) -> list[VersionFile]:
    """Detect version files in a repository.

    Args:
        root: Repository root directory. Defaults to current working directory.
        quiet: Suppress progress output on stderr.

    Returns:
        List of detected version files with their current versions.
    """
    if root is None:
        root = Path.cwd()

    if not quiet:
        print("Scanning for version files...", file=sys.stderr)

    if not root.is_dir():
        return []

    # Parse root pyproject.toml and package.json once and share with workspace scanners.
    root_pyproject_data = _load_root_pyproject(root / "pyproject.toml")
    root_pkg_data = _load_root_package_json(root / "package.json")

    results: list[VersionFile] = []

    for filename, parser, file_type in _ROOT_SCANNERS:
        if filename == "pyproject.toml":
            version = extract_toml_version(root_pyproject_data, "project")
        elif filename == "package.json":
            version = extract_json_version(root_pkg_data)
        else:
            filepath = root / filename
            version = parser(filepath) if filepath.is_file() else None
        if version:
            results.append(VersionFile(path=filename, current_version=version, file_type=file_type))

    # Scan npm workspace packages for version files
    workspaces = root_pkg_data.get("workspaces", []) if root_pkg_data is not None else []
    if isinstance(workspaces, list):
        for workspace_pattern in workspaces:
            if not isinstance(workspace_pattern, str):
                continue
            for workspace_dir in sorted(glob.glob(str(root / workspace_pattern))):
                ws_path = Path(workspace_dir)
                if not ws_path.is_dir():
                    continue
                for filename, parser, file_type in _ROOT_SCANNERS:
                    filepath = ws_path / filename
                    if filepath.is_file():
                        version = parser(filepath)
                        if version:
                            results.append(
                                VersionFile(
                                    path=filepath.relative_to(root).as_posix(),
                                    current_version=version,
                                    file_type=file_type,
                                )
                            )

    # Scan uv workspace members. A package can be in either workspace or both;
    # a path already recorded is skipped so it is not listed twice.
    seen_paths = {vf.path for vf in results}
    for ws_path in _find_uv_workspace_members(root, pyproject_data=root_pyproject_data):
        for filename, parser, file_type in _ROOT_SCANNERS:
            filepath = ws_path / filename
            if not filepath.is_file():
                continue
            rel = filepath.relative_to(root).as_posix()
            if rel in seen_paths:
                continue
            version = parser(filepath)
            if version:
                seen_paths.add(rel)
                results.append(VersionFile(path=rel, current_version=version, file_type=file_type))

    results.extend(_find_python_version_files(root))

    if not quiet:
        for vf in results:
            print(f"Found: {vf.path} (v{vf.current_version})", file=sys.stderr)
        print(f"Detected {len(results)} version file(s)", file=sys.stderr)

    return results


def run() -> None:
    """Entry point for CLI command."""
    results = detect_version_files(quiet=not sys.stderr.isatty())
    output = {
        "version_files": [r.to_dict() for r in results],
        "count": len(results),
    }
    print(json.dumps(output, separators=(",", ":")))
