"""Reviews poll command -- internal loop with approval + rate-limit + fetch.

Loops internally until something actionable happens:
- CodeRabbit approved the PR -> return {"approved": true}
- New comments found -> return the fetch JSON

Handles rate limiting internally (wait + trigger). Never returns
on "no new comments" -- sleeps and retries.
"""

from __future__ import annotations

import contextlib
import json
import re
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

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
from myk_pi_tools.reviews.fetch import get_pr_info, is_qodo_approved, print_approval_summary, print_stderr, run_gh_api
from myk_pi_tools.reviews.fetch import run as fetch_run

_RATE_LIMIT_BUFFER_SECONDS = 30
_POLL_SLEEP_SECONDS = 300  # 5 minutes between cycles when no rate limit

# Pushback indicators in Qodo responses — Qodo disagrees with our fix/decision
_PUSHBACK_KEYWORDS = re.compile(
    r"(\bstill (?:present|exists?|unresolved|open|not (?:fixed|addressed|resolved))\b"
    r"|\bnot (?:fully |completely )?(?:addressed|resolved|fixed)\b"
    r"|\bdisagree\b|\bincorrect\b|\bwrong\b|\bissue (?:remains|persists)\b"
    r"|\bdoes not (?:address|fix|resolve)\b"
    r"|\bshould still\b"
    r"|\brecommend (?:re-?evaluating|revisiting)\b"
    r"|\bre-?open\b)",
    re.IGNORECASE,
)


def _print_poll_summary(pr_number: str, output_dir: str) -> None:
    """Print a summary line showing total/new/skipped counts after fetch."""
    import json
    from pathlib import Path

    json_path = Path(output_dir) / f"pr-{pr_number}-reviews.json"

    if not json_path.exists():
        return

    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return

    total = 0
    new = 0
    skipped = 0
    for source in ("human", "qodo", "coderabbit"):
        for comment in data.get(source, []):
            total += 1
            if comment.get("is_auto_skipped"):
                skipped += 1
            elif comment.get("status") == "pending":
                new += 1

    print_stderr(f"[poll] Summary: {total} total, {new} new, {skipped} auto-skipped")


def _has_actionable_comments(pr_number: str, output_dir: str) -> bool:
    """Check if the fetched reviews JSON has any actionable (non-auto-skipped) comments.

    Reads the JSON file written by fetch_run and checks if any comments
    have status 'pending' and are NOT auto-skipped.
    """
    import json
    from pathlib import Path

    json_path = Path(output_dir) / f"pr-{pr_number}-reviews.json"

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


def _has_actionable_qodo_comments(pr_number: str, output_dir: str) -> bool:
    """Check if fetched reviews have actionable Qodo comments.

    A comment is actionable if:
    - Not auto-skipped AND not already replied (new finding), OR
    - Not auto-skipped AND already replied AND qodo_response contains
      pushback keywords (Qodo disagrees with our previous fix)

    Already-replied findings WITHOUT pushback are not actionable in the poll
    — Qodo's silence or confirmation means the finding is resolved.
    """
    import json
    from pathlib import Path

    json_path = Path(output_dir) / f"pr-{pr_number}-reviews.json"

    if not json_path.exists():
        return True

    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return True

    for comment in data.get("qodo", []):
        if comment.get("is_auto_skipped"):
            continue

        # New finding — not yet replied to
        if not comment.get("already_replied"):
            return True

        # Already replied — only actionable if Qodo pushed back
        qodo_response = comment.get("qodo_response", "")
        if qodo_response and _PUSHBACK_KEYWORDS.search(qodo_response):
            return True

    return False


# Qodo posts a transient comment while reviewing — detect by heading only
# "Looking for bugs?" is the <h3> heading in Qodo's transient comment.
# Do NOT add broad markers — they false-positive against PR summary/description text.
_QODO_REVIEWING_MARKERS = ("Looking for bugs?",)

_QODO_STUCK_TIMEOUT_SECONDS = 3600  # 1 hour — if "Looking for bugs" persists, Qodo is stuck
_QODO_RETRIGGER_COOLDOWN_SECONDS = 1801  # ~30 min cooldown between re-trigger attempts (+1s for strict > comparison)


def _is_qodo_reviewing(owner: str, repo: str, pr_number: str, comments: list | None = None) -> bool:
    """Check if Qodo is currently reviewing the PR.

    Qodo posts a transient comment while reviewing (e.g., "Looking for bugs?").
    If this comment exists, the sticky is about to be updated — we should wait.
    Matches author (qodo-code-review[bot]) and known substring markers.
    """
    if comments is None:
        endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
        comments = run_gh_api(endpoint, paginate=True)
    if not comments or not isinstance(comments, list):
        return False

    for comment in comments:
        author = comment.get("user", {}).get("login") if comment.get("user") else None
        if author != "qodo-code-review[bot]":
            continue
        body = comment.get("body", "")
        # Only match transient review comments — they start with <h3> heading.
        # Don't match reply comments that quote the phrase in prose text.
        if any(f"<h3>{marker}</h3>" in body or body.strip().startswith(marker) for marker in _QODO_REVIEWING_MARKERS):
            print_stderr("[poll] Qodo review in progress (Looking for bugs).")
            return True

    return False


def _retrigger_qodo_review(owner: str, repo: str, pr_number: str) -> bool:
    """Post /agentic_review comment to re-trigger a stuck Qodo review.

    Returns True if the comment was posted successfully.
    """
    try:
        subprocess.run(
            [
                "gh",
                "api",
                f"/repos/{owner}/{repo}/issues/{pr_number}/comments",
                "-X",
                "POST",
                "-f",
                "body=/agentic_review",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        print_stderr("[poll] Posted /agentic_review to re-trigger stuck Qodo review.")
        return True
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.strip() if e.stderr else ""
        print_stderr(f"[poll] Failed to post /agentic_review (rc={e.returncode}): {stderr}")
        return False
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print_stderr(f"[poll] Failed to post /agentic_review: {e}")
        return False


def _request_qodo_sticky_cleanup(owner: str, repo: str, pr_number: str) -> bool:
    """Ask Qodo to re-evaluate sticky findings and remove resolved ones.

    Posts a comment asking @qodo-code-review to check each remaining sticky
    finding against the current code and remove only those that are fully addressed.

    Returns True if the comment was posted successfully.
    """
    body = (
        "@qodo-code-review\n\n"
        "Please re-evaluate all remaining sticky findings against the current code.\n"
        "For each finding, check if the referenced code has been fixed in subsequent commits.\n"
        "Remove findings that are fully addressed. "
        "Keep any findings where the issue is still present in the code."
    )
    try:
        subprocess.run(
            [
                "gh",
                "api",
                f"/repos/{owner}/{repo}/issues/{pr_number}/comments",
                "-X",
                "POST",
                "-f",
                f"body={body}",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        print_stderr("[poll] Posted sticky cleanup request to @qodo-code-review.")
        return True
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.strip() if e.stderr else ""
        print_stderr(f"[poll] Failed to post sticky cleanup request (rc={e.returncode}): {stderr}")
        return False
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        print_stderr(f"[poll] Failed to post sticky cleanup request: {e}")
        return False


def _run_qodo_poll(review_url: str, owner: str, repo: str, pr_number: str, output_dir: str) -> int:
    """Poll for Qodo reviews in a loop until approved or new comments.

    Flow per cycle:
    1. Fetch reviews — if actionable comments found, return them
    2. If 0 new comments, check approval (sticky all resolved + commit match)
    3. If not approved, sleep and retry
    """
    owner_repo = f"{owner}/{repo}"
    _qodo_reviewing_since: float | None = None  # Track when "Looking for bugs" first appeared
    _cleanup_requested = False  # Track if we already asked Qodo to clean up stickies
    cycle = 0

    while True:
        cycle += 1
        print_stderr(f"[poll] Cycle {cycle} for {owner_repo}#{pr_number} (source: qodo)...")

        # Step 1: Fetch reviews first
        print_stderr("[poll] Fetching reviews...")
        fetch_result = fetch_run(review_url, output_dir=output_dir)
        fetch_ok = isinstance(fetch_result, dict)

        if fetch_ok:
            _print_poll_summary(pr_number, output_dir)
            has_actionable = _has_actionable_qodo_comments(pr_number, output_dir)
            if has_actionable:
                assert isinstance(fetch_result, dict)
                fetch_result["approved"] = False
                print_stderr("[poll] Found actionable Qodo comments.")
                print(json.dumps(fetch_result, indent=2))
                return 0
            else:
                print_stderr("[poll] No actionable Qodo comments (all auto-skipped or none found).")
        else:
            print_stderr(f"[poll] Fetch failed (exit code {fetch_result}). Will retry in {_POLL_SLEEP_SECONDS}s...")

        # Step 2: Check approval and handle stuck reviews
        if fetch_ok:
            # Check for stuck Qodo reviews (mid-review detection)
            _comments_endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
            _pr_comments = run_gh_api(_comments_endpoint, paginate=True)
            if _is_qodo_reviewing(owner, repo, pr_number, comments=_pr_comments):
                if _qodo_reviewing_since is None:
                    _qodo_reviewing_since = time.time()
                elif time.time() - _qodo_reviewing_since > _QODO_STUCK_TIMEOUT_SECONDS:
                    print_stderr("[poll] Qodo has been reviewing for over 1 hour — likely stuck.")
                    if _retrigger_qodo_review(owner, repo, pr_number):
                        _qodo_reviewing_since = time.time()
                    else:
                        _qodo_reviewing_since = (
                            time.time() - _QODO_STUCK_TIMEOUT_SECONDS + _QODO_RETRIGGER_COOLDOWN_SECONDS
                        )
                print_stderr(
                    "[poll] Qodo is currently reviewing — skipping approval check, waiting for review to complete."
                )
            elif isinstance(fetch_result, dict) and fetch_result.get("approved"):
                _qodo_reviewing_since = None
                print_stderr("[poll] Checking Qodo approval...")
                print_stderr("[poll] Qodo approved — all findings resolved.")
                # Get approval details for summary
                _approval_detail = is_qodo_approved(owner, repo, pr_number, comments=_pr_comments)
                if _approval_detail:
                    print_approval_summary(_approval_detail)
                print(json.dumps(fetch_result, indent=2))
                return 0
            else:
                _qodo_reviewing_since = None
                # Check for stale sticky findings and request cleanup
                if not _cleanup_requested and not has_actionable:
                    _review_path = Path(output_dir) / f"pr-{pr_number}-reviews.json"
                    if _review_path.exists():
                        try:
                            _review_data = json.loads(_review_path.read_text())
                            _has_stale = any(
                                f.get("is_auto_skipped") and f.get("already_replied")
                                for f in _review_data.get("qodo", [])
                            )
                            if _has_stale:
                                print_stderr("[poll] Stale sticky findings detected — requesting Qodo cleanup.")
                                if _request_qodo_sticky_cleanup(owner, repo, pr_number):
                                    _cleanup_requested = True
                        except Exception:
                            pass

        # No actionable result — sleep and loop
        print_stderr(f"[poll] No new Qodo comments. Sleeping {_POLL_SLEEP_SECONDS}s before next cycle...")
        time.sleep(_POLL_SLEEP_SECONDS)


def run(review_url: str = "", source: str = "coderabbit", *, output_dir: str) -> int:
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
        return _run_qodo_poll(review_url, owner, repo, pr_number, output_dir)

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
            # Fetch reviews data for the approval output
            _approval_data = fetch_run(review_url, output_dir=output_dir)
            if not isinstance(_approval_data, dict):
                # Retry once
                _approval_data = fetch_run(review_url, output_dir=output_dir)
            if isinstance(_approval_data, dict):
                _approval_data["approved"] = True
                print(json.dumps(_approval_data, indent=2))
                return 0
            # Fetch failed — do NOT approve without data, keep polling
            print_stderr("[poll] Warning: approval detected but fetch failed — will retry next cycle")

        # Step 3: Fetch reviews — get actionable comments before waiting on rate limit
        print_stderr("[poll] Fetching reviews...")
        fetch_result = fetch_run(review_url, output_dir=output_dir)
        fetch_ok = isinstance(fetch_result, dict)

        if fetch_ok:
            _print_poll_summary(pr_number, output_dir)
            # Check if there are actionable (non-auto-skipped) comments
            # fetch_run saves JSON to a predictable path
            has_actionable = _has_actionable_comments(pr_number, output_dir)
            if has_actionable:
                assert isinstance(fetch_result, dict)
                fetch_result["approved"] = False
                print(json.dumps(fetch_result, indent=2))
                return 0
            print_stderr("[poll] All fetched comments are auto-skipped (previously addressed). No new comments.")
        else:
            # Fetch failed -- log and retry
            print_stderr(f"[poll] Fetch failed (exit code {fetch_result}). Will retry in {_POLL_SLEEP_SECONDS}s...")

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
                _approval_data = fetch_run(review_url, output_dir=output_dir)
                if not isinstance(_approval_data, dict):
                    # Retry once
                    _approval_data = fetch_run(review_url, output_dir=output_dir)
                if isinstance(_approval_data, dict):
                    _approval_data["approved"] = True
                    print(json.dumps(_approval_data, indent=2))
                    return 0
                # Fetch failed — do NOT approve without data, keep polling
                print_stderr("[poll] Warning: approval detected but fetch failed — will retry next cycle")

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
                        _approval_data = fetch_run(review_url, output_dir=output_dir)
                        if not isinstance(_approval_data, dict):
                            # Retry once
                            _approval_data = fetch_run(review_url, output_dir=output_dir)
                        if isinstance(_approval_data, dict):
                            _approval_data["approved"] = True
                            print(json.dumps(_approval_data, indent=2))
                            return 0
                        # Fetch failed — do NOT approve without data, keep polling
                        print_stderr("[poll] Warning: approval detected but fetch failed — will retry next cycle")
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
