"""Focused unit tests for performance & compact-JSON issues #1174, #1180, and #1184."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import threading
from collections.abc import Set as AbstractSet
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from myk_pi_tools.cli import cli
from myk_pi_tools.db.query import ReviewDB, _body_similarity, _token_similarity, _tokenize_body
from myk_pi_tools.pr import claude_md as pr_claude_md
from myk_pi_tools.pr import diff as pr_diff
from myk_pi_tools.reviews import fetch as reviews_fetch
from myk_pi_tools.reviews import pending_fetch, store_session
from myk_pi_tools.reviews.store import create_tables

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_reviews_db(db_path: Path, rows: list[dict[str, Any]]) -> None:
    """Create a reviews SQLite DB and populate reviews/comments rows."""
    conn = sqlite3.connect(str(db_path))
    try:
        create_tables(conn)
        conn.execute(
            "INSERT INTO reviews (id, pr_number, owner, repo, commit_sha, created_at) "
            "VALUES (1, 10, 'org', 'repo', 'sha1', '2026-01-01T00:00:00Z')"
        )
        for idx, row in enumerate(rows, start=1):
            conn.execute(
                """
                INSERT INTO comments (
                    review_id, source, thread_id, node_id, comment_id,
                    author, path, line, body, priority, status,
                    reply, skip_reason, posted_at, resolved_at, type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    1,
                    row.get("source", "human"),
                    row.get("thread_id", f"PRRT_{idx}"),
                    row.get("node_id", f"node_{idx}"),
                    row.get("comment_id", 100 + idx),
                    row.get("author", "reviewer"),
                    row.get("path", "src/app.py"),
                    row.get("line", idx),
                    row.get("body", "Fix issue"),
                    row.get("priority", "MEDIUM"),
                    row.get("status", "skipped"),
                    row.get("reply"),
                    row.get("skip_reason"),
                    row.get("posted_at"),
                    row.get("resolved_at"),
                    row.get("type"),
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _session_finding(
    finding_id: str,
    inline_comment_id: str | None,
    *,
    git_sha: str = "sha111",
    created_at: str = "2026-02-01T10:00:00Z",
) -> dict[str, Any]:
    return {
        "id": finding_id,
        "title": f"Title {finding_id}",
        "description": f"Desc {finding_id}",
        "category": "Correctness",
        "action_level": "action_required",
        "attribution_status": "implemented",
        "git_sha": git_sha,
        "comment_id": 4200,
        "inline_comment_id": inline_comment_id,
        "created_at": created_at,
    }


# ---------------------------------------------------------------------------
# #1180: Token similarity, ReviewDB dedup/exclude_qodo, fetch skip
# ---------------------------------------------------------------------------


class _NoIntersectSet(set[str]):
    """Set subclass that fails if set intersection is performed."""

    def __and__(self, value: AbstractSet[object]) -> set[str]:
        raise AssertionError("Length-ratio short-circuit should have skipped intersection")


class TestTokenSimilarity1180:
    """Tests for _tokenize_body, _token_similarity, and _body_similarity."""

    def test_tokenize_body_deterministic_truncation_over_2000(self) -> None:
        words = [f"tok{i:04d}" for i in range(2500, 0, -1)]
        body = " ".join(words)
        tokens = _tokenize_body(body)
        expected = set(sorted(words)[:2000])
        assert len(tokens) == 2000
        assert tokens == expected

    def test_token_similarity_length_ratio_short_circuit(self) -> None:
        small = _NoIntersectSet({"a", "b"})
        large = _NoIntersectSet({"a", "b", "c", "d", "e"})
        # 2 / 5 = 0.4 < 0.6 -> must short-circuit without calling __and__
        assert _token_similarity(small, large, threshold=0.6) == 0.0
        assert _token_similarity(set(), large, threshold=0.6) == 0.0

    def test_token_similarity_above_threshold_computes_exact_jaccard(self) -> None:
        t1 = {"a", "b", "c"}
        t2 = {"a", "b", "c", "d"}
        assert _token_similarity(t1, t2, threshold=0.6) == pytest.approx(0.75)

    @pytest.mark.parametrize(
        ("body1", "body2"),
        [
            ("", "some words"),
            ("Add error handling for edge cases", "Add error handling for edge cases"),
            ("Add error handling for null input", "Remove unused import statement"),
            ("Validate user token before parsing", "Validate token before parsing payload"),
            (
                " ".join(f"alpha{i:04d}" for i in range(2400)),
                " ".join(f"alpha{i:04d}" for i in range(500, 2900)),
            ),
        ],
    )
    def test_token_similarity_equivalent_to_body_similarity(self, body1: str, body2: str) -> None:
        expected = _body_similarity(body1, body2)
        actual = _token_similarity(_tokenize_body(body1), _tokenize_body(body2))
        assert actual == pytest.approx(expected)


class TestReviewDB1180:
    """Tests for ReviewDB clustering and dismissed-comment matching."""

    @staticmethod
    def _seed_pattern_db(db_path: Path) -> ReviewDB:
        _seed_reviews_db(
            db_path,
            [
                {
                    "path": "src/a.py",
                    "body": "Add null check before accessing user profile",
                    "status": "skipped",
                    "skip_reason": "Already validated upstream",
                },
                {
                    "path": "src/a.py",
                    "body": "Add null check before accessing user profile field",
                    "status": "not_addressed",
                    "reply": "Already validated upstream",
                },
                {
                    "path": "src/a.py",
                    "body": "Completely unrelated performance note about caching",
                    "status": "skipped",
                    "skip_reason": "Won't fix",
                },
                {
                    "path": "src/b.py",
                    "body": "Add null check before accessing user profile",
                    "status": "addressed",
                    "reply": "Fixed",
                },
            ],
        )
        return ReviewDB(db_path=db_path)

    def test_get_duplicate_patterns_clusters_similar_dismissed(self, tmp_path: Path) -> None:
        db = self._seed_pattern_db(tmp_path / "reviews.db")

        patterns = db.get_duplicate_patterns(min_occurrences=2)
        assert len(patterns) == 1
        assert patterns[0]["path"] == "src/a.py"
        assert patterns[0]["occurrences"] == 2
        assert patterns[0]["reason"] == "Already validated upstream"

    def test_find_similar_comment_matches_dismissed_body(self, tmp_path: Path) -> None:
        db = self._seed_pattern_db(tmp_path / "reviews.db")

        match = db.find_similar_comment(
            "org", "repo", "src/a.py", "Add null check before accessing user profile", threshold=0.6
        )
        assert match is not None
        assert match["path"] == "src/a.py"
        assert match["reply"] == "Already validated upstream"
        assert match["similarity"] == pytest.approx(1.0)

    def test_find_similar_comment_skips_addressed_only_path(self, tmp_path: Path) -> None:
        db = self._seed_pattern_db(tmp_path / "reviews.db")
        assert (
            db.find_similar_comment("org", "repo", "src/b.py", "Add null check before accessing user profile") is None
        )

    def test_find_similar_comment_skips_dissimilar_body(self, tmp_path: Path) -> None:
        db = self._seed_pattern_db(tmp_path / "reviews.db")
        assert db.find_similar_comment("org", "repo", "src/a.py", "Refactor database connection pool") is None


class TestFetchProcessAndCategorize1180:
    """Tests for process_and_categorize dismissed-comment query skipping & matching."""

    def test_skips_dismissed_query_when_only_qodo_threads(self) -> None:
        mock_db = MagicMock()
        mock_db.get_replied_sticky_findings.return_value = []
        mock_db_cls = MagicMock(return_value=mock_db)

        threads = [
            {"author": "qodo-code-review[bot]", "path": "a.py", "body": "Qodo bug", "status": "pending"},
            {"source": "qodo", "author": "bot", "path": "b.py", "body": "Qodo 2", "status": "pending"},
        ]

        with patch.object(reviews_fetch, "ReviewDB", mock_db_cls):
            result = reviews_fetch.process_and_categorize(threads, "org", "repo", pr_number=1)

        mock_db.get_dismissed_comments.assert_not_called()
        assert len(result["qodo"]) == 2

    def test_skips_dismissed_query_when_non_qodo_threads_are_not_pending(self) -> None:
        mock_db = MagicMock()
        mock_db.get_replied_sticky_findings.return_value = []
        mock_db_cls = MagicMock(return_value=mock_db)

        threads = [
            {"author": "alice", "path": "a.py", "body": "Human note", "status": "addressed"},
            {"author": "coderabbitai[bot]", "path": "b.py", "body": "CR note", "status": "skipped"},
        ]

        with patch.object(reviews_fetch, "ReviewDB", mock_db_cls):
            reviews_fetch.process_and_categorize(threads, "org", "repo", pr_number=1)

        mock_db.get_dismissed_comments.assert_not_called()

    def test_calls_get_dismissed_comments_when_non_qodo_pending_exists(self) -> None:
        mock_db = MagicMock()
        mock_db.get_replied_sticky_findings.return_value = []
        mock_db.get_dismissed_comments.return_value = [
            {
                "path": "a.py",
                "line": 10,
                "body": "Avoid broad exception catch",
                "status": "skipped",
                "reply": "intentional",
                "skip_reason": "intentional",
                "comment_id": 99,
            }
        ]
        mock_db_cls = MagicMock(return_value=mock_db)

        threads = [
            {"author": "coderabbitai[bot]", "path": "a.py", "body": "Avoid broad exception catch", "status": "pending"}
        ]

        with patch.object(reviews_fetch, "ReviewDB", mock_db_cls):
            result = reviews_fetch.process_and_categorize(threads, "org", "repo", pr_number=1)

        mock_db.get_dismissed_comments.assert_called_once_with("org", "repo")
        assert result["coderabbit"][0]["is_auto_skipped"] is True
        assert result["coderabbit"][0]["status"] == "skipped"

    def test_pending_coderabbit_auto_skipped_by_dismissed_qodo_comment(self, tmp_path: Path) -> None:
        db_path = tmp_path / "reviews.db"
        _seed_reviews_db(
            db_path,
            [
                {
                    "source": "qodo",
                    "author": "qodo-code-review[bot]",
                    "path": "src/handler.py",
                    "body": "Avoid broad exception catch in request handler",
                    "status": "skipped",
                    "skip_reason": "false positive",
                }
            ],
        )

        threads = [
            {
                "author": "coderabbitai[bot]",
                "path": "src/handler.py",
                "body": "Avoid broad exception catch in request handler function",
                "status": "pending",
            }
        ]

        with patch.object(
            reviews_fetch,
            "ReviewDB",
            lambda db_path=None: ReviewDB(db_path=tmp_path / "reviews.db"),  # noqa: ARG005
        ):
            result = reviews_fetch.process_and_categorize(threads, "org", "repo", pr_number=10)

        assert len(result["coderabbit"]) == 1
        assert result["coderabbit"][0]["is_auto_skipped"] is True
        assert result["coderabbit"][0]["status"] == "skipped"
        assert result["coderabbit"][0]["skip_reason"] == "false positive"


class TestStickyThreadKeyNormalization:
    """Tests for HTML entity normalization in sticky thread keys without bs4."""

    @staticmethod
    def _sticky_pair() -> tuple[dict[str, Any], dict[str, Any]]:
        encoded = {
            "type": "qodo_bug",
            "path": "src/app.py",
            "body": "Validate input &amp; output values\nMore details",
        }
        plain = {
            "type": "qodo_bug",
            "path": "src/app.py",
            "body": "Validate input & output values\nMore details",
        }
        return encoded, plain

    def test_get_thread_key_normalizes_html_entities_without_bs4(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setitem(sys.modules, "bs4", None)
        encoded, plain = self._sticky_pair()

        key_encoded = reviews_fetch.get_thread_key(encoded)
        key_plain = reviews_fetch.get_thread_key(plain)

        assert key_encoded is not None
        assert key_encoded == key_plain

    def test_merge_threads_deduplicates_html_entity_sticky_titles(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setitem(sys.modules, "bs4", None)
        encoded, plain = self._sticky_pair()

        merged = reviews_fetch.merge_threads([encoded], [plain])

        assert len(merged) == 1


# ---------------------------------------------------------------------------
# #1174: Concurrency, ordering, batch prefetch, fail-soft
# ---------------------------------------------------------------------------


class TestClaudeMdCollectRemote1174:
    """Tests for pr.claude_md._collect_remote ordering."""

    def test_collect_remote_preserves_original_order_when_later_finishes_first(self) -> None:
        later_finished = threading.Event()

        def fake_fetch(_owner: str, _repo: str, path: str) -> str | None:
            if path == "CLAUDE.md":
                # Guarantee AGENTS.md finishes before CLAUDE.md
                assert later_finished.wait(timeout=2.0)
                return "# CLAUDE"
            if path == ".claude/CLAUDE.md":
                return None
            if path == "AGENTS.md":
                later_finished.set()
                return "# AGENTS"
            return None

        with patch.object(pr_claude_md, "fetch_from_github", side_effect=fake_fetch):
            sections = pr_claude_md._collect_remote("org", "repo", ["CLAUDE.md", ".claude/CLAUDE.md", "AGENTS.md"])

        assert sections == ["# CLAUDE", "# AGENTS"]


class TestPrDiffRun1174:
    """Tests for pr.diff.run()."""

    _SAMPLE_META: dict[str, Any] = {
        "head": {"sha": "deadbeef"},
        "base": {"ref": "main"},
        "title": "Perf improvements",
        "state": "open",
    }
    _SAMPLE_FILES: list[dict[str, Any]] = [
        {"path": "a.py", "status": "modified", "additions": 3, "deletions": 1, "patch": "@@"}
    ]

    def _run_sample(self, capsys: pytest.CaptureFixture[str]) -> str:
        with (
            patch.object(pr_diff, "fetch_pr_metadata", return_value=self._SAMPLE_META),
            patch.object(pr_diff, "fetch_pr_diff", return_value="diff --git a/a.py b/a.py"),
            patch.object(pr_diff, "fetch_pr_files", return_value=self._SAMPLE_FILES),
        ):
            pr_diff.run(["org/repo", "42"])
        return capsys.readouterr().out.strip()

    def test_pr_diff_run_outputs_compact_json(self, capsys: pytest.CaptureFixture[str]) -> None:
        raw = self._run_sample(capsys)
        assert "\n" not in raw
        parsed = json.loads(raw)
        assert raw == json.dumps(parsed, separators=(",", ":"))

    def test_pr_diff_run_includes_expected_keys(self, capsys: pytest.CaptureFixture[str]) -> None:
        parsed = json.loads(self._run_sample(capsys))
        assert set(parsed.keys()) == {"metadata", "diff", "files"}
        assert parsed["metadata"] == {
            "owner": "org",
            "repo": "repo",
            "pr_number": "42",
            "head_sha": "deadbeef",
            "base_ref": "main",
            "title": "Perf improvements",
            "state": "open",
        }
        assert parsed["diff"] == "diff --git a/a.py b/a.py"
        assert parsed["files"] == self._SAMPLE_FILES

    def test_pr_diff_run_metadata_failure_exits_1(self) -> None:
        with (
            patch.object(pr_diff, "fetch_pr_metadata", side_effect=SystemExit(1)),
            patch.object(pr_diff, "fetch_pr_diff", return_value=""),
            patch.object(pr_diff, "fetch_pr_files", return_value=[]),
            pytest.raises(SystemExit) as exc_info,
        ):
            pr_diff.run(["org/repo", "42"])

        assert exc_info.value.code == 1

    def test_pr_diff_run_metadata_failure_skips_worker_fetches(self) -> None:
        with (
            patch.object(pr_diff, "fetch_pr_metadata", side_effect=SystemExit(1)),
            patch.object(pr_diff, "fetch_pr_diff") as m_diff,
            patch.object(pr_diff, "fetch_pr_files") as m_files,
            pytest.raises(SystemExit) as exc_info,
        ):
            pr_diff.run(["org/repo", "42"])

        assert exc_info.value.code == 1
        m_diff.assert_not_called()
        m_files.assert_not_called()

    def test_pr_diff_run_missing_head_sha_exits_1(self, capsys: pytest.CaptureFixture[str]) -> None:
        with (
            patch.object(pr_diff, "fetch_pr_metadata", return_value={"head": {}, "base": {"ref": "main"}}),
            patch.object(pr_diff, "fetch_pr_diff", return_value=""),
            patch.object(pr_diff, "fetch_pr_files", return_value=[]),
            pytest.raises(SystemExit) as exc_info,
        ):
            pr_diff.run(["org/repo", "42"])

        assert exc_info.value.code == 1
        assert "head SHA" in capsys.readouterr().err


class TestPendingFetchRun1174:
    """Tests for reviews.pending_fetch.run()."""

    @staticmethod
    def _run_concurrent(tmp_path: Path) -> int:
        barrier = threading.Barrier(2, timeout=2.0)

        def fake_comments(_owner: str, _repo: str, _pr_number: str, _review_id: int) -> list[dict[str, Any]]:
            barrier.wait()
            return [{"id": 77, "path": "a.py", "line": 12, "body": "Nit", "status": "pending"}]

        def fake_diff(_owner: str, _repo: str, _pr_number: str) -> str:
            barrier.wait()
            return "diff --git a/a.py b/a.py"

        with (
            patch.object(pending_fetch, "check_dependencies"),
            patch.object(pending_fetch, "get_authenticated_user", return_value="octocat"),
            patch.object(pending_fetch, "find_pending_review", return_value=({"id": 9001}, None)),
            patch.object(pending_fetch, "fetch_pending_review_comments", side_effect=fake_comments),
            patch.object(pending_fetch, "fetch_pr_diff", side_effect=fake_diff),
        ):
            return pending_fetch.run("https://github.com/org/repo/pull/123", output_dir=str(tmp_path))

    def test_pending_fetch_runs_fetches_concurrently(self, tmp_path: Path) -> None:
        assert self._run_concurrent(tmp_path) == 0

    def test_pending_fetch_writes_expected_json(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        assert self._run_concurrent(tmp_path) == 0
        out_path = Path(capsys.readouterr().out.strip())
        assert out_path == tmp_path / "pr-org-repo-123-pending-review.json"
        assert out_path.exists()
        payload = json.loads(out_path.read_text(encoding="utf-8"))
        assert payload["metadata"]["review_id"] == 9001
        assert payload["metadata"]["username"] == "octocat"
        assert len(payload["comments"]) == 1
        assert payload["diff"] == "diff --git a/a.py b/a.py"


class TestStoreSessionPrefetch1174:
    """Tests for reviews.store_session inline-location batch prefetch."""

    @pytest.fixture(autouse=True)
    def _isolate_cache_and_root(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        monkeypatch.setattr(store_session, "_INLINE_LOCATION_CACHE", {})
        monkeypatch.setattr(store_session, "get_project_root", lambda: tmp_path)
        return tmp_path

    @staticmethod
    def _write_session_file(tmp_path: Path, findings: list[dict[str, Any]]) -> Path:
        p = tmp_path / "session.json"
        p.write_text(
            json.dumps({"pr_url": "https://github.com/org/repo/pull/55", "findings": findings}),
            encoding="utf-8",
        )
        return p

    def test_single_paginate_call_when_multiple_uncached_findings(self, tmp_path: Path) -> None:
        json_path = self._write_session_file(
            tmp_path,
            [
                _session_finding("u1", "gh1:PRRT_1:1001"),
                _session_finding("u2", "gh1:PRRT_2:1002"),
            ],
        )
        calls: list[list[str]] = []

        def fake_subprocess_run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
            calls.append(cmd)
            return subprocess.CompletedProcess(
                cmd,
                0,
                stdout=json.dumps([
                    {"id": 1001, "path": "src/one.py", "line": 10},
                    {"id": 1002, "path": "src/two.py", "original_line": 20},
                ]),
                stderr="",
            )

        with patch.object(store_session.subprocess, "run", side_effect=fake_subprocess_run):
            store_session.store_session(json_path)

        assert len(calls) == 1
        assert "--paginate" in calls[0]
        assert "repos/org/repo/pulls/55/comments" in calls[0]

        conn = sqlite3.connect(str(tmp_path / ".pi" / "data" / "reviews.db"))
        try:
            rows = conn.execute("SELECT node_id, path, line FROM comments ORDER BY node_id").fetchall()
        finally:
            conn.close()
        assert rows == [("u1", "src/one.py", 10), ("u2", "src/two.py", 20)]

    def test_cache_miss_falls_back_to_inline_location(self, tmp_path: Path) -> None:
        json_path = self._write_session_file(
            tmp_path,
            [
                _session_finding("u1", "gh1:PRRT_1:1001"),
                _session_finding("u2", "gh1:PRRT_2:1002"),
            ],
        )
        calls: list[list[str]] = []

        def fake_subprocess_run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
            calls.append(cmd)
            if "--paginate" in cmd:
                # Only 1001 present; 1002 is a cache miss
                return subprocess.CompletedProcess(
                    cmd,
                    0,
                    stdout=json.dumps([{"id": 1001, "path": "src/one.py", "line": 11}]),
                    stderr="",
                )
            if "repos/org/repo/pulls/comments/1002" in cmd:
                return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(["src/miss.py", 22]), stderr="")
            raise AssertionError(f"Unexpected command: {cmd}")

        with patch.object(store_session.subprocess, "run", side_effect=fake_subprocess_run):
            store_session.store_session(json_path)

        assert len(calls) == 2
        assert "--paginate" in calls[0]
        assert "repos/org/repo/pulls/comments/1002" in calls[1]

        conn = sqlite3.connect(str(tmp_path / ".pi" / "data" / "reviews.db"))
        try:
            rows = conn.execute("SELECT node_id, path, line FROM comments ORDER BY node_id").fetchall()
        finally:
            conn.close()
        assert rows == [("u1", "src/one.py", 11), ("u2", "src/miss.py", 22)]

    def test_prefetch_degrades_fail_soft_on_gh_errors(self, tmp_path: Path) -> None:
        json_path = self._write_session_file(
            tmp_path,
            [
                _session_finding("u1", "gh1:PRRT_1:1001"),
                _session_finding("u2", "gh1:PRRT_2:1002"),
            ],
        )

        with patch.object(store_session.subprocess, "run", side_effect=FileNotFoundError("gh missing")):
            store_session.store_session(json_path)

        conn = sqlite3.connect(str(tmp_path / ".pi" / "data" / "reviews.db"))
        try:
            rows = conn.execute("SELECT node_id, path, line FROM comments ORDER BY node_id").fetchall()
        finally:
            conn.close()
        assert rows == [("u1", None, None), ("u2", None, None)]


class TestReviewsFetchRun1174:
    """Tests for reviews.fetch.run() parallel execution & deterministic merge order."""

    @staticmethod
    def _run_fetch_with_barrier(tmp_path: Path) -> dict[str, Any]:
        barrier = threading.Barrier(3, timeout=2.0)

        def fake_run_gh_api(endpoint: str, *, paginate: bool = False) -> Any:  # noqa: ARG001
            if endpoint == "/repos/org/repo/pulls/77":
                return {"user": {"login": "prauthor"}, "head": {"sha": "abc123"}}
            if "/issues/77/comments" in endpoint:
                barrier.wait()
                return []
            return None

        def fake_threads(
            _owner: str, _repo: str, _pr_number: str, include_resolved: bool = False, user: str | None = None
        ) -> list[dict[str, Any]]:
            _ = (include_resolved, user)
            barrier.wait()
            return [
                {
                    "thread_id": "T_HUMAN",
                    "node_id": "N_HUMAN",
                    "author": "alice",
                    "path": "a.py",
                    "line": 1,
                    "body": "Human 1",
                },
                {
                    "thread_id": "T_CR",
                    "node_id": "N_CR_THREAD",
                    "author": "coderabbitai[bot]",
                    "path": "b.py",
                    "line": 2,
                    "body": "CR 1",
                },
            ]

        def fake_cr_body(_owner: str, _repo: str, _pr_number: str) -> list[dict[str, Any]]:
            barrier.wait()
            return [
                {
                    "thread_id": None,
                    "node_id": "N_CR_BODY",
                    "comment_id": 500,
                    "review_id": 500,
                    "author": "coderabbitai[bot]",
                    "path": "c.py",
                    "line": 3,
                    "end_line": None,
                    "body": "Outside diff",
                    "type": "outside_diff_comment",
                    "replies": [],
                }
            ]

        cli_findings = [
            {
                "thread_id": "T_QODO",
                "node_id": "N_QODO",
                "comment_id": 600,
                "author": "qodo-code-review[bot]",
                "path": "d.py",
                "line": 4,
                "body": "Qodo finding",
                "source": "qodo",
            }
        ]
        cli_state = {"approved": False, "unresolved_count": 1, "head_sha": "abc123"}

        with (
            patch.object(reviews_fetch, "check_dependencies"),
            patch.object(reviews_fetch, "get_pr_info", return_value=("org", "repo", "77")),
            patch.object(reviews_fetch, "run_gh_api", side_effect=fake_run_gh_api),
            patch.object(reviews_fetch, "fetch_review_threads", side_effect=fake_threads),
            patch.object(reviews_fetch, "fetch_coderabbit_body_comments", side_effect=fake_cr_body),
            patch.object(reviews_fetch, "fetch_qodo_cli_threads", return_value=(cli_findings, cli_state)),
            patch.object(reviews_fetch, "fetch_qodo_reply_comments", return_value=[]),
            patch.object(reviews_fetch, "ReviewDB", side_effect=RuntimeError("disabled in test")),
        ):
            result = reviews_fetch.run(output_dir=str(tmp_path))
        assert isinstance(result, dict)
        return result

    def test_fetch_run_parallelizes_gh_calls(self, tmp_path: Path) -> None:
        result = self._run_fetch_with_barrier(tmp_path)
        assert isinstance(result, dict)
        assert result["metadata"]["owner"] == "org"
        assert result["metadata"]["pr_number"] == 77

    def test_fetch_run_merges_threads_deterministically(self, tmp_path: Path) -> None:
        result = self._run_fetch_with_barrier(tmp_path)
        assert [t["thread_id"] for t in result["human"]] == ["T_HUMAN"]
        assert [t["node_id"] for t in result["coderabbit"]] == ["N_CR_THREAD", "N_CR_BODY"]
        assert [t["thread_id"] for t in result["qodo"]] == ["T_QODO"]


# ---------------------------------------------------------------------------
# #1184: Compact single-line JSON CLI outputs
# ---------------------------------------------------------------------------


class TestCompactJsonCli1184:
    """Verify CLI commands emit single-line compact JSON parseable identically."""

    def test_reviews_fetch_emits_compact_json(self, tmp_path: Path) -> None:
        payload = {
            "metadata": {"owner": "org", "repo": "repo", "pr_number": 5},
            "human": [{"id": 1, "body": "a"}],
            "qodo": [],
            "coderabbit": [],
        }
        runner = CliRunner()
        with patch("myk_pi_tools.reviews.fetch.run", return_value=payload):
            res = runner.invoke(cli, ["reviews", "fetch", "--output-dir", str(tmp_path)])

        assert res.exit_code == 0
        line = res.output.strip()
        assert "\n" not in line
        assert line == json.dumps(payload, separators=(",", ":"))
        assert json.loads(line) == payload

    def test_pr_info_emits_compact_json(self) -> None:
        api_payload = {
            "user": {"login": "alice"},
            "head": {"sha": "abc", "repo": {"full_name": "org/repo"}},
            "base": {"ref": "main", "repo": {"full_name": "org/repo"}},
            "title": "Demo",
            "state": "open",
            "body": "Details",
            "labels": [{"name": "perf"}],
            "assignees": [{"login": "bob"}],
        }
        expected = {
            "owner": "org",
            "repo": "repo",
            "pr_number": "12",
            "author": "alice",
            "head_sha": "abc",
            "base_ref": "main",
            "title": "Demo",
            "state": "open",
            "labels": ["perf"],
            "assignees": ["bob"],
            "is_fork": False,
            "head_repo": "org/repo",
            "body": "Details",
        }
        runner = CliRunner()
        with patch("myk_pi_tools.pr.info.fetch_pr_info", return_value=api_payload):
            res = runner.invoke(cli, ["pr", "info", "org/repo", "12"])

        assert res.exit_code == 0
        line = res.output.strip()
        assert "\n" not in line
        assert line == json.dumps(expected, separators=(",", ":"))
        assert json.loads(line) == expected

    def test_pr_get_review_history_emits_compact_json(self) -> None:
        history = [
            {
                "path": "src/x.py",
                "line": 10,
                "body": "Check bounds",
                "severity": "WARNING",
                "status": "posted",
                "skip_reason": None,
                "resolution_status": "resolved_fixed",
                "author_response": "Fixed",
                "head_sha": "sha1",
                "created_at": "2026-01-01T00:00:00Z",
            }
        ]
        runner = CliRunner()
        with patch("myk_pi_tools.pr.pr_review_store.get_review_history", return_value=history):
            res = runner.invoke(cli, ["pr", "get-review-history", "org", "repo", "12"])

        assert res.exit_code == 0
        line = res.output.strip()
        assert "\n" not in line
        assert line == json.dumps(history, separators=(",", ":"))
        assert json.loads(line) == history

    def test_pr_get_skipped_comments_emits_compact_json(self) -> None:
        skipped = [
            {
                "path": "src/y.py",
                "line": 3,
                "body": "Nit",
                "severity": "INFO",
                "skip_reason": "Won't fix",
                "head_sha": "sha2",
            }
        ]
        runner = CliRunner()
        with patch("myk_pi_tools.pr.pr_review_store.get_skipped_comments", return_value=skipped):
            res = runner.invoke(cli, ["pr", "get-skipped-comments", "org", "repo", "12"])

        assert res.exit_code == 0
        line = res.output.strip()
        assert "\n" not in line
        assert line == json.dumps(skipped, separators=(",", ":"))
        assert json.loads(line) == skipped
