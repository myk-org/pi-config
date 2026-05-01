"""Detect version files in a repository.

Scans for well-known version file patterns across common ecosystems
(Python, Node.js, Rust, Java/Kotlin) and returns found files with
their current version strings.
"""

from __future__ import annotations

import configparser
import json
import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore[no-redef]

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
    try:
        version = data["project"]["version"]
    except (KeyError, TypeError):
        return None
    return version if isinstance(version, str) else None


def _parse_package_json(filepath: Path) -> str | None:
    """Parse version from package.json."""
    try:
        data = json.loads(filepath.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    version = data.get("version")
    return version if isinstance(version, str) else None


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
    try:
        version = data["package"]["version"]
    except (KeyError, TypeError):
        return None
    return version if isinstance(version, str) else None


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
    match = re.search(r'^\s*__version__\s*=\s*["\']([^"\']+)["\']', content, re.MULTILINE)
    return match.group(1) if match else None


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


def detect_version_files(root: Path | None = None) -> list[VersionFile]:
    """Detect version files in a repository.

    Args:
        root: Repository root directory. Defaults to current working directory.

    Returns:
        List of detected version files with their current versions.
    """
    if root is None:
        root = Path.cwd()

    print("Scanning for version files...", file=sys.stderr)

    if not root.is_dir():
        return []

    results: list[VersionFile] = []

    for filename, parser, file_type in _ROOT_SCANNERS:
        filepath = root / filename
        if filepath.is_file():
            version = parser(filepath)
            if version:
                results.append(VersionFile(path=filename, current_version=version, file_type=file_type))

    results.extend(_find_python_version_files(root))

    for vf in results:
        print(f"Found: {vf.path} (v{vf.current_version})", file=sys.stderr)
    print(f"Detected {len(results)} version file(s)", file=sys.stderr)

    return results


def run() -> None:
    """Entry point for CLI command."""
    results = detect_version_files()
    output = {
        "version_files": [r.to_dict() for r in results],
        "count": len(results),
    }
    print(json.dumps(output, indent=2))
