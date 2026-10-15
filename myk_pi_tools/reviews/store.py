"""Store completed review JSON to SQLite database for analytics.

This module runs AFTER the review flow completes. It reads the completed JSON file
(with all posted_at/resolved_at data) and stores it in SQLite for analytics.

The database is stored at: <project-root>/.pi/data/reviews.db
"""

import json
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from myk_pi_tools.logger import create_logger
from myk_pi_tools.reviews.title_extraction import extract_finding_title

# Schema for the reviews database
SCHEMA = """
CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number INTEGER NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL REFERENCES reviews(id),
    source TEXT NOT NULL,
    thread_id TEXT,
    node_id TEXT,
    comment_id INTEGER,
    author TEXT,
    path TEXT,
    line INTEGER,
    body TEXT,
    priority TEXT,
    status TEXT,
    reply TEXT,
    skip_reason TEXT,
    posted_at TEXT,
    resolved_at TEXT,
    type TEXT DEFAULT NULL,
    quality_label TEXT DEFAULT NULL,
    code_diff TEXT DEFAULT NULL,
    title TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_review_id ON comments(review_id);
CREATE INDEX IF NOT EXISTS idx_comments_source ON comments(source);
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(owner, repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_reviews_commit ON reviews(commit_sha);
"""


log = create_logger(__name__)


def get_project_root() -> Path:
    """Detect main project root (resolves through git worktrees).

    Uses git-common-dir to always return the main repo root,
    not the worktree root. This ensures .pi/data/reviews.db
    is shared across all worktrees.
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            log.error(f"Error: git rev-parse failed: {result.stderr.strip()}")
            sys.exit(1)
        git_common = Path(result.stdout.strip()).resolve()
        return git_common.parent
    except subprocess.TimeoutExpired:
        log.error("Error: git command timed out")
        sys.exit(1)
    except FileNotFoundError:
        log.error("Error: git command not found")
        sys.exit(1)


def ensure_database_directory(db_path: Path) -> None:
    """Create database directory with 0700 permissions if needed."""
    db_dir = db_path.parent
    if not db_dir.exists():
        log.info(f"Creating directory: {db_dir}")
        db_dir.mkdir(parents=True, mode=0o700)
    else:
        # Ensure existing directory has correct permissions
        try:
            db_dir.chmod(0o700)
        except OSError as exc:
            print(f"Debug: could not chmod {db_dir}: {exc}", file=sys.stderr)


def create_tables(conn: sqlite3.Connection) -> bool:
    """Create tables if they don't exist, and apply schema migrations.

    Returns True when the `title` column migration ran (caller logs it).
    """
    conn.executescript(SCHEMA)

    # Migration: add 'type' column to existing databases that lack it
    cursor = conn.execute("PRAGMA table_info(comments)")
    columns = {row[1] for row in cursor.fetchall()}
    title_migrated = False
    if "type" not in columns:
        conn.execute("ALTER TABLE comments ADD COLUMN type TEXT DEFAULT NULL")
    if "quality_label" not in columns:
        conn.execute("ALTER TABLE comments ADD COLUMN quality_label TEXT DEFAULT NULL")
    if "code_diff" not in columns:
        conn.execute("ALTER TABLE comments ADD COLUMN code_diff TEXT DEFAULT NULL")
    if "title" not in columns:
        conn.execute("ALTER TABLE comments ADD COLUMN title TEXT DEFAULT NULL")
        title_migrated = True
    return title_migrated


def backfill_titles(conn: sqlite3.Connection) -> int:
    """Fill `comments.title` for rows where it is NULL.

    Runs the deterministic extractor (Python port of the TS engine) over the
    raw body — the body column is never modified. Rows whose bodies yield no
    title (badge-only, empty) keep NULL; readers fall back to body extraction
    for those. Returns the number of rows updated.
    """
    cursor = conn.execute("SELECT id, body FROM comments WHERE title IS NULL AND body IS NOT NULL")
    updated = 0
    for row_id, body in cursor.fetchall():
        title = extract_finding_title(body)
        if title:
            conn.execute("UPDATE comments SET title = ? WHERE id = ?", (title, row_id))
            updated += 1
    return updated


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
            log.warning(f"Warning: Could not get commit SHA: {result.stderr.strip()}")
            return "unknown"
        sha = result.stdout.strip()
        if not sha:
            log.warning("Warning: Could not get commit SHA: empty output")
            return "unknown"
        return sha  # Full SHA for traceability
    except (subprocess.SubprocessError, OSError) as e:
        log.warning(f"Warning: Could not get commit SHA: {e}")
        return "unknown"


def insert_review(conn: sqlite3.Connection, owner: str, repo: str, pr_number: int, commit_sha: str) -> int:
    """Insert a new review record. Always appends, never updates."""
    cursor = conn.cursor()
    created_at = datetime.now(UTC).isoformat()

    cursor.execute(
        "INSERT INTO reviews (owner, repo, pr_number, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)",
        (owner, repo, pr_number, commit_sha, created_at),
    )
    review_id = cursor.lastrowid
    if not review_id:
        raise RuntimeError("Failed to insert review record")
    return int(review_id)


def insert_comment(conn: sqlite3.Connection, review_id: int, source: str, comment: dict[str, Any]) -> None:
    """Insert a single comment record."""
    cursor = conn.cursor()
    # Title: the fetched JSON's parsed title when present (Qodo sticky
    # findings carry it); otherwise the deterministic extraction over the
    # raw body — so every stored row has a clean title when one exists.
    title = comment.get("title") or extract_finding_title(comment.get("body"))
    cursor.execute(
        """
        INSERT INTO comments (
            review_id, source, thread_id, node_id, comment_id, author,
            path, line, body, priority, status, reply, skip_reason,
            posted_at, resolved_at, type, quality_label, code_diff, title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            review_id,
            source,
            comment.get("thread_id"),
            comment.get("node_id"),
            comment.get("comment_id"),
            comment.get("author"),
            comment.get("path"),
            comment.get("line"),
            comment.get("body"),
            comment.get("priority"),
            comment.get("status"),
            comment.get("reply"),
            comment.get("skip_reason"),
            comment.get("posted_at"),
            comment.get("resolved_at"),
            comment.get("type"),
            comment.get("quality_label"),
            comment.get("code_diff"),
            title,
        ),
    )


def store_reviews(json_path: Path) -> None:
    """Store reviews from JSON to SQLite."""
    # Read JSON file
    log.info(f"Reading JSON file: {json_path}")
    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        log.error(f"Error: JSON file not found: {json_path}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        log.error(f"Error: Invalid JSON in file: {e}")
        sys.exit(1)

    # Extract review metadata (nested in metadata object)
    metadata = data.get("metadata", {})
    owner = metadata.get("owner", "")
    repo = metadata.get("repo", "")
    pr_number_raw = metadata.get("pr_number", 0)
    pr_number = int(pr_number_raw) if pr_number_raw else 0

    if not owner or not repo or not pr_number:
        log.error("Error: JSON missing required fields (owner, repo, pr_number)")
        sys.exit(1)

    # Get project root and database path
    project_root = get_project_root()

    # Resolve the SHA in the process cwd (the worktree the CLI was invoked from),
    # NOT project_root: project_root is the main worktree, so using it here
    # records main's HEAD for every review regardless of the branch under review.
    commit_sha = get_current_commit_sha()

    log.info(f"Storing reviews for {owner}/{repo}#{pr_number} (commit: {commit_sha[:7]})...")

    db_path = project_root / ".pi" / "data" / "reviews.db"

    log.info(f"Database: {db_path}")

    # Ensure directory exists
    ensure_database_directory(db_path)

    # Open database and perform operations in a transaction
    conn = sqlite3.connect(str(db_path))
    try:
        # Enable foreign key constraints for referential integrity
        conn.execute("PRAGMA foreign_keys=ON")
        create_tables(conn)

        # One-shot title backfill, tracked by a PERSISTED marker (not by "did
        # the column just appear"): sqlite3's ALTER TABLE autocommits, so a
        # store that fails after migrating would otherwise leave the column
        # present while the backfill UPDATEs roll back with the store's
        # transaction — every later store would see no migration and the
        # historical rows would stay NULL forever. The marker is committed in
        # its own transaction together with the backfill, so a later store
        # failure cannot lose it, and a failed backfill leaves no marker and
        # is retried on the next store. Rows that yield no title keep NULL;
        # readers fall back to body extraction for those. New rows get titles
        # at insert time.
        marker = conn.execute("SELECT value FROM schema_meta WHERE key = 'title_backfill_rows'").fetchone()
        if marker is None:
            backfilled = backfill_titles(conn)
            conn.execute(
                "INSERT INTO schema_meta (key, value) VALUES ('title_backfill_rows', ?)",
                (str(backfilled),),
            )
            conn.commit()  # own transaction — survives later store failures
            log.info(f"Backfilled comments.title for {backfilled} row(s)")

        # Insert new review record (append-only, never update)
        # RuntimeError in insert_review handles invalid lastrowid
        review_id = insert_review(conn, owner, repo, pr_number, commit_sha)

        # Count comments by source
        counts: dict[str, int] = {"human": 0, "qodo": 0, "coderabbit": 0}

        # Insert comments from each source
        for source in ["human", "qodo", "coderabbit"]:
            comments = data.get(source, [])
            for comment in comments:
                insert_comment(conn, review_id, source, comment)
                counts[source] += 1

        # Commit transaction
        conn.commit()

        total_comments = sum(counts.values())
        count_parts = [f"{v} {k}" for k, v in counts.items() if v > 0]
        count_summary = ", ".join(count_parts) if count_parts else "0 comments"

        log.info(f"Stored review (commit: {commit_sha[:7]}) with {total_comments} comments ({count_summary})")

    except sqlite3.Error as e:
        conn.rollback()
        log.info(f"Database error: {e}")
        sys.exit(1)
    finally:
        conn.close()

    # Delete JSON file after successful storage
    try:
        json_path.unlink()
        log.info(f"Deleted JSON file: {json_path}")
    except OSError as e:
        log.warning(f"Warning: Could not delete JSON file: {e}")


def run(json_path: str) -> None:
    """Main entry point.

    Args:
        json_path: Path to the completed review JSON file.
    """
    json_path_obj = Path(json_path).resolve()

    if not json_path_obj.exists():
        log.error(f"Error: JSON file does not exist: {json_path}")
        sys.exit(1)

    store_reviews(json_path_obj)
