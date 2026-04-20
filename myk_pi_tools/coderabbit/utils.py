"""Shared utilities for CodeRabbit operations."""

from __future__ import annotations

import json
import subprocess

# HTML comment marker in CodeRabbit's summary comment
SUMMARY_MARKER = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"


def run_gh(args: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Run a gh CLI command and return (exit_code, stdout, stderr)."""
    try:
        result = subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return 1, "", "gh CLI not found. Install from https://cli.github.com/"
    except subprocess.TimeoutExpired:
        return 1, "", f"Command timed out after {timeout}s"


def find_summary_comment(owner_repo: str, pr_number: int) -> tuple[int | None, str | None, str | None, str]:
    """Find the CodeRabbit summary comment on a PR.

    Returns (comment_id, comment_body, updated_at, error) where error is empty string on success.
    """
    owner, repo = owner_repo.split("/")
    code, output, _stderr = run_gh(
        [
            "api",
            f"repos/{owner}/{repo}/issues/{pr_number}/comments",
            "--jq",
            f'[.[] | select(.body | contains("{SUMMARY_MARKER}"))]'
            f" | last | {{id: .id, body: .body, updated_at: .updated_at}}",
        ],
        timeout=60,
    )

    if code != 0:
        return None, None, None, f"GitHub API error: {_stderr}" if _stderr else "GitHub API request failed"

    if not output:
        return None, None, None, "No CodeRabbit summary comment found on this PR"

    try:
        data = json.loads(output)
        comment_id = data.get("id")
        body = data.get("body")
        updated_at = data.get("updated_at")
        if comment_id is None or body is None:
            return None, None, None, "No CodeRabbit summary comment found on this PR"
        return comment_id, body, updated_at, ""
    except (json.JSONDecodeError, KeyError):
        return None, None, None, "Failed to parse CodeRabbit comment data"


def validate_owner_repo(owner_repo: str) -> bool:
    """Validate owner/repo format."""
    if "/" not in owner_repo or len(owner_repo.split("/")) != 2:
        print(f"Error: Invalid repository format: {owner_repo}. Expected owner/repo.")
        return False
    return True
