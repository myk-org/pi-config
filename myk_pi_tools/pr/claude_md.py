"""Fetch CLAUDE.md and AGENTS.md content for a repository.

Usage:
    myk-pi-tools pr claude-md <owner/repo> <pr_number>
    myk-pi-tools pr claude-md https://github.com/owner/repo/pull/123
    myk-pi-tools pr claude-md https://gitlab.com/group/project/-/merge_requests/42
    myk-pi-tools pr claude-md <pr_number>

Checks local files first if current git repo matches target repo,
then falls back to platform API. Checks both CLAUDE.md and AGENTS.md
locations and outputs all found content.

Output: Combined CLAUDE.md + AGENTS.md content (or empty if none found)
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from myk_pi_tools.pr.common import PRInfo, create_platform
from myk_pi_tools.pr.common import parse_args as _parse_args


def parse_args(args: list[str]) -> PRInfo:
    return _parse_args(args, command_name="claude-md", docstring=__doc__)


def _is_current_repo(target_project_path: str) -> bool:
    """Check if current git repo matches target repo (platform-agnostic)."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        remote = result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return False

    # Extract project path from remote URL (supports GitHub and GitLab, HTTPS and SSH)
    # GitHub: github.com:owner/repo.git or github.com/owner/repo.git
    # GitLab: gitlab.com:group/subgroup/project.git or gitlab.com/group/subgroup/project.git
    match = re.search(r"[:/](.+?)(?:\.git)?$", remote)
    if not match:
        return False

    current_path = match.group(1)
    return current_path.lower() == target_project_path.lower()


def _collect_local(paths: list[str]) -> list[str]:
    """Check local file paths and return contents of those that exist."""
    found = []
    for p in paths:
        f = Path(p)
        if f.is_file():
            found.append(f.read_text(encoding="utf-8"))
    return found


def run(args: list[str]) -> None:
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
    if _is_current_repo(pr_info.project_path):
        sections.extend(_collect_local(local_paths))

    # If nothing found locally, try platform API
    if not sections:
        platform = create_platform(pr_info)
        for path in remote_paths:
            content = platform.get_file_content(path)
            if content:
                sections.append(content)

    if sections:
        print("\n\n".join(sections))
    else:
        print("")
