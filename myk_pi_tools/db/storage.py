"""Unified SQLite storage module for the reviews database (``.pi/data/reviews.db``).

Owns path resolution, schema definitions, forward-compatible migrations,
read-only/read-write connection lifecycle, title backfill upkeep, and all
read/write queries shared by ``reviews store``, ``reviews store-session``,
``reviews status``, ``reviews fetch``, and ``db`` CLI commands.

COUPLING (see AGENTS.md "Reviews DB <-> review-learning"):
``extensions/orchestrator/review-learning.ts`` reads ``reviews`` and
``comments`` (including ``comments.title``) directly via ``node:sqlite``.
Table/column names and status vocabulary must remain schema-compatible.
"""

from __future__ import annotations

import re
import sqlite3
from collections import Counter, defaultdict
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from myk_pi_tools.db.sqlite_helpers import (
    ColumnMigration,
    IndexMigration,
    apply_migrations,
    connect_ro,
    connect_rw,
    ensure_db_directory,
    has_all_migrations,
    open_migrated_ro_with_status,
    resolve_db_path,
)
from myk_pi_tools.logger import create_logger
from myk_pi_tools.reviews.constants import BODY_EMBEDDED_COMMENT_TYPES
from myk_pi_tools.reviews.title_extraction import extract_finding_title
from myk_pi_tools.utils import find_git_root

log = create_logger(__name__)

REVIEWS_DB_NAME = "reviews.db"

_REVIEWS_TABLE_DDL = """CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number INTEGER NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    created_at TEXT NOT NULL
);"""

_COMMENTS_TABLE_DDL = """CREATE TABLE IF NOT EXISTS comments (
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
);"""

_SCHEMA_META_TABLE_DDL = """CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);"""

_TABLE_DDLS: tuple[str, ...] = (
    _REVIEWS_TABLE_DDL,
    _COMMENTS_TABLE_DDL,
    _SCHEMA_META_TABLE_DDL,
)

_REQUIRED_TABLES: tuple[str, ...] = ("reviews", "comments", "schema_meta")

_COLUMN_MIGRATIONS: tuple[ColumnMigration, ...] = (
    ("comments", "type", "ALTER TABLE comments ADD COLUMN type TEXT DEFAULT NULL"),
    ("comments", "quality_label", "ALTER TABLE comments ADD COLUMN quality_label TEXT DEFAULT NULL"),
    ("comments", "code_diff", "ALTER TABLE comments ADD COLUMN code_diff TEXT DEFAULT NULL"),
    ("comments", "title", "ALTER TABLE comments ADD COLUMN title TEXT DEFAULT NULL"),
)

_INDEX_MIGRATIONS: tuple[IndexMigration, ...] = (
    (
        "idx_comments_review_id",
        "comments",
        ("review_id",),
        "CREATE INDEX IF NOT EXISTS idx_comments_review_id ON comments(review_id);",
    ),
    (
        "idx_comments_source",
        "comments",
        ("source",),
        "CREATE INDEX IF NOT EXISTS idx_comments_source ON comments(source);",
    ),
    (
        "idx_comments_status",
        "comments",
        ("status",),
        "CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);",
    ),
    (
        "idx_reviews_pr",
        "reviews",
        ("owner", "repo", "pr_number"),
        "CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(owner, repo, pr_number);",
    ),
    (
        "idx_reviews_pr_number",
        "reviews",
        ("pr_number",),
        "CREATE INDEX IF NOT EXISTS idx_reviews_pr_number ON reviews(pr_number);",
    ),
    (
        "idx_reviews_commit",
        "reviews",
        ("commit_sha",),
        "CREATE INDEX IF NOT EXISTS idx_reviews_commit ON reviews(commit_sha);",
    ),
    (
        "idx_comments_path",
        "comments",
        ("path",),
        "CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(path);",
    ),
    (
        "idx_comments_node_id",
        "comments",
        ("node_id",),
        "CREATE INDEX IF NOT EXISTS idx_comments_node_id ON comments(node_id);",
    ),
)

# Full DDL script kept intact for callers/tests inspecting SCHEMA directly.
SCHEMA = (
    f"\n{_REVIEWS_TABLE_DDL}\n\n"
    f"{_COMMENTS_TABLE_DDL}\n\n"
    f"{_SCHEMA_META_TABLE_DDL}\n\n" + "\n".join(sql for *_prefix, sql in _INDEX_MIGRATIONS) + "\n"
)

_DISMISSED_ADDRESSED_TYPES = tuple(sorted(BODY_EMBEDDED_COMMENT_TYPES - {"qodo_reply"}))
_DISMISSED_ADDRESSED_PLACEHOLDERS = ", ".join("?" for _ in _DISMISSED_ADDRESSED_TYPES)

_WORD_RE = re.compile(r"[a-z0-9]+")
_STANDARD_SOURCES = ("human", "qodo", "coderabbit")
_BACKFILL_BATCH_SIZE = 500


class ReviewDBError(RuntimeError):
    """Raised when a reviews.db storage operation fails."""


def _get_git_root() -> Path:
    """Detect the main git repo root (not worktree root)."""
    return find_git_root()


def resolve_reviews_db_path(project_root: Path | None = None) -> Path:
    """Resolve ``<main-git-root>/.pi/data/reviews.db``."""
    root = project_root if project_root is not None else _get_git_root()
    return resolve_db_path(REVIEWS_DB_NAME, project_root=root)


def ensure_database_directory(db_path: Path) -> None:
    """Create database directory with ``0700`` permissions if needed."""
    ensure_db_directory(db_path)


def create_tables(conn: sqlite3.Connection) -> bool:
    """Create tables/indexes if absent and apply all column migrations.

    Returns True when the ``comments.title`` migration ran on an existing table.
    """
    added = apply_migrations(
        conn,
        _COLUMN_MIGRATIONS,
        table_ddls=_TABLE_DDLS,
        index_migrations=_INDEX_MIGRATIONS,
    )
    return ("comments", "title") in added


def backfill_titles(conn: sqlite3.Connection) -> int:
    """Fill ``comments.title`` for rows where it is NULL.

    Streams eligible rows in bounded batches (``_BACKFILL_BATCH_SIZE``) so
    historical databases do not materialize all comment bodies in memory at
    once. Runs the deterministic extractor (Python port of the TS engine) over
    the raw body — the body column is never modified. Rows whose bodies yield
    no title (badge-only, empty) keep NULL; readers fall back to body
    extraction for those. Returns the number of rows updated.
    """
    select_cursor = conn.execute("SELECT id, body FROM comments WHERE title IS NULL AND body IS NOT NULL")
    updated = 0
    while True:
        batch = select_cursor.fetchmany(_BACKFILL_BATCH_SIZE)
        if not batch:
            break
        updates: list[tuple[str, Any]] = []
        for row_id, body in batch:
            title = extract_finding_title(body)
            if title:
                updates.append((title, row_id))
        if updates:
            conn.executemany("UPDATE comments SET title = ? WHERE id = ?", updates)
            updated += len(updates)
    return updated


def run_title_backfill_once(conn: sqlite3.Connection) -> None:
    """One-shot title backfill, tracked by a persisted ``schema_meta`` marker.

    The marker is gated by persistence (not by "did the column just appear"):
    sqlite3's ALTER TABLE autocommits, so a store that fails after migrating
    would otherwise leave the column present while the backfill UPDATEs roll
    back with the store's transaction. Committing the backfill and marker in
    their own transaction guarantees they survive later store failures, and
    a failed backfill leaves no marker so it retries on the next run.
    """
    marker = conn.execute("SELECT value FROM schema_meta WHERE key = 'title_backfill_rows'").fetchone()
    if marker is None:
        backfilled = backfill_titles(conn)
        conn.execute(
            "INSERT INTO schema_meta (key, value) VALUES ('title_backfill_rows', ?)",
            (str(backfilled),),
        )
        conn.commit()  # own transaction — survives later store failures
        log.info("Backfilled comments.title for %d row(s)", backfilled)


def _title_backfill_up_to_date(conn: sqlite3.Connection) -> bool:
    """Return True when title backfill is recorded, not applicable, or no rows need it."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(comments)").fetchall()}
    if not {"id", "body", "title"}.issubset(cols):
        return True
    marker = conn.execute("SELECT 1 FROM schema_meta WHERE key = 'title_backfill_rows' LIMIT 1").fetchone()
    if marker is not None:
        return True
    needs_backfill = conn.execute("SELECT 1 FROM comments WHERE title IS NULL AND body IS NOT NULL LIMIT 1").fetchone()
    return needs_backfill is None


def _backfill_if_eligible(conn: sqlite3.Connection) -> None:
    """Run one-shot title backfill only when comments carries id/body/title."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(comments)").fetchall()}
    if {"id", "body", "title"}.issubset(cols):
        run_title_backfill_once(conn)


def insert_review(
    conn: sqlite3.Connection,
    owner: str,
    repo: str,
    pr_number: int,
    commit_sha: str,
    created_at: str | None = None,
) -> int:
    """Insert a new review record (append-only)."""
    cursor = conn.cursor()
    if created_at is None:
        created_at = datetime.now(UTC).isoformat()
    log.debug("insert_review: %s/%s#%s commit=%s created_at=%s", owner, repo, pr_number, commit_sha[:7], created_at)

    cursor.execute(
        "INSERT INTO reviews (owner, repo, pr_number, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)",
        (owner, repo, pr_number, commit_sha, created_at),
    )
    review_id = cursor.lastrowid
    if not review_id:
        raise ReviewDBError("Failed to insert review record")
    return int(review_id)


def insert_comment(conn: sqlite3.Connection, review_id: int, source: str, comment: dict[str, Any]) -> None:
    """Insert a single comment record, deriving ``title`` when omitted."""
    cursor = conn.cursor()
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


def _non_resolution_skipped_sql(prefix: str = "") -> str:
    """SQL predicate excluding reasonless or GitHub-resolution-derived skipped rows."""
    p = f"{prefix}." if prefix else ""
    return (
        f"NOT ({p}status = 'skipped' AND ("
        f"(({p}skip_reason IS NULL OR TRIM({p}skip_reason) = '') "
        f"AND ({p}reply IS NULL OR TRIM({p}reply) = '')) "
        f"OR TRIM(COALESCE({p}skip_reason, '')) = 'Resolved on GitHub' "
        f"OR TRIM(COALESCE({p}skip_reason, '')) LIKE 'Resolved on GitHub by %' "
        f"OR TRIM(COALESCE({p}reply, '')) = 'Resolved on GitHub' "
        f"OR TRIM(COALESCE({p}reply, '')) LIKE 'Resolved on GitHub by %'"
        "))"
    )


def _tokenize_body(body: str) -> set[str]:
    """Extract normalized word tokens from body, capped at 2000 sorted tokens."""
    tokens = set(_WORD_RE.findall(body.lower()))
    if len(tokens) > 2000:
        tokens = set(sorted(tokens)[:2000])
    return tokens


def _token_similarity(tokens1: set[str], tokens2: set[str], threshold: float = 0.0) -> float:
    """Calculate Jaccard similarity between pre-tokenized sets with length-ratio short-circuit."""
    len_a = len(tokens1)
    len_b = len(tokens2)
    if not len_a or not len_b:
        return 0.0
    if threshold > 0.0:
        min_len, max_len = (len_a, len_b) if len_a <= len_b else (len_b, len_a)
        if min_len / max_len < threshold:
            return 0.0
    inter_len = len(tokens1 & tokens2)
    return inter_len / (len_a + len_b - inter_len)


def _body_similarity(body1: str, body2: str) -> float:
    """Calculate word overlap ratio between two bodies using Jaccard similarity."""
    tokens1 = _tokenize_body(body1)
    tokens2 = _tokenize_body(body2)
    if not tokens1 or not tokens2:
        return 0.0
    return _token_similarity(tokens1, tokens2)


def _format_table(data: list[dict[str, Any]], columns: list[str] | None = None) -> str:
    """Format data as a human-readable table."""
    if not data:
        return "(no results)"

    if columns is None:
        columns = list(data[0].keys())

    widths = {col: len(col) for col in columns}
    for row in data:
        for col in columns:
            val = str(row.get(col, ""))
            if len(val) > 60:
                val = val[:57] + "..."
            widths[col] = max(widths[col], len(val))

    header = " | ".join(col.ljust(widths[col]) for col in columns).rstrip()
    separator = "-+-".join("-" * widths[col] for col in columns)

    rows = []
    for row in data:
        values = []
        for col in columns:
            val = str(row.get(col, ""))
            if len(val) > 60:
                val = val[:57] + "..."
            values.append(val.ljust(widths[col]))
        rows.append(" | ".join(values).rstrip())

    return "\n".join([header, separator, *rows])


def _query_pr_comments_with_conn(conn: sqlite3.Connection, pr_number: int) -> list[dict[str, Any]]:
    cursor = conn.execute(
        """
        SELECT c.source, c.path, c.line, c.body, c.status, c.reply,
               c.priority, c.skip_reason, c.type, c.quality_label,
               c.node_id, r.commit_sha, r.created_at
        FROM comments c
        JOIN reviews r ON c.review_id = r.id
        WHERE r.pr_number = ?
        ORDER BY r.created_at ASC, c.id ASC
        """,
        (pr_number,),
    )
    rows = [dict(row) for row in cursor.fetchall()]
    log.debug("get_pr_comments pr=%d rows=%d", pr_number, len(rows))
    return rows


def _query_session_finding_ids(conn: sqlite3.Connection, owner: str, repo: str, pr_number: int) -> set[Any]:
    return {
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


class ReviewDB:
    """Unified read/write storage interface for ``.pi/data/reviews.db``.

    Read methods open read-only URI connections and only acquire a short-lived
    read-write lock once if a legacy database lags behind the current schema
    (columns, ``schema_meta``, or indexes). Write methods create the directory,
    apply schema + migrations + one-shot title backfill, and commit atomically.
    """

    def __init__(self, db_path: Path | None = None, *, project_root: Path | None = None) -> None:
        if db_path is None:
            self.db_path = resolve_reviews_db_path(project_root=project_root)
        else:
            self.db_path = db_path
        self._schema_checked = False

    def _connect(self) -> sqlite3.Connection:
        """Open a read-only connection, migrating once on first access if needed."""
        try:
            if not self._schema_checked:
                conn, schema_current = open_migrated_ro_with_status(
                    self.db_path,
                    _COLUMN_MIGRATIONS,
                    table_ddls=_TABLE_DDLS,
                    index_migrations=_INDEX_MIGRATIONS,
                    required_tables=_REQUIRED_TABLES,
                    extra_check=_title_backfill_up_to_date,
                    post_migrate=_backfill_if_eligible,
                    swallow_migration_errors=True,
                )
                if schema_current:
                    self._schema_checked = True
                return conn
            return connect_ro(self.db_path)
        except sqlite3.Error as exc:
            raise ReviewDBError(f"Failed to open database (read-only): {self.db_path.resolve()}") from exc

    def _connect_rw(self) -> sqlite3.Connection:
        """Open a read-write connection with directory creation, schema, and backfill."""
        conn: sqlite3.Connection | None = None
        try:
            conn = connect_rw(self.db_path, ensure_dir=True, foreign_keys=True)
            create_tables(conn)
            run_title_backfill_once(conn)
            self._schema_checked = True
            return conn
        except sqlite3.Error as exc:
            if conn is not None:
                try:
                    conn.rollback()
                except sqlite3.Error:
                    pass
                conn.close()
            raise ReviewDBError(f"Database error: {exc}") from exc

    def migrate(self) -> bool:
        """Ensure an existing database has all current tables, columns, indexes, and title backfill.

        Returns True if a write migration ran, False if the DB is missing or already up-to-date.
        """
        if not self.db_path.exists():
            return False

        ro_conn: sqlite3.Connection | None = None
        try:
            ro_conn = connect_ro(self.db_path)
            if has_all_migrations(
                ro_conn,
                _COLUMN_MIGRATIONS,
                required_tables=_REQUIRED_TABLES,
                required_indexes=_INDEX_MIGRATIONS,
                extra_check=_title_backfill_up_to_date,
            ):
                self._schema_checked = True
                return False
        except sqlite3.Error as exc:
            log.warning("Schema probe warning for %s: %s", self.db_path, exc)
            return False
        finally:
            if ro_conn is not None:
                ro_conn.close()

        rw_conn: sqlite3.Connection | None = None
        try:
            rw_conn = connect_rw(self.db_path, foreign_keys=False)
            create_tables(rw_conn)
            _backfill_if_eligible(rw_conn)
            rw_conn.commit()
            self._schema_checked = True
            return True
        except sqlite3.Error as exc:
            if rw_conn is not None:
                try:
                    rw_conn.rollback()
                except sqlite3.Error:
                    pass
            log.warning("Schema migration warning for %s: %s", self.db_path, exc)
            return False
        finally:
            if rw_conn is not None:
                rw_conn.close()

    # ── Read queries ──────────────────────────────────────────────────────

    def get_dismissed_comments(self, owner: str, repo: str) -> list[dict[str, Any]]:
        """Get dismissed comments for a repository, constrained by type for safety."""
        if not self.db_path.exists():
            log.debug("Database not found: %s", self.db_path)
            return []

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT c.path, c.line, c.body, c.status, c.reply, c.skip_reason, c.author, c.type, c.comment_id
                FROM comments c
                JOIN reviews r ON c.review_id = r.id
                WHERE r.owner = ? AND r.repo = ?
                  AND (
                      c.status IN ('not_addressed', 'skipped')
                      OR (c.status = 'addressed'
                          AND c.type IN ({_DISMISSED_ADDRESSED_PLACEHOLDERS}))
                  )
                  AND {_non_resolution_skipped_sql("c")}
                ORDER BY c.path, c.line
                """,  # noqa: S608
                (owner, repo, *_DISMISSED_ADDRESSED_TYPES),
            )
            return [
                {
                    "path": row["path"],
                    "line": row["line"],
                    "body": row["body"],
                    "status": row["status"],
                    "reply": row["reply"] or row["skip_reason"],
                    "skip_reason": row["skip_reason"],
                    "author": row["author"],
                    "type": row["type"],
                    "comment_id": row["comment_id"],
                }
                for row in cursor.fetchall()
            ]
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("Database error in get_dismissed_comments: %s", exc)
            return []
        finally:
            if conn is not None:
                conn.close()

    def get_replied_sticky_findings(self, owner: str, repo: str, pr_number: int) -> list[dict[str, Any]]:
        """Get Qodo sticky findings that were already replied to for a specific PR."""
        if not self.db_path.exists():
            return []

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT c.comment_id, c.body, c.status, c.reply, c.posted_at, c.code_diff
                FROM comments c
                JOIN reviews r ON c.review_id = r.id
                WHERE r.owner = ? AND r.repo = ? AND r.pr_number = ?
                  AND c.source = 'qodo'
                  AND (c.status IN ('addressed', 'not_addressed', 'skipped')
                       OR (c.status = 'failed' AND c.posted_at IS NOT NULL AND c.posted_at != ''))
                  AND c.comment_id IS NOT NULL
                ORDER BY c.posted_at DESC
                """,
                (owner, repo, pr_number),
            )
            return [
                {
                    "comment_id": row["comment_id"],
                    "body": row["body"],
                    "status": row["status"],
                    "reply": row["reply"],
                    "posted_at": row["posted_at"],
                    "code_diff": row["code_diff"],
                }
                for row in cursor.fetchall()
            ]
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("Database error in get_replied_sticky_findings: %s", exc)
            return []
        finally:
            if conn is not None:
                conn.close()

    def find_similar_comment(
        self, owner: str, repo: str, path: str, body: str, threshold: float = 0.6
    ) -> dict[str, Any] | None:
        """Find a previously dismissed comment matching path and body similarity."""
        if not self.db_path.exists():
            log.debug("Database not found: %s", self.db_path)
            return None

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT c.path, c.line, c.body, c.status, c.reply, c.skip_reason, c.author
                FROM comments c
                JOIN reviews r ON c.review_id = r.id
                WHERE r.owner = ? AND r.repo = ?
                  AND c.path = ?
                  AND c.status IN ('not_addressed', 'skipped')
                  AND c.body IS NOT NULL
                  AND {_non_resolution_skipped_sql("c")}
                """,  # noqa: S608
                (owner, repo, path),
            )

            query_tokens = _tokenize_body(body)
            if not query_tokens:
                return None

            best_match: dict[str, Any] | None = None
            best_similarity = 0.0

            for row in cursor.fetchall():
                similarity = _token_similarity(
                    query_tokens, _tokenize_body(row["body"]), threshold=max(threshold, best_similarity)
                )
                if similarity >= threshold and similarity > best_similarity:
                    best_similarity = similarity
                    best_match = {
                        "path": row["path"],
                        "line": row["line"],
                        "body": row["body"],
                        "status": row["status"],
                        "reply": row["reply"] or row["skip_reason"],
                        "author": row["author"],
                        "similarity": similarity,
                    }

            return best_match
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("Database error in find_similar_comment: %s", exc)
            return None
        finally:
            if conn is not None:
                conn.close()

    def get_stats_by_source(self) -> list[dict[str, Any]]:
        """Get addressed rate statistics grouped by comment source."""
        if not self.db_path.exists():
            log.debug("Database not found: %s", self.db_path)
            return []

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    source,
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'addressed' THEN 1 ELSE 0 END) as addressed,
                    SUM(CASE WHEN status = 'not_addressed' THEN 1 ELSE 0 END) as not_addressed,
                    SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
                FROM comments
                GROUP BY source
                ORDER BY total DESC, source ASC
                """
            )

            results = []
            for row in cursor.fetchall():
                total = row["total"]
                addressed = row["addressed"]
                rate = (addressed / total * 100) if total > 0 else 0.0
                results.append({
                    "source": row["source"],
                    "total": total,
                    "addressed": addressed,
                    "not_addressed": row["not_addressed"],
                    "skipped": row["skipped"],
                    "addressed_rate": f"{rate:.1f}%",
                })
            return results
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("Database error in get_stats_by_source: %s", exc)
            return []
        finally:
            if conn is not None:
                conn.close()

    def get_duplicate_patterns(self, min_occurrences: int = 2) -> list[dict[str, Any]]:
        """Find recurring dismissed patterns (same path + similar body)."""
        if not self.db_path.exists():
            log.debug("Database not found: %s", self.db_path)
            return []

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT path, body, reply, skip_reason
                FROM comments
                WHERE status IN ('not_addressed', 'skipped')
                  AND body IS NOT NULL
                  AND path IS NOT NULL
                  AND {_non_resolution_skipped_sql()}
                ORDER BY path
                """  # noqa: S608
            )

            path_comments: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for row in cursor.fetchall():
                path_comments[row["path"]].append({
                    "body": row["body"],
                    "tokens": _tokenize_body(row["body"]),
                    "reason": row["reply"] or row["skip_reason"],
                })

            patterns = []
            for path, comments in path_comments.items():
                clusters: list[list[dict[str, Any]]] = []
                for comment in comments:
                    added_to_cluster = False
                    for cluster in clusters:
                        if _token_similarity(comment["tokens"], cluster[0]["tokens"], threshold=0.6) >= 0.6:
                            cluster.append(comment)
                            added_to_cluster = True
                            break
                    if not added_to_cluster:
                        clusters.append([comment])

                for cluster in clusters:
                    if len(cluster) >= min_occurrences:
                        reasons = [c["reason"] for c in cluster if c["reason"]]
                        most_common_reason = Counter(reasons).most_common(1)[0][0] if reasons else None
                        patterns.append({
                            "path": path,
                            "body_sample": cluster[0]["body"],
                            "occurrences": len(cluster),
                            "reason": most_common_reason,
                        })

            patterns.sort(key=lambda x: x["occurrences"], reverse=True)
            return patterns
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("Database error in get_duplicate_patterns: %s", exc)
            return []
        finally:
            if conn is not None:
                conn.close()

    def get_reviewer_stats(self) -> list[dict[str, Any]]:
        """Get statistics grouped by reviewer author."""
        if not self.db_path.exists():
            log.debug("Database not found: %s", self.db_path)
            return []

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    COALESCE(author, 'unknown') as author,
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'addressed' THEN 1 ELSE 0 END) as addressed,
                    SUM(CASE WHEN status = 'not_addressed' THEN 1 ELSE 0 END) as not_addressed,
                    SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
                FROM comments
                GROUP BY author
                ORDER BY total DESC, author ASC
                """
            )

            return [
                {
                    "author": row["author"],
                    "total": row["total"],
                    "addressed": row["addressed"],
                    "not_addressed": row["not_addressed"],
                    "skipped": row["skipped"],
                }
                for row in cursor.fetchall()
            ]
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("Database error in get_reviewer_stats: %s", exc)
            return []
        finally:
            if conn is not None:
                conn.close()

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        """Run a read-only SELECT/CTE query against the database."""
        sql_stripped = sql.strip()

        def _strip_sql_comments(s: str) -> str:
            s = re.sub(r"/\*.*?\*/", "", s, flags=re.DOTALL)
            s = re.sub(r"--[^\n]*", "", s)
            return s

        def _strip_sql_strings(s: str) -> str:
            return re.sub(r"'([^']|'')*'", "''", s)

        sql_for_checks = _strip_sql_comments(sql_stripped).lstrip()
        sql_upper = sql_for_checks.upper()

        sql_stmt_check = _strip_sql_strings(sql_for_checks).rstrip(";")
        if ";" in sql_stmt_check:
            raise ValueError("Multiple SQL statements are not allowed")

        if not sql_upper.startswith(("SELECT", "WITH")):
            raise ValueError("Only SELECT/CTE queries are allowed for safety")

        dangerous_keywords = (
            "INSERT",
            "UPDATE",
            "DELETE",
            "DROP",
            "ALTER",
            "CREATE",
            "ATTACH",
            "DETACH",
            "PRAGMA",
        )
        sql_upper_stripped = _strip_sql_strings(sql_upper)
        for keyword in dangerous_keywords:
            if re.search(rf"\b{re.escape(keyword)}\b", sql_upper_stripped):
                raise ValueError(f"SQL keyword '{keyword}' is not allowed in queries")

        if not self.db_path.exists():
            log.debug("Database not found: %s", self.db_path)
            return []

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            cursor = conn.cursor()
            cursor.execute(sql, params)
            return [dict(row) for row in cursor.fetchall()]
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("Database error in query: %s", exc)
            return []
        finally:
            if conn is not None:
                conn.close()

    # ── Status queries (shared with reviews/status.py) ────────────────────

    def get_pr_comments(self, pr_number: int) -> list[dict[str, Any]]:
        """Query all comments for ``pr_number`` ordered chronologically."""
        if not self.db_path.exists():
            return []

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            return _query_pr_comments_with_conn(conn, pr_number)
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("get_pr_comments failed pr=%d: %s", pr_number, exc)
            return []
        finally:
            if conn is not None:
                conn.close()

    def get_pr_repo_info(self, pr_number: int) -> tuple[str, str]:
        """Get ``(owner, repo)`` for ``pr_number``, or ``("", "")`` if absent."""
        if not self.db_path.exists():
            return ("", "")

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            row = conn.execute(
                "SELECT owner, repo FROM reviews WHERE pr_number = ? LIMIT 1",
                (pr_number,),
            ).fetchone()
            return (row["owner"], row["repo"]) if row else ("", "")
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("get_pr_repo_info failed pr=%d: %s", pr_number, exc)
            return ("", "")
        finally:
            if conn is not None:
                conn.close()

    def get_pr_status_data(self, pr_number: int) -> tuple[str, str, list[dict[str, Any]]]:
        """Fetch ``(owner, repo, comments)`` for ``pr_number`` on a single RO connection."""
        if not self.db_path.exists():
            return ("", "", [])

        conn: sqlite3.Connection | None = None
        try:
            conn = self._connect()
            row = conn.execute(
                "SELECT owner, repo FROM reviews WHERE pr_number = ? LIMIT 1",
                (pr_number,),
            ).fetchone()
            owner, repo = (row["owner"], row["repo"]) if row else ("", "")
            try:
                comments = _query_pr_comments_with_conn(conn, pr_number)
            except sqlite3.Error as exc:
                log.error("get_pr_comments failed pr=%d: %s", pr_number, exc)
                comments = []
            return (owner, repo, comments)
        except (sqlite3.Error, ReviewDBError) as exc:
            log.error("get_pr_status_data failed pr=%d: %s", pr_number, exc)
            return ("", "", [])
        finally:
            if conn is not None:
                conn.close()

    def list_prs(self) -> list[dict[str, Any]]:
        """List per-PR summary counts stored in the database."""
        if not self.db_path.exists():
            return []

        conn = self._connect()
        try:
            cursor = conn.execute(
                """
                SELECT r.pr_number,
                       COUNT(c.id) as total,
                       SUM(CASE WHEN c.status = 'addressed' THEN 1 ELSE 0 END) as addressed,
                       SUM(CASE WHEN c.status = 'skipped' THEN 1 ELSE 0 END) as skipped,
                       SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending,
                       MIN(r.created_at) as first_review,
                       MAX(r.created_at) as last_review
                FROM reviews r
                JOIN comments c ON c.review_id = r.id
                GROUP BY r.pr_number
                ORDER BY r.pr_number DESC
                """
            )
            return [dict(row) for row in cursor.fetchall()]
        except sqlite3.Error as exc:
            raise ReviewDBError(f"Database error: {exc}") from exc
        finally:
            conn.close()

    # ── Write & session operations (shared with store.py / store_session.py) ──

    def store_review(
        self,
        owner: str,
        repo: str,
        pr_number: int,
        commit_sha: str,
        comments_by_source: Mapping[str, Sequence[dict[str, Any]]],
        *,
        created_at: str | None = None,
    ) -> dict[str, int]:
        """Persist a review round and its comments atomically.

        Creates tables, applies migrations, and runs the one-shot title backfill
        in its own committed transaction before inserting the new review row.
        Returns per-source inserted comment counts.
        """
        conn = self._connect_rw()
        try:
            review_id = insert_review(conn, owner, repo, pr_number, commit_sha, created_at=created_at)
            counts: dict[str, int] = dict.fromkeys(_STANDARD_SOURCES, 0)
            for source in _STANDARD_SOURCES:
                for comment in comments_by_source.get(source, ()):
                    insert_comment(conn, review_id, source, comment)
                    counts[source] += 1
            conn.commit()
            return counts
        except sqlite3.Error as exc:
            conn.rollback()
            raise ReviewDBError(f"Database error: {exc}") from exc
        finally:
            conn.close()

    def get_session_finding_ids(self, owner: str, repo: str, pr_number: int) -> set[Any]:
        """Lock-free read-only lookup of already-stored session finding UUIDs for a PR.

        Never creates the database file or acquires a write lock so callers can
        safely run network pre-warming between this read pass and the write pass.
        """
        if not self.db_path.exists():
            return set()

        conn: sqlite3.Connection | None = None
        try:
            conn = connect_ro(self.db_path)
            return _query_session_finding_ids(conn, owner, repo, pr_number)
        except sqlite3.Error as exc:
            log.warning(
                "existing-session read pass failed for %s: %s — proceeding without idempotency check",
                self.db_path,
                exc,
            )
            return set()
        finally:
            if conn is not None:
                conn.close()

    def store_session_findings(
        self,
        owner: str,
        repo: str,
        pr_number: int,
        grouped_findings: Sequence[tuple[str, list[dict[str, Any]]]],
        *,
        attribution_fn: Callable[[dict[str, Any]], tuple[str, str]],
        row_builder: Callable[[dict[str, Any]], dict[str, Any]],
        created_at_fn: Callable[[list[dict[str, Any]]], str | None],
        known_existing_ids: set[Any] | None = None,
    ) -> tuple[int, int, int]:
        """Upsert Qodo session findings grouped by commit SHA in one transaction.

        Returns ``(stored_findings, refreshed_findings, skipped_groups)``.
        ``row_builder`` is invoked ONLY for not-yet-stored findings so refresh
        passes never trigger inline-location lookups.
        """
        conn = self._connect_rw()
        try:
            existing_ids: set[Any] = set(known_existing_ids) if known_existing_ids else set()
            existing_ids |= _query_session_finding_ids(conn, owner, repo, pr_number)

            stored_findings = 0
            refreshed_findings = 0
            skipped_groups = 0

            for git_sha, findings in grouped_findings:
                missing = [f for f in findings if f.get("id") not in existing_ids]
                missing_ids = {id(f) for f in missing}

                for finding in findings:
                    if id(finding) in missing_ids:
                        continue
                    status, priority = attribution_fn(finding)
                    updated = conn.execute(
                        """
                        UPDATE comments SET status = ?, priority = ?
                        WHERE node_id = ? AND type = 'session_finding'
                          AND review_id IN (
                              SELECT id FROM reviews WHERE owner = ? AND repo = ? AND pr_number = ?
                          )
                          AND (status != ? OR priority != ?)
                        """,
                        (
                            status,
                            priority,
                            finding.get("id"),
                            owner,
                            repo,
                            pr_number,
                            status,
                            priority,
                        ),
                    )
                    if updated.rowcount > 0:
                        refreshed_findings += 1

                if not missing:
                    skipped_groups += 1
                    continue

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
                    review_id = int(existing_row[0])
                else:
                    review_id = insert_review(
                        conn,
                        owner,
                        repo,
                        pr_number,
                        git_sha,
                        created_at=created_at_fn(missing),
                    )

                for finding in missing:
                    insert_comment(conn, review_id, "qodo", row_builder(finding))
                    stored_findings += 1

            conn.commit()
            return stored_findings, refreshed_findings, skipped_groups
        except sqlite3.Error as exc:
            conn.rollback()
            raise ReviewDBError(f"Database error: {exc}") from exc
        finally:
            conn.close()
