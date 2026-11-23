"""Local-substitutable tests for unified reviews.db storage & shared SQLite helpers (#1363).

All tests run against real ephemeral SQLite databases under ``tmp_path`` —
no SQLite mocks.
"""

from __future__ import annotations

import ast
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from myk_pi_tools.db import sqlite_helpers, storage
from myk_pi_tools.db.storage import ReviewDB, create_tables
from myk_pi_tools.pr.pr_review_store import get_review_history, get_skipped_comments, store_pr_review

# Minimal v1 reviews.db schema BEFORE type, quality_label, code_diff, title,
# schema_meta, and the later indexes were introduced.
_V1_LEGACY_SCHEMA = """
CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number INTEGER NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE comments (
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
    resolved_at TEXT
);
"""

_EXPECTED_INDEXES = {
    "idx_comments_review_id",
    "idx_comments_source",
    "idx_comments_status",
    "idx_reviews_pr",
    "idx_reviews_pr_number",
    "idx_reviews_commit",
    "idx_comments_path",
    "idx_comments_node_id",
}

_QODO_BODY = (
    '<img src="https://img.shields.io/badge/High-634FD1" alt="Action required">\n\n'
    "1\\. Validate user input before constructing SQLite URI <code>🐞 Bug</code>\n\n"
    "<pre>details</pre>"
)


def _seed_v1_legacy_db(db_path: Path) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.executescript(_V1_LEGACY_SCHEMA)
        conn.execute(
            "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) "
            "VALUES (42, 'myk-org', 'demo', 'sha-v1', '2026-01-01T00:00:00+00:00')"
        )
        conn.execute(
            "INSERT INTO comments (review_id, source, path, line, body, priority, status) "
            "VALUES (1, 'qodo', 'src/db.py', 10, ?, 'HIGH', 'addressed')",
            (_QODO_BODY,),
        )
        conn.commit()
    finally:
        conn.close()


class TestLegacyMigrationParity:
    """ReviewDB read/migrate paths stay in full parity with store.create_tables."""

    def test_review_db_read_upgrades_v1_columns_tables_indexes_and_titles(self, tmp_path: Path) -> None:
        db_path = tmp_path / "reviews.db"
        _seed_v1_legacy_db(db_path)

        db = ReviewDB(db_path=db_path)
        stats = db.get_stats_by_source()
        assert len(stats) == 1
        assert stats[0]["source"] == "qodo"
        assert stats[0]["addressed"] == 1

        conn = sqlite3.connect(str(db_path))
        try:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(comments)").fetchall()}
            assert {"type", "quality_label", "code_diff", "title"}.issubset(cols)

            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()}
            assert {"reviews", "comments", "schema_meta"}.issubset(tables)

            indexes = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'").fetchall()}
            assert _EXPECTED_INDEXES.issubset(indexes)

            title = conn.execute("SELECT title FROM comments WHERE id = 1").fetchone()[0]
            assert title == "Validate user input before constructing SQLite URI"

            marker = conn.execute("SELECT value FROM schema_meta WHERE key = 'title_backfill_rows'").fetchone()
            assert marker is not None and marker[0] == "1"
        finally:
            conn.close()

        # Subsequent ReviewDB instances open strictly read-only (1 RO open, 0 RW opens).
        connect_calls: list[tuple[str, bool]] = []
        orig_connect = sqlite3.connect

        def track(target: str, *args: Any, **kwargs: Any) -> sqlite3.Connection:
            connect_calls.append((target, bool(kwargs.get("uri"))))
            return orig_connect(target, *args, **kwargs)

        with patch("sqlite3.connect", side_effect=track):
            fresh_reader = ReviewDB(db_path=db_path)
            assert len(fresh_reader.get_pr_comments(42)) == 1

        assert len(connect_calls) == 1
        assert connect_calls[0][1] is True
        assert "mode=ro" in connect_calls[0][0]

    def test_explicit_migrate_is_idempotent(self, tmp_path: Path) -> None:
        db_path = tmp_path / "reviews.db"
        _seed_v1_legacy_db(db_path)

        db = ReviewDB(db_path=db_path)
        assert db.migrate() is True
        assert db.migrate() is False

    def test_migrate_on_missing_db_returns_false_without_creating_file(self, tmp_path: Path) -> None:
        db_path = tmp_path / "missing.db"
        assert ReviewDB(db_path=db_path).migrate() is False
        assert not db_path.exists()


class TestSqliteHelpers:
    """Shared RO/RW connectors, directory perms, and migration guards."""

    def test_connect_ro_rejects_writes(self, tmp_path: Path) -> None:
        db_path = tmp_path / "ro.db"
        rw = sqlite_helpers.connect_rw(db_path)
        create_tables(rw)
        rw.commit()
        rw.close()

        ro = sqlite_helpers.connect_ro(db_path)
        try:
            with pytest.raises(sqlite3.OperationalError):
                ro.execute(
                    "INSERT INTO reviews (pr_number, owner, repo, commit_sha, created_at) "
                    "VALUES (1, 'o', 'r', 'sha', '2026-01-01')"
                )
        finally:
            ro.close()

    def test_connect_rw_creates_0700_dir_and_enables_foreign_keys(self, tmp_path: Path) -> None:
        db_path = tmp_path / "nested" / "data" / "reviews.db"
        conn = sqlite_helpers.connect_rw(db_path, ensure_dir=True, foreign_keys=True)
        try:
            mode = stat.S_IMODE(db_path.parent.stat().st_mode)
            assert mode == 0o700
            fk_enabled = conn.execute("PRAGMA foreign_keys").fetchone()[0]
            assert fk_enabled == 1
        finally:
            conn.close()

    def test_invalid_table_identifier_rejected(self, tmp_path: Path) -> None:
        db_path = tmp_path / "guard.db"
        conn = sqlite_helpers.connect_rw(db_path)
        try:
            with pytest.raises(ValueError, match="Invalid SQLite identifier"):
                sqlite_helpers.has_all_migrations(conn, [("bad;DROP TABLE reviews", "col", "SELECT 1")])
        finally:
            conn.close()

    def test_pr_review_store_legacy_migration_uses_shared_open_migrated_ro(self, tmp_path: Path) -> None:
        db_path = tmp_path / "pr-reviews.db"
        conn = sqlite3.connect(str(db_path))
        conn.executescript(
            """
            CREATE TABLE pr_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner TEXT NOT NULL,
                repo TEXT NOT NULL,
                pr_number INTEGER NOT NULL,
                head_sha TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE pr_comments (
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
            INSERT INTO pr_reviews (owner, repo, pr_number, head_sha, created_at)
            VALUES ('org', 'repo', 9, 'abc1234', '2026-01-01');
            INSERT INTO pr_comments (review_id, path, line, body, severity, posted_at)
            VALUES (1, 'a.py', 5, 'check null', 'high', '2026-01-01');
            """
        )
        conn.commit()
        conn.close()

        # First read upgrades legacy columns via shared open_migrated_ro
        history = get_review_history("org", "repo", 9, db_path=db_path)
        assert len(history) == 1
        assert history[0]["status"] == "posted"
        assert history[0]["resolution_status"] is None

        # Subsequent reads stay strictly RO
        connect_calls: list[tuple[str, bool]] = []
        orig_connect = sqlite3.connect

        def track(target: str, *args: Any, **kwargs: Any) -> sqlite3.Connection:
            connect_calls.append((target, bool(kwargs.get("uri"))))
            return orig_connect(target, *args, **kwargs)

        with patch("sqlite3.connect", side_effect=track):
            assert get_skipped_comments("org", "repo", 9, db_path=db_path) == []
            assert len(get_review_history("org", "repo", 9, db_path=db_path)) == 1

        assert len(connect_calls) == 2
        assert all(uri and "mode=ro" in target for target, uri in connect_calls)

        # Store still works against migrated DB
        store_pr_review(
            "org",
            "repo",
            9,
            [{"path": "b.py", "line": 2, "body": "skip me", "status": "skipped", "skip_reason": "dup"}],
            head_sha="def5678",
            db_path=db_path,
        )
        assert len(get_skipped_comments("org", "repo", 9, db_path=db_path)) == 1


class TestUnifiedReviewDBOperations:
    """Unified ReviewDB read, status, write, and session APIs."""

    def test_store_and_status_roundtrip(self, tmp_path: Path) -> None:
        db = ReviewDB(project_root=tmp_path)
        assert db.db_path == tmp_path / ".pi" / "data" / "reviews.db"

        counts = db.store_review(
            "myk-org",
            "pi-config",
            1363,
            "sha-1363",
            {
                "human": [
                    {"path": "a.py", "line": 12, "body": "**Fix boundary check on parse**", "status": "addressed"}
                ],
                "qodo": [{"path": "b.py", "line": 30, "body": _QODO_BODY, "status": "skipped", "skip_reason": "n/a"}],
                "coderabbit": [],
            },
        )
        assert counts == {"human": 1, "qodo": 1, "coderabbit": 0}

        owner, repo, comments = db.get_pr_status_data(1363)
        assert (owner, repo) == ("myk-org", "pi-config")
        assert len(comments) == 2
        assert db.get_pr_repo_info(1363) == ("myk-org", "pi-config")

        prs = db.list_prs()
        assert len(prs) == 1
        assert prs[0]["pr_number"] == 1363
        assert prs[0]["total"] == 2
        assert prs[0]["addressed"] == 1
        assert prs[0]["skipped"] == 1

    def test_get_session_finding_ids_does_not_create_missing_db(self, tmp_path: Path) -> None:
        db = ReviewDB(project_root=tmp_path)
        assert db.get_session_finding_ids("org", "repo", 1) == set()
        assert not db.db_path.exists()

    def test_review_learning_ts_schema_contract(self, tmp_path: Path) -> None:
        """Rows written via ReviewDB satisfy every query in extensions/orchestrator/review-learning.ts."""
        db = ReviewDB(project_root=tmp_path)
        db.store_review(
            "myk-org",
            "demo",
            77,
            "sha-1",
            {
                "qodo": [
                    {
                        "path": "src/api.py",
                        "line": 15,
                        "body": _QODO_BODY,
                        "priority": "HIGH",
                        "status": "addressed",
                    },
                    {
                        "path": "src/api.py",
                        "line": 22,
                        "body": "Skipped nit",
                        "priority": "LOW",
                        "status": "skipped",
                    },
                ],
            },
        )

        # Mirror exact queries executed by extensions/orchestrator/review-learning.ts
        conn = sqlite_helpers.connect_ro(db.db_path)
        try:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(comments)").fetchall()}
            assert "title" in cols

            latest = conn.execute(
                "SELECT id, pr_number, commit_sha, owner, repo FROM reviews "
                "WHERE owner=? AND repo=? AND pr_number=? ORDER BY id DESC LIMIT 1",
                ("myk-org", "demo", 77),
            ).fetchone()
            assert latest is not None
            assert (latest["pr_number"], latest["commit_sha"]) == (77, "sha-1")

            addressed = conn.execute(
                "SELECT c.id, c.path, c.line, c.body, c.priority, c.title "
                "FROM comments c WHERE c.review_id=? AND c.status='addressed'",
                (latest["id"],),
            ).fetchall()
            assert len(addressed) == 1
            assert addressed[0]["path"] == "src/api.py"
            assert addressed[0]["title"] == "Validate user input before constructing SQLite URI"

            matched = conn.execute(
                "SELECT c.id, c.path, c.body, c.title FROM comments c "
                "JOIN reviews r ON c.review_id = r.id "
                "WHERE r.owner=? AND r.repo=? AND c.status='addressed' AND c.path IN (?)",
                ("myk-org", "demo", "src/api.py"),
            ).fetchall()
            assert len(matched) == 1
            assert matched[0]["title"] == "Validate user input before constructing SQLite URI"
        finally:
            conn.close()


class TestArchitectureInvariants:
    """Enforce zero raw SQL bypasses and lazy CLI startup."""

    @pytest.mark.parametrize(
        "rel_path",
        [
            "myk_pi_tools/reviews/store.py",
            "myk_pi_tools/reviews/store_session.py",
            "myk_pi_tools/reviews/status.py",
        ],
    )
    def test_review_modules_do_not_import_sqlite3(self, rel_path: str) -> None:
        source = (Path(__file__).resolve().parents[2] / rel_path).read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        assert "sqlite3" not in imported, f"{rel_path} must delegate SQLite access to myk_pi_tools.db.storage"
        assert "mode=ro" not in source

    def test_pr_review_store_reuses_shared_sqlite_helpers(self) -> None:
        source = (Path(__file__).resolve().parents[2] / "myk_pi_tools/pr/pr_review_store.py").read_text(
            encoding="utf-8"
        )
        assert "from myk_pi_tools.db.sqlite_helpers import" in source
        assert "def _connect_ro(" not in source
        assert "def _has_all_migration_columns(" not in source
        assert "def _run_migrations(" not in source

    def test_importing_cli_skips_storage_and_sqlite_helpers(self) -> None:
        code = (
            "import sys, myk_pi_tools.cli; "
            "heavy = ('sqlite3', 'myk_pi_tools.db.storage', "
            "'myk_pi_tools.db.sqlite_helpers', 'myk_pi_tools.db.query'); "
            "print(','.join(m for m in heavy if m in sys.modules))"
        )
        proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
        assert proc.stdout.strip() == ""

    def test_storage_and_query_reexport_same_class(self) -> None:
        from myk_pi_tools.db import ReviewDB as LazyReviewDB
        from myk_pi_tools.db.query import ReviewDB as QueryReviewDB

        assert LazyReviewDB is storage.ReviewDB
        assert QueryReviewDB is storage.ReviewDB
