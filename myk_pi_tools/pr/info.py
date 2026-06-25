"""Fetch PR information as structured JSON.

Usage:
    myk-pi-tools pr info <owner/repo> <pr_number>
    myk-pi-tools pr info https://github.com/owner/repo/pull/123
    myk-pi-tools pr info <pr_number>
"""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any

from myk_pi_tools.pr.common import PRInfo
from myk_pi_tools.pr.common import parse_args as _parse_args


def parse_args(args: list[str]) -> PRInfo:
    """Parse command arguments for pr info.

    Args:
        args: Command line arguments.

    Returns:
        PRInfo with owner, repo, and pr_number.
    """
    return _parse_args(args, command_name="info", docstring=__doc__)


def fetch_pr_info(pr_info: PRInfo) -> dict[str, Any]:
    """Fetch PR information from GitHub API.

    Args:
        pr_info: Parsed PR information.

    Returns:
        PR data dictionary from GitHub API.

    Raises:
        SystemExit: If API call fails.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "api",
                f"/repos/{pr_info.owner}/{pr_info.repo}/pulls/{pr_info.pr_number}",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        )
        return json.loads(result.stdout)
    except FileNotFoundError:
        print(
            "Error: GitHub CLI (gh) not found. Install gh to fetch PR info.",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(
            f"Error: Timed out fetching PR info for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(
            f"Error: Failed to fetch PR info for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        print(e.stderr, file=sys.stderr)
        sys.exit(1)


def run(args: list[str]) -> None:
    """Run the pr info command.

    Args:
        args: Command line arguments.
    """
    pr_info = parse_args(args)
    data = fetch_pr_info(pr_info)

    author = data.get("user", {}).get("login", "")
    head_sha = data.get("head", {}).get("sha", "")
    base_ref = data.get("base", {}).get("ref", "")
    title = data.get("title", "")
    state = data.get("state", "")
    body = data.get("body", "") or ""
    labels = [label.get("name", "") for label in data.get("labels", [])]
    assignees = [a.get("login", "") for a in data.get("assignees", [])]

    # Detect if PR is from a fork
    head_repo = data.get("head", {}).get("repo", {}) or {}
    base_repo = data.get("base", {}).get("repo", {}) or {}
    is_fork = head_repo.get("full_name", "") != base_repo.get("full_name", "")
    head_repo_full = head_repo.get("full_name", "")

    output = {
        "owner": pr_info.owner,
        "repo": pr_info.repo,
        "pr_number": pr_info.pr_number,
        "author": author,
        "head_sha": head_sha,
        "base_ref": base_ref,
        "title": title,
        "state": state,
        "labels": labels,
        "assignees": assignees,
        "is_fork": is_fork,
        "head_repo": head_repo_full,
        "body": body,
    }

    print(json.dumps(output, indent=2))
