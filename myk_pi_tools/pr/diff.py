"""Fetch PR diff and metadata needed for code review.

Usage:
    myk-pi-tools pr diff <owner/repo> <pr_number>
    myk-pi-tools pr diff https://github.com/owner/repo/pull/123
    myk-pi-tools pr diff <pr_number>
"""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any

from myk_pi_tools.pr.common import PRInfo
from myk_pi_tools.pr.common import parse_args as _parse_args


def parse_args(args: list[str]) -> PRInfo:
    """Parse command line arguments for the diff command.

    Args:
        args: Command line arguments.

    Returns:
        PRInfo with owner, repo, and pr_number.
    """
    return _parse_args(args, command_name="diff", docstring=__doc__)


def fetch_pr_metadata(pr_info: PRInfo) -> dict[str, Any]:
    """Fetch PR metadata from GitHub API.

    Args:
        pr_info: Parsed PR information.

    Returns:
        PR metadata dictionary.

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
            "Error: GitHub CLI (gh) not found. Install gh to fetch PR metadata.",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(
            f"Error: Timed out fetching PR metadata for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(
            f"Error: Failed to fetch PR metadata for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        print(e.stderr, file=sys.stderr)
        sys.exit(1)


def fetch_pr_diff(pr_info: PRInfo) -> str:
    """Fetch PR diff.

    Args:
        pr_info: Parsed PR information.

    Returns:
        PR diff as a string.

    Raises:
        SystemExit: If gh pr diff fails.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "diff",
                pr_info.pr_number,
                "--repo",
                pr_info.repo_full_name,
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        )
        return result.stdout
    except FileNotFoundError:
        print(
            "Error: GitHub CLI (gh) not found. Install gh to fetch PR diff.",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(
            f"Error: Timed out fetching PR diff for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(
            f"Error: Failed to fetch PR diff for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        print(e.stderr, file=sys.stderr)
        sys.exit(1)


def fetch_pr_files(pr_info: PRInfo) -> list[dict[str, Any]]:
    """Fetch PR changed files.

    Args:
        pr_info: Parsed PR information.

    Returns:
        List of file change dictionaries.

    Raises:
        SystemExit: If API call fails.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "api",
                f"/repos/{pr_info.owner}/{pr_info.repo}/pulls/{pr_info.pr_number}/files",
                "--paginate",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=120,
        )
        # --paginate returns concatenated JSON arrays, merge them
        files_data = []
        for item in json.loads(f"[{result.stdout.replace('][', ',')}]"):
            if isinstance(item, list):
                files_data.extend(item)
            else:
                files_data.append(item)
        # Extract relevant fields
        return [
            {
                "path": f["filename"],
                "status": f["status"],
                "additions": f["additions"],
                "deletions": f["deletions"],
                "patch": f.get("patch", ""),
            }
            for f in files_data
        ]
    except FileNotFoundError:
        print(
            "Error: GitHub CLI (gh) not found. Install gh to fetch PR files.",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(
            f"Error: Timed out fetching PR files for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(
            f"Error: Failed to fetch PR files for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        print(e.stderr, file=sys.stderr)
        sys.exit(1)


def run(args: list[str]) -> None:
    """Main entry point for the pr-diff command.

    Args:
        args: Command line arguments.
    """
    pr_info = parse_args(args)

    # Fetch PR metadata
    metadata = fetch_pr_metadata(pr_info)

    head_sha = metadata.get("head", {}).get("sha")
    base_ref = metadata.get("base", {}).get("ref")
    pr_title = metadata.get("title")
    pr_state = metadata.get("state")

    if not head_sha:
        print("Error: Failed to extract head SHA from PR metadata", file=sys.stderr)
        sys.exit(1)

    if not base_ref:
        print("Error: Failed to extract base ref from PR metadata", file=sys.stderr)
        sys.exit(1)

    # Fetch diff and files
    pr_diff = fetch_pr_diff(pr_info)
    files = fetch_pr_files(pr_info)

    # Build output JSON
    output = {
        "metadata": {
            "owner": pr_info.owner,
            "repo": pr_info.repo,
            "pr_number": pr_info.pr_number,
            "head_sha": head_sha,
            "base_ref": base_ref,
            "title": pr_title,
            "state": pr_state,
        },
        "diff": pr_diff,
        "files": files,
    }

    print(json.dumps(output, indent=2))
