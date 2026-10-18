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

        comment_count = conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0]
        assert comment_count == 3, "one comment row per finding"
    finally:
        conn.close()

    assert json_path.exists(), "the session JSON is the loop's record — never deleted"


def test_comment_row_mapping_from_finding(project_root: Path) -> None:
    """A finding maps onto the comment columns with translated vocabulary."""
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
    ]
    json_path = _write_session(project_root, _session_json(findings))
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        comments = conn.execute(
            """
            SELECT c.comment_id, c.node_id, c.author, c.body, c.title, c.status, c.priority,
                   c.posted_at, c.type, c.quality_label, c.path, c.line
            FROM comments c JOIN reviews r ON c.review_id = r.id
            ORDER BY c.id
            """
        ).fetchall()
        first = comments[0]
        assert first[0] == 4282020651, "comment_id is the GitHub comment id"
        assert first[1] == "uuid-1", "node_id is the session finding UUID"
        assert first[2] == "qodo"
        assert first[3] == "Finding one\n\nDesc one", "body is title + description"
        assert first[4] == "Finding one"
        assert first[5] == "addressed", "implemented maps to the resolved vocabulary"
        assert first[6] == "HIGH", "action_required maps to HIGH priority"
        assert first[7] == "2026-02-01T10:00:00+00:00"
        assert first[8] == "session_finding"
        assert first[9] == "Correctness", "quality_label from category"
        assert first[10] is None and first[11] is None
        dismissed = comments[1]
        assert dismissed[5] == "skipped", "dismissed maps to the resolved vocabulary"
        assert dismissed[6] == "LOW", "informational maps to LOW priority"
    finally:
        conn.close()


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


def test_later_round_on_new_commit_stores_only_the_new_group(project_root: Path) -> None:
    """A later round on the same PR (new commit) stores only the new group."""
    findings = [
        _finding("uuid-1", "Finding one", "Desc one", "sha-aaa", "2026-02-01T10:00:00+00:00"),
    ]
    json_path = _write_session(project_root, _session_json(findings))
    store_session.run(str(json_path))

    round2 = _session_json([_finding("uuid-4", "Finding four", "Desc four", "sha-ccc", "2026-02-03T10:00:00+00:00")])
    json_path.write_text(json.dumps(round2), encoding="utf-8")
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        shas = {row[0] for row in conn.execute("SELECT commit_sha FROM reviews").fetchall()}
        assert shas == {"sha-aaa", "sha-ccc"}
        assert conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 2
    finally:
        conn.close()


def test_later_import_appends_to_the_same_review_row(project_root: Path) -> None:
    """A later import adding a finding for an imported commit reuses its session review row."""
    json_path = _write_session(
        project_root,
        _session_json([_finding("uuid-1", "Finding one", "Desc one", "sha-aaa", "2026-02-01T10:00:00+00:00")]),
    )
    store_session.run(str(json_path))

    later = _session_json([
        _finding("uuid-1", "Finding one", "Desc one", "sha-aaa", "2026-02-01T10:00:00+00:00"),
        _finding("uuid-2", "Finding two", "Desc two", "sha-aaa", "2026-02-01T11:00:00+00:00"),
    ])
    json_path.write_text(json.dumps(later), encoding="utf-8")
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        assert conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 1, "one row per round, not per import"
        assert conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 2
    finally:
        conn.close()


def test_cli_store_session_command_dispatches(project_root: Path) -> None:
    """The reviews store-session CLI wrapper dispatches to the store (Qodo 9e0b43e9)."""
    from click.testing import CliRunner

    from myk_pi_tools.reviews.commands import reviews

    json_path = _write_session(
        project_root,
        _session_json([_finding("uuid-1", "CLI finding", "Desc", "sha-aaa", "2026-02-01T10:00:00+00:00")]),
    )
    result = CliRunner().invoke(reviews, ["store-session", str(json_path)])
    assert result.exit_code == 0, result.output

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        assert conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 1
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


def test_session_findings_stored_alongside_ordinary_rows(project_root: Path) -> None:
    """A review row from the ordinary store path must not hide session findings."""
    db = _db_path(project_root)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    try:
        from myk_pi_tools.reviews.store import create_tables

        create_tables(conn)
        conn.execute(
            "INSERT INTO reviews (owner, repo, pr_number, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)",
            ("myk-org", "pi-config", 939, "sha-aaa", "2026-02-01T08:00:00+00:00"),
        )
        ordinary_review_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            """INSERT INTO comments
               (review_id, source, comment_id, author, body, status, type)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (ordinary_review_id, "qodo", 111, "qodo", "ordinary comment", "pending", "issue_comment"),
        )
        conn.commit()
    finally:
        conn.close()

    findings = [_finding("uuid-1", "Finding one", "Desc one", "sha-aaa", "2026-02-01T10:00:00+00:00")]
    json_path = _write_session(project_root, _session_json(findings))
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(db))
    try:
        assert conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 2, "session row appended, not skipped"
        rows = conn.execute("SELECT type, node_id FROM comments ORDER BY id").fetchall()
        assert [r[0] for r in rows] == ["issue_comment", "session_finding"]
        assert rows[1][1] == "uuid-1"
    finally:
        conn.close()


def test_status_report_renders_session_findings(project_root: Path, tmp_path: Path) -> None:
    """reviews status must render stored session findings into the HTML report."""
    findings = [
        _finding("uuid-1", "Rendered finding title", "Desc one", "sha-aaa", "2026-02-01T10:00:00+00:00"),
    ]
    json_path = _write_session(project_root, _session_json(findings))
    store_session.run(str(json_path))

    output_dir = tmp_path / "report"
    output_dir.mkdir()
    import myk_pi_tools.reviews.status as status_mod
    from myk_pi_tools.reviews.status import run as status_run

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(status_mod, "get_project_root", lambda: project_root)
    try:
        status_run(pr_number=939, output_dir=str(output_dir))
    finally:
        monkeypatch.undo()

    html_path = output_dir / "review-status-939.html"
    assert html_path.exists(), "HTML report generated for a session-reviewed PR"
    html = html_path.read_text(encoding="utf-8")
    assert "Rendered finding title" in html, "session finding appears in the report"


def test_later_poll_refreshes_stored_finding_status(project_root: Path) -> None:
    """A finding stored as pending reflects its later attribution (Qodo 7be4f7fc)."""
    finding = _finding(
        "uuid-1",
        "Finding one",
        "Desc one",
        "sha-aaa",
        "2026-02-01T10:00:00+00:00",
        attribution_status="pending",
    )
    json_path = _write_session(project_root, _session_json([finding]))
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        assert conn.execute("SELECT status FROM comments").fetchone()[0] == "pending"
    finally:
        conn.close()

    finding["attribution_status"] = "implemented"
    json_path.write_text(json.dumps(_session_json([finding])), encoding="utf-8")
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        assert conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 1, "no duplicate row"
        assert conn.execute("SELECT status FROM comments").fetchone()[0] == "addressed"
    finally:
        conn.close()


def test_finding_without_id_is_skipped_not_duplicated(project_root: Path) -> None:
    """A finding without an id is untrackable — skipped, never duplicated (Qodo a16004a7)."""
    finding = _finding("uuid-1", "Finding one", "Desc one", "sha-aaa", "2026-02-01T10:00:00+00:00")
    no_id = dict(finding)
    no_id.pop("id")
    json_path = _write_session(project_root, _session_json([no_id]))
    store_session.run(str(json_path))
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        assert conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0] == 0, "untrackable finding never stored"
        assert conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 0
    finally:
        conn.close()


def test_insert_review_logs_at_debug_level(project_root: Path, caplog: pytest.LogCaptureFixture) -> None:
    """insert_review leaves an execution record in the logs (Qodo 2f94f554)."""
    import logging

    from myk_pi_tools.reviews.store import insert_review

    db = _db_path(project_root)
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db))
    try:
        from myk_pi_tools.reviews.store import create_tables

        create_tables(conn)
        with caplog.at_level(logging.DEBUG, logger="myk_pi_tools.reviews.store"):
            insert_review(conn, "myk-org", "pi-config", 943, "sha-xyz", created_at="2026-02-01T10:00:00+00:00")
        assert any("insert_review" in record.message for record in caplog.records)
    finally:
        conn.close()


def test_refresh_updates_priority_when_status_unchanged(project_root: Path) -> None:
    """A later poll that changes only action_level refreshes priority (Qodo 42c7b5c1).

    The refresh guard is (status != ? OR priority != ?) — a status-only guard
    left action_level-only changes stale in the DB.
    """
    first = _session_json([
        _finding(
            "uuid-prio",
            "Priority drift",
            "Desc",
            "sha-prio",
            "2026-02-01T10:00:00+00:00",
            action_level="informational",
            attribution_status="pending",
        )
    ])
    json_path = _write_session(project_root, first)
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        row = conn.execute("SELECT status, priority FROM comments WHERE node_id = 'uuid-prio'").fetchone()
        assert row == ("pending", "LOW")
    finally:
        conn.close()

    # Same status, escalated action_level — priority must follow.
    second = _session_json([
        _finding(
            "uuid-prio",
            "Priority drift",
            "Desc",
            "sha-prio",
            "2026-02-01T10:00:00+00:00",
            action_level="action_required",
            attribution_status="pending",
        )
    ])
    json_path = _write_session(project_root, second)
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        rows = conn.execute("SELECT status, priority FROM comments WHERE node_id = 'uuid-prio'").fetchall()
        assert rows == [("pending", "HIGH")], "priority refreshed even when status is unchanged"
    finally:
        conn.close()


def test_stores_path_and_line_from_inline_comment(project_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Path/line are recovered from the inline GitHub comment (Qodo aab6f6a7).

    Session findings carry no file location; the inline comment does. Without
    the lookup every session row stores path=None and never resurfaces in
    write-time review-learning injection (which filters on path IS NOT NULL).
    """
    monkeypatch.setattr(store_session, "_inline_location", lambda _owner, _repo, _iid: ("src/api.py", 42))
    findings = [
        _finding("uuid-inline", "Inline finding", "Desc", "sha-inl", "2026-02-01T10:00:00+00:00"),
    ]
    json_path = _write_session(project_root, _session_json(findings))
    store_session.run(str(json_path))

    conn = sqlite3.connect(str(_db_path(project_root)))
    try:
        row = conn.execute("SELECT path, line FROM comments WHERE node_id = 'uuid-inline'").fetchone()
        assert row == ("src/api.py", 42), "inline comment location stored on the row"
    finally:
        conn.close()


def test_inline_location_skips_non_string_ids() -> None:
    """A non-string inline_comment_id (old JSON shapes) never shells out."""
    assert store_session._inline_location("myk-org", "pi-config", 4282020651) == (None, None)
    assert store_session._inline_location("myk-org", "pi-config", None) == (None, None)
