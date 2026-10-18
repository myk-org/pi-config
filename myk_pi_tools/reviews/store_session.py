"""Store Qodo pr-review-session findings to the reviews database.

This module runs when a `qodo read pr-review-session findings --json` loop
converges (clean round). It converts the session JSON into reviews DB rows:
one `reviews` row per distinct commit the findings were raised on, and one
`comments` row per finding (source=qodo, status from attribution_status).

Unlike `store`, the input JSON is NOT deleted — the session file is the
loop's own record.

The database is stored at: <project-root>/.pi/data/reviews.db
"""

import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from myk_pi_tools.logger import create_logger
from myk_pi_tools.reviews.store import (
    create_tables,
    ensure_database_directory,
    get_project_root,
    insert_comment,
    insert_review,
    run_title_backfill_once,
)

log = create_logger(__name__)

_PR_URL_RE = re.compile(r"^https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)/?$")


def _parse_pr_url(pr_url: str) -> tuple[str, str, int]:
    """Extract (owner, repo, pr_number) from a GitHub PR URL.

    Exits with code 1 when the URL is missing or malformed.
    """
    match = _PR_URL_RE.match(pr_url.strip())
    if not match:
        log.error(f"Error: could not parse owner/repo/pr_number from pr_url: {pr_url!r}")
        sys.exit(1)
    owner, repo, pr_number = match.groups()
    return owner, repo, int(pr_number)


def _earliest_created_at(findings: list[dict[str, Any]]) -> str | None:
    """Earliest finding created_at in a commit group (None when absent)."""
    timestamps = [f["created_at"] for f in findings if isinstance(f.get("created_at"), str)]
    return min(timestamps) if timestamps else None


def _to_comment_row(finding: dict[str, Any]) -> dict[str, Any]:
    """Map a session finding onto the insert_comment row shape."""
    title = finding.get("title", "")
    description = finding.get("description", "")
    # Status vocabulary of the status listing is addressed/skipped/pending
    # (Qodo 21abfb4f) — raw attribution_status values would appear in the
    # totals but never in the resolution counts. `resolved` is Qodo's
    # resolved-attribution spelling (Qodo 5bcf0ad3).
    attribution = finding.get("attribution_status")
    status = {
        "implemented": "addressed",
        "resolved": "addressed",
        "dismissed": "skipped",
    }.get(attribution if isinstance(attribution, str) else "", "pending")
    # Priority shares the column with the fetch path's HIGH/MEDIUM/LOW
    # classification (Qodo 50984056) — raw action_level strings would make
    # priority-based queries inconsistent across store paths.
    level = finding.get("action_level")
    priority = {
        "action_required": "HIGH",
        "remediation_recommended": "MEDIUM",
        "informational": "LOW",
    }.get(level if isinstance(level, str) else "", "MEDIUM")
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
    return {
        "comment_id": gh_comment_id,
        "node_id": finding.get("id"),
        "author": "qodo",
        "path": None,
        "line": None,
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

    pr_url = data.get("pr_url", "")
    if not pr_url:
        log.error("Error: session JSON missing required field (pr_url)")
        sys.exit(1)
    owner, repo, pr_number = _parse_pr_url(pr_url)

    log.info(f"Storing session findings for {owner}/{repo}#{pr_number}")

    # Group findings by the commit they were raised on — one reviews row per
    # commit preserves the per-round structure of the session loop.
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for finding in data.get("findings", []):
        git_sha = finding.get("git_sha")
        if not git_sha:
            log.warning(f"Skipping finding without git_sha: {finding.get('id', '<no id>')}")
            continue
        groups[git_sha].append(finding)

    if not groups:
        log.info("No findings in session JSON — nothing to store")

    project_root = get_project_root()
    db_path = project_root / ".pi" / "data" / "reviews.db"
    log.info(f"Database: {db_path}")

    ensure_database_directory(db_path)

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        create_tables(conn)
        run_title_backfill_once(conn)

        # Idempotency (Qodo 78903709): a review row for this PR+commit is
        # NOT proof the session was stored — the ordinary store path can
        # record GitHub comments for the same commit first. Skip a finding
        # only when its own session UUID is already in the DB; skip the
        # whole group only when every finding of the group is present.
        existing_session_ids = {
            row[0]
            for row in conn.execute(
                """
                SELECT c.node_id FROM comments c
                JOIN reviews r ON c.review_id = r.id
                WHERE r.owner = ? AND r.repo = ? AND r.pr_number = ?
                  AND c.type = 'session_finding' AND c.node_id IS NOT NULL
                """,
                (owner, repo, pr_number),
            )
        }

        stored_findings = 0
        skipped_groups = 0
        # Deterministic order: earliest round first.
        for git_sha in sorted(groups, key=lambda sha: _earliest_created_at(groups[sha]) or ""):
            findings = groups[git_sha]
            missing = [f for f in findings if f.get("id") not in existing_session_ids]
            if not missing:
                skipped_groups += 1
                continue
            # A later import for an already-imported commit appends to that
            # commit's existing SESSION review row (Qodo 5355150b) — one
            # review row per round, not one per import.
            existing_row = conn.execute(
                """
                SELECT r.id FROM reviews r
                JOIN comments c ON c.review_id = r.id
                WHERE r.owner = ? AND r.repo = ? AND r.pr_number = ? AND r.commit_sha = ?
                  AND c.type = 'session_finding'
                LIMIT 1
                """,
                (owner, repo, pr_number, git_sha),
            ).fetchone()
            if existing_row is not None:
                review_id = existing_row[0]
            else:
                review_id = insert_review(
                    conn, owner, repo, pr_number, git_sha, created_at=_earliest_created_at(missing)
                )
            for finding in missing:
                insert_comment(conn, review_id, "qodo", _to_comment_row(finding))
                stored_findings += 1

        conn.commit()

        if skipped_groups:
            log.info(f"Skipped {skipped_groups} commit group(s) already stored")
        log.info(
            f"Stored {stored_findings} session finding(s) across "
            f"{len(groups) - skipped_groups} commit(s) for {owner}/{repo}#{pr_number}"
        )

    except sqlite3.Error as e:
        conn.rollback()
        log.error(f"Database error: {e}")
        sys.exit(1)
    finally:
        conn.close()

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
