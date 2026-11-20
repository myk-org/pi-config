"""Common utilities for PR-related commands.

This module contains shared code used by multiple PR subcommands.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from typing import Any

from myk_pi_tools.utils import parse_pr_url, run_gh

_REPO_FORMAT_RE = re.compile(r"^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$")
_PR_NUMBER_RE = re.compile(r"^\d+$")


def validate_repo_format(repo_full_name: str) -> bool:
    """Validate repository format (owner/repo)."""
    return bool(_REPO_FORMAT_RE.match(repo_full_name))


def validate_pr_number(pr_number: str) -> bool:
    """Validate PR number is numeric."""
    return bool(_PR_NUMBER_RE.match(pr_number))


@dataclass
class PRInfo:
    """Parsed PR information from arguments."""

    owner: str
    repo: str
    pr_number: str

    @property
    def repo_full_name(self) -> str:
        """Return the full repository name as owner/repo."""
        return f"{self.owner}/{self.repo}"


def parse_args(args: list[str], command_name: str, docstring: str | None = None) -> PRInfo:
    """Parse command line arguments to extract PR information.

    Supports:
        - Two args: owner/repo and pr_number
        - One arg: GitHub URL (https://github.com/owner/repo/pull/123)
        - One arg: PR number only (gets repo from current git context)

    Args:
        args: Command line arguments.
        command_name: Name of the command for error messages (e.g., "diff", "claude-md").
        docstring: Optional docstring to print for help. If None, prints usage only.

    Returns:
        PRInfo with owner, repo, and pr_number.

    Raises:
        SystemExit: If arguments are invalid or repo cannot be determined.
    """
    if len(args) == 2:
        repo_full_name = args[0]
        pr_number = args[1]
    elif len(args) == 1:
        input_arg = args[0]

        # Check if it's a help flag
        if input_arg in ("-h", "--help"):
            if docstring:
                print(docstring)
            else:
                _print_usage(command_name)
            sys.exit(0)

        # Check if it's a GitHub URL
        parsed = parse_pr_url(input_arg, require_scheme=False)
        if parsed:
            owner, repo, pr_number = parsed
            return PRInfo(owner=owner, repo=repo, pr_number=pr_number)

        # Check if it's just a number (PR number only)
        if validate_pr_number(input_arg):
            pr_number = input_arg
            # Get repo from current git context
            code, stdout, _stderr = run_gh(
                [
                    "repo",
                    "view",
                    "--json",
                    "owner,name",
                    "-q",
                    '.owner.login + "/" + .name',
                ],
                timeout=30,
            )
            if code != 0:
                if "gh CLI not found" in _stderr:
                    print(
                        "Error: GitHub CLI (gh) not found. Install gh or pass owner/repo explicitly.",
                        file=sys.stderr,
                    )
                elif "timed out" in _stderr:
                    print(
                        "Error: Timed out detecting repository. Provide full URL.",
                        file=sys.stderr,
                    )
                else:
                    print(
                        "Error: Could not determine repository. Run from a git repo or provide full URL.",
                        file=sys.stderr,
                    )
                sys.exit(1)
            repo_full_name = stdout.strip()
            if not repo_full_name:
                print(
                    "Error: Could not determine repository. Run from a git repo or provide full URL.",
                    file=sys.stderr,
                )
                sys.exit(1)
        else:
            print(f"Error: Invalid input format: {input_arg}", file=sys.stderr)
            print("", file=sys.stderr)
            print("Expected formats:", file=sys.stderr)
            print(f"  pr {command_name} <owner/repo> <pr_number>", file=sys.stderr)
            print(
                f"  pr {command_name} https://github.com/owner/repo/pull/123",
                file=sys.stderr,
            )
            print(f"  pr {command_name} <pr_number>", file=sys.stderr)
            sys.exit(1)
    else:
        _print_usage(command_name)
        sys.exit(1)

    # Validate repository format
    if not validate_repo_format(repo_full_name):
        print(
            f"Error: Invalid repository format. Expected 'owner/repo', got: {repo_full_name}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Validate PR number is numeric
    if not validate_pr_number(pr_number):
        print(
            f"Error: PR number must be numeric, got: {pr_number}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Extract owner and repo
    owner, repo = repo_full_name.split("/", 1)
    return PRInfo(owner=owner, repo=repo, pr_number=pr_number)


def fetch_pr_metadata(pr_info: PRInfo, *, label: str = "PR metadata") -> dict[str, Any]:
    """Fetch PR metadata JSON from GitHub REST API, exiting on failure."""
    code, stdout, stderr = run_gh(
        [
            "api",
            f"/repos/{pr_info.owner}/{pr_info.repo}/pulls/{pr_info.pr_number}",
        ],
        timeout=60,
    )
    if code != 0:
        if "gh CLI not found" in stderr:
            print(
                f"Error: GitHub CLI (gh) not found. Install gh to fetch {label}.",
                file=sys.stderr,
            )
        elif "timed out" in stderr:
            print(
                f"Error: Timed out fetching {label} for {pr_info.repo_full_name}#{pr_info.pr_number}",
                file=sys.stderr,
            )
        else:
            print(
                f"Error: Failed to fetch {label} for {pr_info.repo_full_name}#{pr_info.pr_number}",
                file=sys.stderr,
            )
            if stderr:
                print(stderr, file=sys.stderr)
        sys.exit(1)
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        print(
            f"Error: Invalid JSON response from GitHub API for {pr_info.repo_full_name}#{pr_info.pr_number}",
            file=sys.stderr,
        )
        sys.exit(1)


def _print_usage(command_name: str) -> None:
    """Print usage information for a PR command.

    Args:
        command_name: Name of the command (e.g., "diff", "claude-md").
    """
    print("Usage:", file=sys.stderr)
    print(f"  pr {command_name} <owner/repo> <pr_number>", file=sys.stderr)
    print(
        f"  pr {command_name} https://github.com/owner/repo/pull/123",
        file=sys.stderr,
    )
    print(f"  pr {command_name} <pr_number>", file=sys.stderr)
