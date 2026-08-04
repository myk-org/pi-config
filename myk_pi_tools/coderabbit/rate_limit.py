"""CodeRabbit rate limit and reviews-paused handler.

Provides composable operations:
- run_check: detect rate limiting and return JSON status
- run_trigger: wait, post review trigger, and poll until review starts
- run_retry: all-in-one check, wait remaining, trigger, and confirm
- _post_resume_trigger: post resume trigger when reviews are paused
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import UTC, datetime
from typing import Any

from myk_pi_tools.coderabbit.utils import (
    find_summary_comment as _find_summary_comment,
)
from myk_pi_tools.coderabbit.utils import (
    run_gh as _run_gh,
)
from myk_pi_tools.coderabbit.utils import (
    validate_owner_repo as _validate_owner_repo,
)

_RATE_LIMITED_MARKER = "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->"
_REVIEWS_PAUSED_MARKER = "<!-- This is an auto-generated comment: reviews paused by coderabbit.ai -->"
# Fallback: match body text when HTML marker is absent — requires both strings
_REVIEWS_PAUSED_FALLBACK_HEADING = "Reviews paused"
_REVIEWS_PAUSED_FALLBACK_SETTING = "auto_pause_after_reviewed_commits"

# Regex to parse wait time from rate limit message
_WAIT_TIME_RE = re.compile(r"Please wait \*\*(?:(\d+) minutes? and )?(\d+) seconds?\*\*")

_POLL_INTERVAL = 60  # seconds between polls
_MAX_POLL_ATTEMPTS = 10  # max 10 minutes
_TRIGGER_REPLY_TEXT = "Review triggered"


def _parse_wait_seconds(body: str) -> int | None:
    """Parse wait time in seconds from rate limit message body.

    Returns total seconds or None if can't parse.
    """
    match = _WAIT_TIME_RE.search(body)
    if not match:
        return None

    minutes = int(match.group(1)) if match.group(1) else 0
    seconds = int(match.group(2))
    return minutes * 60 + seconds


def _post_coderabbit_comment(owner_repo: str, pr_number: int, command: str) -> int | None:
    """Post @coderabbitai <command> comment on the PR. Returns comment ID or None."""
    owner, repo = owner_repo.split("/")
    code, stdout, stderr = _run_gh(
        [
            "api",
            f"repos/{owner}/{repo}/issues/{pr_number}/comments",
            "-f",
            f"body=@coderabbitai {command}",
        ],
        timeout=30,
    )
    if code != 0:
        if stderr:
            print(f"Failed to post {command} trigger: {stderr}", file=sys.stderr)
        return None
    try:
        return json.loads(stdout).get("id")
    except (json.JSONDecodeError, AttributeError):
        return None


def _post_review_trigger(owner_repo: str, pr_number: int) -> int | None:
    """Post @coderabbitai review comment on the PR. Returns comment ID or None."""
    return _post_coderabbit_comment(owner_repo, pr_number, "review")


def _post_resume_trigger(owner_repo: str, pr_number: int) -> int | None:
    """Post @coderabbitai resume comment on the PR. Returns comment ID or None."""
    return _post_coderabbit_comment(owner_repo, pr_number, "resume")


def _find_trigger_reply(owner_repo: str, pr_number: int, trigger_comment_id: int) -> bool | str:
    """Check if CodeRabbit posted a 'Review triggered' reply after our trigger comment.

    Returns:
        True if reply found
        False if not found yet
        str with error details if API call failed
    """
    owner, repo = owner_repo.split("/")
    code, output, stderr = _run_gh(
        [
            "api",
            f"repos/{owner}/{repo}/issues/{pr_number}/comments",
            "--jq",
            '[.[] | select(.user.login == "coderabbitai[bot]"'
            f' and (.body | contains("{_TRIGGER_REPLY_TEXT}"))'
            f" and .id > {trigger_comment_id})] | length",
        ],
        timeout=60,
    )
    if code != 0:
        return stderr or "API request failed"
    try:
        return int(output.strip()) > 0
    except (ValueError, TypeError):
        return f"Unexpected output: {output}"


def run_check(owner_repo: str, pr_number: int) -> int:
    """Check if CodeRabbit is rate limited. Outputs JSON to stdout.

    Returns exit code (0 = success, 1 = error).
    """
    if not _validate_owner_repo(owner_repo):
        return 1

    comment_id, body, updated_at, error = _find_summary_comment(owner_repo, pr_number)

    if comment_id is None or body is None:
        print(f"Error: {error}")
        return 1

    if _RATE_LIMITED_MARKER not in body:
        print(json.dumps({"rate_limited": False}))
        return 0

    wait_seconds = _parse_wait_seconds(body)
    if wait_seconds is None:
        print("Error: Could not parse wait time from rate limit message.")
        snippet = "\n".join(body.split("\n")[:10])
        print(f"Comment snippet:\n{snippet}")
        return 1

    print(
        json.dumps({
            "rate_limited": True,
            "wait_seconds": wait_seconds,
            "comment_id": comment_id,
            "updated_at": updated_at,
        })
    )
    return 0


def _post_and_poll_trigger(owner_repo: str, pr_number: int, *, output: Any = None) -> tuple[int | None, int]:
    """Post @coderabbitai review and poll for confirmation.

    Returns (trigger_comment_id, exit_code). trigger_comment_id is None on failure.
    """
    out = output or sys.stdout
    print("Posting @coderabbitai review...", file=out)
    trigger_id = _post_review_trigger(owner_repo, pr_number)
    if trigger_id is None:
        print("Error: Failed to post review trigger comment.", file=out)
        return None, 1
    print(f"Review trigger posted (comment ID: {trigger_id}).", file=out)

    consecutive_errors = 0
    for attempt in range(1, _MAX_POLL_ATTEMPTS + 1):
        print(
            f"Polling for 'Review triggered' reply (attempt {attempt}/{_MAX_POLL_ATTEMPTS})...",
            file=out,
        )
        result = _find_trigger_reply(owner_repo, pr_number, trigger_id)
        if result is True:
            print("Review triggered confirmed!", file=out)
            return trigger_id, 0
        if isinstance(result, str):
            consecutive_errors += 1
            print(
                f"Warning: API error checking for reply ({consecutive_errors}/3): {result}",
                file=out,
            )
            if consecutive_errors >= 3:
                print(f"Error: 3 consecutive API failures. Last error: {result}", file=out)
                return trigger_id, 1
        else:
            consecutive_errors = 0
        if attempt < _MAX_POLL_ATTEMPTS:
            time.sleep(_POLL_INTERVAL)

    print("Error: Timeout waiting for 'Review triggered' reply (10 minutes).", file=out)
    return trigger_id, 1


def run_trigger(owner_repo: str, pr_number: int, wait_seconds: int = 0) -> int:
    """Wait then trigger CodeRabbit review. Polls until review starts.

    Returns exit code (0 = success, 1 = error).
    """
    if not _validate_owner_repo(owner_repo):
        return 1

    if wait_seconds > 0:
        minutes, secs = divmod(wait_seconds, 60)
        print(f"Waiting {minutes}m {secs}s before triggering review...")
        time.sleep(wait_seconds)

    _, exit_code = _post_and_poll_trigger(owner_repo, pr_number)
    return exit_code


def run_retry(owner_repo: str, pr_number: int) -> int:
    """Check rate limit, wait remaining time, and trigger review.

    All-in-one: check → calculate elapsed → wait remaining → trigger → confirm.
    Outputs JSON to stdout.
    Returns exit code (0 = success, 1 = error).
    """
    if not _validate_owner_repo(owner_repo):
        return 1

    comment_id, body, updated_at, error = _find_summary_comment(owner_repo, pr_number)

    if comment_id is None or body is None:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    if _RATE_LIMITED_MARKER not in body:
        print(json.dumps({"status": "not_rate_limited"}))
        return 0

    wait_seconds = _parse_wait_seconds(body)
    if wait_seconds is None:
        print("Error: Could not parse wait time from rate limit message.", file=sys.stderr)
        snippet = "\n".join(body.split("\n")[:10])
        print(f"Comment snippet:\n{snippet}", file=sys.stderr)
        return 1

    # Calculate remaining wait from comment timestamp
    remaining = wait_seconds
    elapsed = 0
    if updated_at:
        try:
            comment_time = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
            elapsed = max(0, int((datetime.now(UTC) - comment_time).total_seconds()))
            remaining = max(0, wait_seconds - elapsed)
        except (ValueError, TypeError):
            print(
                f"Warning: Could not parse comment timestamp '{updated_at}' — using full wait",
                file=sys.stderr,
            )

    remaining = min(remaining, 3600)  # cap at 1 hour to prevent DoS

    if remaining > 0:
        minutes, secs = divmod(remaining, 60)
        print(
            f"Rate limited — waiting {minutes}m {secs}s (elapsed {elapsed}s of {wait_seconds}s)...",
            file=sys.stderr,
        )
        time.sleep(remaining)
    else:
        print(
            f"Rate limit expired ({elapsed}s elapsed of {wait_seconds}s) — triggering immediately...",
            file=sys.stderr,
        )

    trigger_id, exit_code = _post_and_poll_trigger(owner_repo, pr_number, output=sys.stderr)
    if exit_code != 0:
        return exit_code

    print(
        json.dumps({
            "status": "triggered",
            "comment_id": comment_id,
            "trigger_comment_id": trigger_id,
            "waited_seconds": remaining,
        })
    )
    return 0
