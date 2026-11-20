"""Regression and optimization tests for WT-19 Python Reviews & DB R2 issues.

Covers:
- #1271: reply_and_resolve_thread combined GraphQL + parallel post / pending_update
- #1276: in-memory reuse in poll.py and address.py
- #1280: shallow-boundary and per-path git check caching in resolved_threads.py
- #1285: RO SQLite opens on read-only paths and missing indexes in store.py
- #1290: single-pass DOM classification in coderabbit_parser and skip-resolved in qodo_parser
- #1294: shared find_git_root, run_gh, post_issue_comment, fetch_pr_metadata
- #1296: atomic_write_json, parse_pr_url, get_thread_key prefixes, code approval helper
- #1298: compute_remaining_wait and validate_repo_format / validate_pr_number
- #1300: strip _enrichment_checked, route per-item chatter to debug, rstrip tables
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from myk_pi_tools.coderabbit.rate_limit import compute_remaining_wait
from myk_pi_tools.db.query import ReviewDB, _format_table
from myk_pi_tools.pr import resolved_threads
from myk_pi_tools.pr.common import PRInfo, validate_pr_number, validate_repo_format
from myk_pi_tools.pr.pr_review_store import get_review_history, get_skipped_comments, store_pr_review
from myk_pi_tools.reviews import address, fetch, pending_update, poll, post, store
from myk_pi_tools.reviews.coderabbit_parser import parse_review_body_comments
from myk_pi_tools.reviews.qodo_parser import parse_qodo_sticky_comment
from myk_pi_tools.reviews.status import format_tui_table
from myk_pi_tools.reviews.status import run as status_run
from myk_pi_tools.utils import atomic_write_json, parse_pr_url, post_issue_comment, run_gh


class TestCombinedReplyAndResolve1271:
    """#1271: Combined reply+resolve GraphQL mutation and parallel dispatch."""

    def test_reply_and_resolve_thread_both_succeed(self) -> None:
        gql_body = json.dumps({
            "data": {
                "addPullRequestReviewThreadReply": {"comment": {"id": "C1"}},
                "resolveReviewThread": {"thread": {"id": "T1", "isResolved": True}},
            }
        })
        proc = subprocess.CompletedProcess(["gh"], 0, stdout=f"HTTP/1.1 200 OK\r\n\r\n{gql_body}".encode(), stderr=b"")
        with patch("myk_pi_tools.reviews.post.subprocess.run", return_value=proc) as mock_run:
            reply_ok, resolve_ok = post.reply_and_resolve_thread("T1", "Fixed in abc123")

        assert (reply_ok, resolve_ok) == (True, True)
        mock_run.assert_called_once()
        payload = json.loads(mock_run.call_args.kwargs["input"].decode())
        assert "addPullRequestReviewThreadReply" in payload["query"]
        assert "resolveReviewThread" in payload["query"]

    def test_reply_and_resolve_partial_failure_preserves_reply_status(self) -> None:
        gql_body = json.dumps({
            "data": {
                "addPullRequestReviewThreadReply": {"comment": {"id": "C1"}},
                "resolveReviewThread": None,
            },
            "errors": [{"message": "Viewer cannot resolve thread"}],
        })
        proc = subprocess.CompletedProcess(["gh"], 0, stdout=f"HTTP/1.1 200 OK\r\n\r\n{gql_body}".encode(), stderr=b"")
        with patch("myk_pi_tools.reviews.post.subprocess.run", return_value=proc):
            reply_ok, resolve_ok = post.reply_and_resolve_thread("T1", "Fixed")

        assert (reply_ok, resolve_ok) == (True, False)

    def test_post_run_combines_and_parallelizes_threads(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        review_path = tmp_path / "reviews.json"
        review_path.write_text(
            json.dumps({
                "metadata": {"owner": "o", "repo": "r", "pr_number": 7},
                "human": [],
                "qodo": [
                    {"thread_id": "T1", "path": "a.py", "status": "addressed", "reply": "Fixed a in abc"},
                    {"thread_id": "T2", "path": "b.py", "status": "addressed", "reply": "Fixed b in def"},
                ],
                "coderabbit": [],
            }),
            encoding="utf-8",
        )
        monkeypatch.setattr(post, "check_dependencies", lambda: None)

        gql_calls: list[str] = []

        def fake_reply_and_resolve(tid: str, _body: str) -> tuple[bool, bool]:
            gql_calls.append(tid)
            return (True, tid == "T1")  # T2 fails resolve only

        with (
            patch.object(post, "reply_and_resolve_thread", side_effect=fake_reply_and_resolve),
            pytest.raises(SystemExit) as exc,
        ):
            post.run(str(review_path))

        assert exc.value.code == 1
        assert sorted(gql_calls) == ["T1", "T2"]
        updated = json.loads(review_path.read_text(encoding="utf-8"))
        assert updated["qodo"][0]["posted_at"]
        assert updated["qodo"][0]["resolved_at"]
        assert updated["qodo"][1]["posted_at"]
        assert "resolved_at" not in updated["qodo"][1]

    def test_pending_update_parallel_not_found_aborts(self, tmp_path: Path) -> None:
        review_path = tmp_path / "pending.json"
        review_path.write_text(
            json.dumps({
                "metadata": {"owner": "o", "repo": "r", "pr_number": 1, "review_id": 2},
                "comments": [
                    {
                        "id": 1,
                        "node_id": "N1",
                        "path": "a.py",
                        "body": "old1",
                        "refined_body": "new1",
                        "status": "accepted",
                    },
                    {
                        "id": 2,
                        "node_id": "N2",
                        "path": "b.py",
                        "body": "old2",
                        "refined_body": "new2",
                        "status": "accepted",
                    },
                ],
            }),
            encoding="utf-8",
        )
        with (
            patch.object(pending_update, "check_dependencies"),
            patch.object(pending_update, "update_comment_body", return_value="not_found"),
        ):
            rc = pending_update.run(str(review_path))
        assert rc == 1


class TestPollAndAddressReuse1276:
    """#1276: Reuse in-memory fetch data and summary comment."""

    def test_poll_helpers_accept_in_memory_data_without_disk_read(self, tmp_path: Path) -> None:
        # No pr-99-reviews.json on disk!
        data = {
            "human": [],
            "qodo": [{"is_auto_skipped": False, "already_replied": False, "status": "pending"}],
            "coderabbit": [],
        }
        assert poll._has_actionable_comments("99", str(tmp_path), data=data) is True
        assert poll._has_actionable_qodo_comments("99", str(tmp_path), data=data) is True
        poll._print_poll_summary("99", str(tmp_path), data=data)

    def test_coderabbit_poll_calls_find_summary_comment_once_per_cycle(self, tmp_path: Path) -> None:
        find_calls = 0

        def fake_find(_owner_repo: str, _pr: int) -> tuple[int, str, str, str]:
            nonlocal find_calls
            find_calls += 1
            return (10, "Not approved and not rate limited", "2026-01-01T00:00:00Z", "")

        fetch_calls = 0

        def fake_fetch(_url: str, *, output_dir: str) -> dict[str, Any]:  # noqa: ARG001
            nonlocal fetch_calls
            fetch_calls += 1
            if fetch_calls == 1:
                return {"human": [], "qodo": [], "coderabbit": []}  # 0 actionable
            return {"human": [{"is_auto_skipped": False}], "qodo": [], "coderabbit": []}

        with (
            patch.object(poll, "get_pr_info", return_value=("o", "r", "5")),
            patch.object(poll, "validate_owner_repo", return_value=True),
            patch.object(poll, "find_summary_comment", side_effect=fake_find),
            patch.object(poll, "fetch_run", side_effect=fake_fetch),
            patch.object(poll.time, "sleep"),
            patch("builtins.print"),
        ):
            rc = poll.run(source="coderabbit", output_dir=str(tmp_path))

        assert rc == 0
        # 1st cycle checks approval + rate limit from a single find_summary_comment call; 2nd cycle checks once
        assert find_calls == 2

    def test_address_reuses_posted_data_without_double_read(self, tmp_path: Path) -> None:
        review_path = tmp_path / "pr-5-reviews.json"
        review_path.write_text(
            json.dumps({
                "metadata": {"owner": "o", "repo": "r", "pr_number": 5},
                "human": [
                    {"thread_id": "T1", "path": "a.py", "line": 10, "status": "pending", "body": "Fix me"},
                    {"thread_id": "T2", "path": "b.py", "line": 20, "status": "pending", "body": "Fix later"},
                ],
                "qodo": [],
                "coderabbit": [],
            }),
            encoding="utf-8",
        )
        replies_path = tmp_path / "replies.txt"
        replies_path.write_text("a.py:10|Fixed a\n", encoding="utf-8")

        def fake_post(p: str) -> None:
            d = json.loads(Path(p).read_bytes())
            d["human"][0]["posted_at"] = "2026-01-01T00:00:00Z"
            Path(p).write_text(json.dumps(d), encoding="utf-8")

        read_count = 0
        orig_read_text = Path.read_text

        def counting_read_text(self: Path, *args: Any, **kwargs: Any) -> str:
            nonlocal read_count
            if self == review_path:
                read_count += 1
            return orig_read_text(self, *args, **kwargs)

        with (
            patch("myk_pi_tools.reviews.post.run", side_effect=fake_post),
            patch.object(Path, "read_text", counting_read_text),
        ):
            rc = address.run(str(review_path), str(replies_path))

        assert rc == 0
        # 1 initial read + 1 post-run read (no 3rd redundant read)
        assert read_count == 2


class TestResolvedThreadsCache1280:
    """#1280: Shallow boundary and per-path git checks cached across threads in run()."""

    def test_run_caches_shallow_boundary_and_per_path_checks(self, tmp_path: Path) -> None:
        threads_file = tmp_path / "threads.json"
        threads_file.write_text(
            json.dumps({
                "threads": [
                    {"thread_id": "1", "path": "a.py", "created_at": "2025-02-01T00:00:00Z"},
                    {"thread_id": "2", "path": "a.py", "created_at": "2025-02-01T00:00:00Z"},
                    {"thread_id": "3", "path": "a.py", "created_at": "2025-03-01T00:00:00Z"},
                ]
            }),
            encoding="utf-8",
        )
        git_calls: list[tuple[str, ...]] = []

        def fake_git(_repo: Path, *args: str) -> str | None:
            git_calls.append(args)
            if args[:2] == ("rev-parse", "--git-dir"):
                return ".git"
            if args[:2] == ("rev-parse", "--is-shallow-repository"):
                return "true"
            if args[:2] == ("rev-list", "--max-parents=0"):
                return "deadbeef"
            if args[:2] == ("log", "--no-walk"):
                return "2024-01-01T00:00:00+00:00"
            if args[:2] == ("cat-file", "-e"):
                return ""
            if args[0] == "log":
                return ""
            return None

        with patch.object(resolved_threads, "_git", side_effect=fake_git), patch("builtins.print") as mock_print:
            rc = resolved_threads.run(str(tmp_path), str(threads_file))

        assert rc == 0
        verdicts = json.loads(mock_print.call_args[0][0])
        assert all(v["suppressed"] is True for v in verdicts)
        # Shallow boundary checked once; cat-file once for a.py; git log twice (2 distinct since values)
        assert sum(1 for c in git_calls if c[:2] == ("rev-parse", "--is-shallow-repository")) == 1
        assert sum(1 for c in git_calls if c[:2] == ("cat-file", "-e")) == 1
        assert sum(1 for c in git_calls if c[0] == "log" and c[1].startswith("--since=")) == 2


class TestReadOnlySqliteAndIndexes1285:
    """#1285: Avoid RW SQLite opens on read-only paths and verify indexes."""

    def test_store_schema_has_missing_indexes(self, tmp_path: Path) -> None:
        db_path = tmp_path / "reviews.db"
        conn = sqlite3.connect(str(db_path))
        store.create_tables(conn)
        indexes = {row[1] for row in conn.execute("SELECT * FROM sqlite_master WHERE type = 'index'").fetchall()}
        conn.close()
        assert {"idx_reviews_pr_number", "idx_comments_path", "idx_comments_node_id"}.issubset(indexes)

    def test_review_db_init_uses_ro_only_on_up_to_date_db(self, tmp_path: Path) -> None:
        db_path = tmp_path / "reviews.db"
        conn = sqlite3.connect(str(db_path))
        store.create_tables(conn)
        conn.close()

        connect_calls: list[tuple[str, bool]] = []
        orig_connect = sqlite3.connect

        def tracking_connect(target: str, *args: Any, **kwargs: Any) -> sqlite3.Connection:
            connect_calls.append((target, bool(kwargs.get("uri"))))
            return orig_connect(target, *args, **kwargs)

        with patch("myk_pi_tools.db.query.sqlite3.connect", side_effect=tracking_connect):
            db = ReviewDB(db_path=db_path)
            assert db.get_stats_by_source() == []

        assert all(uri for _, uri in connect_calls)
        assert all("mode=ro" in target for target, _ in connect_calls)

    def test_pr_review_store_reads_use_ro_without_commit(self, tmp_path: Path) -> None:
        db_path = tmp_path / "pr-reviews.db"
        store_pr_review(
            "org",
            "repo",
            1,
            [{"path": "a.py", "line": 1, "body": "b", "status": "skipped", "skip_reason": "dup"}],
            head_sha="sha",
            db_path=db_path,
        )

        connect_calls: list[tuple[str, bool]] = []
        orig_connect = sqlite3.connect

        def tracking_connect(target: str, *args: Any, **kwargs: Any) -> sqlite3.Connection:
            connect_calls.append((target, bool(kwargs.get("uri"))))
            return orig_connect(target, *args, **kwargs)

        with patch("myk_pi_tools.pr.pr_review_store.sqlite3.connect", side_effect=tracking_connect):
            assert len(get_skipped_comments("org", "repo", 1, db_path=db_path)) == 1
            assert len(get_review_history("org", "repo", 1, db_path=db_path)) == 1

        assert all(uri and "mode=ro" in target for target, uri in connect_calls)

    def test_status_run_opens_reviews_db_once(self, tmp_path: Path) -> None:
        db_dir = tmp_path / ".pi" / "data"
        db_dir.mkdir(parents=True)
        db_path = db_dir / "reviews.db"
        conn = sqlite3.connect(str(db_path))
        store.create_tables(conn)
        rid = store.insert_review(conn, "org", "repo", 12, "abc1234")
        store.insert_comment(conn, rid, "qodo", {"path": "a.py", "line": 1, "body": "**Bug**", "status": "addressed"})
        conn.commit()
        conn.close()

        connect_count = 0
        orig_connect = sqlite3.connect

        def counting_connect(target: str, *args: Any, **kwargs: Any) -> sqlite3.Connection:
            nonlocal connect_count
            if "reviews.db" in str(target):
                connect_count += 1
            return orig_connect(target, *args, **kwargs)

        with (
            patch("myk_pi_tools.reviews.status.get_project_root", return_value=tmp_path),
            patch("myk_pi_tools.reviews.status.subprocess.run", side_effect=OSError("no gh")),
            patch("myk_pi_tools.reviews.status.sqlite3.connect", side_effect=counting_connect),
        ):
            status_run(pr_number=12, output_dir=str(tmp_path / "out"))

        assert connect_count == 1


class TestParsers1290:
    """#1290: Single-pass CodeRabbit parser and skip-resolved Qodo parser."""

    def test_coderabbit_single_pass_parses_all_sections_and_strips_ai_prompts(self) -> None:
        body = (
            "<details><summary>⚠️ Outside diff range comments (1)</summary><blockquote>"
            "<details><summary>a.py (1)</summary><blockquote>"
            "`10` _Potential issue_ | _Major_\n\n**Outside**\n\nDesc"
            "<details><summary>🤖 Prompt for AI Agents</summary>ignored</details>"
            "</blockquote></details></blockquote></details>"
            "<details><summary>🛠️ Major comments (1)</summary><blockquote>"
            "<details><summary>b.py (1)</summary><blockquote>"
            "`20` _Potential issue_ | _Major_\n\n**Major**\n\nDesc"
            "</blockquote></details></blockquote></details>"
        )
        parsed = parse_review_body_comments(body)
        assert len(parsed["outside_diff"]) == 1
        assert "ignored" not in parsed["outside_diff"][0]["body"]
        assert len(parsed["major"]) == 1
        assert parsed["minor"] == []

    def test_qodo_parser_skips_resolved_without_bs4_on_title(self, monkeypatch: pytest.MonkeyPatch) -> None:
        html_body = (
            "<h3>Code Review by Qodo</h3>\n"
            "<details><summary>  1.  <s>Resolved title</s> "
            "<code>✓ Resolved</code> <code>🐞 Bug</code> <code>≡ Correctness</code></summary>\n"
            "desc\n</details>\n"
            "<details><summary>  2.  Plain open title &amp; more "
            "<code>🐞 Bug</code> <code>≡ Correctness</code></summary>\n"
            "<details><summary>Description</summary><pre>Open desc</pre></details>\n"
            "</details>"
        )
        bs4_calls = 0
        import bs4

        orig_bs = bs4.BeautifulSoup

        def counting_bs(*args: Any, **kwargs: Any) -> Any:
            nonlocal bs4_calls
            bs4_calls += 1
            return orig_bs(*args, **kwargs)

        monkeypatch.setattr(bs4, "BeautifulSoup", counting_bs)
        findings = parse_qodo_sticky_comment(html_body)
        assert len(findings) == 1
        assert findings[0]["title"] == "Plain open title & more"
        # Only 1 BS4 call for the open finding's inner block (0 for codes_str, 0 for resolved, 0 for plain title)
        assert bs4_calls == 1


class TestSharedHelpersAndTokenCleanup1294_1296_1298_1300:
    """#1294, #1296, #1298, #1300."""

    def test_utils_helpers_and_validation(self, tmp_path: Path) -> None:
        assert parse_pr_url("https://github.com/myk-org/pi-config/pull/123#discussion_r1") == (
            "myk-org",
            "pi-config",
            "123",
        )
        assert validate_repo_format("myk-org/pi-config") is True
        assert validate_repo_format("invalid") is False
        assert validate_pr_number("42") is True
        assert validate_pr_number("abc") is False

        out = tmp_path / "data.json"
        atomic_write_json(out, {"ok": True})
        assert json.loads(out.read_text(encoding="utf-8")) == {"ok": True}

        with patch("myk_pi_tools.utils.subprocess.run", side_effect=FileNotFoundError):
            code, _out, err = run_gh(["--version"])
            assert code == 1
            assert "gh CLI not found" in err

        ok_proc = subprocess.CompletedProcess(["gh"], 0, stdout='{"id": 7}', stderr="")
        with patch("myk_pi_tools.utils.subprocess.run", return_value=ok_proc):
            ok, stdout, err = post_issue_comment("o", "r", 1, "hi")
            assert ok is True
            assert '"id": 7' in stdout
            assert err == ""

    def test_compute_remaining_wait(self) -> None:
        now = datetime.now(UTC)
        recent = (now - timedelta(seconds=20)).isoformat().replace("+00:00", "Z")
        remaining, elapsed, ok = compute_remaining_wait(100, recent)
        assert ok is True
        assert 19 <= elapsed <= 22
        assert 78 <= remaining <= 81

        assert compute_remaining_wait(100, None) == (100, 0, True)
        assert compute_remaining_wait(100, "bad-ts") == (100, 0, False)

    def test_get_thread_key_all_body_comment_prefixes(self) -> None:
        expected = {
            "outside_diff_comment": "odc",
            "major_comment": "mjc",
            "minor_comment": "mnc",
            "nitpick_comment": "npc",
            "duplicate_comment": "dpc",
        }
        for ctype, prefix in expected.items():
            key = fetch.get_thread_key({"type": ctype, "review_id": 5, "path": "a.py", "line": 9, "end_line": 10})
            assert key == f"{prefix}:5:a.py:9:10"

    def test_fetch_run_strips_enrichment_checked(self, tmp_path: Path) -> None:
        def fake_enrich(findings: list[dict[str, Any]], _replies: list[dict[str, Any]]) -> None:
            for item in findings:
                item["_enrichment_checked"] = True

        with (
            patch.object(fetch, "check_dependencies"),
            patch.object(fetch, "get_pr_info", return_value=("o", "r", "9")),
            patch.object(fetch, "run_gh_api", return_value={"user": {"login": "a"}, "head": {"sha": "abc"}}),
            patch.object(fetch, "fetch_review_threads", return_value=[]),
            patch.object(fetch, "fetch_coderabbit_body_comments", return_value=[]),
            patch.object(fetch, "fetch_qodo_cli_threads", return_value=(None, None)),
            patch.object(fetch, "fetch_qodo_sticky_findings", return_value=[]),
            patch.object(fetch, "fetch_qodo_reply_comments", return_value=[]),
            patch.object(
                fetch,
                "process_and_categorize",
                return_value={
                    "human": [],
                    "qodo": [{"already_replied": True, "status": "pending", "body": "x"}],
                    "coderabbit": [],
                },
            ),
            patch.object(fetch, "_enrich_findings_with_qodo_replies", side_effect=fake_enrich),
            patch.object(fetch, "is_qodo_approved", return_value=None),
        ):
            res = fetch.run(output_dir=str(tmp_path))

        assert isinstance(res, dict)
        assert "_enrichment_checked" not in res["qodo"][0]
        disk = json.loads((tmp_path / "pr-9-reviews.json").read_text(encoding="utf-8"))
        assert "_enrichment_checked" not in disk["qodo"][0]

    def test_tables_rstrip_trailing_whitespace(self) -> None:
        t1 = _format_table([{"col": "val", "tail": "short"}])
        for line in t1.splitlines():
            assert line == line.rstrip()

        t2 = format_tui_table(
            [{"source": "qodo", "path": "a.py", "line": 1, "body": "Title", "status": "pending", "reply": "ok"}],
            {"number": 1, "branch": "feat", "title": "Test"},
        )
        for line in t2.splitlines():
            assert line == line.rstrip()

    def test_post_and_pending_update_do_not_spam_skip_to_stderr(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        review_path = tmp_path / "reviews.json"
        review_path.write_text(
            json.dumps({
                "metadata": {"owner": "o", "repo": "r", "pr_number": 7},
                "human": [],
                "qodo": [{"thread_id": "T1", "path": "a.py", "status": "pending", "body": "x"}],
                "coderabbit": [],
            }),
            encoding="utf-8",
        )
        monkeypatch.setattr(post, "check_dependencies", lambda: None)
        with pytest.raises(SystemExit) as exc:
            post.run(str(review_path))
        assert exc.value.code == 0
        err = capsys.readouterr().err
        assert "Skipping qodo[0]" not in err
        assert "=== Summary ===" in err

        pending_path = tmp_path / "pending.json"
        pending_path.write_text(
            json.dumps({
                "metadata": {"owner": "o", "repo": "r", "pr_number": 1, "review_id": 2},
                "comments": [
                    {"id": 1, "node_id": "N1", "path": "a.py", "body": "old", "refined_body": None, "status": "pending"}
                ],
            }),
            encoding="utf-8",
        )
        with patch.object(pending_update, "check_dependencies"):
            rc = pending_update.run(str(pending_path))
        assert rc == 0
        err2 = capsys.readouterr().err
        assert "Skipping comment [0]" not in err2
        assert "=== Summary ===" in err2

    def test_pr_info_unused_import_check(self) -> None:
        info = PRInfo(owner="o", repo="r", pr_number="1")
        assert info.repo_full_name == "o/r"
        assert sys.version_info >= (3, 11)
