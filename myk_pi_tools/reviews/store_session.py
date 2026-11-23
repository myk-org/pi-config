"""Store Qodo pr-review-session findings to the reviews database.

This module runs after EVERY completed round of a `qodo read
pr-review-session findings --json` loop (not just convergence) — the loop
prompt stores post-resolution on a fresh fetch. It converts the session
JSON into reviews DB rows: one `reviews` row per distinct commit the
findings were raised on, and one `comments` row per finding (source=qodo,
status from attribution_status, path/line recovered from the inline GitHub
comment when one exists).

COUPLING (see AGENTS.md "Reviews DB ↔ review-learning"): the rows written
here are the input of extensions/orchestrator/review-learning.ts — addressed
findings (status='addressed') are distilled into memory lessons. Schema or
status-vocabulary changes must keep getAddressedComments working, and any
new store entry point must trigger or feed distillation.

Unlike `store`, the input JSON is NOT deleted — the session file is the
loop's own record.

The database is stored at: <project-root>/.pi/data/reviews.db
"""

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from myk_pi_tools.db.storage import ReviewDB, ReviewDBError
from myk_pi_tools.logger import create_logger
from myk_pi_tools.reviews.constants import ACTION_LEVEL_PRIORITY
from myk_pi_tools.reviews.store import get_project_root
from myk_pi_tools.utils import merge_paginated_json, parse_pr_url

log = create_logger(__name__)


def _parse_pr_url(pr_url: str) -> tuple[str, str, int]:
    """Extract (owner, repo, pr_number) from a GitHub PR URL.

    Exits with code 1 when the URL is missing or malformed.
    """
    parsed = parse_pr_url(pr_url.strip())
    if not parsed:
        log.error(f"Error: could not parse owner/repo/pr_number from pr_url: {pr_url!r}")
        sys.exit(1)
    owner, repo, pr_number = parsed
    return owner, repo, int(pr_number)


def _earliest_created_at(findings: list[dict[str, Any]]) -> str | None:
    """Earliest finding created_at in a commit group (None when absent)."""
    timestamps = [f["created_at"] for f in findings if isinstance(f.get("created_at"), str)]
    return min(timestamps) if timestamps else None


def _inline_rest_id(inline_comment_id: Any) -> str | None:
    """GitHub REST review-comment id from a Qodo inline_comment_id.

    Qodo's `inline_comment_id` is `gh1:PRRT_...:<rest-id>` — the trailing
    numeric segment is the REST pulls-comment id the public API accepts.
    """
    if not isinstance(inline_comment_id, str):
        return None
    rest_id = inline_comment_id.rsplit(":", 1)[-1]
    return rest_id if rest_id.isdigit() else None


_INLINE_LOCATION_CACHE: dict[str, tuple[str | None, int | None]] = {}


def _inline_location(owner: str, repo: str, inline_comment_id: Any) -> tuple[str | None, int | None]:
    """(path, line) of a finding's inline GitHub comment, via gh.

    Session findings carry no file location, but review-learning's
    write-time injection filters on `comments.path IS NOT NULL` — without
    the lookup, no session-stored finding ever resurfaces at write time
    (Qodo aab6f6a7). Cached per REST id; fail-soft (path stays None when gh
    is unavailable or the comment is gone).
    """
    rest_id = _inline_rest_id(inline_comment_id)
    if rest_id is None:
        return (None, None)
    if rest_id in _INLINE_LOCATION_CACHE:
        return _INLINE_LOCATION_CACHE[rest_id]
    path: str | None = None
    line: int | None = None
    try:
        result = subprocess.run(
            [
                "gh",
                "api",
                f"repos/{owner}/{repo}/pulls/comments/{rest_id}",
                "--jq",
                "[.path, (.line // .original_line)]",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        parsed = json.loads(result.stdout)
        if isinstance(parsed, list) and len(parsed) >= 2:
            path = parsed[0] if isinstance(parsed[0], str) else None
            line = parsed[1] if isinstance(parsed[1], int) else None
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as e:
        # OSError covers FileNotFoundError — a missing gh binary must degrade
        # to path=None, never abort storage before the transaction commits
        # (Qodo 8f3f78c2).
        log.debug(f"Inline location lookup failed for comment {rest_id}: {e}")
    _INLINE_LOCATION_CACHE[rest_id] = (path, line)
    return (path, line)


def _prefetch_inline_locations(
    owner: str,
    repo: str,
    pr_number: int,
    uncached_inline_ids: list[Any],
) -> None:
    """Batch-fetch PR review comment locations via a single paginated API call.

    Pre-populates _INLINE_LOCATION_CACHE for all returned comments, then falls
    back to per-ID _inline_location() only for cache misses. Fail-soft on gh
    errors or missing binary.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "api",
                f"repos/{owner}/{repo}/pulls/{pr_number}/comments",
                "--paginate",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        for item in merge_paginated_json(result.stdout):
            if not isinstance(item, dict):
                continue
            cid = item.get("id")
            if cid is None:
                continue
            cid_str = str(cid)
            if not cid_str.isdigit():
                continue
            raw_path = item.get("path")
            raw_line = item.get("line") or item.get("original_line")
            path = raw_path if isinstance(raw_path, str) else None
            line = raw_line if isinstance(raw_line, int) and not isinstance(raw_line, bool) else None
            _INLINE_LOCATION_CACHE[cid_str] = (path, line)
    except (subprocess.SubprocessError, OSError, json.JSONDecodeError) as e:
        log.warning(f"Batch inline location prefetch failed for {owner}/{repo}#{pr_number}: {e}")

    for inline_id in uncached_inline_ids:
        rest_id = _inline_rest_id(inline_id)
        if rest_id is not None and rest_id not in _INLINE_LOCATION_CACHE:
            _inline_location(owner, repo, inline_id)


def _attribution(finding: dict[str, Any]) -> tuple[str, str]:
    """(status, priority) mapped from a session finding — no side effects.

    The refresh loop needs ONLY these two values; going through
    `_to_comment_row` would fire a blocking gh api inline-location lookup per
    stored finding on every round, for data the UPDATE never uses (Qodo
    db081d9b).
    """
    attribution = finding.get("attribution_status")
    status = {
        "implemented": "addressed",
        "resolved": "addressed",
        "dismissed": "skipped",
    }.get(attribution if isinstance(attribution, str) else "", "pending")
    level = finding.get("action_level")
    priority = ACTION_LEVEL_PRIORITY.get(level if isinstance(level, str) else "", "MEDIUM")
    return status, priority


def _to_comment_row(finding: dict[str, Any], owner: str, repo: str) -> dict[str, Any]:
    """Map a session finding onto the insert_comment row shape."""
    title = finding.get("title", "")
    description = finding.get("description", "")
    # Status vocabulary of the status listing is addressed/skipped/pending
    # (Qodo 21abfb4f) — raw attribution_status values would appear in the
    # totals but never in the resolution counts. `resolved` is Qodo's
    # resolved-attribution spelling (Qodo 5bcf0ad3).
    status, priority = _attribution(finding)
    # GitHub comment id when the finding has one (Qodo fb3f939c): the
    # integer comments.comment_id column must carry the GitHub id the rest
    # of the pipeline expects; the session UUID goes to node_id.
    raw_comment_id = finding.get("comment_id")
    if isinstance(raw_comment_id, int):
        gh_comment_id: int | None = raw_comment_id
    elif isinstance(raw_comment_id, str) and raw_comment_id.isdigit():
        gh_comment_id = int(raw_comment_id)
    else:
        gh_comment_id = None
    # File location from the inline GitHub comment (Qodo aab6f6a7): session
    # JSON findings carry no path, but the inline comment does — populated
    # rows keep write-time review-learning injection and path-keyed
    # recurrence working. Fail-soft: unresolvable comments store path=None.
    path, line = _inline_location(owner, repo, finding.get("inline_comment_id"))
    return {
        "comment_id": gh_comment_id,
        "node_id": finding.get("id"),
        "author": "qodo",
        "path": path,
        "line": line,
        "body": f"{title}\n\n{description}",
        "priority": priority,
        "status": status,
        "posted_at": finding.get("created_at"),
        "type": "session_finding",
        "quality_label": finding.get("category"),
        "title": title,
    }


def store_session(json_path: Path) -> None:
    """Store session findings from JSON to SQLite, grouped by commit."""
    log.info(f"Reading session JSON file: {json_path}")
    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        log.error(f"Error: JSON file not found: {json_path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        log.error(f"Error: Invalid JSON in file: {e}")
        sys.exit(1)

    # Controlled shape validation (Qodo d41e21ed): a valid JSON file that
    # is not the expected object graph (e.g. `[]`, `\"findings\": null`)
    # must produce a clear input error, not an uncaught TypeError deep in
    # the grouping loop.
    if not isinstance(data, dict):
        log.error(f"Error: session JSON must be a JSON object, got {type(data).__name__}")
        sys.exit(1)
    findings_raw = data.get("findings", [])
    if not isinstance(findings_raw, list):
        log.error(f"Error: 'findings' must be a JSON array, got {type(findings_raw).__name__}")
        sys.exit(1)
    for idx, finding in enumerate(findings_raw):
        if not isinstance(finding, dict):
            log.error(f"Error: findings[{idx}] must be a JSON object, got {type(finding).__name__}")
            sys.exit(1)

    pr_url = data.get("pr_url", "")
    if not pr_url:
        log.error("Error: session JSON missing required field (pr_url)")
        sys.exit(1)
    owner, repo, pr_number = _parse_pr_url(pr_url)

    log.info(f"Storing session findings for {owner}/{repo}#{pr_number}")

    # Group findings by the commit they were raised on — one reviews row per
    # commit preserves the per-round structure of the session loop.
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen_ids: set[Any] = set()  # within-run dedupe (Qodo d285f08c)
    for finding in findings_raw:
        git_sha = finding.get("git_sha")
        if not git_sha:
            # Dropped input data is data loss — error, not warning (Qodo 74714f98).
            log.error(f"Skipping finding without git_sha: {finding.get('id', '<no id>')}")
            continue
        # A finding without an id cannot be tracked idempotently (Qodo
        # a16004a7): re-imports would treat it as missing forever and append
        # duplicate comment rows — skip it rather than store an untrackable
        # row.
        if not finding.get("id"):
            log.error(f"Skipping finding without id on commit {git_sha[:7]}: {finding.get('title', '<no title>')}")
            continue
        # A JSON repeating an id would insert the finding twice (the DB-side
        # idempotency set is computed once, before any insert) — the first
        # occurrence wins, the repeat is dropped with an error record.
        if finding.get("id") in seen_ids:
            log.error(f"Skipping repeated finding id in session JSON: {finding.get('id')}")
            continue
        seen_ids.add(finding.get("id"))
        groups[git_sha].append(finding)

    if not groups:
        log.info("No findings in session JSON — nothing to store")

    project_root = get_project_root()
    db = ReviewDB(project_root=project_root)
    log.info("Database: %s", db.db_path)

    # Read pass WITHOUT the write lock (Qodo c47d2f7c + db081d9b): which
    # session findings are already stored? Computed on a short-lived read-only
    # connection so the gh api pre-warm below only touches findings that
    # will actually be INSERTED — already-stored findings never re-query
    # GitHub on re-import.
    existing_session_ids = db.get_session_finding_ids(owner, repo, pr_number)

    # Pre-warm the inline-location cache BEFORE the write transaction opens
    # (Qodo c47d2f7c): the gh api lookups must not run while the SQLite write
    # lock is held — a concurrent reviews store/address could hit "database is
    # locked" on a large first import. Only not-yet-stored findings are looked
    # up; when >= 2 uncached rest_ids exist, batch-fetch all PR comments once.
    uncached_inline_ids: list[Any] = []
    seen_uncached_rest_ids: set[str] = set()
    for group_findings in groups.values():
        for finding in group_findings:
            if finding.get("id") not in existing_session_ids:
                inline_id = finding.get("inline_comment_id")
                rest_id = _inline_rest_id(inline_id)
                if (
                    rest_id is not None
                    and rest_id not in _INLINE_LOCATION_CACHE
                    and rest_id not in seen_uncached_rest_ids
                ):
                    seen_uncached_rest_ids.add(rest_id)
                    uncached_inline_ids.append(inline_id)

    if len(uncached_inline_ids) >= 2:
        _prefetch_inline_locations(owner, repo, pr_number, uncached_inline_ids)
    elif uncached_inline_ids:
        _inline_location(owner, repo, uncached_inline_ids[0])

    # Deterministic order: earliest round first.
    grouped_findings = [
        (git_sha, groups[git_sha])
        for git_sha in sorted(groups, key=lambda sha: _earliest_created_at(groups[sha]) or "")
    ]

    try:
        stored_findings, refreshed_findings, skipped_groups = db.store_session_findings(
            owner,
            repo,
            pr_number,
            grouped_findings,
            attribution_fn=_attribution,
            row_builder=lambda f: _to_comment_row(f, owner, repo),
            created_at_fn=_earliest_created_at,
            known_existing_ids=existing_session_ids,
        )
    except ReviewDBError as e:
        log.error("%s", e)
        sys.exit(1)

    if skipped_groups:
        log.info("Skipped %d commit group(s) already stored", skipped_groups)
    if refreshed_findings:
        log.info("Refreshed attribution on %d already-stored finding(s)", refreshed_findings)
    log.info(
        "Stored %d session finding(s) across %d commit(s) for %s/%s#%d",
        stored_findings,
        len(groups) - skipped_groups,
        owner,
        repo,
        pr_number,
    )

    # The session JSON is intentionally NOT deleted — it is the loop's record.


def run(json_path: str) -> None:
    """Main entry point.

    Args:
        json_path: Path to the Qodo pr-review-session findings JSON file.
    """
    json_path_obj = Path(json_path).resolve()

    if not json_path_obj.exists():
        log.error(f"Error: JSON file does not exist: {json_path}")
        sys.exit(1)

    store_session(json_path_obj)
