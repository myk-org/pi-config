"""Tests for the PR review store module."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest
from click.testing import CliRunner

from myk_pi_tools.pr.commands import pr
from myk_pi_tools.pr.pr_review_store import (
    get_review_history,
    get_skipped_comments,
    run_store,
    store_pr_review,
    update_resolution,
)


@pytest.fixture()
def db_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Provide a temp DB path and patch _get_db_path to return it."""
    path = tmp_path / "pr-reviews.db"
    monkeypatch.setattr("myk_pi_tools.pr.pr_review_store._get_db_path", lambda: path)
    return path


def _query_all(db_path: Path, table: str) -> list[sqlite3.Row]:
    """Helper: fetch all rows from a table as dicts."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(f"SELECT * FROM {table}").fetchall()  # noqa: S608
    conn.close()
    return rows


def test_store_posted_comments(db_path: Path) -> None:
    """Store comments with default status='posted', verify in DB."""
    comments = [
        {"path": "src/main.py", "line": 10, "body": "Fix this", "severity": "warning"},
        {"path": "src/utils.py", "line": 20, "body": "Refactor", "severity": "suggestion"},
    ]
    store_pr_review("myorg", "myrepo", 42, comments, head_sha="abc1234")

    reviews = _query_all(db_path, "pr_reviews")
    assert len(reviews) == 1
    assert reviews[0]["owner"] == "myorg"
    assert reviews[0]["repo"] == "myrepo"
    assert reviews[0]["pr_number"] == 42
    assert reviews[0]["head_sha"] == "abc1234"

    stored = _query_all(db_path, "pr_comments")
    assert len(stored) == 2
    assert stored[0]["path"] == "src/main.py"
    assert stored[0]["status"] == "posted"
    assert stored[0]["skip_reason"] is None
    assert stored[1]["path"] == "src/utils.py"
    assert stored[1]["status"] == "posted"


def test_store_skipped_comments(db_path: Path) -> None:
    """Store comments with status='skipped' and skip_reason, verify both fields."""
    comments = [
        {
            "path": "src/api.py",
            "line": 5,
            "body": "Unused import",
            "severity": "nitpick",
            "status": "skipped",
            "skip_reason": "duplicate of existing comment",
        },
    ]
    store_pr_review("org", "repo", 7, comments, head_sha="def5678")

    stored = _query_all(db_path, "pr_comments")
    assert len(stored) == 1
    assert stored[0]["status"] == "skipped"
    assert stored[0]["skip_reason"] == "duplicate of existing comment"
    assert stored[0]["body"] == "Unused import"


def test_store_mixed_comments(db_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Store mix of posted and skipped comments, verify counts in log output."""
    comments = [
        {"path": "a.py", "line": 1, "body": "posted1", "status": "posted"},
        {"path": "b.py", "line": 2, "body": "skipped1", "status": "skipped", "skip_reason": "dup"},
        {"path": "c.py", "line": 3, "body": "posted2"},  # default = posted
        {"path": "d.py", "line": 4, "body": "skipped2", "status": "skipped", "skip_reason": "low severity"},
    ]
    store_pr_review("org", "repo", 10, comments, head_sha="aaa1111")

    stderr = capsys.readouterr().err
    assert "2 posted" in stderr
    assert "2 skipped" in stderr

    stored = _query_all(db_path, "pr_comments")
    assert len(stored) == 4
    posted = [r for r in stored if r["status"] == "posted"]
    skipped = [r for r in stored if r["status"] == "skipped"]
    assert len(posted) == 2
    assert len(skipped) == 2


def test_store_with_author(db_path: Path) -> None:
    """Store with author field, verify saved in pr_reviews."""
    store_pr_review("org", "repo", 1, [{"body": "test"}], head_sha="sha1", author="janedoe")

    reviews = _query_all(db_path, "pr_reviews")
    assert len(reviews) == 1
    assert reviews[0]["author"] == "janedoe"


def test_store_without_author(db_path: Path) -> None:
    """Store without author, verify NULL in pr_reviews.author."""
    store_pr_review("org", "repo", 2, [{"body": "test"}], head_sha="sha2")

    reviews = _query_all(db_path, "pr_reviews")
    assert len(reviews) == 1
    assert reviews[0]["author"] is None


def test_get_skipped_comments(db_path: Path) -> None:
    """Store skipped comments then query with get_skipped_comments()."""
    comments = [
        {
            "path": "x.py",
            "line": 1,
            "body": "skip me",
            "severity": "nitpick",
            "status": "skipped",
            "skip_reason": "dup",
        },
        {
            "path": "y.py",
            "line": 2,
            "body": "post me",
            "severity": "warning",
            "status": "posted",
        },
        {
            "path": "z.py",
            "line": 3,
            "body": "skip too",
            "severity": "info",
            "status": "skipped",
            "skip_reason": "low prio",
        },
    ]
    store_pr_review("org", "repo", 55, comments, head_sha="bbb2222")

    result = get_skipped_comments("org", "repo", 55, db_path=db_path)
    assert len(result) == 2
    assert result[0]["path"] == "x.py"
    assert result[0]["skip_reason"] == "dup"
    assert result[0]["head_sha"] == "bbb2222"
    assert result[1]["path"] == "z.py"
    assert result[1]["skip_reason"] == "low prio"


def test_get_skipped_comments_empty(db_path: Path) -> None:
    """Query when no skipped comments exist returns empty list."""
    # Store only posted comments
    store_pr_review("org", "repo", 99, [{"body": "posted", "status": "posted"}], head_sha="ccc3333")

    result = get_skipped_comments("org", "repo", 99, db_path=db_path)
    assert result == []


def test_get_skipped_comments_no_db(tmp_path: Path) -> None:
    """Query when DB file doesn't exist returns empty list."""
    nonexistent = tmp_path / "does-not-exist.db"
    result = get_skipped_comments("org", "repo", 1, db_path=nonexistent)
    assert result == []


def test_schema_migration(db_path: Path) -> None:
    """Create DB with old schema (no status/skip_reason/author), verify migration adds columns."""
    # Create old-schema DB without status, skip_reason, and author columns
    old_schema = """
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
    """
    conn = sqlite3.connect(str(db_path))
    conn.executescript(old_schema)
    # Insert a legacy row without the new columns
    conn.execute(
        "INSERT INTO pr_reviews (owner, repo, pr_number, head_sha, created_at) VALUES (?, ?, ?, ?, ?)",
        ("org", "repo", 1, "old_sha", "2025-01-01T00:00:00"),
    )
    conn.execute(
        "INSERT INTO pr_comments"
        " (review_id, thread_id, path, line, body, severity, posted_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (1, "t1", "old.py", 5, "old comment", "warning", "2025-01-01T00:00:00"),
    )
    conn.commit()
    conn.close()

    # Now store via the normal API — this triggers migration
    comments = [
        {
            "path": "new.py",
            "line": 10,
            "body": "new comment",
            "severity": "error",
            "status": "skipped",
            "skip_reason": "test reason",
        },
    ]
    store_pr_review("org", "repo", 2, comments, head_sha="new_sha", author="migrator")

    # Verify migration added the columns and data is correct
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Old comment should have default status='posted', NULL skip_reason
    old_comments = conn.execute("SELECT * FROM pr_comments WHERE review_id = 1").fetchall()
    assert len(old_comments) == 1
    assert old_comments[0]["status"] == "posted"  # default from migration
    assert old_comments[0]["skip_reason"] is None

    # New comment should have the explicitly set values
    new_comments = conn.execute("SELECT * FROM pr_comments WHERE review_id = 2").fetchall()
    assert len(new_comments) == 1
    assert new_comments[0]["status"] == "skipped"
    assert new_comments[0]["skip_reason"] == "test reason"

    # Old review should have NULL author, new review should have 'migrator'
    reviews = conn.execute("SELECT * FROM pr_reviews ORDER BY id").fetchall()
    assert len(reviews) == 2
    assert reviews[0]["author"] is None
    assert reviews[1]["author"] == "migrator"

    conn.close()


def test_store_invalid_status_raises(db_path: Path) -> None:
    """Passing an invalid status raises ValueError before any DB write."""
    comments = [{"path": "a.py", "line": 1, "body": "bad", "status": "invalid"}]
    with pytest.raises(ValueError):
        store_pr_review("org", "repo", 1, comments, head_sha="sha1")

    # DB should not have been created or written to
    assert not db_path.exists()


def test_store_skipped_without_reason_raises(db_path: Path) -> None:  # noqa: ARG001
    """Passing status='skipped' without skip_reason raises ValueError."""
    comments = [{"path": "a.py", "line": 1, "body": "needs reason", "status": "skipped"}]
    with pytest.raises(ValueError):
        store_pr_review("org", "repo", 1, comments, head_sha="sha1")


def test_store_skipped_whitespace_reason_raises(db_path: Path) -> None:  # noqa: ARG001
    """Passing status='skipped' with whitespace-only skip_reason raises ValueError."""
    comments = [
        {"path": "a.py", "line": 1, "body": "needs reason", "status": "skipped", "skip_reason": "  "},
    ]
    with pytest.raises(ValueError):
        store_pr_review("org", "repo", 2, comments, head_sha="sha2")


def test_cli_get_skipped(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ARG001
    """CLI get-skipped-comments returns JSON output with exit code 0."""
    comments = [
        {
            "path": "x.py",
            "line": 1,
            "body": "skip me",
            "severity": "nitpick",
            "status": "skipped",
            "skip_reason": "dup",
        },
    ]
    store_pr_review("org", "repo", 55, comments, head_sha="bbb2222")

    runner = CliRunner()
    result = runner.invoke(pr, ["get-skipped-comments", "org", "repo", "55"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 1
    assert data[0]["path"] == "x.py"
    assert data[0]["skip_reason"] == "dup"


def test_update_resolution_happy_path(db_path: Path) -> None:
    """Store a posted comment, update its resolution, verify DB reflects the update."""
    comments = [
        {"path": "src/main.py", "line": 10, "body": "Fix this", "severity": "warning"},
    ]
    store_pr_review("org", "repo", 42, comments, head_sha="abc1234")

    updated = update_resolution(
        "org",
        "repo",
        42,
        file_path="src/main.py",
        line=10,
        resolution_status="resolved_fixed",
        author_response="Fixed in latest commit",
        db_path=db_path,
    )
    assert updated is True

    stored = _query_all(db_path, "pr_comments")
    assert len(stored) == 1
    assert stored[0]["resolution_status"] == "resolved_fixed"
    assert stored[0]["author_response"] == "Fixed in latest commit"


def test_update_resolution_no_match(db_path: Path) -> None:
    """update_resolution for a non-existent file/line returns False."""
    comments = [
        {"path": "src/main.py", "line": 10, "body": "Fix this", "severity": "warning"},
    ]
    store_pr_review("org", "repo", 42, comments, head_sha="abc1234")

    updated = update_resolution(
        "org",
        "repo",
        42,
        file_path="nonexistent.py",
        line=99,
        resolution_status="resolved_fixed",
        db_path=db_path,
    )
    assert updated is False


def test_update_resolution_invalid_status(db_path: Path) -> None:
    """update_resolution with an invalid resolution_status raises ValueError."""
    comments = [
        {"path": "src/main.py", "line": 10, "body": "Fix this", "severity": "warning"},
    ]
    store_pr_review("org", "repo", 42, comments, head_sha="abc1234")

    with pytest.raises(ValueError, match="Invalid resolution_status"):
        update_resolution(
            "org",
            "repo",
            42,
            file_path="src/main.py",
            line=10,
            resolution_status="invalid_status",
            db_path=db_path,
        )


def test_update_resolution_line_none(db_path: Path) -> None:
    """update_resolution with line=None matches by path only."""
    comments = [
        {"path": "src/main.py", "line": 10, "body": "Fix this", "severity": "warning"},
        {"path": "src/main.py", "line": 20, "body": "Fix that", "severity": "error"},
    ]
    store_pr_review("org", "repo", 42, comments, head_sha="abc1234")

    updated = update_resolution(
        "org",
        "repo",
        42,
        file_path="src/main.py",
        line=None,
        resolution_status="resolved_accepted",
        author_response="Accepted",
        db_path=db_path,
    )
    assert updated is True

    # Should update the most recent match (line=20, higher id)
    stored = _query_all(db_path, "pr_comments")
    resolved = [r for r in stored if r["resolution_status"] is not None]
    assert len(resolved) == 1
    assert resolved[0]["line"] == 20
    assert resolved[0]["resolution_status"] == "resolved_accepted"


def test_get_review_history_mixed(db_path: Path) -> None:
    """Store comments with different statuses, update one, verify get_review_history returns all."""
    comments = [
        {"path": "a.py", "line": 1, "body": "posted1", "severity": "warning", "status": "posted"},
        {
            "path": "b.py",
            "line": 2,
            "body": "skipped1",
            "severity": "nitpick",
            "status": "skipped",
            "skip_reason": "duplicate",
        },
        {"path": "c.py", "line": 3, "body": "posted2", "severity": "error", "status": "posted"},
    ]
    store_pr_review("org", "repo", 42, comments, head_sha="abc1234")

    # Update one posted comment with a resolution
    update_resolution(
        "org",
        "repo",
        42,
        file_path="a.py",
        line=1,
        resolution_status="resolved_fixed",
        author_response="Fixed it",
        db_path=db_path,
    )

    result = get_review_history("org", "repo", 42, db_path=db_path)
    assert len(result) == 3

    # posted1 — resolved
    assert result[0]["path"] == "a.py"
    assert result[0]["status"] == "posted"
    assert result[0]["resolution_status"] == "resolved_fixed"
    assert result[0]["author_response"] == "Fixed it"
    assert result[0]["head_sha"] == "abc1234"

    # skipped1
    assert result[1]["path"] == "b.py"
    assert result[1]["status"] == "skipped"
    assert result[1]["skip_reason"] == "duplicate"
    assert result[1]["resolution_status"] is None
    assert result[1]["author_response"] is None

    # posted2 — no resolution
    assert result[2]["path"] == "c.py"
    assert result[2]["status"] == "posted"
    assert result[2]["resolution_status"] is None


def test_get_review_history_empty(db_path: Path) -> None:
    """get_review_history for a PR with no comments returns empty list."""
    # Store comments for a different PR
    store_pr_review("org", "repo", 99, [{"body": "test"}], head_sha="sha1")

    result = get_review_history("org", "repo", 42, db_path=db_path)
    assert result == []


def test_get_review_history_no_db(tmp_path: Path) -> None:
    """get_review_history with a non-existent db_path returns empty list."""
    nonexistent = tmp_path / "does-not-exist.db"
    result = get_review_history("org", "repo", 1, db_path=nonexistent)
    assert result == []


def test_schema_migration_adds_resolution_columns(db_path: Path) -> None:
    """Create DB with old schema (without resolution columns), verify migration adds them."""
    # Create old-schema DB without resolution_status/author_response columns
    old_schema = """
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
    """
    conn = sqlite3.connect(str(db_path))
    conn.executescript(old_schema)
    conn.execute(
        "INSERT INTO pr_reviews (owner, repo, pr_number, head_sha, author, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("org", "repo", 1, "old_sha", None, "2025-01-01T00:00:00"),
    )
    conn.execute(
        "INSERT INTO pr_comments"
        " (review_id, path, line, body, severity, status, posted_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (1, "old.py", 5, "old comment", "warning", "posted", "2025-01-01T00:00:00"),
    )
    conn.commit()
    conn.close()

    # Verify columns don't exist yet
    conn = sqlite3.connect(str(db_path))
    cursor = conn.execute("PRAGMA table_info(pr_comments)")
    col_names = {row[1] for row in cursor.fetchall()}
    conn.close()
    assert "resolution_status" not in col_names
    assert "author_response" not in col_names

    # Trigger migration via update_resolution
    updated = update_resolution(
        "org",
        "repo",
        1,
        file_path="old.py",
        line=5,
        resolution_status="resolved_fixed",
        author_response="Fixed",
        db_path=db_path,
    )
    assert updated is True

    # Verify columns now exist and data is correct
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.execute("PRAGMA table_info(pr_comments)")
    col_names = {row[1] for row in cursor.fetchall()}
    assert "resolution_status" in col_names
    assert "author_response" in col_names

    row = conn.execute("SELECT * FROM pr_comments WHERE id = 1").fetchone()
    assert row["resolution_status"] == "resolved_fixed"
    assert row["author_response"] == "Fixed"
    conn.close()


def test_cli_update_resolution(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ARG001
    """CLI update-resolution updates a comment and exits 0."""
    comments = [
        {"path": "src/main.py", "line": 10, "body": "Fix this", "severity": "warning"},
    ]
    store_pr_review("org", "repo", 42, comments, head_sha="abc1234")

    runner = CliRunner()
    result = runner.invoke(
        pr,
        [
            "update-resolution",
            "org",
            "repo",
            "42",
            "--path",
            "src/main.py",
            "--line",
            "10",
            "--status",
            "resolved_fixed",
            "--response",
            "Fixed in latest commit",
        ],
    )
    assert result.exit_code == 0

    stored = _query_all(db_path, "pr_comments")
    assert stored[0]["resolution_status"] == "resolved_fixed"
    assert stored[0]["author_response"] == "Fixed in latest commit"


def test_cli_get_review_history(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ARG001
    """CLI get-review-history returns JSON output with exit code 0."""
    comments = [
        {"path": "x.py", "line": 1, "body": "posted", "severity": "warning", "status": "posted"},
        {
            "path": "y.py",
            "line": 2,
            "body": "skipped",
            "severity": "nitpick",
            "status": "skipped",
            "skip_reason": "dup",
        },
    ]
    store_pr_review("org", "repo", 55, comments, head_sha="bbb2222")

    runner = CliRunner()
    result = runner.invoke(pr, ["get-review-history", "org", "repo", "55"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert len(data) == 2
    assert data[0]["path"] == "x.py"
    assert data[0]["status"] == "posted"
    assert data[1]["path"] == "y.py"
    assert data[1]["status"] == "skipped"
    assert data[1]["skip_reason"] == "dup"


def test_run_store_with_author(db_path: Path, tmp_path: Path) -> None:
    """run_store() reads author from metadata and stores it in pr_reviews."""
    json_data = {
        "metadata": {
            "owner": "org",
            "repo": "repo",
            "pr_number": 10,
            "head_sha": "abc123",
            "author": "janedoe",
        },
        "comments": [{"path": "f.py", "line": 1, "body": "ok", "severity": "info"}],
    }
    json_file = tmp_path / "review.json"
    json_file.write_text(json.dumps(json_data))

    exit_code = run_store(str(json_file))
    assert exit_code == 0

    reviews = _query_all(db_path, "pr_reviews")
    assert len(reviews) == 1
    assert reviews[0]["author"] == "janedoe"
