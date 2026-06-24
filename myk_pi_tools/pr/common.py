"""Common utilities for PR-related commands.

This module contains shared code used by multiple PR subcommands.
"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from myk_pi_tools.platform.base import Platform


@dataclass
class PRInfo:
    """Parsed PR/MR information from arguments."""

    owner: str
    repo: str
    pr_number: int
    platform: str = "github"
    project_path: str = ""  # Full path for GitLab nested groups
    host: str = ""  # Hostname for GitLab (e.g., gitlab.com)

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
        pr_number_str = args[1]
    elif len(args) == 1:
        input_arg = args[0]

        # Check if it's a help flag
        if input_arg in ("-h", "--help"):
            if docstring:
                print(docstring)
            else:
                _print_usage(command_name)
            sys.exit(0)

        # Check if it's a GitLab MR URL (check first — more specific pattern)
        gitlab_match = re.match(
            r"^(?:https?://)?([^/]+)/(.+)/-/merge_requests/(\d+)(?:[/?#].*)?$",
            input_arg,
        )
        if gitlab_match:
            host = gitlab_match.group(1)
            project_path = gitlab_match.group(2)
            mr_number = int(gitlab_match.group(3))
            # For GitLab, owner is the namespace, repo is the last segment
            parts = project_path.rsplit("/", 1)
            owner = parts[0] if len(parts) > 1 else ""
            repo = parts[-1]
            return PRInfo(
                owner=owner,
                repo=repo,
                pr_number=mr_number,
                platform="gitlab",
                project_path=project_path,
                host=host,
            )

        # Check if it's a GitHub URL
        url_match = re.search(
            r"^(?:https?://)?github\.com/([^/]+)/([^/]+)/pull/(\d+)(?:/.*)?$",
            input_arg,
        )
        if url_match:
            owner = url_match.group(1)
            repo = url_match.group(2)
            pr_number = int(url_match.group(3))
            return PRInfo(
                owner=owner, repo=repo, pr_number=pr_number, platform="github", project_path=f"{owner}/{repo}"
            )

        # Check if it's just a number (PR number only)
        if re.match(r"^\d+$", input_arg):
            pr_number_str = input_arg
            # Get repo from current git context
            try:
                result = subprocess.run(
                    [
                        "gh",
                        "repo",
                        "view",
                        "--json",
                        "owner,name",
                        "-q",
                        '.owner.login + "/" + .name',
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=30,
                )
                repo_full_name = result.stdout.strip()
                if not repo_full_name:
                    raise ValueError("Empty repo name")
            except FileNotFoundError:
                print(
                    "Error: GitHub CLI (gh) not found. Install gh or pass owner/repo explicitly.",
                    file=sys.stderr,
                )
                sys.exit(1)
            except (subprocess.CalledProcessError, ValueError):
                print(
                    "Error: Could not determine repository. Run from a git repo or provide full URL.",
                    file=sys.stderr,
                )
                sys.exit(1)
            except subprocess.TimeoutExpired:
                print(
                    "Error: Timed out detecting repository. Provide full URL.",
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
            print(
                f"  pr {command_name} https://gitlab.com/group/project/-/merge_requests/42",
                file=sys.stderr,
            )
            print(f"  pr {command_name} <pr_number>", file=sys.stderr)
            sys.exit(1)
    else:
        _print_usage(command_name)
        sys.exit(1)

    # Validate repository format
    repo_pattern = r"^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$"
    if not re.match(repo_pattern, repo_full_name):
        print(
            f"Error: Invalid repository format. Expected 'owner/repo', got: {repo_full_name}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Validate PR number is numeric
    if not re.match(r"^\d+$", pr_number_str):
        print(
            f"Error: PR number must be numeric, got: {pr_number_str}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Extract owner and repo
    owner, repo = repo_full_name.split("/", 1)
    return PRInfo(owner=owner, repo=repo, pr_number=int(pr_number_str), platform="github", project_path=repo_full_name)


def build_pr_info(owner: str, repo: str, pr_number: int | str, url: str = "") -> PRInfo:
    """Build a PRInfo from individual fields, auto-detecting platform from URL.

    If a URL is provided, platform is detected from the URL pattern.
    Otherwise defaults to github.
    """
    import re as _re

    pr_num = int(pr_number) if isinstance(pr_number, str) else pr_number

    # Check if URL is a GitLab MR URL
    gitlab_match = (
        _re.match(
            r"^(?:https?://)?([^/]+)/(.+)/-/merge_requests/(\d+)(?:[/?#].*)?$",
            url,
        )
        if url
        else None
    )

    if gitlab_match:
        host = gitlab_match.group(1)
        project_path = gitlab_match.group(2)
        parts = project_path.rsplit("/", 1)
        return PRInfo(
            owner=parts[0] if len(parts) > 1 else "",
            repo=parts[-1],
            pr_number=int(gitlab_match.group(3)),
            platform="gitlab",
            project_path=project_path,
            host=host,
        )

    return PRInfo(
        owner=owner,
        repo=repo,
        pr_number=pr_num,
        platform="github",
        project_path=f"{owner}/{repo}",
    )


def create_platform(pr_info: PRInfo) -> Platform:
    """Create a Platform instance from PRInfo.

    Single dispatch point — all business logic calls this instead of
    branching on pr_info.platform.
    """
    from myk_pi_tools.platform.github import GitHubPlatform
    from myk_pi_tools.platform.gitlab import GitLabPlatform

    if pr_info.platform == "gitlab":
        return GitLabPlatform(
            host=pr_info.host,
            project_path=pr_info.project_path,
        )
    return GitHubPlatform(owner=pr_info.owner, repo=pr_info.repo)


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
    print(
        f"  pr {command_name} https://gitlab.com/group/project/-/merge_requests/42",
        file=sys.stderr,
    )
    print(f"  pr {command_name} <pr_number>", file=sys.stderr)
