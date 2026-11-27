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
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from myk_pi_tools.coderabbit.utils import (
    find_coderabbit_check_run as _find_coderabbit_check_run,
)
from myk_pi_tools.coderabbit.utils import (
    find_rate_limit_reply_comment as _find_rate_limit_reply_comment,
)
from myk_pi_tools.coderabbit.utils import (
    validate_owner_repo as _validate_owner_repo,
)
from myk_pi_tools.github import post_issue_comment
from myk_pi_tools.github import run_gh as _run_gh
from myk_pi_tools.logger import create_logger

log = create_logger(__name__)

_REVIEWS_PAUSED_MARKER = "<!-- This is an auto-generated comment: reviews paused by coderabbit.ai -->"
# Fallback: match body text when HTML marker is absent — requires both strings
_REVIEWS_PAUSED_FALLBACK_HEADING = "Reviews paused"
_REVIEWS_PAUSED_FALLBACK_SETTING = "auto_pause_after_reviewed_commits"

# Regex to parse wait time from rate limit message (legacy format)
_WAIT_TIME_RE = re.compile(r"Please wait \*\*(?:(\d+) minutes? and )?(\d+) seconds?\*\*")

_RATE_LIMIT_PHRASE_PATTERN = (
    r"\b(?:(?:next(?:\s+included)?\s+review\s+)?(?:will\s+be\s+)?available\s+in|please\s+wait)\b"
)

# Detect rate-limit phrase even when no duration tokens follow (→ None, not body-wide).
_RATE_LIMIT_PHRASE_RE = re.compile(_RATE_LIMIT_PHRASE_PATTERN, re.IGNORECASE)
# Match duration tokens near known CodeRabbit rate-limit phrases.
# Captures one contiguous duration expression (e.g. "58 minutes", "1 hour and 30 minutes").
# Allows optional bold (**), punctuation, whitespace, and newline between phrase and duration.
# Two \*{0,2} groups cover markdown like "**Next review available in:** **58 minutes**"
# (closing bold after colon, then opening bold before the duration).
_DURATION_CONTEXT_RE = re.compile(
    _RATE_LIMIT_PHRASE_PATTERN
    + r"(?:\s+(?:for|about|approximately))?"
    + r"[,.:;\s\-\u2013\u2014]*\*{0,2}\s*\*{0,2}\s*"
    + r"((?:\d+\s*(?:hours?|minutes?|seconds?)(?:\s*,?\s*(?:and\s+)?)?)+)"
    + r"\s*\*{0,2}",
    re.IGNORECASE | re.MULTILINE,
)
_DURATION_TOKEN_RE = re.compile(r"(\d+)\s*(hours?|minutes?|seconds?)", re.IGNORECASE)
# First contiguous duration expression in a body (no phrase prefix).
_FIRST_DURATION_RE = re.compile(
    r"((?:\d+\s*(?:hours?|minutes?|seconds?)(?:\s*,?\s*(?:and\s+)?)?)+)",
    re.IGNORECASE,
)

DEFAULT_RATE_LIMIT_WINDOW = 3600  # 1 hour fallback when no wait time is parseable
_POLL_INTERVAL = 60  # seconds between polls
_MAX_POLL_ATTEMPTS = 10  # max 10 minutes
_TRIGGER_REPLY_TEXT = "Review triggered"


def _sum_duration_tokens(text: str) -> int | None:
    """Sum hour/minute/second tokens in text via findall. Returns total seconds or None."""
    total = 0
    found = False
    for amount_str, unit in _DURATION_TOKEN_RE.findall(text):
        amount = int(amount_str)
        unit_lower = unit.lower()
        if unit_lower.startswith("hour"):
            total += amount * 3600
        elif unit_lower.startswith("minute"):
            total += amount * 60
        else:
            total += amount
        found = True
    return total if found else None


def _parse_anchored_wait_seconds(body: str) -> int | None:
    """Parse wait time in seconds anchored to a rate-limit phrase only.

    Checks ``_WAIT_TIME_RE`` and ``_DURATION_CONTEXT_RE`` — never falls back to
    bare duration expressions so check-run timing tables cannot be misparsed.
    """
    match = _WAIT_TIME_RE.search(body)
    if match:
        minutes = int(match.group(1)) if match.group(1) else 0
        seconds = int(match.group(2))
        return minutes * 60 + seconds

    context_match = _DURATION_CONTEXT_RE.search(body)
    if context_match:
        return _sum_duration_tokens(context_match.group(1))
    return None


def _parse_wait_seconds(body: str) -> int | None:
    """Parse wait time in seconds from rate limit message body.

    Handles multiple formats:
    - Legacy: "Please wait **N minutes and N seconds**"
    - Generic: "**58 minutes**", "**2 hours and 30 minutes**", etc.

    Strategy:
    1. Try the legacy regex first (backward compatibility).
    2. Look for durations anchored to known phrases ("Next review available in",
       "available in", "please wait"). If a phrase is found, only tokens within
       that scope are used; an empty anchored match returns None (triggers
       timestamp fallback).
    3. If no rate-limit phrase is present, use the first contiguous duration
       expression (not a body-wide sum of all tokens).

    Returns total seconds or None if nothing parseable.
    """
    anchored = _parse_anchored_wait_seconds(body)
    if anchored is not None:
        return anchored

    # Phrase present but no contiguous duration tokens → None (timestamp fallback)
    # rather than risking false positives from body-wide scan.
    if _RATE_LIMIT_PHRASE_RE.search(body):
        return None

    # No context phrase — first contiguous duration expression only
    first_match = _FIRST_DURATION_RE.search(body)
    if first_match:
        return _sum_duration_tokens(first_match.group(1))
    return None


def is_rate_limited_check_run(check_run: dict[str, Any]) -> bool:
    """Return True iff the CodeRabbit check run ended neutral with a rate-limit output."""
    if check_run.get("conclusion") != "neutral":
        return False
    output = check_run.get("output")
    if not isinstance(output, dict):
        return False
    title = output.get("title") if isinstance(output.get("title"), str) else ""
    summary = output.get("summary") if isinstance(output.get("summary"), str) else ""
    return "rate limit" in f"{title} {summary}".lower()


@dataclass(frozen=True)
class RateLimitStatus:
    """Structured CodeRabbit rate-limit status derived from the PR head check run."""

    rate_limited: bool
    check_run_id: int | None = None
    head_sha: str | None = None
    conclusion: str | None = None
    title: str | None = None
    updated_at: str | None = None
    parsed_wait_seconds: int | None = None


def detect_rate_limit(
    owner_repo: str,
    pr_number: int,
    *,
    comments: list[dict[str, Any]] | None = None,
) -> tuple[RateLimitStatus | None, str]:
    """Detect CodeRabbit rate limiting from the PR head SHA's CodeRabbit check run."""
    check_run, error = _find_coderabbit_check_run(owner_repo, pr_number)
    if error:
        return None, error
    if check_run is None:
        return RateLimitStatus(rate_limited=False), ""

    raw_id = check_run.get("id")
    check_run_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else None
    raw_sha = check_run.get("head_sha")
    head_sha = raw_sha if isinstance(raw_sha, str) and raw_sha else None
    raw_conclusion = check_run.get("conclusion")
    conclusion = raw_conclusion if isinstance(raw_conclusion, str) else None
    raw_output = check_run.get("output")
    output: dict[str, Any] = raw_output if isinstance(raw_output, dict) else {}
    raw_title = output.get("title")
    title = raw_title if isinstance(raw_title, str) else None
    raw_summary = output.get("summary")
    summary = raw_summary if isinstance(raw_summary, str) else ""
    raw_text = output.get("text")
    text = raw_text if isinstance(raw_text, str) else ""
    raw_completed = check_run.get("completed_at") or check_run.get("started_at")
    completed_at = raw_completed if isinstance(raw_completed, str) and raw_completed else None

    if not is_rate_limited_check_run(check_run):
        return (
            RateLimitStatus(
                rate_limited=False,
                check_run_id=check_run_id,
                head_sha=head_sha,
                conclusion=conclusion,
                title=title,
            ),
            "",
        )

    parsed_wait = _parse_anchored_wait_seconds(f"{summary}\n{text}")
    if parsed_wait is None:
        reply, reply_err = _find_rate_limit_reply_comment(
            owner_repo,
            pr_number,
            completed_at=completed_at,
            comments=comments,
        )
        if reply_err:
            log.warning(
                "Could not fetch rate-limit reply comment for %s#%d (%s); falling back",
                owner_repo,
                pr_number,
                reply_err,
            )
            parsed_wait = None
        elif reply is not None:
            raw_reply_body = reply.get("body")
            reply_body = raw_reply_body if isinstance(raw_reply_body, str) else ""
            parsed_wait = _parse_wait_seconds(reply_body)

    return (
        RateLimitStatus(
            rate_limited=True,
            check_run_id=check_run_id,
            head_sha=head_sha,
            conclusion=conclusion,
            title=title,
            updated_at=completed_at,
            parsed_wait_seconds=parsed_wait,
        ),
        "",
    )


def compute_remaining_wait(wait_seconds: int, updated_at: str | None) -> tuple[int, int, bool]:
    """Compute ``(remaining, elapsed, parsed_ok)`` from ``updated_at`` against ``wait_seconds``."""
    if not updated_at:
        return wait_seconds, 0, True
    try:
        comment_time = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        elapsed = max(0, int((datetime.now(UTC) - comment_time).total_seconds()))
        remaining = max(0, wait_seconds - elapsed)
        return remaining, elapsed, True
    except (ValueError, TypeError):
        return wait_seconds, 0, False


def _post_coderabbit_comment(owner_repo: str, pr_number: int, command: str) -> int | None:
    """Post @coderabbitai <command> comment on the PR. Returns comment ID or None."""
    owner, repo = owner_repo.split("/")
    ok, stdout, err = post_issue_comment(owner, repo, pr_number, f"@coderabbitai {command}", timeout=30)
    if not ok:
        if err:
            print(f"Failed to post {command} trigger: {err}", file=sys.stderr)
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
        return stderr.strip() or "API request failed"
    try:
        return int(output.strip()) > 0
    except (ValueError, TypeError):
        return f"Unexpected output: {output}"


def run_check(owner_repo: str, pr_number: int) -> int:
    """Check if CodeRabbit is rate limited. Outputs JSON to stdout.

    JSON output fields:
        rate_limited (bool): Whether CodeRabbit is rate limited.
        wait_seconds (int): Seconds to wait (when rate_limited is True).
        check_run_id (int | None): The CodeRabbit check run ID (when present).
        head_sha (str | None): PR head SHA inspected.
        conclusion (str | None): Check run conclusion.
        title (str | None): Check run output title.
        updated_at (str | None): ISO 8601 timestamp of the check run.
        fallback (bool, optional): True when wait_seconds is estimated from the check-run
            timestamp using DEFAULT_RATE_LIMIT_WINDOW, not parsed from text.

    Returns exit code (0 = success, 1 = error).
    """
    if not _validate_owner_repo(owner_repo):
        return 1

    status, error = detect_rate_limit(owner_repo, pr_number)
    if status is None:
        log.error("Rate limit check failed for %s#%d: %s", owner_repo, pr_number, error)
        print(f"Error: {error}", file=sys.stderr)
        return 1

    if not status.rate_limited:
        if status.check_run_id is None:
            print(json.dumps({"rate_limited": False}, separators=(",", ":")))
        else:
            print(
                json.dumps(
                    {
                        "rate_limited": False,
                        "check_run_id": status.check_run_id,
                        "head_sha": status.head_sha,
                        "conclusion": status.conclusion,
                        "title": status.title,
                    },
                    separators=(",", ":"),
                )
            )
        return 0

    fallback = False
    if status.parsed_wait_seconds is None:
        fallback = True
        wait_seconds, _, parsed_ok = compute_remaining_wait(DEFAULT_RATE_LIMIT_WINDOW, status.updated_at)
        if not parsed_ok:
            log.warning(
                "Could not parse check-run timestamp '%s' — using full fallback window",
                status.updated_at,
            )
            print(
                f"Warning: Could not parse check-run timestamp '{status.updated_at}' — using full fallback window",
                file=sys.stderr,
            )
    else:
        wait_seconds = status.parsed_wait_seconds

    result: dict[str, Any] = {
        "rate_limited": True,
        "wait_seconds": wait_seconds,
        "check_run_id": status.check_run_id,
        "head_sha": status.head_sha,
        "conclusion": status.conclusion,
        "title": status.title,
        "updated_at": status.updated_at,
    }
    if fallback:
        result["fallback"] = True
    print(json.dumps(result, separators=(",", ":")))
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

    status, error = detect_rate_limit(owner_repo, pr_number)
    if status is None:
        log.error("Rate limit check failed for %s#%d: %s", owner_repo, pr_number, error)
        print(f"Error: {error}", file=sys.stderr)
        return 1

    if not status.rate_limited:
        print(json.dumps({"status": "not_rate_limited"}, separators=(",", ":")))
        return 0

    is_fallback = status.parsed_wait_seconds is None
    wait_seconds: int = DEFAULT_RATE_LIMIT_WINDOW if status.parsed_wait_seconds is None else status.parsed_wait_seconds

    # Calculate remaining wait from check-run timestamp
    remaining, elapsed, parsed_ok = compute_remaining_wait(wait_seconds, status.updated_at)
    if not parsed_ok:
        log.warning("Could not parse check-run timestamp '%s' — using full wait", status.updated_at)
        print(
            f"Warning: Could not parse check-run timestamp '{status.updated_at}' — using full wait",
            file=sys.stderr,
        )

    if is_fallback:
        print(
            f"Warning: Could not parse wait time — using fallback"
            f" ({remaining}s remaining of {DEFAULT_RATE_LIMIT_WINDOW}s window)",
            file=sys.stderr,
        )

    remaining = min(remaining, DEFAULT_RATE_LIMIT_WINDOW)  # cap to prevent DoS

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
        json.dumps(
            {
                "status": "triggered",
                "check_run_id": status.check_run_id,
                "trigger_comment_id": trigger_id,
                "waited_seconds": remaining,
            },
            separators=(",", ":"),
        )
    )
    return 0
