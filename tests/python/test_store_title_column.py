"""Tests for the comments.title column: migration, backfill, persistence.

The title is a derived, re-backfillable column — the raw body is never
modified (it stays the audit record of what the reviewer said).
"""

import json
import sqlite3
from pathlib import Path

import pytest

from myk_pi_tools.reviews.store import SCHEMA, backfill_titles, create_tables, insert_comment, insert_review

# Legacy schema (pre-title) — mirrors every DB created before the migration.
LEGACY_SCHEMA = SCHEMA.replace(",\n    title TEXT DEFAULT NULL\n);", "\n);")

QODO_BODY = (
    '<img src="https://img.shields.io/badge/High-634FD1" alt="Action required">\n\n'
    "1\\. Formatted tool permissions bypass pinned-rule protection <code>\U0001f41e Bug</code>\n\n"
    "<pre>ONLY_PERMIT_RE requires the first character...</pre>"
)


@pytest.fixture()
def legacy_db(tmp_path: Path) -> Path:
    db_path = tmp_path / "reviews.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(LEGACY_SCHEMA)
    # Seed rows with raw SQL — the legacy table has no title column, and the
    # production insert_comment (which writes title) must not be used here.
    conn.execute(
        "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) "
        "VALUES (42, 'myk-org', 'demo', 'sha-1', '2026-01-01')"
    )
    conn.execute(
        "INSERT INTO comments (review_id, source, path, line, body, status) "
        "VALUES (1, 'qodo', 'src/api.py', 1, ?, 'addressed')",
        (QODO_BODY,),
    )
    conn.execute(
        "INSERT INTO comments (review_id, source, path, line, body, status) "
        "VALUES (1, 'qodo', 'src/api.py', 2, ?, 'skipped')",
        ('<img src="https://badge">',),
    )
    conn.commit()
    conn.close()
    return db_path


def test_migration_adds_title_column_and_backfills(legacy_db: Path) -> None:
    conn = sqlite3.connect(str(legacy_db))
    try:
        assert create_tables(conn) is True, "title migration runs on a legacy DB"
        assert backfill_titles(conn) == 1, "only the body with a usable title is backfilled"
        conn.commit()
        rows = conn.execute("SELECT body, title FROM comments ORDER BY id").fetchall()
        assert rows[0][1] == "Formatted tool permissions bypass pinned-rule protection"
        assert rows[1][1] is None, "badge-only body keeps NULL (readers fall back to body extraction)"
        assert rows[0][0].startswith("<img"), "raw body is never modified"
    finally:
        conn.close()


def test_migration_is_idempotent_and_backfill_is_a_noop_afterwards(legacy_db: Path) -> None:
    conn = sqlite3.connect(str(legacy_db))
    try:
        assert create_tables(conn) is True
        backfill_titles(conn)
        conn.commit()
        assert create_tables(conn) is False, "second run: column exists, no migration"
        assert backfill_titles(conn) == 0, "second run: nothing left to backfill"
    finally:
        conn.close()


def test_fresh_schema_has_title_column(tmp_path: Path) -> None:
    conn = sqlite3.connect(str(tmp_path / "reviews.db"))
    try:
        assert create_tables(conn) is False, "fresh DB: column in SCHEMA, no ALTER needed"
        columns = {row[1] for row in conn.execute("PRAGMA table_info(comments)").fetchall()}
        assert "title" in columns
    finally:
        conn.close()


def test_insert_comment_prefers_json_title_then_extracts_from_body(tmp_path: Path) -> None:
    conn = sqlite3.connect(str(tmp_path / "reviews.db"))
    try:
        create_tables(conn)
        review_id = insert_review(conn, "myk-org", "demo", 42, "sha-1")
        # JSON title wins (Qodo sticky findings carry the parsed title)
        insert_comment(conn, review_id, "qodo", {"body": QODO_BODY, "title": "Parsed title from fetch"})
        # No JSON title → deterministic extraction over the body
        insert_comment(conn, review_id, "qodo", {"body": "**Markdown bold title on the endpoint**"})
        # Neither → NULL
        insert_comment(conn, review_id, "qodo", {"body": '<img src="https://badge">'})
        titles = [row[0] for row in conn.execute("SELECT title FROM comments ORDER BY id").fetchall()]
        assert titles == ["Parsed title from fetch", "Markdown bold title on the endpoint", None]
    finally:
        conn.close()


def test_store_reviews_persists_titles_and_backfills_legacy_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from myk_pi_tools.reviews import store

    # legacy DB at the project root the store resolves
    db_path = tmp_path / ".pi" / "data" / "reviews.db"
    db_path.parent.mkdir(parents=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(LEGACY_SCHEMA)
    # Raw SQL — the legacy table has no title column
    conn.execute(
        "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) "
        "VALUES (41, 'myk-org', 'demo', 'sha-old', '2026-01-01')"
    )
    conn.execute(
        "INSERT INTO comments (review_id, source, path, line, body, status) "
        "VALUES (1, 'qodo', 'src/old.py', 1, ?, 'addressed')",
        (QODO_BODY,),
    )
    conn.commit()
    conn.close()

    json_path = tmp_path / "pr-42-reviews.json"
    json_path.write_text(
        json.dumps({
            "metadata": {"owner": "myk-org", "repo": "demo", "pr_number": 42},
            "human": [],
            "qodo": [
                {
                    "path": "src/api.py",
                    "line": 7,
                    "body": "**Unhandled None on the endpoint response**",
                    "status": "addressed",
                    "title": "Unhandled None on the endpoint response",
                }
            ],
            "coderabbit": [],
        })
    )

    monkeypatch.setattr(store, "get_project_root", lambda: tmp_path)
    monkeypatch.setattr(store, "get_current_commit_sha", lambda: "sha-new")
    store.store_reviews(json_path)

    conn = sqlite3.connect(str(db_path))
    try:
        # new row carries its title
        new_row = conn.execute(
            "SELECT c.title FROM comments c JOIN reviews r ON c.review_id = r.id WHERE r.pr_number = 42"
        ).fetchone()
        assert new_row[0] == "Unhandled None on the endpoint response"
        # legacy row was backfilled by the same store run
        legacy_title = conn.execute("SELECT title FROM comments WHERE path = 'src/old.py'").fetchone()[0]
        assert legacy_title == "Formatted tool permissions bypass pinned-rule protection"
    finally:
        conn.close()
