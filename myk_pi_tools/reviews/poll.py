"""Reviews poll command -- internal loop with approval + rate-limit + fetch.

Loops internally until something actionable happens:
- CodeRabbit approved the PR -> return {"approved": true}
- New comments found -> return the fetch JSON

Handles rate limiting internally (wait + trigger). Never returns
on "no new comments" -- sleeps and retries.
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from myk_pi_tools.coderabbit.approved import _APPROVED_MARKER
from myk_pi_tools.coderabbit.rate_limit import (
    _RATE_LIMITED_MARKER,
    _REVIEWS_PAUSED_FALLBACK_HEADING,
    _REVIEWS_PAUSED_FALLBACK_SETTING,
    _REVIEWS_PAUSED_MARKER,
    _parse_wait_seconds,
    _post_resume_trigger,
    compute_remaining_wait,
    run_trigger,
)
from myk_pi_tools.coderabbit.utils import SUMMARY_MARKER, find_summary_comment, validate_owner_repo
from myk_pi_tools.logger import create_logger
from myk_pi_tools.reviews.ask_qodo import post_and_wait_for_qodo_reply
from myk_pi_tools.reviews.constants import QODO_STICKY_TYPES
from myk_pi_tools.reviews.fetch import (
    consume_fetch_context,
    get_pr_info,
    is_qodo_approved,
    print_approval_summary,
    print_stderr,
    run_gh_api,
)
from myk_pi_tools.reviews.fetch import run as fetch_run
from myk_pi_tools.utils import atomic_write_json, post_issue_comment

log = create_logger(__name__)

_RATE_LIMIT_BUFFER_SECONDS = 30
_POLL_SLEEP_SECONDS = 300  # 5 minutes between cycles when no rate limit

# Pushback indicators in Qodo responses — Qodo disagrees with our fix/decision
_PUSHBACK_KEYWORDS = re.compile(
    r"(\bstill (?:present|exists?|unresolved|open|not (?:fixed|addressed|resolved))\b"
    r"|\bnot (?:fully |completely )?(?:addressed|resolved|fixed)\b"
    r"|\bdisagree\b|\bissue (?:remains|persists)\b"
    r"|\b(?:is|that'?s|this is|are) (?:incorrect|wrong)\b"
    r"|^\s*(?:incorrect|wrong)\.?\s*$"
    r"|\bdoes not (?:address|fix|resolve)\b"
    r"|\bshould still\b"
    r"|\brecommend (?:re-?evaluating|revisiting)\b"
    r"|\bre-?open\b)",
    re.IGNORECASE | re.MULTILINE,
)


def _load_reviews_data(pr_number: str, output_dir: str, data: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Return ``data`` when supplied, else read ``pr-<pr_number>-reviews.json`` from disk."""
    if data is not None:
        return data
    json_path = Path(output_dir) / f"pr-{pr_number}-reviews.json"
    if not json_path.exists():
        return None
    try:
        with open(json_path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _print_poll_summary(pr_number: str, output_dir: str, data: dict[str, Any] | None = None) -> None:
    """Print a summary line showing total/new/skipped counts after fetch."""
    loaded = _load_reviews_data(pr_number, output_dir, data)
    if loaded is None:
        return

    total = 0
    new = 0
    skipped = 0
    for source in ("human", "qodo", "coderabbit"):
        for comment in loaded.get(source, []):
            total += 1
            if comment.get("is_auto_skipped"):
                skipped += 1
            elif comment.get("status") == "pending":
                new += 1

    log.debug("[poll] Summary: %d total, %d new, %d auto-skipped", total, new, skipped)


def _has_actionable_comments(pr_number: str, output_dir: str, data: dict[str, Any] | None = None) -> bool:
    """Check if the fetched reviews JSON has any actionable (non-auto-skipped) comments."""
    loaded = _load_reviews_data(pr_number, output_dir, data)
    if loaded is None:
        # Can't determine — assume actionable to be safe
        return True

    for source in ("human", "qodo", "coderabbit"):
        for comment in loaded.get(source, []):
            if not comment.get("is_auto_skipped"):
                return True

    return False


def _has_actionable_qodo_comments(pr_number: str, output_dir: str, data: dict[str, Any] | None = None) -> bool:
    """Check if fetched reviews have actionable Qodo comments.

    A comment is actionable if:
    - Not auto-skipped AND not already replied (new finding), OR
    - Not auto-skipped AND already replied AND qodo_response contains
      pushback keywords (Qodo disagrees with our previous fix)

    Already-replied findings WITHOUT pushback are not actionable in the poll
    — Qodo's silence or confirmation means the finding is resolved.
    """
    loaded = _load_reviews_data(pr_number, output_dir, data)
    if loaded is None:
        return True

    for comment in loaded.get("qodo", []):
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
# "Looking for bugs?" and "Qodo is busy working" are <h3> headings in Qodo's transient comment.
# Do NOT add broad markers — they false-positive against PR summary/description text.
_QODO_REVIEWING_MARKERS = ("Looking for bugs?", "Qodo is busy working")

_QODO_STUCK_TIMEOUT_SECONDS = 3600  # 1 hour — if Qodo's transient comment persists, Qodo is stuck
_QODO_RETRIGGER_COOLDOWN_SECONDS = 1801  # ~30 min cooldown between re-trigger attempts (+1s for strict > comparison)


def _is_qodo_reviewing(owner: str, repo: str, pr_number: str, comments: list | None = None) -> bool:
    """Check if Qodo is currently reviewing the PR.

    Qodo posts a transient comment while reviewing (e.g., "Looking for bugs?", "Qodo is busy working").
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
            print_stderr("[poll] Qodo review in progress.")
            return True

    return False


def _retrigger_qodo_review(owner: str, repo: str, pr_number: str) -> bool:
    """Post /agentic_review comment to re-trigger a stuck Qodo review.

    Returns True if the comment was posted successfully.
    """
    ok, _stdout, err = post_issue_comment(owner, repo, pr_number, "/agentic_review", timeout=30)
    if ok:
        print_stderr("[poll] Posted /agentic_review to re-trigger stuck Qodo review.")
        return True
    print_stderr(f"[poll] Failed to post /agentic_review: {err}")
    return False


def _run_fetch_quiet(review_url: str, *, output_dir: str) -> dict[str, Any] | int:
    """Run ``fetch_run`` while routing routine progress lines to ``log.debug``."""
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        result = fetch_run(review_url, output_dir=output_dir)
    for line in buf.getvalue().splitlines():
        if not line:
            continue
        lower = line.lower()
        if "error" in lower or "warning" in lower or "⚠️" in line:
            print_stderr(line)
        else:
            log.debug("[fetch] %s", line)
    return result


_CLEANUP_REQUEST_TEXT = (
    "Please re-evaluate all remaining sticky findings against the current code.\n"
    "For each finding, check if the referenced code has been fixed in subsequent commits.\n"
    "Remove findings that are fully addressed. "
    "Keep any findings where the issue is still present in the code."
)


def _request_qodo_sticky_cleanup(owner: str, repo: str, pr_number: str) -> str:
    """Ask Qodo to re-evaluate sticky findings via /ask command and wait for reply.

    Uses Qodo v2's /ask command instead of @mention — Qodo v2 responds to
    slash commands, not free-text @mentions.

    Returns Qodo's reply body text, or empty string on timeout/failure.
    """
    message = f"/qodo {_CLEANUP_REQUEST_TEXT}"
    match_lines = [line.strip() for line in _CLEANUP_REQUEST_TEXT.strip().splitlines() if line.strip()]
    return post_and_wait_for_qodo_reply(
        owner,
        repo,
        pr_number,
        message,
        match_lines,
        label="poll",
    )


def _run_qodo_poll(review_url: str, owner: str, repo: str, pr_number: str, output_dir: str) -> int:
    """Poll for Qodo reviews in a loop until approved or new comments.

    Flow per cycle:
    1. Fetch reviews — if actionable comments found, return them
    2. If 0 new comments, check approval (sticky all resolved + commit match)
    3. If not approved, sleep and retry
    """
    owner_repo = f"{owner}/{repo}"
    _qodo_reviewing_since: float | None = None  # Track when Qodo's transient "reviewing" comment first appeared
    _cleanup_last_requested_at: float = 0  # Timestamp of last cleanup request (0 = never)
    _CLEANUP_RETRY_COOLDOWN_SECONDS = 300  # 5 min cooldown between cleanup retries
    _cleanup_response = ""  # Qodo's reply to our cleanup request
    cycle = 0
    _result: dict | None = None

    while True:
        cycle += 1
        has_actionable = False
        log.debug("[poll] Cycle %d for %s#%s (source: qodo)...", cycle, owner_repo, pr_number)

        # Step 1: Fetch reviews first
        log.debug("[poll] Fetching reviews...")
        fetch_result = _run_fetch_quiet(review_url, output_dir=output_dir)
        fetch_ok = isinstance(fetch_result, dict)
        fetch_ctx = consume_fetch_context(owner, repo, pr_number) if fetch_ok else None

        if fetch_ok:
            assert isinstance(fetch_result, dict)
            _print_poll_summary(pr_number, output_dir, data=fetch_result)
            has_actionable = _has_actionable_qodo_comments(pr_number, output_dir, data=fetch_result)
            if has_actionable:
                fetch_result["approved"] = False
                fetch_result["qodo_cleanup_response"] = _cleanup_response
                print_stderr("[poll] Found actionable Qodo comments.")
                _result = fetch_result
                break
            else:
                log.debug("[poll] No actionable Qodo comments (all auto-skipped or none found).")
        else:
            print_stderr(f"[poll] Fetch failed (exit code {fetch_result}). Will retry in {_POLL_SLEEP_SECONDS}s...")

        # Step 2: Check approval and handle stuck reviews
        if fetch_ok:
            assert isinstance(fetch_result, dict)
            # CLI state (issue #958): when the qodo CLI branch ran this cycle,
            # its review_session is authoritative for in-progress detection
            # and the approval summary — no comment-churn heuristics needed.
            _cli_state = fetch_result.get("qodo_cli_state")
            if _cli_state is not None:
                if _cli_state.get("reviewing"):
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
                        f"[poll] Qodo review in progress (CLI session status: {_cli_state.get('status')}) —"
                        " skipping approval check, waiting for review to complete."
                    )
                elif fetch_result.get("approved"):
                    _qodo_reviewing_since = None
                    log.debug("[poll] Checking Qodo approval...")
                    print_stderr("[poll] Qodo approved — all findings resolved.")
                    print_approval_summary(_cli_state)
                    fetch_result["qodo_cleanup_response"] = ""  # Clear — stale when approved
                    _result = fetch_result
                    break
                else:
                    # No open findings, not reviewing, not approved (session
                    # behind head, etc.) — keep polling. Stale sticky cleanup
                    # is a GitHub-scrape concern; in CLI mode attribution_status
                    # is authoritative, so there is nothing to clean up.
                    _qodo_reviewing_since = None
            else:
                # GitHub branch: reuse issue comments fetched by fetch_run when available
                _pr_comments = fetch_ctx.get("issue_comments") if fetch_ctx is not None else None
                if _pr_comments is None:
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
                    log.debug(
                        "[poll] Qodo is currently reviewing — skipping approval check, waiting for review to complete."
                    )
                elif fetch_result.get("approved"):
                    _qodo_reviewing_since = None
                    log.debug("[poll] Checking Qodo approval...")
                    print_stderr("[poll] Qodo approved — all findings resolved.")
                    _approval_detail = fetch_ctx.get("approval_detail") if fetch_ctx is not None else None
                    if _approval_detail is None:
                        _approval_detail = is_qodo_approved(owner, repo, pr_number, comments=_pr_comments)
                    if _approval_detail:
                        print_approval_summary(_approval_detail)
                    fetch_result["qodo_cleanup_response"] = ""  # Clear — stale when approved
                    _result = fetch_result
                    break
                else:
                    _qodo_reviewing_since = None
                    # Check for stale sticky findings and request cleanup
                    _cleanup_cooldown_elapsed = (
                        _cleanup_last_requested_at == 0
                        or time.time() - _cleanup_last_requested_at > _CLEANUP_RETRY_COOLDOWN_SECONDS
                    )
                    if _cleanup_cooldown_elapsed and not has_actionable:
                        try:
                            _qodo_items = fetch_result.get("qodo")
                            if not _qodo_items:
                                _disk_data = _load_reviews_data(pr_number, output_dir)
                                _qodo_items = _disk_data.get("qodo", []) if _disk_data else []
                            _has_stale = any(
                                f.get("already_replied")
                                and not f.get("thread_id")
                                and f.get("type") in QODO_STICKY_TYPES
                                for f in _qodo_items
                            )
                            if _has_stale:
                                _retry_label = "Retrying" if _cleanup_last_requested_at > 0 else "Requesting"
                                print_stderr(
                                    f"[poll] Stale sticky findings detected — {_retry_label.lower()} Qodo cleanup."
                                )
                                _cleanup_reply = _request_qodo_sticky_cleanup(owner, repo, pr_number)
                                _cleanup_last_requested_at = time.time()
                                if _cleanup_reply:
                                    _cleanup_response = _cleanup_reply
                                    # Re-fetch to get fresh data
                                    _fresh = _run_fetch_quiet(review_url, output_dir=output_dir)
                                    if isinstance(_fresh, dict):
                                        _fresh["qodo_cleanup_response"] = _cleanup_response
                                        _fresh["approved"] = False
                                        _result = _fresh
                                        break
                                else:
                                    # Cleanup request timed out — Qodo didn't reply.
                                    # Force a fresh review via /agentic_review so Qodo
                                    # re-evaluates the PR and resolves stale stickies.
                                    print_stderr(
                                        "[poll] Cleanup timed out — triggering /agentic_review"
                                        " to force fresh Qodo review."
                                    )
                                    _retrigger_qodo_review(owner, repo, pr_number)

                        except Exception as e:
                            print_stderr(f"[poll] Cleanup check failed: {e}")

        if _result is not None:
            break

        # No actionable result — sleep and loop
        log.debug("[poll] No new Qodo comments. Sleeping %ds before next cycle...", _POLL_SLEEP_SECONDS)
        time.sleep(_POLL_SLEEP_SECONDS)

    # Single exit path — re-write file and print to stdout
    _json_path = Path(output_dir) / f"pr-{_result['metadata']['pr_number']}-reviews.json"
    atomic_write_json(
        _json_path,
        _result,
        indent=2,
        prefix=f"pr-{_result['metadata']['pr_number']}-reviews.json.",
    )
    print(json.dumps(_result, separators=(",", ":")))
    return 0


def _extract_coderabbit_summary(
    comments: list[dict[str, Any]],
) -> tuple[int | None, str | None, str | None, str]:
    """Extract the latest CodeRabbit summary comment from already-fetched issue comments."""
    matches = [c for c in comments if SUMMARY_MARKER in (c.get("body") or "")]
    if not matches:
        return None, None, None, "No CodeRabbit summary comment found on this PR"
    latest = matches[-1]
    comment_id = latest.get("id")
    body = latest.get("body")
    updated_at = latest.get("updated_at")
    if comment_id is None or body is None:
        return None, None, None, "No CodeRabbit summary comment found on this PR"
    return comment_id, body, updated_at, ""


def _emit_approval_if_ready(
    owner_repo: str,
    pr_number: int,
    review_url: str,
    output_dir: str,
    *,
    summary_comment: tuple[int | None, str | None, str | None, str] | None = None,
) -> tuple[bool, tuple[int | None, str | None, str | None, str] | None]:
    """Check CodeRabbit approval (optionally reusing ``summary_comment``) and emit JSON if ready.

    Returns ``(emitted, summary_comment)``.
    """
    if summary_comment is None:
        if not validate_owner_repo(owner_repo):
            return False, None
        summary_comment = find_summary_comment(owner_repo, pr_number)
    _cid, body, _updated_at, _err = summary_comment
    if body is None or _APPROVED_MARKER not in body:
        return False, summary_comment

    print_stderr("[poll] CodeRabbit approved \u2014 no actionable comments.")
    approval_data = _run_fetch_quiet(review_url, output_dir=output_dir)
    if not isinstance(approval_data, dict):
        approval_data = _run_fetch_quiet(review_url, output_dir=output_dir)
    if isinstance(approval_data, dict):
        approval_data["approved"] = True
        print(json.dumps(approval_data, separators=(",", ":")))
        return True, summary_comment
    print_stderr("[poll] Warning: approval detected but fetch failed — will retry next cycle")
    return False, summary_comment


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
    pr_num_int = int(pr_number)
    cycle = 0
    resume_attempts = 0

    while True:
        cycle += 1
        log.debug("[poll] Cycle %d for %s#%s...", cycle, owner_repo, pr_number)

        # Step 2: Check if CodeRabbit approved
        log.debug("[poll] Checking CodeRabbit approval...")
        emitted, _ = _emit_approval_if_ready(owner_repo, pr_num_int, review_url, output_dir)
        if emitted:
            return 0

        # Step 3: Fetch reviews — get actionable comments before waiting on rate limit
        log.debug("[poll] Fetching reviews...")
        fetch_result = _run_fetch_quiet(review_url, output_dir=output_dir)
        fetch_ok = isinstance(fetch_result, dict)
        fetch_ctx = consume_fetch_context(owner, repo, pr_number) if fetch_ok else None

        if fetch_ok:
            assert isinstance(fetch_result, dict)
            _print_poll_summary(pr_number, output_dir, data=fetch_result)
            has_actionable = _has_actionable_comments(pr_number, output_dir, data=fetch_result)
            if has_actionable:
                fetch_result["approved"] = False
                print_stderr("[poll] Found actionable comments.")
                print(json.dumps(fetch_result, separators=(",", ":")))
                return 0
            log.debug("[poll] All fetched comments are auto-skipped (previously addressed). No new comments.")
        else:
            print_stderr(f"[poll] Fetch failed (exit code {fetch_result}). Will retry in {_POLL_SLEEP_SECONDS}s...")

        # Step 4: Check CodeRabbit rate limit using post-fetch summary state
        log.debug("[poll] Checking CodeRabbit rate limit...")
        issue_comments = fetch_ctx.get("issue_comments") if fetch_ctx is not None else None
        if isinstance(issue_comments, list):
            comment_id, body, updated_at, error = _extract_coderabbit_summary(issue_comments)
        else:
            comment_id, body, updated_at, error = find_summary_comment(owner_repo, pr_num_int)

        if comment_id is not None and body is not None and _RATE_LIMITED_MARKER in body:
            # Rate limited -- parse wait time and subtract elapsed time
            wait_seconds = _parse_wait_seconds(body)
            if wait_seconds is None:
                print_stderr("[poll] Warning: Rate limited but could not parse wait time. Using 300s default.")
                wait_seconds = 300

            remaining, elapsed, parsed_ok = compute_remaining_wait(wait_seconds, updated_at)
            if not parsed_ok:
                print_stderr("[poll] Warning: Could not parse comment timestamp. Using full wait time.")
            elif updated_at:
                log.debug(
                    "[poll] Rate limit posted %ds ago. Original: %ds, remaining: %ds",
                    elapsed,
                    wait_seconds,
                    remaining,
                )

            total_wait = remaining + _RATE_LIMIT_BUFFER_SECONDS
            print_stderr(f"[poll] CodeRabbit is rate limited. Waiting {total_wait}s then triggering re-review...")

            # Trigger (waits internally, posts trigger, polls until review starts)
            with contextlib.redirect_stdout(sys.stderr):
                trigger_result = run_trigger(owner_repo, pr_num_int, total_wait)
            if trigger_result != 0:
                print_stderr("[poll] Warning: Trigger returned non-zero. Continuing loop.")

            # Step 5: Check approval again after trigger (new review might approve)
            log.debug("[poll] Re-checking approval after rate limit trigger...")
            emitted, _ = _emit_approval_if_ready(owner_repo, pr_num_int, review_url, output_dir)
            if emitted:
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

                resume_id = _post_resume_trigger(owner_repo, pr_num_int)
                if resume_id is not None:
                    print_stderr(f"[poll] Posted @coderabbitai resume (comment ID: {resume_id})")

                    # Re-check approval after resume (CodeRabbit may immediately approve)
                    log.debug("[poll] Re-checking approval after resume trigger...")
                    emitted, _ = _emit_approval_if_ready(owner_repo, pr_num_int, review_url, output_dir)
                    if emitted:
                        return 0
                else:
                    print_stderr("[poll] Warning: Failed to post resume trigger. Will retry next cycle.")

        elif comment_id is None:
            if error and "No CodeRabbit summary comment found" in error:
                log.debug("[poll] No CodeRabbit summary comment found.")
            elif error:
                print_stderr(f"[poll] Could not check rate limit ({error}).")
            else:
                log.debug("[poll] No CodeRabbit summary comment found.")
        else:
            log.debug("[poll] No rate limit detected.")

        # Step 6: No actionable result -- sleep and loop
        log.debug("[poll] No new comments. Sleeping %ds before next cycle...", _POLL_SLEEP_SECONDS)
        time.sleep(_POLL_SLEEP_SECONDS)
