"""Platform detection — strict, no fallbacks, no guessing."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from myk_pi_tools.platform.base import Platform


def detect_platform(url: str = "", *, cwd: str | None = None) -> Platform:
    """Detect the code hosting platform and return the appropriate implementation.

    Detection from URL (checked in order — GitLab first, more specific):
    1. URL matches {host}/.+/-/merge_requests/\\d+ → GitLabPlatform
    2. URL hostname is github.com → GitHubPlatform
    3. Neither → error

    Detection from git remote (when no URL):
    1. Remote contains github.com/ or github.com: → GitHubPlatform
    2. glab repo view succeeds → GitLabPlatform
    3. Neither → error

    Args:
        url: PR/MR URL (optional). If empty, detects from git remote.
        cwd: Working directory for git commands.

    Returns:
        Platform instance.

    Raises:
        SystemExit: If platform cannot be detected.
    """
    if url:
        return _detect_from_url(url, cwd=cwd)
    return _detect_from_remote(cwd=cwd)


def _detect_from_url(url: str, *, cwd: str | None = None) -> Platform:
    """Detect platform from a PR/MR URL."""
    from myk_pi_tools.platform.github import GitHubPlatform
    from myk_pi_tools.platform.gitlab import GitLabPlatform

    # GitLab: {host}/.+/-/merge_requests/\d+
    gitlab_match = re.match(
        r"^(?:https?://)?([^/]+)/(.+)/-/merge_requests/(\d+)(?:[/?#].*)?$",
        url,
    )
    if gitlab_match:
        host = gitlab_match.group(1)
        project_path = gitlab_match.group(2)
        mr_number = int(gitlab_match.group(3))
        return GitLabPlatform(host=host, project_path=project_path, mr_number=mr_number, cwd=cwd)

    # GitHub: github.com/{owner}/{repo}/pull/{number}
    github_match = re.match(
        r"^(?:https?://)?github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:[/?#].*)?$",
        url,
    )
    if github_match:
        owner = github_match.group(1)
        repo = github_match.group(2)
        return GitHubPlatform(owner=owner, repo=repo, cwd=cwd)

    print(
        "Error: Could not detect platform from URL. "
        "Supported: GitHub (github.com) and GitLab (/-/merge_requests/ URLs).",
        file=sys.stderr,
    )
    sys.exit(1)


def _detect_from_remote(*, cwd: str | None = None) -> Platform:
    """Detect platform from git remote URL."""
    from myk_pi_tools.platform.github import GitHubPlatform
    from myk_pi_tools.platform.gitlab import GitLabPlatform

    # Get remote URL
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=cwd,
        )
        if result.returncode != 0:
            print(
                "Error: Could not get git remote URL. Not in a git repository?",
                file=sys.stderr,
            )
            sys.exit(1)
        remote_url = result.stdout.strip()
    except FileNotFoundError:
        print("Error: git not found.", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("Error: git remote get-url timed out.", file=sys.stderr)
        sys.exit(1)

    # Step 1: Check for GitHub (cheap string check)
    if "github.com/" in remote_url or "github.com:" in remote_url:
        # Extract owner/repo from remote
        match = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$", remote_url)
        if match:
            return GitHubPlatform(owner=match.group(1), repo=match.group(2), cwd=cwd)
        print(
            f"Error: Remote URL contains github.com but could not parse owner/repo: {remote_url}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Step 2: Try glab repo view (handles all GitLab hosts)
    if not shutil.which("glab"):
        print(
            "Error: Remote is not GitHub, and glab is not installed. Install glab or pass a full PR/MR URL.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        result = subprocess.run(
            ["glab", "repo", "view", "--output", "json"],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=cwd,
        )
        if result.returncode == 0 and result.stdout.strip():
            import json

            try:
                repo_data = json.loads(result.stdout)
                # glab repo view returns full project info
                full_path = repo_data.get("full_path") or repo_data.get("path_with_namespace", "")
                if full_path:
                    # Extract host from remote URL for GitLab
                    host_match = re.match(r"^(?:https?://|git@)([^/:]+)", remote_url)
                    host = host_match.group(1) if host_match else "gitlab.com"
                    return GitLabPlatform(host=host, project_path=full_path, cwd=cwd)
            except (json.JSONDecodeError, KeyError):
                pass
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    # Step 3: Neither
    print(
        "Error: Could not detect platform. Remote is not GitHub, and glab does not "
        "recognize this repository. Pass a full PR/MR URL.",
        file=sys.stderr,
    )
    sys.exit(1)
