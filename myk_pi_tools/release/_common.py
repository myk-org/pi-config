"""Shared internal helpers for release subcommands."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from myk_pi_tools.logger import create_logger
from myk_pi_tools.release.release_map import ReleaseMap, ReleaseMapError, load_release_map

log = create_logger("myk_pi_tools.release._common")

# Release-tag shapes: legacy lockstep ``v1.2.3`` and per-package
# ``name@1.2.3`` (issue #965), both with an optional prerelease suffix
# (``-rc.1``). Anything else (stray personal/experimental tags) must never
# anchor a window or count as a semver release tag.
RELEASE_TAG_RE = re.compile(r"^(v|[A-Za-z0-9._-]+@)[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$")

# Single shared pattern for Python ``__version__ = "X.Y.Z"`` assignments.
# Group 1: prefix + opening quote, Group 2: version string, Group 3: closing quote.
PY_VERSION_RE = re.compile(r'^(\s*__version__\s*=\s*["\'])([^"\']+)(["\'])', re.MULTILINE)


def run_command(
    cmd: list[str],
    *,
    timeout: int = 60,
    cwd: Path | None = None,
) -> tuple[int, str, str]:
    """Run a command and return ``(returncode, stdout, stderr)`` (stripped)."""
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return 1, "", f"Command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 1, "", f"Command timed out after {timeout} seconds"


def run_git(repo_root: Path, args: list[str], timeout: int = 60) -> str:
    """Run git in ``repo_root``; raise ``RuntimeError`` with context on failure."""
    code, stdout, stderr = run_command(["git", "-C", str(repo_root), *args], timeout=timeout)
    if code != 0:
        if stderr.startswith("Command timed out"):
            raise RuntimeError(f"git timed out: {' '.join(args[:3])}…")
        raise RuntimeError(f"git failed ({' '.join(args[:3])}…): {stderr or code}")
    return stdout


def check_dependencies(commands: Sequence[str]) -> list[str]:
    """Return any required commands that are missing from PATH."""
    return [cmd for cmd in commands if shutil.which(cmd) is None]


def extract_toml_version(data: Any, section: str) -> str | None:
    """Extract a non-empty string ``version`` from a parsed TOML table section."""
    if not isinstance(data, dict):
        return None
    table = data.get(section)
    if not isinstance(table, dict):
        return None
    version = table.get("version")
    return version if isinstance(version, str) and version else None


def extract_json_version(data: Any) -> str | None:
    """Extract a non-empty string top-level ``version`` from parsed JSON."""
    if not isinstance(data, dict):
        return None
    version = data.get("version")
    return version if isinstance(version, str) and version else None


def extract_py_version(content: str) -> str | None:
    """Extract ``__version__`` from Python source text."""
    match = PY_VERSION_RE.search(content)
    return match.group(2) if match else None


def load_and_validate_map(
    repo_root: Path,
    force_packages: tuple[str, ...] = (),
) -> ReleaseMap:
    """Load ``release-map.toml`` and validate ``--force-package`` names.

    Exits with status 1 and a stderr message on schema error or unknown
    forced package names.
    """
    try:
        release_map = load_release_map(repo_root)
    except ReleaseMapError as exc:
        log.error("Failed to load release map under %s: %s", repo_root, exc)
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    known = {x.name for x in release_map.packages}
    unknown_forced = [p for p in force_packages if p not in known]
    if unknown_forced:
        print(
            f"error: --force-package names not in the map: {', '.join(unknown_forced)}",
            file=sys.stderr,
        )
        raise SystemExit(1)

    return release_map
