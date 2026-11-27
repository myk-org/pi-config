"""Shared utilities for CodeRabbit operations."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from typing import Any

from myk_pi_tools.github import run_gh, run_gh_api_result
from myk_pi_tools.logger import create_logger
from myk_pi_tools.pr.common import validate_repo_format

log = create_logger(__name__)

# HTML comment marker in CodeRabbit's summary comment
SUMMARY_MARKER = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->"

CODERABBIT_CHECK_NAME = "CodeRabbit"
CODERABBIT_APP_SLUG = "coderabbitai"
CODERABBIT_BOT_LOGIN = "coderabbitai[bot]"
REPLY_LOOKBACK_SECONDS = 300


def _parse_iso_timestamp(ts: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp into a timezone-aware UTC datetime, or None."""
    if not isinstance(ts, str):
        return None
    cleaned = ts.strip()
    if not cleaned:
        return None
    if cleaned.endswith(("Z", "z")):
        cleaned = f"{cleaned[:-1]}+00:00"
    try:
        dt = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _check_run_sort_key(run: dict[str, Any]) -> tuple[float, float, float, int]:
    """Sort key ordering check runs newest-first by effective timestamp, completed, started, id."""
    completed_dt = _parse_iso_timestamp(run.get("completed_at"))
    started_dt = _parse_iso_timestamp(run.get("started_at"))
    completed_ts = completed_dt.timestamp() if completed_dt is not None else -1.0
    started_ts = started_dt.timestamp() if started_dt is not None else -1.0
    effective_ts = completed_ts if completed_dt is not None else started_ts
    raw_id = run.get("id")
    run_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else 0
    return (effective_ts, completed_ts, started_ts, run_id)


def _comment_sort_key(comment: dict[str, Any]) -> tuple[float, float, int]:
    """Sort key ordering issue comments newest-first by created_at, updated_at, id."""
    created_dt = _parse_iso_timestamp(comment.get("created_at"))
    updated_dt = _parse_iso_timestamp(comment.get("updated_at"))
    created_ts = created_dt.timestamp() if created_dt is not None else -1.0
    updated_ts = updated_dt.timestamp() if updated_dt is not None else -1.0
    raw_id = comment.get("id")
    comment_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else 0
    return (created_ts, updated_ts, comment_id)


def find_coderabbit_check_run(owner_repo: str, pr_number: int) -> tuple[dict[str, Any] | None, str]:
    """Find the newest CodeRabbit check run on a PR's head SHA.

    Returns ``(check_run, error)`` where ``error`` is ``""`` on success (including
    when no CodeRabbit check run exists yet).
    """
    owner, repo = owner_repo.split("/")
    pr_data, err = run_gh_api_result(f"repos/{owner}/{repo}/pulls/{pr_number}", timeout=60)
    if err:
        log.warning("Failed to fetch PR %s#%d: %s", owner_repo, pr_number, err)
        return None, f"GitHub API error: {err}"

    head = pr_data.get("head") if isinstance(pr_data, dict) else None
    raw_sha = head.get("sha") if isinstance(head, dict) else None
    if not isinstance(raw_sha, str) or not raw_sha.strip():
        log.warning("Could not resolve PR head SHA for %s#%d", owner_repo, pr_number)
        return None, "Could not resolve PR head SHA"
    head_sha = raw_sha.strip()

    runs_data, err = run_gh_api_result(
        f"repos/{owner}/{repo}/commits/{head_sha}/check-runs?per_page=100",
        paginate=True,
        timeout=60,
    )
    if err:
        log.warning("Failed to fetch check runs for %s#%d at %s: %s", owner_repo, pr_number, head_sha, err)
        return None, f"GitHub API error: {err}"

    if isinstance(runs_data, dict):
        pages: list[Any] = [runs_data]
    elif isinstance(runs_data, list):
        pages = runs_data
    else:
        pages = []

    check_runs: list[dict[str, Any]] = []
    for page in pages:
        if isinstance(page, dict) and isinstance(page.get("check_runs"), list):
            check_runs.extend(run for run in page["check_runs"] if isinstance(run, dict))

    matching = [
        run
        for run in check_runs
        if run.get("name") == CODERABBIT_CHECK_NAME
        and isinstance(run.get("app"), dict)
        and run["app"].get("slug") == CODERABBIT_APP_SLUG
    ]
    if not matching:
        log.debug("No CodeRabbit check run found for %s#%d at %s", owner_repo, pr_number, head_sha)
        return None, ""

    latest_run = max(matching, key=_check_run_sort_key)
    latest = dict(latest_run)
    if not latest.get("head_sha"):
        latest["head_sha"] = head_sha
    log.debug(
        "Found CodeRabbit check run id=%s conclusion=%s for %s#%d at %s",
        latest.get("id"),
        latest.get("conclusion"),
        owner_repo,
        pr_number,
        latest["head_sha"],
    )
    return latest, ""


def find_rate_limit_reply_comment(
    owner_repo: str,
    pr_number: int,
    *,
    completed_at: str | None = None,
    comments: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any] | None, str]:
    """Find the newest CodeRabbit rate-limit reply comment (excluding the summary comment)."""
    owner, repo = owner_repo.split("/")
    if comments is None:
        fetched, err = run_gh_api_result(
            f"repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100",
            paginate=True,
            timeout=60,
        )
        if err:
            log.warning("Failed to fetch PR comments for %s#%d: %s", owner_repo, pr_number, err)
            return None, f"GitHub API error: {err}"
        comments = fetched if isinstance(fetched, list) else []

    completed_dt = _parse_iso_timestamp(completed_at)
    cutoff = completed_dt - timedelta(seconds=REPLY_LOOKBACK_SECONDS) if completed_dt is not None else None

    matching: list[dict[str, Any]] = []
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        user = comment.get("user")
        if not isinstance(user, dict) or user.get("login") != CODERABBIT_BOT_LOGIN:
            continue
        body = comment.get("body")
        if not isinstance(body, str) or SUMMARY_MARKER in body or "rate limit" not in body.lower():
            continue
        if cutoff is not None:
            created_dt = _parse_iso_timestamp(comment.get("created_at"))
            if created_dt is None or created_dt < cutoff:
                continue
        matching.append(comment)

    if not matching:
        return None, ""
    return max(matching, key=_comment_sort_key), ""


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
