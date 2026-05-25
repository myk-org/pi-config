"""Reviews poll command -- internal loop with approval + rate-limit + fetch.

Loops internally until something actionable happens:
- CodeRabbit approved the PR -> return {"approved": true}
- New comments found -> return the fetch JSON

Handles rate limiting internally (wait + trigger). Never returns
on "no new comments" -- sleeps and retries.
"""

from __future__ import annotations

import contextlib
import re
import sys
import time
from datetime import UTC, datetime

from myk_pi_tools.coderabbit.approved import is_approved
from myk_pi_tools.coderabbit.rate_limit import (
    _RATE_LIMITED_MARKER,
    _REVIEWS_PAUSED_FALLBACK_HEADING,
    _REVIEWS_PAUSED_FALLBACK_SETTING,
    _REVIEWS_PAUSED_MARKER,
    _parse_wait_seconds,
    _post_resume_trigger,
    run_trigger,
)
from myk_pi_tools.coderabbit.utils import find_summary_comment
from myk_pi_tools.reviews.fetch import get_pr_info, print_stderr, run_gh_api
from myk_pi_tools.reviews.fetch import run as fetch_run

_RATE_LIMIT_BUFFER_SECONDS = 30
_POLL_SLEEP_SECONDS = 300  # 5 minutes between cycles when no rate limit


def _has_actionable_comments(pr_number: str) -> bool:
    """Check if the fetched reviews JSON has any actionable (non-auto-skipped) comments.

    Reads the JSON file written by fetch_run and checks if any comments
    have status 'pending' and are NOT auto-skipped.
    """
    import json
    import os
    import tempfile
    from pathlib import Path

    tmp_base = Path(os.environ.get("TMPDIR") or tempfile.gettempdir())
    json_path = tmp_base / "pi-work" / f"pr-{pr_number}-reviews.json"

    if not json_path.exists():
        # Can't determine — assume actionable to be safe
        return True

    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return True

    for source in ("human", "qodo", "coderabbit"):
        for comment in data.get(source, []):
            if not comment.get("is_auto_skipped"):
                return True

    return False


def _has_actionable_qodo_comments(pr_number: str) -> bool:
    """Check if fetched reviews have actionable Qodo comments (not auto-skipped)."""
    import json
    import os
    import tempfile
    from pathlib import Path

    tmp_base = Path(os.environ.get("TMPDIR") or tempfile.gettempdir())
    json_path = tmp_base / "pi-work" / f"pr-{pr_number}-reviews.json"

    if not json_path.exists():
        return True

    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return True

    for comment in data.get("qodo", []):
        if not comment.get("is_auto_skipped"):
            return True

    return False


def _is_qodo_approved(owner: str, repo: str, pr_number: str) -> bool:
    """Check if Qodo has approved the PR.

    Qodo is considered to have approved when:
    1. A "Persistent review updated to latest commit" comment exists from Qodo
    2. The sticky summary comment has 0 unresolved findings

    Returns True if approved, False otherwise.
    """
    from myk_pi_tools.reviews.qodo_parser import is_qodo_sticky_comment, parse_qodo_sticky_comment

    # Fetch issue comments to find both the sticky and the "updated" confirmation
    endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
    comments = run_gh_api(endpoint, paginate=True)

    if not comments or not isinstance(comments, list):
        return False

    QODO_USERS = {"qodo-code-review[bot]", "qodo-code-review"}

    # Get PR head SHA once (not per comment)
    pr_endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}"
    pr_data = run_gh_api(pr_endpoint)
    head_sha = ""
    if isinstance(pr_data, dict):
        head_sha = pr_data.get("head", {}).get("sha", "")

    has_update_confirmation = False
    sticky_all_resolved = False

    for comment in comments:
        author = comment.get("user", {}).get("login") if comment.get("user") else None
        if author not in QODO_USERS:
            continue

        body = comment.get("body", "")

        # Check for "Persistent review updated" referencing the LATEST commit
        # Skip the sticky comment itself — it can contain commit URLs in audit trail
        if "Persistent review" in body and "updated to latest commit" in body and not is_qodo_sticky_comment(body):
            # Extract commit hash from the URL in the body
            commit_match = re.search(r"/commit/([0-9a-f]{7,40})", body)
            if commit_match:
                review_commit = commit_match.group(1)
                # Match if review commit matches PR head SHA
                if head_sha and head_sha.startswith(review_commit):
                    has_update_confirmation = True
                else:
                    print_stderr(
                        f"[poll] Qodo reviewed {review_commit[:7]} but HEAD is {head_sha[:7]} — not yet reviewed."
                    )

        # Check the sticky summary comment
        if is_qodo_sticky_comment(body):
            unresolved = parse_qodo_sticky_comment(body)
            # Truncate at "Previous review results" to match parser scope
            import re as _re

            _prev_re = _re.compile(r"(?:<!-- FOLDED_SECTION_START -->|### Previous review results)")
            _prev_match = _prev_re.search(body)
            current_body = body[: _prev_match.start()] if _prev_match else body
            # Only approve if current section has resolved/dismissed findings
            has_resolved_findings = (
                "\u2713 Resolved" in current_body
                or "Resolved</code>" in current_body
                or "\u2717 Dismissed" in current_body
                or "Dismissed</code>" in current_body
            )
            if len(unresolved) == 0 and has_resolved_findings:
                sticky_all_resolved = True

    return has_update_confirmation and sticky_all_resolved


def _run_qodo_poll(review_url: str, owner: str, repo: str, pr_number: str) -> int:
    """Poll for Qodo reviews in a loop until approved or new comments.

    Flow per cycle:
    1. Fetch reviews — if actionable comments found, return them
    2. If 0 new comments, check approval (sticky all resolved + commit match)
    3. If not approved, sleep and retry
    """
    owner_repo = f"{owner}/{repo}"
    cycle = 0

    while True:
        cycle += 1
        print_stderr(f"[poll] Cycle {cycle} for {owner_repo}#{pr_number} (source: qodo)...")

        # Step 1: Fetch reviews first
        print_stderr("[poll] Fetching reviews...")
        fetch_result = fetch_run(review_url)

        if fetch_result == 0:
            has_actionable = _has_actionable_qodo_comments(pr_number)
            if has_actionable:
                print_stderr("[poll] Found actionable Qodo comments.")
                return 0
            print_stderr("[poll] No actionable Qodo comments (all auto-skipped or none found).")
        else:
            print_stderr(f"[poll] Fetch failed with exit code {fetch_result}. Will retry in {_POLL_SLEEP_SECONDS}s...")

        # Step 2: Only check approval AFTER confirming 0 new comments
        # This prevents approving before processing new findings
        if fetch_result == 0:
            print_stderr("[poll] Checking Qodo approval...")
            if _is_qodo_approved(owner, repo, pr_number):
                print_stderr("[poll] Qodo approved — all findings resolved.")
                print('{"approved": true}')
                return 0

        # No actionable result — sleep and loop
        print_stderr(f"[poll] No new Qodo comments. Sleeping {_POLL_SLEEP_SECONDS}s before next cycle...")
        time.sleep(_POLL_SLEEP_SECONDS)


def run(review_url: str = "", source: str = "coderabbit") -> int:
    """Poll for reviews in a loop until approval or new comments.

    Steps (repeated in a loop):
    1. Check if CodeRabbit approved (exit if yes)
    2. Fetch reviews (exit if actionable comments — fix them now, don't wait)
    3. Check if CodeRabbit is rate limited (wait + trigger if yes)
    4. Check approval again after rate limit trigger
    5. No new comments -> sleep 5 min, loop back to step 1

    Returns exit code (0 = success, 1 = error).
    """
    # Get PR info
    owner, repo, pr_number = get_pr_info(review_url)

    if source == "qodo":
        return _run_qodo_poll(review_url, owner, repo, pr_number)

    # CodeRabbit poll (source == "coderabbit" or "all")
    owner_repo = f"{owner}/{repo}"
    cycle = 0
    resume_attempts = 0

    while True:
        cycle += 1
        print_stderr(f"[poll] Cycle {cycle} for {owner_repo}#{pr_number}...")

        # Step 2: Check if CodeRabbit approved
        print_stderr("[poll] Checking CodeRabbit approval...")
        if is_approved(owner_repo, int(pr_number)):
            print_stderr("[poll] CodeRabbit approved \u2014 no actionable comments.")
            print('{"approved": true}')
            return 0

        # Step 3: Fetch reviews — get actionable comments before waiting on rate limit
        print_stderr("[poll] Fetching reviews...")
        fetch_result = fetch_run(review_url)

        if fetch_result == 0:
            # Check if there are actionable (non-auto-skipped) comments
            # fetch_run saves JSON to a predictable path
            has_actionable = _has_actionable_comments(pr_number)
            if has_actionable:
                return 0
            print_stderr("[poll] All fetched comments are auto-skipped (previously addressed). No new comments.")
        else:
            # Fetch failed -- log and retry
            print_stderr(f"[poll] Fetch failed with exit code {fetch_result}. Will retry in {_POLL_SLEEP_SECONDS}s...")

        # Step 4: Check CodeRabbit rate limit
        print_stderr("[poll] Checking CodeRabbit rate limit...")
        comment_id, body, updated_at, error = find_summary_comment(owner_repo, int(pr_number))

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
                    elapsed = (datetime.now(UTC) - comment_time).total_seconds()
                    remaining = max(0, wait_seconds - int(elapsed))
                    print_stderr(
                        f"[poll] Rate limit posted {int(elapsed)}s ago."
                        f" Original: {wait_seconds}s, remaining: {remaining}s"
                    )
                except (ValueError, TypeError):
                    print_stderr("[poll] Warning: Could not parse comment timestamp. Using full wait time.")

            total_wait = remaining + _RATE_LIMIT_BUFFER_SECONDS
            print_stderr(f"[poll] CodeRabbit is rate limited. Waiting {total_wait}s then triggering re-review...")

            # Trigger (waits internally, posts trigger, polls until review starts)
            with contextlib.redirect_stdout(sys.stderr):
                trigger_result = run_trigger(owner_repo, int(pr_number), total_wait)
            if trigger_result != 0:
                print_stderr("[poll] Warning: Trigger returned non-zero. Continuing loop.")

            # Step 5: Check approval again after trigger (new review might approve)
            print_stderr("[poll] Re-checking approval after rate limit trigger...")
            if is_approved(owner_repo, int(pr_number)):
                print_stderr("[poll] CodeRabbit approved \u2014 no actionable comments.")
                print('{"approved": true}')
                return 0

        elif (
            comment_id is not None
            and body is not None
            and (
                _REVIEWS_PAUSED_MARKER in body
                or (_REVIEWS_PAUSED_FALLBACK_HEADING in body and _REVIEWS_PAUSED_FALLBACK_SETTING in body)
            )
        ):
            # Reviews paused — auto-resume (max 3 attempts per poll session)
            resume_attempts += 1

            if resume_attempts > 3:
                print_stderr(
                    "[poll] ⚠️  CodeRabbit still paused after 3 resume attempts. "
                    "Continuing poll without resuming — manual intervention may be needed."
                )
            else:
                print_stderr(
                    f"[poll] ⚠️  CodeRabbit paused reviews (too many commits). "
                    f"Auto-resuming (attempt {resume_attempts}/3)..."
                )
                print_stderr("[poll] 💡 To prevent this, add to .coderabbit.yaml:")
                print_stderr("[poll]     reviews:")
                print_stderr("[poll]       auto_review:")
                print_stderr("[poll]         auto_pause_after_reviewed_commits: 0")

                resume_id = _post_resume_trigger(owner_repo, int(pr_number))
                if resume_id is not None:
                    print_stderr(f"[poll] Posted @coderabbitai resume (comment ID: {resume_id})")

                    # Re-check approval after resume (CodeRabbit may immediately approve)
                    print_stderr("[poll] Re-checking approval after resume trigger...")
                    if is_approved(owner_repo, int(pr_number)):
                        print_stderr("[poll] CodeRabbit approved — no actionable comments.")
                        print('{"approved": true}')
                        return 0
                else:
                    print_stderr("[poll] Warning: Failed to post resume trigger. Will retry next cycle.")

        elif comment_id is None:
            if error and "No CodeRabbit summary comment found" in error:
                print_stderr("[poll] No CodeRabbit summary comment found.")
            elif error:
                print_stderr(f"[poll] Could not check rate limit ({error}).")
            else:
                print_stderr("[poll] No CodeRabbit summary comment found.")
        else:
            print_stderr("[poll] No rate limit detected.")

        # Step 6: No actionable result -- sleep and loop
        print_stderr(f"[poll] No new comments. Sleeping {_POLL_SLEEP_SECONDS}s before next cycle...")
        time.sleep(_POLL_SLEEP_SECONDS)
