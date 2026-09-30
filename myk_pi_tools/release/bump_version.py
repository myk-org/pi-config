"""Update version strings in detected version files.

Reads files detected by detect_versions, replaces version strings
with the new version, and writes them back. Does not perform any
git operations.
"""

from __future__ import annotations

import configparser
import json
import os
import re
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from myk_pi_tools.release.detect_versions import detect_version_files


def _atomic_write(filepath: Path, content: str) -> None:
    """Write content to file atomically using temp file + rename."""
    # Capture original permissions if file exists
    original_mode = filepath.stat().st_mode if filepath.exists() else None
    fd, tmp_path = tempfile.mkstemp(dir=filepath.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        if original_mode is not None:
            os.chmod(tmp_path, original_mode)
        Path(tmp_path).replace(filepath)
    except BaseException:
        Path(tmp_path).unlink(missing_ok=True)
        raise


@dataclass
class BumpResult:
    """Result of a version bump operation."""

    status: str
    version: str | None = None
    updated: list[dict[str, str]] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, object]:
        """Convert to dictionary for JSON output."""
        if self.status == "success":
            return {
                "status": self.status,
                "version": self.version,
                "updated": self.updated,
                "skipped": self.skipped,
            }
        result: dict[str, object] = {"status": self.status, "error": self.error}
        if self.skipped:
            result["skipped"] = self.skipped
        return result


def _bump_pyproject_toml(filepath: Path, new_version: str) -> str | None:
    content = filepath.read_text(encoding="utf-8")
    # Find the [project] section (tolerant of whitespace around header)
    project_match = re.search(r"^\[\s*project\s*\]", content, re.MULTILINE)
    if not project_match:
        return None
    section_start = project_match.end()
    # Match next top-level section (not sub-tables like [project.urls])
    next_section = re.search(r"^\[(?!project[.\]])", content[section_start:], re.MULTILINE)
    if next_section:
        section_content = content[section_start : section_start + next_section.start()]
    else:
        section_content = content[section_start:]
    match = re.search(r'^(\s*version\s*=\s*["\'])([^"\']+)(["\'])', section_content, re.MULTILINE)
    if not match:
        return None
    old_version = match.group(2)
    # Adjust match positions to full file offsets
    abs_start = section_start + match.start(2)
    abs_end = section_start + match.end(2)
    new_content = content[:abs_start] + new_version + content[abs_end:]
    _atomic_write(filepath, new_content)
    return old_version


def _bump_package_json(filepath: Path, new_version: str) -> str | None:
    content = filepath.read_text(encoding="utf-8")
    # Confirm the top-level version via JSON parsing
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        return None
    old_version = data.get("version")
    if not isinstance(old_version, str):
        return None
    # Replace only the first top-level "version" value that matches the parsed old_version
    pattern = rf'("version"\s*:\s*"){re.escape(old_version)}(")'
    new_content, n = re.subn(pattern, rf"\g<1>{new_version}\2", content, count=1)
    if n != 1:
        return None
    _atomic_write(filepath, new_content)
    return old_version


def _bump_setup_cfg(filepath: Path, new_version: str) -> str | None:
    content = filepath.read_text(encoding="utf-8")
    # First verify the version exists in [metadata] using configparser
    config = configparser.ConfigParser()
    try:
        config.read_string(content)
        old_version = config.get("metadata", "version")
    except (configparser.NoSectionError, configparser.NoOptionError, configparser.Error):
        return None
    old_version = old_version.strip().strip("\"'")
    # Skip dynamic version directives (attr:, file:)
    if old_version.lower().startswith(("attr:", "file:")):
        return None
    # Find [metadata] section and replace version only within it
    metadata_match = re.search(r"^\[\s*metadata\s*\]", content, re.MULTILINE | re.IGNORECASE)
    if not metadata_match:
        return None
    section_start = metadata_match.end()
    next_section = re.search(r"^\[", content[section_start:], re.MULTILINE)
    if next_section:
        section_content = content[section_start : section_start + next_section.start()]
    else:
        section_content = content[section_start:]
    match = re.search(r"^(\s*version\s*=\s*)(\S+)", section_content, re.MULTILINE)
    if not match:
        return None
    abs_start = section_start + match.start(2)
    abs_end = section_start + match.end(2)
    new_content = content[:abs_start] + new_version + content[abs_end:]
    _atomic_write(filepath, new_content)
    return old_version


def _bump_cargo_toml(filepath: Path, new_version: str) -> str | None:
    content = filepath.read_text(encoding="utf-8")
    # Find the [package] section (tolerant of whitespace around header)
    package_match = re.search(r"^\[\s*package\s*\]", content, re.MULTILINE)
    if not package_match:
        return None
    section_start = package_match.end()
    # Match next top-level section (not sub-tables like [package.metadata])
    next_section = re.search(r"^\[(?!package[.\]])", content[section_start:], re.MULTILINE)
    if next_section:
        section_content = content[section_start : section_start + next_section.start()]
    else:
        section_content = content[section_start:]
    match = re.search(r'^(\s*version\s*=\s*["\'])([^"\']+)(["\'])', section_content, re.MULTILINE)
    if not match:
        return None
    old_version = match.group(2)
    # Adjust match positions to full file offsets
    abs_start = section_start + match.start(2)
    abs_end = section_start + match.end(2)
    new_content = content[:abs_start] + new_version + content[abs_end:]
    _atomic_write(filepath, new_content)
    return old_version


def _bump_gradle(filepath: Path, new_version: str) -> str | None:
    content = filepath.read_text(encoding="utf-8")
    match = re.search(r"""^(\s*version\s*=?\s*['"])([^'"]+)(['"])""", content, re.MULTILINE)
    if not match:
        return None
    old_version = match.group(2)
    new_content = content[: match.start(2)] + new_version + content[match.end(2) :]
    _atomic_write(filepath, new_content)
    return old_version


def _bump_python_version(filepath: Path, new_version: str) -> str | None:
    content = filepath.read_text(encoding="utf-8")
    match = re.search(r'^(\s*__version__\s*=\s*["\'])([^"\']+)(["\'])', content, re.MULTILINE)
    if not match:
        return None
    old_version = match.group(2)
    new_content = content[: match.start(2)] + new_version + content[match.end(2) :]
    _atomic_write(filepath, new_content)
    return old_version


_BUMPERS: dict[str, Callable[[Path, str], str | None]] = {
    "pyproject": _bump_pyproject_toml,
    "package_json": _bump_package_json,
    "setup_cfg": _bump_setup_cfg,
    "cargo": _bump_cargo_toml,
    "gradle": _bump_gradle,
    "python_version": _bump_python_version,
}


def bump_version_files(
    new_version: str,
    files: list[str] | None = None,
    root: Path | None = None,
) -> BumpResult:
    """Update version strings in detected version files.

    Args:
        new_version: The new version string (e.g., "1.2.0").
        files: Optional list of specific file paths to update.
               If None, updates all detected version files.
        root: Repository root directory. Defaults to current working directory.

    Returns:
        BumpResult with status and details.
    """
    print(f"Bumping version to {new_version}...", file=sys.stderr)

    if root is None:
        root = Path.cwd()

    new_version = new_version.strip()
    if not new_version or any(ch in new_version for ch in ("\n", "\r")):
        return BumpResult(
            status="failed",
            error="Invalid version: must be a non-empty single-line string.",
        )
    if new_version.startswith("v") or new_version.startswith("V"):
        return BumpResult(
            status="failed",
            error=f"Invalid version: '{new_version}' should not start with 'v'. Use '{new_version[1:]}' instead.",
        )

    if not root.is_dir():
        return BumpResult(status="failed", error=f"Root path is not a directory: {root}")

    detected = detect_version_files(root)
    if not detected:
        return BumpResult(status="failed", error="No version files found in repository.")

    if files is not None:
        normalized_files = [Path(f).as_posix() for f in files]
        filtered = [vf for vf in detected if vf.path in normalized_files]
        if not filtered:
            available = [vf.path for vf in detected]
            return BumpResult(
                status="failed",
                error=f"None of the specified files were found in detected version files. Available: {available}",
            )
        matched_paths = {vf.path for vf in filtered}
        unmatched = [f for f in normalized_files if f not in matched_paths]
        if unmatched:
            available = [vf.path for vf in detected]
            return BumpResult(
                status="failed",
                error=(
                    f"Some specified files were not found in detected version files."
                    f" Unmatched: {unmatched}. Available: {available}"
                ),
            )
        detected = filtered

    updated: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    for vf in detected:
        bumper = _BUMPERS.get(vf.file_type)
        if bumper is None:
            print(f"Skipped: {vf.path} (Unknown file type: {vf.file_type})", file=sys.stderr)
            skipped.append({"path": vf.path, "reason": f"Unknown file type: {vf.file_type}"})
            continue

        filepath = root / vf.path
        # Prevent path traversal
        try:
            filepath.resolve().relative_to(root.resolve())
        except ValueError:
            print(f"Skipped: {vf.path} (Path traversal detected)", file=sys.stderr)
            skipped.append({"path": vf.path, "reason": "Path traversal detected"})
            continue
        try:
            old_version = bumper(filepath, new_version)
        except OSError as e:
            print(f"Skipped: {vf.path} (I/O error: {e})", file=sys.stderr)
            skipped.append({"path": vf.path, "reason": f"I/O error: {e}"})
            continue
        if old_version is not None:
            print(f"Updated: {vf.path} ({old_version} → {new_version})", file=sys.stderr)
            updated.append({"path": vf.path, "old_version": old_version, "new_version": new_version})
        else:
            print(f"Skipped: {vf.path} (Could not find version pattern in file)", file=sys.stderr)
            skipped.append({"path": vf.path, "reason": "Could not find version pattern in file"})

    if not updated:
        return BumpResult(
            status="failed",
            error="No version files were updated.",
            skipped=skipped,
        )

    return BumpResult(
        status="success",
        version=new_version,
        updated=updated,
        skipped=skipped,
    )


def run(new_version: str, files: list[str] | None = None) -> None:
    """Entry point for CLI command."""
    result = bump_version_files(new_version=new_version, files=files if files else None)
    print(json.dumps(result.to_dict(), indent=2))
    if result.status == "failed":
        sys.exit(1)
