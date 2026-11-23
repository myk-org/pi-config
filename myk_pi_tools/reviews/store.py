"""Store completed review JSON to SQLite database for analytics.

This module runs AFTER the review flow completes. It reads the completed JSON file
(with all posted_at/resolved_at data) and stores it in SQLite via
:class:`myk_pi_tools.db.storage.ReviewDB`.

The database is stored at: <project-root>/.pi/data/reviews.db
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from myk_pi_tools.db.storage import (
    SCHEMA,
    ReviewDB,
    ReviewDBError,
    backfill_titles,
    create_tables,
    ensure_database_directory,
    insert_comment,
    insert_review,
    run_title_backfill_once,
)
from myk_pi_tools.logger import create_logger
from myk_pi_tools.utils import find_git_root

log = create_logger(__name__)

__all__ = [
    "SCHEMA",
    "backfill_titles",
    "create_tables",
    "ensure_database_directory",
    "get_current_commit_sha",
    "get_project_root",
    "insert_comment",
    "insert_review",
    "run",
    "run_title_backfill_once",
    "store_reviews",
]


def get_project_root() -> Path:
    """Detect main project root (resolves through git worktrees).

    Uses git-common-dir to always return the main repo root,
    not the worktree root. This ensures .pi/data/reviews.db
    is shared across all worktrees.
    """
    try:
        return find_git_root()
    except RuntimeError as exc:
        log.error("Error: %s", exc)
        sys.exit(1)


def get_current_commit_sha(cwd: Path | None = None) -> str:
    """Get the current git commit SHA.

    Args:
        cwd: Working directory for git command. If None, uses current directory.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if result.returncode != 0:
            log.warning("Warning: Could not get commit SHA: %s", result.stderr.strip())
            return "unknown"
        sha = result.stdout.strip()
        if not sha:
            log.warning("Warning: Could not get commit SHA: empty output")
            return "unknown"
        return sha  # Full SHA for traceability
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("Warning: Could not get commit SHA: %s", e)
        return "unknown"


def store_reviews(json_path: Path) -> None:
    """Store reviews from JSON to SQLite."""
    log.info("Reading JSON file: %s", json_path)
    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        log.error("Error: JSON file not found: %s", json_path)
        sys.exit(1)
    except json.JSONDecodeError as e:
        log.error("Error: Invalid JSON in file: %s", e)
        sys.exit(1)

    metadata = data.get("metadata", {})
    owner = metadata.get("owner", "")
    repo = metadata.get("repo", "")
    pr_number_raw = metadata.get("pr_number", 0)
    pr_number = int(pr_number_raw) if pr_number_raw else 0

    if not owner or not repo or not pr_number:
        log.error("Error: JSON missing required fields (owner, repo, pr_number)")
        sys.exit(1)

    project_root = get_project_root()

    # Resolve the SHA in the process cwd (the worktree the CLI was invoked from),
    # NOT project_root: project_root is the main worktree, so using it here
    # records main's HEAD for every review regardless of the branch under review.
    commit_sha = get_current_commit_sha()

    log.info("Storing reviews for %s/%s#%d (commit: %s)...", owner, repo, pr_number, commit_sha[:7])

    db = ReviewDB(project_root=project_root)
    log.info("Database: %s", db.db_path)

    try:
        counts = db.store_review(owner, repo, pr_number, commit_sha, data)
    except ReviewDBError as e:
        log.error("%s", e)
        sys.exit(1)

    total_comments = sum(counts.values())
    count_parts = [f"{v} {k}" for k, v in counts.items() if v > 0]
    count_summary = ", ".join(count_parts) if count_parts else "0 comments"
    log.info("Stored review (commit: %s) with %d comments (%s)", commit_sha[:7], total_comments, count_summary)

    # Delete JSON file after successful storage
    try:
        json_path.unlink()
        log.info("Deleted JSON file: %s", json_path)
    except OSError as e:
        log.warning("Warning: Could not delete JSON file: %s", e)


def run(json_path: str) -> None:
    """Main entry point.

    Args:
        json_path: Path to the completed review JSON file.
    """
    json_path_obj = Path(json_path).resolve()

    if not json_path_obj.exists():
        log.error("Error: JSON file does not exist: %s", json_path)
        sys.exit(1)

    store_reviews(json_path_obj)
