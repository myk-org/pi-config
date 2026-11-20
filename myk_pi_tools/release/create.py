"""Create a GitHub release with the finalized version and changelog.

This module replicates the logic from create-github-release.sh.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from myk_pi_tools.logger import create_logger
from myk_pi_tools.release._common import RELEASE_TAG_RE, check_dependencies, run_command

log = create_logger(__name__)


@dataclass
class ReleaseResult:
    """Result of creating a release."""

    status: str
    tag: str | None = None
    url: str | None = None
    prerelease: bool = False
    draft: bool = False
    error: str | None = None

    def to_dict(self) -> dict[str, str | bool | None]:
        """Convert to dictionary for JSON output."""
        if self.status == "success":
            return {
                "status": self.status,
                "tag": self.tag,
                "url": self.url,
                "prerelease": self.prerelease,
                "draft": self.draft,
            }
        return {
            "status": self.status,
            "error": self.error,
        }


def _run_command(cmd: list[str], timeout: int = 60) -> tuple[int, str, str]:
    """Run a command and return exit code, stdout, and stderr."""
    return run_command(cmd, timeout=timeout)


def _check_dependencies() -> list[str]:
    """Check for required dependencies."""
    return check_dependencies(("gh",))


def _validate_repo_format(repo: str) -> bool:
    """Validate repository format (owner/repo)."""
    pattern = r"^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$"
    return bool(re.match(pattern, repo))


def _is_semver_tag(tag: str) -> bool:
    """Check vX.Y.Z tags and per-package ``name@X.Y.Z`` tags (issue #965)."""
    return bool(RELEASE_TAG_RE.match(tag))


def _extract_release_url(gh_output: str, repo: str, tag: str) -> str:
    """Extract release URL from gh output or construct it."""
    pattern = r"https://github\.com/[^/]+/[^/]+/releases/tag/[^\s]+"
    match = re.search(pattern, gh_output)
    if match:
        return match.group(0)
    return f"https://github.com/{repo}/releases/tag/{tag}"


def create_release(
    owner_repo: str,
    tag: str,
    changelog_file: str,
    prerelease: bool = False,
    draft: bool = False,
    target: str | None = None,
    title: str | None = None,
) -> ReleaseResult:
    """Create a GitHub release.

    Args:
        owner_repo: Repository in owner/repo format.
        tag: Release tag (e.g., v1.3.0).
        changelog_file: Path to file containing release notes.
        prerelease: Mark as pre-release.
        draft: Create as draft release.
        target: Target branch for the release.
        title: Release title (defaults to tag name).

    Returns:
        ReleaseResult with status and details.
    """
    print(f"Creating release {tag} for {owner_repo}...", file=sys.stderr)

    # Check dependencies
    missing = _check_dependencies()
    if missing:
        return ReleaseResult(
            status="failed",
            error=f"Required command(s) not installed: {', '.join(missing)}",
        )

    # Validate repository format
    if not _validate_repo_format(owner_repo):
        return ReleaseResult(
            status="failed",
            error=f"Invalid repository format: '{owner_repo}'. Expected format: owner/repo",
        )

    # Warn if tag doesn't follow semver (output to stderr)
    if not _is_semver_tag(tag):
        print(
            f"Warning: Tag '{tag}' does not follow semantic versioning format (vX.Y.Z)",
            file=sys.stderr,
        )

    # Validate changelog file exists
    changelog_path = Path(changelog_file)
    if not changelog_path.is_file():
        return ReleaseResult(
            status="failed",
            error=f"Changelog file not found: {changelog_file}",
        )

    # Build gh release create command
    cmd = [
        "gh",
        "release",
        "create",
        tag,
        "--repo",
        owner_repo,
        "--notes-file",
        changelog_file,
        "--title",
        title.strip() if title and title.strip() else tag,
    ]

    if target:
        cmd.extend(["--target", target])

    if prerelease:
        cmd.append("--prerelease")

    if draft:
        cmd.append("--draft")

    # Execute gh release create (use longer timeout for release creation)
    print("Running gh release create...", file=sys.stderr)
    exit_code, stdout, stderr = _run_command(cmd, timeout=300)

    if exit_code != 0:
        error_msg = stderr if stderr else stdout
        log.error("gh release create failed for %s (%s): %s", owner_repo, tag, error_msg)
        return ReleaseResult(
            status="failed",
            error=f"gh release create failed: {error_msg}",
        )

    # Extract URL from output
    combined_output = f"{stdout}\n{stderr}"
    release_url = _extract_release_url(combined_output, owner_repo, tag)
    log.info("Created release %s for %s: %s", tag, owner_repo, release_url)
    print(f"Release created: {release_url}", file=sys.stderr)

    return ReleaseResult(
        status="success",
        tag=tag,
        url=release_url,
        prerelease=prerelease,
        draft=draft,
    )


def run(
    owner_repo: str,
    tag: str,
    changelog_file: str,
    prerelease: bool = False,
    draft: bool = False,
    target: str | None = None,
    title: str | None = None,
) -> None:
    """Entry point for CLI command.

    Args:
        owner_repo: Repository in owner/repo format.
        tag: Release tag (e.g., v1.3.0).
        changelog_file: Path to file containing release notes.
        prerelease: Mark as pre-release.
        draft: Create as draft release.
        target: Target branch for the release.
        title: Release title (defaults to tag name).
    """
    result = create_release(
        owner_repo=owner_repo,
        tag=tag,
        changelog_file=changelog_file,
        prerelease=prerelease,
        draft=draft,
        target=target,
        title=title,
    )
    print(json.dumps(result.to_dict(), separators=(",", ":")))
    if result.status == "failed":
        sys.exit(1)
