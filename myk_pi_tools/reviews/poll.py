"""Reviews poll command -- atomic rate-limit check + trigger + fetch.

Combines CodeRabbit rate limit handling and review fetching into a single
atomic operation so the AI cannot skip the rate limit check.
"""

from __future__ import annotations

from datetime import datetime, timezone

_RATE_LIMIT_BUFFER_SECONDS = 30


def run(review_url: str = "") -> int:
    """Poll for reviews with automatic rate limit handling.

    Steps:
    1. Determine owner/repo/pr_number from branch or review_url
    2. Check if CodeRabbit is rate limited
    3. If rate limited: wait + trigger re-review
    4. Fetch reviews

    Returns exit code (0 = success, 1 = error).
    """
    import contextlib  # noqa: PLC0415
    import sys  # noqa: PLC0415

    from myk_pi_tools.coderabbit.rate_limit import (  # noqa: PLC0415
        _RATE_LIMITED_MARKER,
        _find_summary_comment,
        _parse_wait_seconds,
        run_trigger,
    )

    # NOTE: These underscore-prefixed symbols are intentionally shared between
    # rate_limit.py and this module. Covered by tests in test_reviews_poll.py.
    from myk_pi_tools.reviews.fetch import get_pr_info, print_stderr  # noqa: PLC0415
    from myk_pi_tools.reviews.fetch import run as fetch_run  # noqa: PLC0415

    # Step 1: Get PR info
    owner, repo, pr_number = get_pr_info(review_url)
    owner_repo = f"{owner}/{repo}"

    # Step 2: Check CodeRabbit rate limit
    print_stderr(f"[poll] Checking CodeRabbit rate limit for {owner_repo}#{pr_number}...")
    comment_id, body, updated_at, error = _find_summary_comment(owner_repo, int(pr_number))

    if comment_id is not None and body is not None and _RATE_LIMITED_MARKER in body:
        # Rate limited -- parse wait time and subtract elapsed time
        wait_seconds = _parse_wait_seconds(body)
        if wait_seconds is None:
            print_stderr("[poll] Warning: Rate limited but could not parse wait time. Using 300s default.")
            wait_seconds = 300

        # Calculate remaining wait time based on when the comment was posted
        remaining = wait_seconds
        if updated_at:
            try:
                comment_time = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
                elapsed = (datetime.now(timezone.utc) - comment_time).total_seconds()
                remaining = max(0, wait_seconds - int(elapsed))
                print_stderr(
                    f"[poll] Rate limit posted {int(elapsed)}s ago. Original: {wait_seconds}s, remaining: {remaining}s"
                )
            except (ValueError, TypeError):
                print_stderr("[poll] Warning: Could not parse comment timestamp. Using full wait time.")

        total_wait = remaining + _RATE_LIMIT_BUFFER_SECONDS
        print_stderr(f"[poll] CodeRabbit is rate limited. Waiting {total_wait}s then triggering re-review...")

        # Step 3: Trigger (waits internally, posts trigger, polls until review starts)
        # Redirect stdout to stderr during trigger to keep stdout clean for JSON
        with contextlib.redirect_stdout(sys.stderr):
            trigger_result = run_trigger(owner_repo, int(pr_number), total_wait)
        if trigger_result != 0:
            print_stderr("[poll] Warning: Trigger returned non-zero. Proceeding with fetch anyway.")
    elif comment_id is None:
        # No summary comment found -- might not have a CodeRabbit review yet, that's OK
        if error and "No CodeRabbit summary comment found" in error:
            print_stderr("[poll] No CodeRabbit summary comment found. Proceeding to fetch.")
        elif error:
            print_stderr(f"[poll] Could not check rate limit ({error}). Proceeding to fetch anyway.")
        else:
            print_stderr("[poll] No CodeRabbit summary comment found. Proceeding to fetch.")
    else:
        print_stderr("[poll] No rate limit detected. Proceeding to fetch.")

    # Step 4: Fetch reviews
    print_stderr("[poll] Fetching reviews...")
    return fetch_run(review_url)
