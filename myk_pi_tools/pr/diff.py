"""Fetch PR diff and metadata needed for code review.

Usage:
    myk-pi-tools pr diff <owner/repo> <pr_number>
    myk-pi-tools pr diff https://github.com/owner/repo/pull/123
    myk-pi-tools pr diff https://gitlab.com/group/project/-/merge_requests/42
    myk-pi-tools pr diff <pr_number>
"""

from __future__ import annotations

import json
import sys

from myk_pi_tools.pr.common import PRInfo, create_platform
from myk_pi_tools.pr.common import parse_args as _parse_args


def parse_args(args: list[str]) -> PRInfo:
    """Parse command line arguments for the diff command.

    Args:
        args: Command line arguments.

    Returns:
        PRInfo with owner, repo, and pr_number.
    """
    return _parse_args(args, command_name="diff", docstring=__doc__)


def run(args: list[str]) -> None:
    """Main entry point for the pr-diff command.

    Args:
        args: Command line arguments.
    """
    pr_info = parse_args(args)
    platform = create_platform(pr_info)

    # Fetch PR metadata
    metadata = platform.fetch_pr_metadata(pr_info.pr_number)

    if not metadata.head_sha:
        print("Error: Failed to extract head SHA from PR metadata", file=sys.stderr)
        sys.exit(1)

    if not metadata.base_branch:
        print("Error: Failed to extract base ref from PR metadata", file=sys.stderr)
        sys.exit(1)

    # Fetch diff and files
    pr_diff = platform.fetch_diff(pr_info.pr_number)
    changed_files = platform.fetch_changed_files(pr_info.pr_number)

    # Build output JSON
    output = {
        "metadata": {
            "owner": pr_info.owner,
            "repo": pr_info.repo,
            "pr_number": pr_info.pr_number,
            "head_sha": metadata.head_sha,
            "base_ref": metadata.base_branch,
            "title": metadata.title,
            "state": metadata.state,
        },
        "diff": pr_diff,
        "files": [
            {
                "path": f.path,
                "status": f.status,
                "additions": f.additions,
                "deletions": f.deletions,
                "patch": f.patch,
            }
            for f in changed_files
        ],
    }

    print(json.dumps(output, indent=2))
