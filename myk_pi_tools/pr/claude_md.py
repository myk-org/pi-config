"""Fetch CLAUDE.md and AGENTS.md content for a repository.

Usage:
    myk-pi-tools pr claude-md <owner/repo> <pr_number>
    myk-pi-tools pr claude-md https://github.com/owner/repo/pull/123
    myk-pi-tools pr claude-md <pr_number>

Checks local files first if current git repo matches target repo,
then falls back to GitHub API. Checks both CLAUDE.md and AGENTS.md
locations and outputs all found content.

Output: Combined CLAUDE.md + AGENTS.md content (or empty if none found)
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

from myk_pi_tools.pr.common import PRInfo
from myk_pi_tools.pr.common import parse_args as _parse_args


def parse_args(args: list[str]) -> PRInfo:
    """Parse command line arguments for the claude-md command.

    Args:
        args: Command line arguments.

    Returns:
        PRInfo with owner, repo, and pr_number.
    """
    return _parse_args(args, command_name="claude-md", docstring=__doc__)


def is_current_repo(target_repo: str) -> bool:
    """Check if current git repo matches target repo.

    Args:
        target_repo: Target repository in owner/repo format.

    Returns:
        True if current repo matches target.
    """
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        current_remote = result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return False

    # Extract owner/repo from remote URL (supports both HTTPS and SSH)
    match = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$", current_remote)
    if not match:
        return False

    current_repo_name = f"{match.group(1)}/{match.group(2)}"

    # Compare (case-insensitive)
    return current_repo_name.lower() == target_repo.lower()


def fetch_from_github(owner: str, repo: str, file_path: str) -> str | None:
    """Fetch file content from GitHub API.

    Args:
        owner: Repository owner.
        repo: Repository name.
        file_path: Path to the file in the repository.

    Returns:
        File content as string, or None if not found.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "api",
                f"/repos/{owner}/{repo}/contents/{file_path}",
                "-H",
                "Accept: application/vnd.github.raw",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        )
        return result.stdout if result.stdout else None
    except (
        subprocess.CalledProcessError,
        FileNotFoundError,
        subprocess.TimeoutExpired,
    ):
        return None


def _collect_local(paths: list[str]) -> list[str]:
    """Check local file paths and return contents of those that exist."""
    found = []
    for p in paths:
        f = Path(p)
        if f.is_file():
            found.append(f.read_text(encoding="utf-8"))
    return found


def _collect_remote(owner: str, repo: str, paths: list[str]) -> list[str]:
    """Fetch file contents from GitHub API for paths that exist."""
    found = []
    for p in paths:
        content = fetch_from_github(owner, repo, p)
        if content:
            found.append(content)
    return found


def run(args: list[str]) -> None:
    """Main entry point for the pr-claude-md command.

    Strategy: Check all known locations for both CLAUDE.md and AGENTS.md,
    output all found content concatenated.

    Local paths checked (if current repo matches target):
      - ./CLAUDE.md
      - ./.claude/CLAUDE.md
      - ./AGENTS.md
      - ./.agents/AGENTS.md

    Remote paths checked via GitHub API:
      - CLAUDE.md
      - .claude/CLAUDE.md
      - AGENTS.md
      - .agents/AGENTS.md

    Args:
        args: Command line arguments.
    """
    pr_info = parse_args(args)
    sections: list[str] = []

    local_paths = [
        "./CLAUDE.md",
        "./.claude/CLAUDE.md",
        "./AGENTS.md",
        "./.agents/AGENTS.md",
    ]

    remote_paths = [
        "CLAUDE.md",
        ".claude/CLAUDE.md",
        "AGENTS.md",
        ".agents/AGENTS.md",
    ]

    # Check local files if current repo matches target
    if is_current_repo(pr_info.repo_full_name):
        sections.extend(_collect_local(local_paths))

    # If nothing found locally, try GitHub API
    if not sections:
        if shutil.which("gh") is None:
            print(
                "Error: GitHub CLI (gh) not found. Install gh to fetch project context files.",
                file=sys.stderr,
            )
            sys.exit(1)

        sections.extend(_collect_remote(pr_info.owner, pr_info.repo, remote_paths))

    if sections:
        print("\n\n".join(sections))
    else:
        print("")
