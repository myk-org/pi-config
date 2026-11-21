"""Regression tests for issue #1225.

When a human replies inside a Qodo inline review thread on GitHub and/or resolves
the conversation, `reviews fetch` must preserve the GitHub thread's `replies[]`,
`is_resolved`, and `resolved_by` on the reconciled Qodo CLI finding — both when
the CLI finding carries a `thread_id` and when `thread_id` is null (falling back
to `comment_id` or normalized title/path/line matching) — and without breaking
`reviews.db` storage/distillation.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from myk_pi_tools.reviews import fetch as fetch_mod
from myk_pi_tools.reviews import store as store_mod
from myk_pi_tools.reviews.fetch import _reconcile_cli_threads_with_github

PR_URL = "https://github.com/org/repo/pull/42"
HEAD_SHA = "a" * 40


def _cli_finding(**over: Any) -> dict[str, Any]:
    finding: dict[str, Any] = {
        "thread_id": "PRRT_kwDO1",
        "node_id": None,
        "comment_id": None,
        "author": "qodo-code-review",
        "path": "src/app.py",
        "line": 42,
        "end_line": 44,
        "body": "**Missing null check**\n\nThis can raise.",
        "title": "Missing null check",
        "quality_label": "Correctness",
        "type": "qodo_bug",
        "source": "qodo",
        "priority": "HIGH",
        "reply": None,
        "status": "pending",
        "code_diff": "",
        "evidence": "",
        "evidence_refs": [],
        "agent_prompt": "",
        "qodo_cli": True,
        "attribution_status": "pending",
        "is_resolved": None,
        "finding_uuid": "uuid-1",
    }
    finding.update(over)
    return finding


def _gh_qodo_twin(**over: Any) -> dict[str, Any]:
    twin: dict[str, Any] = {
        "thread_id": "PRRT_kwDO1",
        "node_id": "PRRC_node_1",
        "comment_id": 1001,
        "author": "qodo-code-review[bot]",
        "path": "src/app.py",
        "line": 42,
        "end_line": 44,
        "body": (
            '<img src="https://img.shields.io/badge/High-634FD1" alt="Action required">\n\n'
            "1\\. Missing null check <code>\U0001f41e Bug</code> <code>\u2261 Correctness</code>\n\n"
            "<pre>This can raise when input is None.</pre>"
        ),
        "created_at": "2026-11-20T10:00:00Z",
        "replies": [],
        "is_resolved": False,
        "resolved_by": None,
    }
    twin.update(over)
    return twin


# ---------------------------------------------------------------------------
# 1. GraphQL query includes resolvedBy { login } and parses resolved_by
# ---------------------------------------------------------------------------


def test_fetch_review_threads_queries_and_extracts_resolved_by_across_pages() -> None:
    """Both initial and cursor-paginated GraphQL queries request `resolvedBy { login }`."""
    queries_seen: list[str] = []
    responses = [
        {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviewThreads": {
                            "pageInfo": {"hasNextPage": True, "endCursor": "CUR_1"},
                            "nodes": [
                                {
                                    "id": "PRRT_p1",
                                    "isResolved": True,
                                    "resolvedBy": {"login": "myakove"},
                                    "comments": {
                                        "nodes": [
                                            {
                                                "id": "PRRC_1",
                                                "databaseId": 101,
                                                "author": {"login": "qodo-code-review[bot]"},
                                                "path": "src/a.py",
                                                "line": 10,
                                                "body": "**First finding**\n\nDetails",
                                                "createdAt": "2026-11-20T10:00:00Z",
                                            },
                                            {
                                                "id": "PRRC_2",
                                                "databaseId": 102,
                                                "author": {"login": "myakove"},
                                                "path": "src/a.py",
                                                "line": 10,
                                                "body": "Its ok, I approve it",
                                                "createdAt": "2026-11-20T11:00:00Z",
                                            },
                                        ]
                                    },
                                }
                            ],
                        }
                    }
                }
            }
        },
        {
            "data": {
                "repository": {
                    "pullRequest": {
                        "reviewThreads": {
                            "pageInfo": {"hasNextPage": False, "endCursor": None},
                            "nodes": [
                                {
                                    "id": "PRRT_p2",
                                    "isResolved": False,
                                    "resolvedBy": None,
                                    "comments": {
                                        "nodes": [
                                            {
                                                "id": "PRRC_3",
                                                "databaseId": 103,
                                                "author": {"login": "qodo-code-review[bot]"},
                                                "path": "src/b.py",
                                                "line": 20,
                                                "body": "**Second finding**\n\nDetails",
                                                "createdAt": "2026-11-20T12:00:00Z",
                                            }
                                        ]
                                    },
                                }
                            ],
                        }
                    }
                }
            }
        },
    ]

    def fake_graphql(query: str, _variables: dict[str, Any]) -> dict[str, Any]:
        queries_seen.append(query)
        return responses[len(queries_seen) - 1]

    with patch.object(fetch_mod, "run_gh_graphql", side_effect=fake_graphql):
        threads = fetch_mod.fetch_review_threads("org", "repo", "42", include_resolved=True)

    assert len(queries_seen) == 2
    assert all("resolvedBy { login }" in q for q in queries_seen)
    assert len(threads) == 2
    assert threads[0]["is_resolved"] is True
    assert threads[0]["resolved_by"] == "myakove"
    assert threads[0]["replies"] == [
        {"author": "myakove", "body": "Its ok, I approve it", "created_at": "2026-11-20T11:00:00Z"}
    ]
    assert threads[1]["is_resolved"] is False
    assert threads[1]["resolved_by"] is None


# ---------------------------------------------------------------------------
# 2. Reconciliation with thread_id
# ---------------------------------------------------------------------------


def test_reconcile_open_cli_finding_resolved_on_github_with_human_reply() -> None:
    """Open CLI finding whose GitHub thread was replied to & resolved by a human."""
    reply = {"author": "myakove", "body": "Its ok, I approve it", "created_at": "2026-11-20T11:00:00Z"}
    cli = [_cli_finding(thread_id="PRRT_kwDO1")]
    twin = _gh_qodo_twin(thread_id="PRRT_kwDO1", is_resolved=True, resolved_by="myakove", replies=[reply])

    _reconcile_cli_threads_with_github(cli, [twin])

    t = cli[0]
    assert t["is_resolved"] is True
    assert t["resolved_by"] == "myakove"
    assert t["replies"] == [reply]
    assert t["replies"][0] is not reply  # shallow-copied, no aliasing
    assert t["status"] == "skipped"
    assert t["is_auto_skipped"] is True
    assert t["skip_reason"] == "Resolved on GitHub by myakove"


def test_reconcile_open_cli_finding_resolved_without_resolved_by_login() -> None:
    """Resolved GitHub thread without `resolved_by` falls back to generic skip reason."""
    cli = [_cli_finding(thread_id="PRRT_kwDO1")]
    twin = _gh_qodo_twin(thread_id="PRRT_kwDO1", is_resolved=True, resolved_by=None, replies=[])

    _reconcile_cli_threads_with_github(cli, [twin])

    t = cli[0]
    assert t["is_resolved"] is True
    assert t["resolved_by"] is None
    assert t["replies"] == []
    assert t["status"] == "skipped"
    assert t["is_auto_skipped"] is True
    assert t["skip_reason"] == "Resolved on GitHub"


def test_reconcile_open_cli_finding_unresolved_with_human_reply_stays_pending() -> None:
    """An unresolved thread with human feedback keeps replies and stays pending (not auto-skipped)."""
    reply = {"author": "myakove", "body": "Please also guard empty list", "created_at": "2026-11-20T11:00:00Z"}
    cli = [_cli_finding(thread_id="PRRT_kwDO1")]
    twin = _gh_qodo_twin(thread_id="PRRT_kwDO1", is_resolved=False, resolved_by=None, replies=[reply])

    _reconcile_cli_threads_with_github(cli, [twin])

    t = cli[0]
    assert t["is_resolved"] is False
    assert t["resolved_by"] is None
    assert t["replies"] == [reply]
    assert t["status"] == "pending"
    assert not t.get("is_auto_skipped")
    assert not t.get("already_replied")


def test_reconcile_unmatched_explicit_thread_id_does_not_fallback_by_title() -> None:
    """A CLI finding with an explicit but unmatched thread_id must not steal another thread by title."""
    cli = [_cli_finding(thread_id="PRRT_other", title="Missing null check")]
    twin = _gh_qodo_twin(
        thread_id="PRRT_kwDO1",
        is_resolved=True,
        resolved_by="myakove",
        replies=[{"author": "myakove", "body": "Approved", "created_at": "2026-11-20T11:00:00Z"}],
    )

    _reconcile_cli_threads_with_github(cli, [twin])

    assert cli[0]["thread_id"] == "PRRT_other"
    assert cli[0]["is_resolved"] is None
    assert "replies" not in cli[0]
    assert cli[0]["status"] == "pending"


# ---------------------------------------------------------------------------
# 3. Fallback matching when thread_id is None
# ---------------------------------------------------------------------------


def test_reconcile_null_thread_id_matches_by_title_and_inherits_all_fields() -> None:
    """CLI finding with thread_id=None, path='', line=None matches real Qodo HTML body by title."""
    reply = {"author": "myakove", "body": "Its ok, I approve it", "created_at": "2026-11-20T11:00:00Z"}
    cli = [
        _cli_finding(
            thread_id=None,
            path="",
            line=None,
            end_line=None,
            comment_id=None,
            title="Generated reference text is edited directly",
            body="**Generated reference text is edited directly**\n\nDesc.",
        )
    ]
    twin = _gh_qodo_twin(
        thread_id="PRRT_fallback_1",
        node_id="PRRC_fallback_1",
        comment_id=5555,
        path="docs/llms-full.txt",
        line=12,
        end_line=15,
        body=(
            '<img src="https://img.shields.io/badge/High-634FD1?style=flat-square" '
            'height="20px" alt="Action required">\n\n'
            "3\\. Generated reference text is edited directly "
            "<code>\U0001f4d8 Rule violation</code> <code>\u2699 Maintainability</code>\n\n"
            "<pre><b><i>docs/llms-full.txt</i></b> adds documentation content directly.</pre>"
        ),
        is_resolved=True,
        resolved_by="myakove",
        replies=[reply],
    )

    _reconcile_cli_threads_with_github(cli, [twin])

    t = cli[0]
    assert t["thread_id"] == "PRRT_fallback_1"
    assert t["node_id"] == "PRRC_fallback_1"
    assert t["comment_id"] == 5555
    assert t["path"] == "docs/llms-full.txt"
    assert t["line"] == 12
    assert t["end_line"] == 15
    assert t["replies"] == [reply]
    assert t["is_resolved"] is True
    assert t["resolved_by"] == "myakove"
    assert t["status"] == "skipped"
    assert t["is_auto_skipped"] is True
    assert t["skip_reason"] == "Resolved on GitHub by myakove"


def test_reconcile_null_thread_id_matches_short_title_and_html_entities() -> None:
    """Short (<15 char) titles and HTML entities / markdown pipes match cleanly."""
    cli = [
        _cli_finding(
            thread_id=None,
            path="",
            line=None,
            title="Check a|b & c",
            body="**Check a|b & c**\n\nShort title.",
        )
    ]
    twin = _gh_qodo_twin(
        thread_id="PRRT_short",
        path="src/short.py",
        line=8,
        body=(
            '<img src="https://img.shields.io/badge/Med" alt="Medium">\n\n'
            "**Check a|b &amp; c**\n\n"
            "This is a much longer explanation line that exceeds fifteen characters."
        ),
        is_resolved=True,
        resolved_by="alice",
        replies=[{"author": "alice", "body": "Intentional", "created_at": "2026-11-20T12:00:00Z"}],
    )

    _reconcile_cli_threads_with_github(cli, [twin])

    assert cli[0]["thread_id"] == "PRRT_short"
    assert cli[0]["is_resolved"] is True
    assert cli[0]["resolved_by"] == "alice"
    assert cli[0]["replies"][0]["body"] == "Intentional"


def test_reconcile_null_thread_id_disambiguates_by_path_and_line() -> None:
    """Duplicate titles on different files/lines disambiguate using path then line."""
    cli_path = [
        _cli_finding(thread_id=None, path="src/b.py", line=None, title="Missing null check"),
    ]
    twins_path = [
        _gh_qodo_twin(thread_id="PRRT_a", path="src/a.py", line=10, is_resolved=False),
        _gh_qodo_twin(thread_id="PRRT_b", path="src/b.py", line=20, is_resolved=True, resolved_by="bob"),
    ]
    _reconcile_cli_threads_with_github(cli_path, twins_path)
    assert cli_path[0]["thread_id"] == "PRRT_b"
    assert cli_path[0]["is_resolved"] is True
    assert cli_path[0]["resolved_by"] == "bob"

    cli_line = [
        _cli_finding(thread_id=None, path="src/a.py", line=99, title="Missing null check"),
    ]
    twins_line = [
        _gh_qodo_twin(thread_id="PRRT_l10", path="src/a.py", line=10, is_resolved=False),
        _gh_qodo_twin(thread_id="PRRT_l99", path="src/a.py", line=99, is_resolved=True, resolved_by="carol"),
    ]
    _reconcile_cli_threads_with_github(cli_line, twins_line)
    assert cli_line[0]["thread_id"] == "PRRT_l99"
    assert cli_line[0]["resolved_by"] == "carol"


def test_reconcile_null_thread_id_skips_ambiguous_twins() -> None:
    """Ambiguous fallback with two identical-title twins and no path/line must not guess."""
    cli = [_cli_finding(thread_id=None, comment_id=None, path="", line=None, title="Missing null check")]
    twins = [
        _gh_qodo_twin(thread_id="PRRT_1", path="src/a.py", line=10, is_resolved=True, resolved_by="alice"),
        _gh_qodo_twin(thread_id="PRRT_2", path="src/b.py", line=20, is_resolved=False),
    ]

    _reconcile_cli_threads_with_github(cli, twins)

    assert cli[0]["thread_id"] is None
    assert cli[0]["is_resolved"] is None
    assert cli[0]["status"] == "pending"


def test_reconcile_two_pass_exact_id_claims_twin_before_fallback() -> None:
    """Pass 1 exact thread_id match claims its twin so pass 2 matches the remaining twin."""
    cli = [
        _cli_finding(thread_id=None, comment_id=None, path="", line=None, title="Missing null check"),
        _cli_finding(thread_id="PRRT_1", path="src/a.py", line=10, title="Missing null check"),
    ]
    twins = [
        _gh_qodo_twin(thread_id="PRRT_1", path="src/a.py", line=10, is_resolved=False),
        _gh_qodo_twin(
            thread_id="PRRT_2",
            path="src/b.py",
            line=20,
            is_resolved=True,
            resolved_by="myakove",
            replies=[{"author": "myakove", "body": "Approved", "created_at": "2026-11-20T12:00:00Z"}],
        ),
    ]

    _reconcile_cli_threads_with_github(cli, twins)

    assert cli[1]["thread_id"] == "PRRT_1"
    assert cli[1]["is_resolved"] is False
    assert cli[0]["thread_id"] == "PRRT_2"
    assert cli[0]["is_resolved"] is True
    assert cli[0]["resolved_by"] == "myakove"


def test_reconcile_null_thread_id_matches_by_comment_id() -> None:
    """When thread_id is None, a unique comment_id matches even if title differs."""
    cli = [_cli_finding(thread_id=None, comment_id=7777, path="", line=None, title="Different CLI title")]
    twin = _gh_qodo_twin(
        thread_id="PRRT_by_cid",
        comment_id=7777,
        body="Unrelated raw body",
        is_resolved=True,
        resolved_by="dana",
        replies=[{"author": "dana", "body": "LGTM", "created_at": "2026-11-20T12:00:00Z"}],
    )

    _reconcile_cli_threads_with_github(cli, [twin])

    assert cli[0]["thread_id"] == "PRRT_by_cid"
    assert cli[0]["is_resolved"] is True
    assert cli[0]["resolved_by"] == "dana"
    assert cli[0]["replies"][0]["body"] == "LGTM"


# ---------------------------------------------------------------------------
# 4. End-to-end fetch.run() + reviews.db compatibility
# ---------------------------------------------------------------------------


def _run_fetch_scenario(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    cli_threads: list[dict[str, Any]],
    graphql_nodes: list[dict[str, Any]],
    include_resolved: bool = False,
) -> dict[str, Any]:
    cli_state = {
        "source": "qodo-cli",
        "status": "completed",
        "reviewing": False,
        "approved": False,
        "head_sha": HEAD_SHA,
        "unresolved_count": len(cli_threads),
    }
    graphql_response = {
        "data": {
            "repository": {
                "pullRequest": {
                    "reviewThreads": {
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                        "nodes": graphql_nodes,
                    }
                }
            }
        }
    }

    monkeypatch.setattr(fetch_mod, "check_dependencies", lambda: None)
    monkeypatch.setattr(fetch_mod, "get_pr_info", lambda pr_url="": ("org", "repo", "42"))  # noqa: ARG005
    monkeypatch.setattr(fetch_mod, "run_gh_graphql", lambda _q, _v: graphql_response)
    monkeypatch.setattr(fetch_mod, "fetch_qodo_cli_threads", lambda _u, _h: (cli_threads, cli_state))
    monkeypatch.setattr(fetch_mod, "fetch_coderabbit_body_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_qodo_reply_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(
        fetch_mod,
        "run_gh_api",
        lambda endpoint, paginate=False: (  # noqa: ARG005
            {"user": {"login": "myakove"}, "head": {"sha": HEAD_SHA}} if "/pulls/" in endpoint else []
        ),
    )

    result = fetch_mod.run(PR_URL, include_resolved=include_resolved, output_dir=str(tmp_path))
    assert isinstance(result, dict)
    return result


def test_fetch_run_reconciles_resolved_and_replied_qodo_threads_when_include_resolved_false(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """End-to-end #1225: default include_resolved=False still reconciles resolved Qodo threads."""
    cli_threads = [
        _cli_finding(
            thread_id=None,
            path="",
            line=None,
            end_line=None,
            title="Missing null check",
            body="**Missing null check**\n\nCan raise on None.",
        ),
        _cli_finding(
            thread_id="PRRT_open_replied",
            path="src/open.py",
            line=25,
            title="Handle empty list",
            body="**Handle empty list**\n\nMay index error.",
        ),
    ]
    graphql_nodes = [
        # Resolved Qodo thread matching CLI finding #1 (thread_id=None on CLI)
        {
            "id": "PRRT_resolved_qodo",
            "isResolved": True,
            "resolvedBy": {"login": "myakove"},
            "comments": {
                "nodes": [
                    {
                        "id": "PRRC_rq_1",
                        "databaseId": 2001,
                        "author": {"login": "qodo-code-review[bot]"},
                        "path": "src/app.py",
                        "line": 42,
                        "body": (
                            '<img src="https://img.shields.io/badge/High" alt="High">\n\n'
                            "1\\. Missing null check <code>\U0001f41e Bug</code>\n\n<pre>Details</pre>"
                        ),
                        "createdAt": "2026-11-20T10:00:00Z",
                    },
                    {
                        "id": "PRRC_rq_2",
                        "databaseId": 2002,
                        "author": {"login": "myakove"},
                        "path": "src/app.py",
                        "line": 42,
                        "body": "Its ok, I approve it",
                        "createdAt": "2026-11-20T10:30:00Z",
                    },
                ]
            },
        },
        # Unresolved Qodo thread with human reply matching CLI finding #2
        {
            "id": "PRRT_open_replied",
            "isResolved": False,
            "resolvedBy": None,
            "comments": {
                "nodes": [
                    {
                        "id": "PRRC_oq_1",
                        "databaseId": 2003,
                        "author": {"login": "qodo-code-review[bot]"},
                        "path": "src/open.py",
                        "line": 25,
                        "body": "**Handle empty list**\n\nMay index error.",
                        "createdAt": "2026-11-20T10:00:00Z",
                    },
                    {
                        "id": "PRRC_oq_2",
                        "databaseId": 2004,
                        "author": {"login": "myakove"},
                        "path": "src/open.py",
                        "line": 25,
                        "body": "Please also add a regression test",
                        "createdAt": "2026-11-20T10:45:00Z",
                    },
                ]
            },
        },
        # Resolved human thread — must stay hidden when include_resolved=False
        {
            "id": "PRRT_human_resolved",
            "isResolved": True,
            "resolvedBy": {"login": "reviewer"},
            "comments": {
                "nodes": [
                    {
                        "id": "PRRC_hr_1",
                        "databaseId": 2005,
                        "author": {"login": "reviewer"},
                        "path": "src/h.py",
                        "line": 5,
                        "body": "Resolved human nit",
                        "createdAt": "2026-11-20T09:00:00Z",
                    }
                ]
            },
        },
        # Unresolved human thread — must remain visible
        {
            "id": "PRRT_human_open",
            "isResolved": False,
            "resolvedBy": None,
            "comments": {
                "nodes": [
                    {
                        "id": "PRRC_ho_1",
                        "databaseId": 2006,
                        "author": {"login": "reviewer"},
                        "path": "src/h.py",
                        "line": 9,
                        "body": "Open human comment",
                        "createdAt": "2026-11-20T09:15:00Z",
                    }
                ]
            },
        },
    ]

    result = _run_fetch_scenario(
        monkeypatch,
        tmp_path,
        cli_threads=cli_threads,
        graphql_nodes=graphql_nodes,
        include_resolved=False,
    )

    # Human threads respect include_resolved=False
    assert [t["thread_id"] for t in result["human"]] == ["PRRT_human_open"]

    # Qodo findings appear once each (GitHub twins deduped)
    assert len(result["qodo"]) == 2
    by_id = {t["thread_id"]: t for t in result["qodo"]}
    assert set(by_id) == {"PRRT_resolved_qodo", "PRRT_open_replied"}

    resolved_qodo = by_id["PRRT_resolved_qodo"]
    assert resolved_qodo["path"] == "src/app.py"
    assert resolved_qodo["line"] == 42
    assert resolved_qodo["is_resolved"] is True
    assert resolved_qodo["resolved_by"] == "myakove"
    assert resolved_qodo["status"] == "skipped"
    assert resolved_qodo["is_auto_skipped"] is True
    assert resolved_qodo["skip_reason"] == "Resolved on GitHub by myakove"
    assert resolved_qodo["replies"] == [
        {"author": "myakove", "body": "Its ok, I approve it", "created_at": "2026-11-20T10:30:00Z"}
    ]

    open_qodo = by_id["PRRT_open_replied"]
    assert open_qodo["is_resolved"] is False
    assert open_qodo["resolved_by"] is None
    assert open_qodo["status"] == "pending"
    assert not open_qodo.get("is_auto_skipped")
    assert open_qodo["replies"] == [
        {"author": "myakove", "body": "Please also add a regression test", "created_at": "2026-11-20T10:45:00Z"}
    ]

    # Verify JSON written to disk stores cleanly into reviews.db without breaking distillation schema
    json_path = Path(result["metadata"]["json_path"])
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert len(saved["qodo"]) == 2

    monkeypatch.setattr(store_mod, "get_project_root", lambda: tmp_path)
    monkeypatch.setattr(store_mod, "get_current_commit_sha", lambda cwd=None: HEAD_SHA)  # noqa: ARG005
    store_mod.store_reviews(json_path)

    db_path = tmp_path / ".pi" / "data" / "reviews.db"
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute("SELECT source, thread_id, status, skip_reason, title FROM comments ORDER BY id").fetchall()
    finally:
        conn.close()

    qodo_rows = {r[1]: r for r in rows if r[0] == "qodo"}
    assert qodo_rows["PRRT_resolved_qodo"] == (
        "qodo",
        "PRRT_resolved_qodo",
        "skipped",
        "Resolved on GitHub by myakove",
        "Missing null check",
    )
    assert qodo_rows["PRRT_open_replied"] == (
        "qodo",
        "PRRT_open_replied",
        "pending",
        None,
        "Handle empty list",
    )


def test_fetch_run_include_resolved_true_dedups_fallback_matched_qodo_twin(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """With include_resolved=True, resolved human threads appear while matched Qodo twins dedup."""
    cli_threads = [
        _cli_finding(
            thread_id=None,
            path="",
            line=None,
            title="Missing null check",
            body="**Missing null check**\n\nCan raise on None.",
        )
    ]
    graphql_nodes = [
        {
            "id": "PRRT_resolved_qodo",
            "isResolved": True,
            "resolvedBy": {"login": "myakove"},
            "comments": {
                "nodes": [
                    {
                        "id": "PRRC_rq_1",
                        "databaseId": 2001,
                        "author": {"login": "qodo-code-review[bot]"},
                        "path": "src/app.py",
                        "line": 42,
                        "body": "**Missing null check**\n\nCan raise on None.",
                        "createdAt": "2026-11-20T10:00:00Z",
                    },
                    {
                        "id": "PRRC_rq_2",
                        "databaseId": 2002,
                        "author": {"login": "myakove"},
                        "path": "src/app.py",
                        "line": 42,
                        "body": "Approved",
                        "createdAt": "2026-11-20T10:30:00Z",
                    },
                ]
            },
        },
        {
            "id": "PRRT_human_resolved",
            "isResolved": True,
            "resolvedBy": {"login": "reviewer"},
            "comments": {
                "nodes": [
                    {
                        "id": "PRRC_hr_1",
                        "databaseId": 2005,
                        "author": {"login": "reviewer"},
                        "path": "src/h.py",
                        "line": 5,
                        "body": "Resolved human nit",
                        "createdAt": "2026-11-20T09:00:00Z",
                    }
                ]
            },
        },
    ]

    result = _run_fetch_scenario(
        monkeypatch,
        tmp_path,
        cli_threads=cli_threads,
        graphql_nodes=graphql_nodes,
        include_resolved=True,
    )

    assert [t["thread_id"] for t in result["human"]] == ["PRRT_human_resolved"]
    assert result["human"][0]["resolved_by"] == "reviewer"
    assert len(result["qodo"]) == 1
    assert result["qodo"][0]["thread_id"] == "PRRT_resolved_qodo"
    assert result["qodo"][0]["qodo_cli"] is True
    assert result["qodo"][0]["is_resolved"] is True
    assert result["qodo"][0]["resolved_by"] == "myakove"
    assert result["qodo"][0]["replies"][0]["body"] == "Approved"
