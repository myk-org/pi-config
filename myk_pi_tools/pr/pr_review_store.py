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
    review_id INTEGER NOT NULL REFERENCES pr_reviews(id),
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
"""


def log(message: str) -> None:
    print(message, file=sys.stderr)


def _get_project_root() -> Path:
    """Detect main project root (resolves through git worktrees)."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            log(f"Error: git rev-parse failed: {result.stderr.strip()}")
            sys.exit(1)
        return Path(result.stdout.strip()).resolve().parent
    except subprocess.TimeoutExpired:
        log("Error: git command timed out")
        sys.exit(1)
    except FileNotFoundError:
        log("Error: git command not found")
        sys.exit(1)


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
        except OSError:
            pass
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
) -> None:
    """Store posted PR review comments to the database.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: PR number.
        comments: List of comment dicts with keys: thread_id, comment_id,
                  path, line, body, severity, posted_at.
    """
    project_root = _get_project_root()
    db_path = project_root / ".pi" / "data" / "pr-reviews.db"
    _ensure_db(db_path)

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
        log(f"Database error: {e}")
        sys.exit(1)
    finally:
        conn.close()


def get_pr_review_comments(owner: str, repo: str, pr_number: int) -> list[dict[str, Any]]:
    """Get all previously posted review comments for a PR.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: PR number.

    Returns:
        List of dicts with keys: thread_id, comment_id, path, line, body,
        severity, posted_at, head_sha, review_created_at.
    """
    db_path = _get_db_path()
    if not db_path.exists():
        return []

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT c.thread_id, c.comment_id, c.path, c.line, c.body,
                   c.severity, c.posted_at, r.head_sha, r.created_at as review_created_at
            FROM pr_comments c
            JOIN pr_reviews r ON c.review_id = r.id
            WHERE r.owner = ? AND r.repo = ? AND r.pr_number = ?
            ORDER BY c.posted_at DESC
            """,
            (owner, repo, pr_number),
        )
        return [dict(row) for row in cursor.fetchall()]
    except sqlite3.Error as e:
        log(f"Database error: {e}")
        return []
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

    store_pr_review(owner, repo, pr_number, comments)
    return 0
