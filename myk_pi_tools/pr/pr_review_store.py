"""Store and query outgoing PR review comments in SQLite.

Separate from reviews.db (which handles incoming review-handler comments).
This DB tracks comments posted by /pr-review and /refine-review prompts
for past-cycle verification on subsequent runs.

Database location: <git-root>/.pi/data/pr-reviews.db
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS pr_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES pr_reviews(id) ON DELETE CASCADE,
    thread_id TEXT,
    comment_id INTEGER,
    path TEXT,
    line INTEGER,
    body TEXT,
    severity TEXT,
    posted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pr_comments_review_id ON pr_comments(review_id);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_pr ON pr_reviews(owner, repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_pr_comments_posted_at ON pr_comments(posted_at);
"""


def log(message: str) -> None:
    print(message, file=sys.stderr)


def _get_project_root() -> Path:
    """Detect main project root (resolves through git worktrees)."""
    from myk_pi_tools.reviews.store import get_project_root

    return get_project_root()


def _get_current_commit_sha(cwd: Path | None = None) -> str:
    """Get the current git commit SHA."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if result.returncode != 0:
            return "unknown"
        return result.stdout.strip() or "unknown"
    except (subprocess.SubprocessError, OSError):
        return "unknown"


def _get_db_path() -> Path:
    """Get the pr-reviews.db path."""
    project_root = _get_project_root()
    return project_root / ".pi" / "data" / "pr-reviews.db"


def _ensure_db(db_path: Path) -> None:
    """Create DB directory and tables if needed."""
    db_dir = db_path.parent
    if not db_dir.exists():
        db_dir.mkdir(parents=True, mode=0o700)
    else:
        try:
            db_dir.chmod(0o700)
        except OSError as exc:
            log(f"Warning: could not chmod {db_dir}: {exc}")
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(SCHEMA)
    finally:
        conn.close()


def store_pr_review(
    owner: str,
    repo: str,
    pr_number: int,
    comments: list[dict[str, Any]],
    head_sha: str | None = None,
) -> None:
    """Store posted PR review comments to the database.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: PR number.
        comments: List of comment dicts with keys: thread_id, comment_id,
                  path, line, body, severity, posted_at.
    """
    db_path = _get_db_path()
    _ensure_db(db_path)

    if not head_sha:
        project_root = _get_project_root()
        head_sha = _get_current_commit_sha(cwd=project_root)
    created_at = datetime.now(UTC).isoformat()

    log(f"Storing {len(comments)} PR review comment(s) for {owner}/{repo}#{pr_number}...")
    log(f"Database: {db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("PRAGMA foreign_keys=ON")

        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO pr_reviews (owner, repo, pr_number, head_sha, created_at) VALUES (?, ?, ?, ?, ?)",
            (owner, repo, pr_number, head_sha, created_at),
        )
        review_id = cursor.lastrowid
        if not review_id:
            raise RuntimeError("Failed to insert pr_reviews record")

        for comment in comments:
            cursor.execute(
                """
                INSERT INTO pr_comments (
                    review_id, thread_id, comment_id, path, line, body, severity, posted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    review_id,
                    comment.get("thread_id"),
                    comment.get("comment_id"),
                    comment.get("path"),
                    comment.get("line"),
                    comment.get("body"),
                    comment.get("severity"),
                    comment.get("posted_at"),
                ),
            )

        conn.commit()
        log(f"Stored {len(comments)} comment(s) (commit: {head_sha[:7]})")

    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"Database error storing PR review: {e}") from e
    finally:
        conn.close()


def run_store(json_path: str) -> int:
    """Store PR review comments from a JSON file.

    The JSON file should have:
    - metadata: {owner, repo, pr_number}
    - comments: [{thread_id, comment_id, path, line, body, severity, posted_at}, ...]

    Args:
        json_path: Path to the JSON file.

    Returns:
        Exit code (0 for success, 1 for error).
    """
    path = Path(json_path).resolve()
    if not path.exists():
        log(f"Error: JSON file not found: {json_path}")
        return 1

    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log(f"Error reading JSON: {e}")
        return 1

    metadata = data.get("metadata", {})
    owner = metadata.get("owner", "")
    repo = metadata.get("repo", "")
    pr_number_raw = metadata.get("pr_number", 0)

    if not owner or not repo or not pr_number_raw:
        log("Error: JSON missing required metadata (owner, repo, pr_number)")
        return 1

    try:
        pr_number = int(pr_number_raw)
    except (TypeError, ValueError):
        log(f"Error: Invalid pr_number: {pr_number_raw}")
        return 1

    if pr_number <= 0:
        log(f"Error: Invalid pr_number: {pr_number}")
        return 1

    comments = data.get("comments", [])
    if not comments:
        log("No comments to store")
        return 0

    if not isinstance(comments, list):
        log(f"Error: 'comments' must be a list, got {type(comments).__name__}")
        return 1

    for i, comment in enumerate(comments):
        if not isinstance(comment, dict):
            log(f"Error: comment[{i}] must be a dict, got {type(comment).__name__}")
            return 1

    head_sha = metadata.get("head_sha") or metadata.get("commit_sha")

    try:
        store_pr_review(owner, repo, pr_number, comments, head_sha=head_sha)
    except RuntimeError as e:
        log(f"Error: {e}")
        return 1
    return 0
