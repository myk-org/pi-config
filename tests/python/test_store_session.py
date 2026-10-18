"""Tests for reviews store-session: Qodo pr-review-session findings to DB.

The session JSON is the loop's authoritative record — it must never be
deleted by the store, and re-running must not duplicate rows.
"""

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from myk_pi_tools.reviews import store_session


def _finding(
    finding_id: str,
    title: str,
    description: str,
    git_sha: str,
    created_at: str,
    action_level: str = "action_required",
    attribution_status: str = "implemented",
) -> dict[str, Any]:
    """A session finding with the real pr-review-session JSON shape."""
    return {
        "id": finding_id,
        "title": title,
        "description": description,
        "category": "Correctness",
        "action_level": action_level,
        "attribution_status": attribution_status,
        "review_source": "pr-agent",
        "git_sha": git_sha,
        "finding_source": "pr_agent",
        "review_run_id": "run-1",
        "comment_id": 4282020651,
        "inline_comment_id": 4282020652,
        "created_at": created_at,
    }


def _session_json(
    findings: list[dict[str, Any]], pr_url: str = "https://github.com/myk-org/pi-config/pull/939"
) -> dict[str, Any]:
    return {
        "pr_url": pr_url,
        "git_provider": "github",
        "review_session": {"id": "session-1"},
        "finding_count": len(findings),
        "findings": findings,
    }


def _write_session(tmp_path: Path, data: dict[str, Any]) -> Path:
    json_path = tmp_path / "session-findings.json"
    json_path.write_text(json.dumps(data), encoding="utf-8")
    return json_path


def _db_path(tmp_path: Path) -> Path:
    return tmp_path / ".pi" / "data" / "reviews.db"


@pytest.fixture()
def project_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(store_session, "get_project_root", lambda: tmp_path)
    return tmp_path


def test_stores_findings_grouped_by_commit_sha(project_root: Path) -> None:
    """Two distinct git_shas → two reviews rows, one comment row per finding."""
    findings = [
        _finding("uuid-1", "Finding one", "Desc one", "sha-aaa", "2026-02-01T10:00:00+00:00"),
        _finding(
            "uuid-2",
            "Finding two",
            "Desc two",
            "sha-aaa",
            "2026-02-01T09:00:00+00:00",
            action_level="informational",
            attribution_status="dismissed",
        ),
        _finding("uuid-3", "Finding three", "Desc three", "sha-bbb", "2026-02-02T12:00:00+00:00"),
    ]
    json_path = _write_session(project_root, _session_json(findings))

    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        reviews = conn.execute("SELECT commit_sha, created_at FROM reviews ORDER BY created_at").fetchall()
        assert [r[0] for r in reviews] == ["sha-aaa", "sha-bbb"], "one reviews row per distinct commit"
        # created_at = earliest finding created_at within the group
        assert reviews[0][1] == "2026-02-01T09:00:00+00:00"

        comments = conn.execute(
            """
            SELECT c.comment_id, c.author, c.body, c.title, c.status, c.priority,
                   c.posted_at, c.type, c.path, c.line
            FROM comments c JOIN reviews r ON c.review_id = r.id
            ORDER BY c.id
            """
        ).fetchall()
        assert len(comments) == 3
        first = comments[0]
        assert first[0] == "uuid-1", "comment_id is the finding id"
        assert first[1] == "qodo"
        assert first[2] == "Finding one\n\nDesc one", "body is title + description"
        assert first[3] == "Finding one"
        assert first[4] == "implemented", "status from attribution_status"
        assert first[5] == "action_required", "priority from action_level"
        assert first[6] == "2026-02-01T10:00:00+00:00"
        assert first[7] == "session_finding"
        assert first[8] is None and first[9] is None
        dismissed = comments[1]
        assert dismissed[4] == "dismissed"
        assert dismissed[5] == "informational"
    finally:
        conn.close()

    assert json_path.exists(), "the session JSON is the loop's record — never deleted"


def test_rerun_is_idempotent_no_duplicate_rows(project_root: Path) -> None:
    """Running store-session twice must not duplicate reviews/comments rows."""
    findings = [
        _finding("uuid-1", "Finding one", "Desc one", "sha-aaa", "2026-02-01T10:00:00+00:00"),
        _finding("uuid-3", "Finding three", "Desc three", "sha-bbb", "2026-02-02T12:00:00+00:00"),
    ]
    json_path = _write_session(project_root, _session_json(findings))

    store_session.run(str(json_path))
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        review_count = conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]
        comment_count = conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0]
        assert review_count == 2, "commit groups already stored are skipped"
        assert comment_count == 2
    finally:
        conn.close()

    # A later round on the same PR (new commit) stores only the new group.
    round2 = _session_json([_finding("uuid-4", "Finding four", "Desc four", "sha-ccc", "2026-02-03T10:00:00+00:00")])
    json_path.write_text(json.dumps(round2), encoding="utf-8")
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        shas = {row[0] for row in conn.execute("SELECT commit_sha FROM reviews").fetchall()}
        assert shas == {"sha-aaa", "sha-bbb", "sha-ccc"}
        assert conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 3
    finally:
        conn.close()


def test_invalid_pr_url_exits_with_code_1(project_root: Path) -> None:
    """A malformed pr_url exits 1 before anything is stored."""
    json_path = _write_session(project_root, _session_json([], pr_url="not-a-github-url"))

    with pytest.raises(SystemExit) as exc_info:
        store_session.run(str(json_path))
    assert exc_info.value.code == 1
    assert not _db_path(project_root).exists(), "nothing stored on invalid pr_url"


def test_empty_findings_list_stores_nothing(project_root: Path) -> None:
    """An empty findings list stores no rows, exits 0, keeps the JSON."""
    json_path = _write_session(project_root, _session_json([]))

    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        assert conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 0
    finally:
        conn.close()
    assert json_path.exists()


def test_missing_pr_url_field_exits_with_code_1(project_root: Path) -> None:
    """A session JSON without pr_url exits 1 before anything is stored."""
    json_path = _write_session(project_root, {"findings": []})

    with pytest.raises(SystemExit) as exc_info:
        store_session.run(str(json_path))
    assert exc_info.value.code == 1
