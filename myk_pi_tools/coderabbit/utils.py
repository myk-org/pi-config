"""Shared utilities for CodeRabbit operations."""

from __future__ import annotations

import json
import sys

from myk_pi_tools.github import run_gh
from myk_pi_tools.pr.common import validate_repo_format

# HTML comment marker in CodeRabbit's summary comment
SUMMARY_MARKER = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"


def find_summary_comment(owner_repo: str, pr_number: int) -> tuple[int | None, str | None, str | None, str]:
    """Find the CodeRabbit summary comment on a PR.

    Returns (comment_id, comment_body, updated_at, error) where error is empty string on success.
    """
    owner, repo = owner_repo.split("/")
    code, raw_output, raw_stderr = run_gh(
        [
            "api",
            f"repos/{owner}/{repo}/issues/{pr_number}/comments",
            "--jq",
            f'[.[] | select(.body | contains("{SUMMARY_MARKER}"))]'
            f" | last | {{id: .id, body: .body, updated_at: .updated_at}}",
        ],
        timeout=60,
    )
    output = raw_output.strip()
    stderr = raw_stderr.strip()

    if code != 0:
        return None, None, None, f"GitHub API error: {stderr}" if stderr else "GitHub API request failed"

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
    if not validate_repo_format(owner_repo):
        print(f"Error: Invalid repository format: {owner_repo}. Expected owner/repo.", file=sys.stderr)
        return False
    return True
