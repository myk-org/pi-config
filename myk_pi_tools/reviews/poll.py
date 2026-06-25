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
        if any(marker in body for marker in _QODO_REVIEWING_MARKERS):
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
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        print_stderr(f"[poll] Failed to post /agentic_review: {e}")
        return False


def _is_qodo_approved(owner: str, repo: str, pr_number: str, comments: list | None = None) -> dict | None:
    """Check if Qodo has approved the PR.

    Returns a summary dict if approved, None if not approved.

    Approved when:
    1. Sticky comment has 0 unresolved findings (or all unresolved are already replied to)
    2. Sticky has at least one resolved/dismissed finding (not empty)
    3. Sticky updated_at is AFTER PR head commit date (Qodo finished reviewing latest)

    Returns dict with keys:
    - approved: True
    - reason: str ("all_resolved" or "stale_sticky")
    - total_findings: int (total in sticky, resolved + unresolved)
    - resolved_count: int (resolved/dismissed by Qodo)
    - unresolved_count: int (still open in sticky)
    - findings: list of dicts with title, status, reply (from DB for already-replied)
    """
    from myk_pi_tools.reviews.qodo_parser import is_qodo_sticky_comment, parse_qodo_sticky_comment

    # Get PR head SHA
    pr_endpoint = f"/repos/{owner}/{repo}/pulls/{pr_number}"
    pr_data = run_gh_api(pr_endpoint)
    if not isinstance(pr_data, dict):
        return None
    head_sha = pr_data.get("head", {}).get("sha", "")
    if not head_sha:
        return None

    # Get commit date for PR HEAD
    commit_endpoint = f"/repos/{owner}/{repo}/commits/{head_sha}"
    commit_data = run_gh_api(commit_endpoint)
    if not isinstance(commit_data, dict):
        return None
    commit_date = commit_data.get("commit", {}).get("committer", {}).get("date", "")
    if not commit_date:
        return None

    # Find the Qodo sticky comment
    if comments is None:
        endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
        comments = run_gh_api(endpoint, paginate=True)
    if not comments or not isinstance(comments, list):
        return None

    QODO_USERS = {"qodo-code-review[bot]", "qodo-code-review"}

    for comment in comments:
        author = comment.get("user", {}).get("login") if comment.get("user") else None
        if author not in QODO_USERS:
            continue

        body = comment.get("body", "")
        if not is_qodo_sticky_comment(body):
            continue

        # Check sticky was updated AFTER the commit
        sticky_updated = comment.get("updated_at", "")
        if not sticky_updated or sticky_updated < commit_date:
            print_stderr(f"[poll] Sticky updated {sticky_updated} but commit at {commit_date} — not yet reviewed.")
            return None

        # Parse for unresolved findings
        unresolved = parse_qodo_sticky_comment(body)

        # Count resolved findings from the sticky body
        import re as _re

        _prev_re = _re.compile(r"^\s*<!-- FOLDED_SECTION_START -->\s*$", _re.MULTILINE)
        _prev_match = _prev_re.search(body)
        current_body = body[: _prev_match.start()] if _prev_match else body
        resolved_count = current_body.count("Resolved</code>") + current_body.count("Dismissed</code>")
        total_findings = resolved_count + len(unresolved)

        if len(unresolved) > 0:
            # Check if all unresolved findings were already replied to (stale sticky)
            try:
                from myk_pi_tools.db.query import ReviewDB

                db = ReviewDB(db_path=None)
                replied = db.get_replied_sticky_findings(owner, repo, int(pr_number))

                # Build lookup: (comment_id, body, code_diff) -> DB record
                replied_map: dict[tuple[int, str, str], dict] = {}
                for r in replied:
                    cid = r.get("comment_id")
                    rbody = r.get("body") or ""
                    rcode_diff = r.get("code_diff") or ""
                    if cid is not None:
                        key = (int(cid), rbody, rcode_diff)
                        existing = replied_map.get(key)
                        if existing is None:
                            replied_map[key] = r
                        else:
                            # Prefer records with meaningful replies over dedup artifacts
                            existing_reply = existing.get("reply") or ""
                            new_reply = r.get("reply") or ""
                            if "Already replied" in existing_reply and "Already replied" not in new_reply and new_reply:
                                replied_map[key] = r

                # Check each unresolved finding
                sticky_id = int(comment.get("id", 0))
                all_replied = True
                findings_summary = []
                for finding in unresolved:
                    finding_body = f"**{finding.get('title', '')}**\n\n{finding.get('description', '')}"
                    finding_code_diff = finding.get("code_diff") or ""
                    key = (sticky_id, finding_body, finding_code_diff)
                    db_record = replied_map.get(key)
                    if db_record:
                        findings_summary.append({
                            "title": finding.get("title", ""),
                            "finding_type": finding.get("finding_type", ""),
                            "status": db_record.get("status", "unknown"),
                            "reply": db_record.get("reply", ""),
                        })
                    else:
                        all_replied = False
                        break

                if all_replied:
                    print_stderr(
                        f"[poll] Sticky has {len(unresolved)} unresolved finding(s),"
                        f" but all already replied to (stale sticky)."
                    )
                    print_stderr("[poll] Treating stale sticky as approved.")
                    return {
                        "approved": True,
                        "reason": "stale_sticky",
                        "total_findings": total_findings,
                        "resolved_count": resolved_count,
                        "unresolved_count": len(unresolved),
                        "findings": findings_summary,
                    }
            except Exception as e:
                print_stderr(f"[poll] Warning: Could not check replied sticky findings: {e}")

            print_stderr(f"[poll] Sticky has {len(unresolved)} unresolved finding(s).")
            return None

        # Check at least one resolved/dismissed finding exists
        has_resolved = (
            "✓ Resolved" in current_body
            or "Resolved</code>" in current_body
            or "✗ Dismissed" in current_body
            or "Dismissed</code>" in current_body
        )
        if not has_resolved:
            print_stderr("[poll] Sticky has no resolved findings — empty review.")
            return None

        # All checks passed — fully approved by Qodo
        return {
            "approved": True,
            "reason": "all_resolved",
            "total_findings": total_findings,
            "resolved_count": resolved_count,
            "unresolved_count": 0,
            "findings": [],
        }

    # No sticky comment found
    return None


def _print_approval_summary(approval: dict) -> None:
    """Print a summary of the Qodo approval status."""
    reason = approval.get("reason", "unknown")
    total = approval.get("total_findings", 0)
    resolved = approval.get("resolved_count", 0)
    unresolved = approval.get("unresolved_count", 0)
    findings = approval.get("findings", [])

    print_stderr("")
    print_stderr("[poll] === Qodo Approval Summary ===")
    print_stderr(f"  Total findings: {total} ({resolved} resolved by Qodo, {unresolved} still in sticky)")

    if reason == "all_resolved":
        print_stderr("  Status: All findings resolved/dismissed by Qodo ✅")
    elif reason == "stale_sticky":
        print_stderr("  Status: Stale sticky — all unresolved findings already replied to")
        if findings:
            print_stderr("")
            print_stderr("  Unresolved findings (already replied):")
            for i, f in enumerate(findings, 1):
                title = f.get("title", "unknown")
                status = f.get("status", "unknown")
                finding_type = f.get("finding_type", "")
                reply = f.get("reply", "")
                status_icon = {"addressed": "✅", "not_addressed": "⚠️", "skipped": "⏭️"}.get(status, "❓")
                type_tag = f" [{finding_type}]" if finding_type else ""
                print_stderr(f"    {i}. {status_icon} [{status}]{type_tag} {title}")
                if reply:
                    # Show first line of reply, truncated
                    reason_line = reply.split("\n")[0].strip()
                    if len(reason_line) > 100:
                        reason_line = reason_line[:97] + "..."
                    print_stderr(f"       Reply: {reason_line}")

    print_stderr("")


def _run_qodo_poll(review_url: str, owner: str, repo: str, pr_number: str, output_dir: str) -> int:
    """Poll for Qodo reviews in a loop until approved or new comments.

    Flow per cycle:
    1. Fetch reviews — if actionable comments found, return them
    2. If 0 new comments, check approval (sticky all resolved + commit match)
    3. If not approved, sleep and retry
    """
    owner_repo = f"{owner}/{repo}"
    _qodo_reviewing_since: float | None = None  # Track when "Looking for bugs" first appeared
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
                # Before returning, check if Qodo is mid-review — if so, wait for it to finish
                _comments_endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
                _pr_comments = run_gh_api(_comments_endpoint, paginate=True)
                if _is_qodo_reviewing(owner, repo, pr_number, comments=_pr_comments):
                    if _qodo_reviewing_since is None:
                        _qodo_reviewing_since = time.time()
                    elif time.time() - _qodo_reviewing_since > _QODO_STUCK_TIMEOUT_SECONDS:
                        print_stderr("[poll] Qodo has been reviewing for over 1 hour — likely stuck.")
                        if _retrigger_qodo_review(owner, repo, pr_number):
                            _qodo_reviewing_since = time.time()  # Reset timer on success
                        else:
                            # Cooldown: retry after ~30 min (shift timer to 30 min before threshold)
                            _qodo_reviewing_since = (
                                time.time() - _QODO_STUCK_TIMEOUT_SECONDS + _QODO_RETRIGGER_COOLDOWN_SECONDS
                            )
                    print_stderr(
                        "[poll] Qodo is currently reviewing —"
                        " waiting for review to complete before processing findings."
                    )
                else:
                    _qodo_reviewing_since = None  # Reset — Qodo finished reviewing
                    print_stderr("[poll] Found actionable Qodo comments.")
                    assert isinstance(fetch_result, dict)
                    fetch_result["approved"] = False
                    print(json.dumps(fetch_result, indent=2))
                    return 0
            else:
                print_stderr("[poll] No actionable Qodo comments (all auto-skipped or none found).")
        else:
            print_stderr(f"[poll] Fetch failed (exit code {fetch_result}). Will retry in {_POLL_SLEEP_SECONDS}s...")

        # Step 2: Only check approval AFTER confirming 0 new comments
        # This prevents approving before processing new findings
        if fetch_ok:
            # Fetch PR comments once — reused by mid-review and approval checks
            _comments_endpoint = f"/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"
            _pr_comments = run_gh_api(_comments_endpoint, paginate=True)
            # Don't check approval if Qodo is mid-review — sticky is about to change
            if _is_qodo_reviewing(owner, repo, pr_number, comments=_pr_comments):
                if _qodo_reviewing_since is None:
                    _qodo_reviewing_since = time.time()
                elif time.time() - _qodo_reviewing_since > _QODO_STUCK_TIMEOUT_SECONDS:
                    print_stderr("[poll] Qodo has been reviewing for over 1 hour — likely stuck.")
                    if _retrigger_qodo_review(owner, repo, pr_number):
                        _qodo_reviewing_since = time.time()  # Reset timer on success
                    else:
                        # Cooldown: retry after ~30 min (shift timer to 30 min before threshold)
                        _qodo_reviewing_since = (
                            time.time() - _QODO_STUCK_TIMEOUT_SECONDS + _QODO_RETRIGGER_COOLDOWN_SECONDS
                        )
                print_stderr(
                    "[poll] Qodo is currently reviewing — skipping approval check, waiting for review to complete."
                )
            else:
                _qodo_reviewing_since = None  # Reset — Qodo finished reviewing
                print_stderr("[poll] Checking Qodo approval...")
                approval = _is_qodo_approved(owner, repo, pr_number, comments=_pr_comments)
                if approval:
                    reason = approval.get("reason", "unknown")
                    if reason == "all_resolved":
                        print_stderr("[poll] Qodo approved — all findings resolved.")
                    elif reason == "stale_sticky":
                        print_stderr("[poll] Qodo approved — stale sticky, all unresolved findings already replied to.")
                    else:
                        print_stderr(f"[poll] Qodo approved — {reason}.")
                    # Print approval summary
                    _print_approval_summary(approval)
                    assert isinstance(fetch_result, dict)
                    fetch_result["approved"] = True
                    print(json.dumps(fetch_result, indent=2))
                    return 0

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
            if isinstance(_approval_data, dict):
                _approval_data["approved"] = True
                print(json.dumps(_approval_data, indent=2))
            else:
                print(json.dumps({"approved": True}, indent=2))
            return 0

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
                if isinstance(_approval_data, dict):
                    _approval_data["approved"] = True
                    print(json.dumps(_approval_data, indent=2))
                else:
                    print(json.dumps({"approved": True}, indent=2))
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
                        _approval_data = fetch_run(review_url, output_dir=output_dir)
                        if isinstance(_approval_data, dict):
                            _approval_data["approved"] = True
                            print(json.dumps(_approval_data, indent=2))
                        else:
                            print(json.dumps({"approved": True}, indent=2))
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
