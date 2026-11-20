"""Store outgoing PR review comments in SQLite.

Separate from reviews.db (which handles incoming review-handler comments).
This DB tracks comments posted by /pr-review and /refine-review prompts
for past-cycle verification on subsequent runs.

Database location: <git-root>/.pi/data/pr-reviews.db
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from myk_pi_tools.utils import find_git_root

VALID_STATUSES = {"posted", "skipped", "resolved_external"}
VALID_RESOLUTION_STATUSES = {"resolved_fixed", "resolved_accepted", "resolved_bad_fix", "resolved_no_fix"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS pr_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    author TEXT,
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
    posted_at TEXT,
    status TEXT DEFAULT 'posted',
    skip_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_pr_comments_review_id ON pr_comments(review_id);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_pr ON pr_reviews(owner, repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_pr_comments_posted_at ON pr_comments(posted_at);
"""

# Migration for existing databases that lack the new columns
_MIGRATIONS = [
    # pr_comments migrations
    ("pr_comments", "status", "ALTER TABLE pr_comments ADD COLUMN status TEXT DEFAULT 'posted'"),
    ("pr_comments", "skip_reason", "ALTER TABLE pr_comments ADD COLUMN skip_reason TEXT"),
    # pr_reviews migrations
    ("pr_reviews", "author", "ALTER TABLE pr_reviews ADD COLUMN author TEXT"),
    ("pr_comments", "resolution_status", "ALTER TABLE pr_comments ADD COLUMN resolution_status TEXT"),
    ("pr_comments", "author_response", "ALTER TABLE pr_comments ADD COLUMN author_response TEXT"),
]


def log(message: str) -> None:
    print(message, file=sys.stderr)


def _get_project_root() -> Path:
    """Detect main project root (resolves through git worktrees)."""
    try:
        return find_git_root()
    except RuntimeError as e:
        raise RuntimeError("Failed to detect project root — git not available or not in a repo") from e


def _connect_ro(db_path: Path) -> sqlite3.Connection:
    """Open ``db_path`` read-only with ``sqlite3.Row`` factory."""
    resolved = db_path.resolve()
    db_uri = f"file:{quote(resolved.as_posix(), safe='/:')}?mode=ro"
    conn = sqlite3.connect(db_uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _has_all_migration_columns(conn: sqlite3.Connection) -> bool:
    """Return True when all migration-added columns already exist."""
    table_columns: dict[str, set[str]] = {}
    for table, col_name, _sql in _MIGRATIONS:
        if table not in table_columns:
            table_columns[table] = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if col_name not in table_columns[table]:
            return False
    return True


def _get_db_path() -> Path:
    """Get the pr-reviews.db path."""
    project_root = _get_project_root()
    return project_root / ".pi" / "data" / "pr-reviews.db"


def _run_migrations(conn: sqlite3.Connection) -> None:
    """Apply schema migrations for existing databases."""
    # Cache column info per table
    table_columns: dict[str, set[str]] = {}

    for table, col_name, sql in _MIGRATIONS:
        if table not in table_columns:
            # table names come from hardcoded _MIGRATIONS — safe, PRAGMA can't be parameterized
            cursor = conn.execute(f"PRAGMA table_info({table})")
            table_columns[table] = {row[1] for row in cursor.fetchall()}

        if col_name not in table_columns[table]:
            try:
                conn.execute(sql)
                table_columns[table].add(col_name)
                log(f"Schema migration: added '{col_name}' column to {table}")
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e).lower():
                    raise


def store_pr_review(
    owner: str,
    repo: str,
    pr_number: int,
    comments: list[dict[str, Any]],
    head_sha: str | None = None,
    author: str | None = None,
    db_path: Path | None = None,
) -> None:
    """Store PR review comments to the database.

    Stores posted, skipped, and third-party resolved findings. Each comment dict may include:
    - status: 'posted' (default), 'skipped', or 'resolved_external'
    - skip_reason: reason for skipping (only when status='skipped')
    - resolution_status / author_response: our verdict on a third-party resolved thread
      (only when status='resolved_external'); rows are upserted by thread_id so a
      re-review of the same thread updates the row — including path/line, which move
      when the PR is rebased or the thread is re-anchored — instead of duplicating it

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: PR number.
        comments: List of comment dicts with keys: thread_id, comment_id,
                  path, line, body, severity, posted_at, status, skip_reason.
        head_sha: Git commit SHA for the reviewed code. Auto-detected from the
                  HEAD of the current worktree if not provided.
        author: PR author login (e.g., 'username').
        db_path: Override database path (default: auto-detected from git root).
    """
    if db_path is None:
        db_path = _get_db_path()
    # Ensure directory exists
    db_dir = db_path.parent
    if not db_dir.exists():
        db_dir.mkdir(parents=True, mode=0o700)
    else:
        try:
            db_dir.chmod(0o700)
        except OSError as exc:
            log(f"Warning: could not chmod {db_dir}: {exc}")

    if not head_sha:
        # No SHA from the fetch metadata: resolve it in the process cwd (the
        # worktree the CLI was invoked from), not in _get_project_root() — that
        # is the MAIN worktree, so its HEAD would be recorded for every review.
        from myk_pi_tools.reviews.store import get_current_commit_sha

        head_sha = get_current_commit_sha()
    created_at = datetime.now(UTC).isoformat()

    # Validate all comments before touching the database
    for i, comment in enumerate(comments):
        status = comment.get("status", "posted")
        if status not in VALID_STATUSES:
            raise ValueError(f"Invalid status '{status}' in comment[{i}], must be one of {VALID_STATUSES}")
        skip_reason = comment.get("skip_reason", "").strip()
        if status == "skipped" and not skip_reason:
            raise ValueError("status='skipped' requires a non-empty skip_reason")
        resolution_status = comment.get("resolution_status")
        if resolution_status is not None and resolution_status not in VALID_RESOLUTION_STATUSES:
            raise ValueError(
                f"Invalid resolution_status '{resolution_status}' in comment[{i}], "
                f"must be one of {VALID_RESOLUTION_STATUSES}"
            )
        if status == "resolved_external" and not resolution_status:
            raise ValueError("status='resolved_external' requires a resolution_status")

    log(f"Storing {len(comments)} PR review comment(s) for {owner}/{repo}#{pr_number}...")
    log(f"Database: {db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(SCHEMA)
        _run_migrations(conn)
        conn.execute("PRAGMA foreign_keys=ON")

        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO pr_reviews (owner, repo, pr_number, head_sha, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (owner, repo, pr_number, head_sha, author, created_at),
        )
        review_id = cursor.lastrowid
        if not review_id:
            raise RuntimeError("Failed to insert pr_reviews record")

        counts = dict.fromkeys(("posted", "skipped", "resolved_external", "updated"), 0)
        for comment in comments:
            status = comment.get("status", "posted")
            existing_id = (
                _find_external_resolution(cursor, owner, repo, pr_number, comment)
                if status == "resolved_external"
                else None
            )
            if existing_id is not None:
                counts["updated"] += 1
                cursor.execute(
                    """
                    UPDATE pr_comments
                    SET resolution_status = ?, author_response = ?,
                        path = COALESCE(?, path), line = COALESCE(?, line),
                        body = COALESCE(?, body), posted_at = COALESCE(?, posted_at)
                    WHERE id = ?
                    """,
                    (
                        comment["resolution_status"],
                        comment.get("author_response"),
                        comment.get("path"),
                        comment.get("line"),
                        comment.get("body"),
                        comment.get("posted_at"),
                        existing_id,
                    ),
                )
                continue
            counts[status] += 1
            cursor.execute(
                """
                INSERT INTO pr_comments (
                    review_id, thread_id, comment_id, path, line, body, severity,
                    posted_at, status, skip_reason, resolution_status, author_response
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    status,
                    comment.get("skip_reason"),
                    comment.get("resolution_status"),
                    comment.get("author_response"),
                ),
            )

        conn.commit()
        parts = [f"{counts['posted']} posted"]
        for key in ("skipped", "resolved_external", "updated"):
            if counts[key]:
                parts.append(f"{counts[key]} {key}")
        log(f"Stored {len(comments)} comment(s) ({', '.join(parts)}) (commit: {head_sha[:7]})")

    except sqlite3.Error as e:
        conn.rollback()
        raise RuntimeError(f"Database error storing PR review: {e}") from e
    finally:
        conn.close()


def _find_external_resolution(
    cursor: sqlite3.Cursor,
    owner: str,
    repo: str,
    pr_number: int,
    comment: dict[str, Any],
) -> int | None:
    """Find an already-stored third-party resolved row for this thread/comment id.

    Matching is by thread id (falling back to comment id) because resolved external
    threads are not 'posted' by us — the status='posted' filter of the posted path
    never matches them.
    """
    thread_id = comment.get("thread_id")
    comment_id = comment.get("comment_id")
    if not thread_id and not comment_id:
        return None
    match_column = "thread_id" if thread_id else "comment_id"
    row = cursor.execute(
        f"""
        SELECT c.id FROM pr_comments c
        JOIN pr_reviews r ON c.review_id = r.id
        WHERE r.owner = ? AND r.repo = ? AND r.pr_number = ?
          AND c.status = 'resolved_external' AND c.{match_column} = ?  -- noqa: S608
        ORDER BY c.id DESC LIMIT 1
        """,
        (owner, repo, pr_number, thread_id or comment_id),
    ).fetchone()
    return row[0] if row else None


def get_skipped_comments(
    owner: str,
    repo: str,
    pr_number: int,
    db_path: Path | None = None,
) -> list[dict[str, Any]]:
    """Get previously skipped comments for a PR.

    Returns:
        List of dicts with keys: path, line, body, severity, skip_reason, head_sha.
    """
    if db_path is None:
        db_path = _get_db_path()

    if not db_path.exists():
        return []

    conn = _connect_ro(db_path)
    try:
        if not _has_all_migration_columns(conn):
            conn.close()
            rw_conn = sqlite3.connect(str(db_path))
            try:
                _run_migrations(rw_conn)
                rw_conn.commit()
            finally:
                rw_conn.close()
            conn = _connect_ro(db_path)
        cursor = conn.execute(
            """
            SELECT c.path, c.line, c.body, c.severity, c.skip_reason, r.head_sha
            FROM pr_comments c
            JOIN pr_reviews r ON c.review_id = r.id
            WHERE r.owner = ? AND r.repo = ? AND r.pr_number = ?
              AND c.status = 'skipped'
            ORDER BY c.id
            """,
            (owner, repo, pr_number),
        )
        return [dict(row) for row in cursor.fetchall()]
    except sqlite3.Error as e:
        raise RuntimeError(f"Failed to query skipped comments: {e}") from e
    finally:
        conn.close()


def update_resolution(
    owner: str,
    repo: str,
    pr_number: int,
    file_path: str,
    line: int | None,
    resolution_status: str,
    author_response: str | None = None,
    db_path: Path | None = None,
) -> bool:
    """Update resolution status for a previously posted comment.

    Matches by owner/repo/pr_number/path/line, updates the most recent match.
    Resolution decisions are made by the reviewing LLM (Phase 1c), not the PR author.

    Args:
        owner: Repository owner.
        repo: Repository name.
        pr_number: PR number.
        file_path: File path of the comment.
        line: Line number of the comment (None to match any line in file).
        resolution_status: One of: resolved_fixed, resolved_accepted, resolved_bad_fix, resolved_no_fix.
        author_response: The PR author's reply text (why they resolved/dismissed).

    Returns:
        True if a comment was updated, False if no matching comment found.
    """
    if resolution_status not in VALID_RESOLUTION_STATUSES:
        raise ValueError(f"Invalid resolution_status '{resolution_status}', must be one of {VALID_RESOLUTION_STATUSES}")

    if db_path is None:
        db_path = _get_db_path()

    if not db_path.exists():
        return False

    conn = sqlite3.connect(str(db_path))
    try:
        _run_migrations(conn)
        conn.commit()
        conn.execute("PRAGMA foreign_keys=ON")

        # Find the most recent matching posted comment
        query = """
            SELECT c.id FROM pr_comments c
            JOIN pr_reviews r ON c.review_id = r.id
            WHERE r.owner = ? AND r.repo = ? AND r.pr_number = ?
              AND c.path = ? AND c.status = 'posted'
        """
        params: list = [owner, repo, pr_number, file_path]
        if line is not None:
            query += " AND c.line = ?"
            params.append(line)
        query += " ORDER BY c.id DESC LIMIT 1"

        cursor = conn.execute(query, params)
        row = cursor.fetchone()
        if not row:
            return False

        comment_id = row[0]
        conn.execute(
            "UPDATE pr_comments SET resolution_status = ?, author_response = ? WHERE id = ?",
            (resolution_status, author_response, comment_id),
        )
        conn.commit()
        log(f"Updated resolution for {file_path}:{line} \u2192 {resolution_status}")
        return True
    except sqlite3.Error as e:
        raise RuntimeError(f"Failed to update resolution: {e}") from e
    finally:
        conn.close()


def get_review_history(
    owner: str,
    repo: str,
    pr_number: int,
    db_path: Path | None = None,
) -> list[dict[str, Any]]:
    """Get ALL past findings for a PR \u2014 posted, skipped, and resolved.

    Returns a comprehensive history of all review findings across all cycles,
    including resolution status and author responses. This is the single source
    of truth for reviewers to avoid re-raising dismissed findings.

    Returns:
        List of dicts with keys: path, line, body, severity, status,
        skip_reason, resolution_status, author_response, head_sha, created_at.
    """
    if db_path is None:
        db_path = _get_db_path()

    if not db_path.exists():
        return []

    conn = _connect_ro(db_path)
    try:
        if not _has_all_migration_columns(conn):
            conn.close()
            rw_conn = sqlite3.connect(str(db_path))
            try:
                _run_migrations(rw_conn)
                rw_conn.commit()
            finally:
                rw_conn.close()
            conn = _connect_ro(db_path)
        cursor = conn.execute(
            """
            SELECT c.path, c.line, c.body, c.severity, c.status,
                   c.skip_reason, c.resolution_status, c.author_response,
                   r.head_sha, r.created_at
            FROM pr_comments c
            JOIN pr_reviews r ON c.review_id = r.id
            WHERE r.owner = ? AND r.repo = ? AND r.pr_number = ?
            ORDER BY r.created_at, c.id
            """,
            (owner, repo, pr_number),
        )
        return [dict(row) for row in cursor.fetchall()]
    except sqlite3.Error as e:
        raise RuntimeError(f"Failed to query review history: {e}") from e
    finally:
        conn.close()


def run_store(json_path: str) -> int:
    """Store PR review comments from a JSON file.

    The JSON file should have:
    - metadata: {owner, repo, pr_number, author (optional)}
    - comments: [{thread_id, comment_id, path, line, body, severity, posted_at,
                  status (optional), skip_reason (optional)}, ...]

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

    if not isinstance(comments, list):
        log(f"Error: 'comments' must be a list, got {type(comments).__name__}")
        return 1

    for i, comment in enumerate(comments):
        if not isinstance(comment, dict):
            log(f"Error: comment[{i}] must be a dict, got {type(comment).__name__}")
            return 1

    head_sha = metadata.get("head_sha") or metadata.get("commit_sha")
    author = metadata.get("author")

    try:
        store_pr_review(owner, repo, pr_number, comments, head_sha=head_sha, author=author)
    except (RuntimeError, ValueError) as e:
        log(f"Error: {e}")
        return 1
    return 0
