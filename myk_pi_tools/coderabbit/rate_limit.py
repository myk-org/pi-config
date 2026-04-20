"""CodeRabbit rate limit handler.

Provides two composable operations:
- run_check: detect rate limiting and return JSON status
- run_trigger: wait, post review trigger, and poll until review starts
"""

from __future__ import annotations

import json
import re
import time

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

# Regex to parse wait time from rate limit message
_WAIT_TIME_RE = re.compile(r"Please wait \*\*(?:(\d+) minutes? and )?(\d+) seconds?\*\*")

_POLL_INTERVAL = 60  # seconds between polls
_MAX_POLL_ATTEMPTS = 10  # max 10 minutes


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


def _post_review_trigger(owner_repo: str, pr_number: int) -> bool:
    """Post @coderabbitai review comment on the PR."""
    owner, repo = owner_repo.split("/")
    code, _, stderr = _run_gh(
        [
            "api",
            f"repos/{owner}/{repo}/issues/{pr_number}/comments",
            "-f",
            "body=@coderabbitai review",
        ],
        timeout=30,
    )
    if code != 0 and stderr:
        print(f"Failed to post review trigger: {stderr}")
    return code == 0


def _is_rate_limited(owner_repo: str, pr_number: int) -> bool | str:
    """Check if the summary comment still shows rate limited.

    Returns:
        True if rate limited
        False if not rate limited (review started)
        "no_comment" if summary comment not found (likely replaced)
        "error" if API call failed
    """
    _, body, _, error = _find_summary_comment(owner_repo, pr_number)
    if body is None:
        if error == "No CodeRabbit summary comment found on this PR":
            return "no_comment"
        return "error"
    return _RATE_LIMITED_MARKER in body


def run_check(owner_repo: str, pr_number: int) -> int:
    """Check if CodeRabbit is rate limited. Outputs JSON to stdout.

    Returns exit code (0 = success, 1 = error).
    """
    if not _validate_owner_repo(owner_repo):
        return 1

    comment_id, body, _, error = _find_summary_comment(owner_repo, pr_number)

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

    print(json.dumps({"rate_limited": True, "wait_seconds": wait_seconds, "comment_id": comment_id}))
    return 0


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

    print("Posting @coderabbitai review...")
    if not _post_review_trigger(owner_repo, pr_number):
        print("Error: Failed to post review trigger comment.")
        return 1
    print("Review trigger posted.")

    none_streak = 0
    for attempt in range(1, _MAX_POLL_ATTEMPTS + 1):
        print(f"Polling for review start (attempt {attempt}/{_MAX_POLL_ATTEMPTS})...")
        status = _is_rate_limited(owner_repo, pr_number)
        if status == "error":
            print("Warning: API error while checking status. Retrying...")
            none_streak = 0  # API errors don't count toward comment-gone detection
        elif status == "no_comment":
            none_streak += 1
            if none_streak >= 2:
                print("Review started (comment replaced).")
                return 0
            print("Warning: Could not find comment. Retrying...")
        elif not status:
            print("Review started!")
            return 0
        else:
            none_streak = 0
        if attempt < _MAX_POLL_ATTEMPTS:
            time.sleep(_POLL_INTERVAL)

    print("Error: Timeout waiting for review to start (10 minutes).")
    return 1
