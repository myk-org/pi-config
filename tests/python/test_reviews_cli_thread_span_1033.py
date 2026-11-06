"""Regression tests for issue #1033.

Qodo's CLI `pr-review-session` payload omits `file_path`/`start_line` for findings it
closed, and `fetch` dropped the GitHub twin that still carried them. The result was a
spanless record stamped `is_auto_skipped`, so `reviews address` matched nothing and
reported "no findings matched" on a PR whose threads were still open.

The fixtures here are the two shapes that matter: a finding CLI-closed while its GitHub
thread is still open (must stay answerable), and one closed *and* resolved (must stay
skipped).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner

from myk_pi_tools.reviews.address import _is_addressable, apply_replies
from myk_pi_tools.reviews.commands import reviews
from myk_pi_tools.reviews.fetch import _reconcile_cli_threads_with_github
from myk_pi_tools.reviews.qodo_cli import map_cli_findings_to_threads


def _cli_thread(**over: Any) -> dict[str, Any]:
    """A CLI thread as `map_cli_findings_to_threads` produces it for a closed finding."""
    thread: dict[str, Any] = {
        "thread_id": "PRRT_kwDOA1",
        "node_id": None,
        "comment_id": 111,
        "author": "qodo-code-review",
        "path": "",
        "line": None,
        "end_line": None,
        "body": "**Missing null check**\n\nThis can raise.",
        "status": "skipped",
        "type": "qodo_bug",
        "priority": "HIGH",
        "reply": None,
        "qodo_cli": True,
        "attribution_status": "implemented",
        "is_resolved": False,
        "is_auto_skipped": True,
    }
    thread.update(over)
    return thread


def _github_twin(**over: Any) -> dict[str, Any]:
    """The GitHub review thread `fetch` still holds at dedup time."""
    twin: dict[str, Any] = {
        "thread_id": "PRRT_kwDOA1",
        "node_id": "PRRC_node_1",
        "comment_id": 111,
        "author": "qodo-code-review[bot]",
        "path": "src/app.py",
        "line": 42,
        "end_line": 44,
        "body": "raw html body",
        "replies": [],
        "is_resolved": False,
    }
    twin.update(over)
    return twin


# --- fetch: the span must survive the dedup that drops the twin ---


def test_reconcile_inherits_span_from_github_twin() -> None:
    cli = [_cli_thread()]
    _reconcile_cli_threads_with_github(cli, [_github_twin()])
    t = cli[0]
    assert t["path"] == "src/app.py"
    assert t["line"] == 42
    assert t["end_line"] == 44
    assert t["node_id"] == "PRRC_node_1"
    assert t["thread_id"] == "PRRT_kwDOA1"


def test_reconcile_keeps_cli_span_when_present() -> None:
    cli = [_cli_thread(path="src/other.py", line=7)]
    _reconcile_cli_threads_with_github(cli, [_github_twin()])
    assert cli[0]["path"] == "src/other.py"
    assert cli[0]["line"] == 7


def test_reconcile_reopens_closed_but_unresolved_thread() -> None:
    cli = [_cli_thread()]
    _reconcile_cli_threads_with_github(cli, [_github_twin(is_resolved=False)])
    t = cli[0]
    assert t["is_resolved"] is False
    assert t["is_auto_skipped"] is False
    assert t["status"] == "pending"
    assert _is_addressable(t) is True


def test_reconcile_inherits_resolved_state_from_twin() -> None:
    cli = [_cli_thread()]
    _reconcile_cli_threads_with_github(cli, [_github_twin(is_resolved=True)])
    assert cli[0]["is_resolved"] is True


def test_resolved_thread_stays_unaddressable() -> None:
    cli = [_cli_thread()]
    _reconcile_cli_threads_with_github(cli, [_github_twin(is_resolved=True)])
    t = cli[0]
    assert t["is_auto_skipped"] is True
    assert _is_addressable(t) is False


def test_reconcile_does_not_assert_already_replied() -> None:
    """#1033 root cause (b): closure is not a reply unless the thread shows one."""
    cli = [_cli_thread()]
    _reconcile_cli_threads_with_github(cli, [_github_twin(replies=[])])
    assert not cli[0].get("already_replied")

    with_reply = [_cli_thread()]
    _reconcile_cli_threads_with_github(with_reply, [_github_twin(replies=[{"body": "done"}])])
    assert with_reply[0]["already_replied"] is True


def test_reconcile_without_twin_leaves_thread_untouched() -> None:
    cli = [_cli_thread(thread_id="PRRT_missing")]
    _reconcile_cli_threads_with_github(cli, [_github_twin()])
    assert cli[0]["path"] == ""
    assert cli[0]["is_auto_skipped"] is True


# --- the CLI mapper must not claim a reply it cannot see ---


@pytest.mark.parametrize("status", ["full_implementation", "dismissed", "detected_after_merge", "outdated"])
def test_closed_cli_finding_is_not_marked_replied(status: str) -> None:
    data = {
        "review_session": {},
        "findings": [
            {
                "id": "uuid-1",
                "title": "Missing null check",
                "description": "d",
                "category": "Correctness",
                "attribution_status": status,
                "inline_comment_id": "gh1:PRRT_kwDOA1:222",
            }
        ],
    }
    t = map_cli_findings_to_threads(data)[0]
    assert t["is_auto_skipped"] is True
    assert t["status"] == "skipped"
    assert not t.get("already_replied")
    assert t.get("reply") is None
    # The field is present on every thread but None = unknown (Qodo finding on #1034):
    # a False placeholder made resolved threads look open and got them replied to.
    assert t["is_resolved"] is None


# --- is_resolved round-trip: counting open threads matches GitHub ---


def test_is_resolved_round_trip_counts_open_not_resolved() -> None:
    """7 open twins + 1 resolved twin → `not is_resolved` must yield 7, not 8."""
    cli = []
    twins = []
    for i in range(8):
        thread_id = f"PRRT_{i}"
        cli.append(_cli_thread(thread_id=thread_id))
        twins.append(_github_twin(thread_id=thread_id, is_resolved=i == 0))
    _reconcile_cli_threads_with_github(cli, twins)
    assert len([t for t in cli if not t["is_resolved"]]) == 7


# --- informational items keep their skip even under the new fallback ---


def test_informational_entry_stays_unaddressable() -> None:
    entry = _cli_thread(type="qodo_reply", path="src/app.py", line=42, is_auto_skipped=True)
    assert _is_addressable(entry) is False


def test_auto_skipped_without_span_stays_unaddressable() -> None:
    assert _is_addressable(_cli_thread()) is False


# --- address: the headline assertion (1 reply posted, 1 thread resolved) ---


def _patch_post_store(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Replace post.run/store.run with recorders; post must be called with replies to post."""
    calls: list[tuple[str, str]] = []

    def fake_post(path: str) -> int:
        """Real post.run posts the reply, then stamps posted_at/resolved_at."""
        calls.append(("post", path))
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        addressed = [e for e in data.get("qodo", []) if e.get("reply") and e.get("status") == "addressed"]
        assert addressed, "address called post with nothing addressed"
        assert len(addressed) == 1
        for entry in addressed:
            entry["posted_at"] = "2026-11-06T00:00:00Z"
            entry["resolved_at"] = "2026-11-06T00:00:00Z"
        Path(path).write_text(json.dumps(data), encoding="utf-8")
        return 0

    def fake_store(path: str) -> int:
        calls.append(("store", path))
        return 0

    monkeypatch.setattr("myk_pi_tools.reviews.post.run", fake_post)
    monkeypatch.setattr("myk_pi_tools.reviews.store.run", fake_store)
    return calls


def test_address_posts_one_reply_for_closed_but_open_thread(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """#1033 headline: previously zero replies and zero resolves."""
    _patch_post_store(monkeypatch)
    thread = _cli_thread()
    _reconcile_cli_threads_with_github([thread], [_github_twin(is_resolved=False)])
    assert _is_addressable(thread) is True

    reviews_json = tmp_path / "pr-42-reviews.json"
    reviews_json.write_text(
        json.dumps({"metadata": {"owner": "o", "repo": "r", "pr_number": 42}, "qodo": [thread]}),
        encoding="utf-8",
    )
    replies = tmp_path / "replies.json"
    replies.write_text("src/app.py:42|Fixed in the next commit.\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(reviews_json), "--replies", str(replies)])
    assert result.exit_code == 0, result.output
    saved = json.loads(reviews_json.read_text(encoding="utf-8"))
    assert saved["qodo"][0]["reply"] == "Fixed in the next commit."
    assert saved["qodo"][0]["status"] == "addressed"
    # one reply posted, and the thread resolved
    assert saved["qodo"][0]["posted_at"]
    assert saved["qodo"][0]["resolved_at"]


def test_apply_replies_matches_inherited_span() -> None:
    """The reply rule lands on the inherited path:line, not on an empty span."""
    thread = _cli_thread()
    _reconcile_cli_threads_with_github([thread], [_github_twin(is_resolved=False)])
    data: dict[str, Any] = {"metadata": {}, "qodo": [thread]}
    groups = apply_replies(data, [{"path": "src/app.py", "line": 42, "reply": "ok"}], "addressed")
    assert len(groups) == 1
    assert data["qodo"][0]["reply"] == "ok"


def test_address_cli_warns_when_findings_are_stranded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A spanless-but-open thread must not fail without naming the count."""
    _patch_post_store(monkeypatch)
    stranded = _cli_thread()  # spanless, auto-skipped, still open on GitHub
    reviews_json = tmp_path / "pr-42-reviews.json"
    reviews_json.write_text(
        json.dumps({"metadata": {"owner": "o", "repo": "r", "pr_number": 42}, "qodo": [stranded]}),
        encoding="utf-8",
    )
    replies = tmp_path / "replies.json"
    replies.write_text("*|Acknowledged.\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(reviews_json), "--replies", str(replies)])
    assert result.exit_code != 0, "a stranded finding must not exit 0"
    assert "still open" in result.output


def test_already_replied_entry_is_not_addressable() -> None:
    """A reconciled entry with an existing reply must not receive a second one."""
    entry = _cli_thread(path="src/app.py", line=42, is_auto_skipped=True, is_resolved=False)
    entry["already_replied"] = True
    assert _is_addressable(entry) is False


def test_skipped_with_reason_is_not_addressable() -> None:
    """`auto_skip_replied_findings` marks skip_reason; that decision must survive."""
    entry = _cli_thread(path="src/app.py", line=42, is_auto_skipped=True, is_resolved=False)
    entry["skip_reason"] = "Already replied, Qodo did not push back"
    assert _is_addressable(entry) is False


def test_unknown_resolution_is_not_addressable() -> None:
    """None means fetch could not see the twin — never treat that as open."""
    entry = _cli_thread(path="src/app.py", line=42, is_auto_skipped=True, is_resolved=None)
    assert _is_addressable(entry) is False


def test_stranded_warning_fires_on_partial_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Qodo finding on #1034: the warning was confined to the all-stranded path."""
    _patch_post_store(monkeypatch)
    matched = _cli_thread(path="src/app.py", line=42, is_auto_skipped=False, is_resolved=False)
    stranded = _cli_thread(thread_id="PRRT_stranded", path="", line=None, is_auto_skipped=True, is_resolved=False)
    reviews_json = tmp_path / "pr-42-reviews.json"
    reviews_json.write_text(
        json.dumps({"metadata": {"owner": "o", "repo": "r", "pr_number": 42}, "qodo": [matched, stranded]}),
        encoding="utf-8",
    )
    replies = tmp_path / "replies.json"
    replies.write_text("src/app.py:42|Fixed.\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(reviews_json), "--replies", str(replies)])
    # The matched finding is still addressed, and the stranded one is named.
    assert "still open" in result.output
    saved = json.loads(reviews_json.read_text(encoding="utf-8"))
    assert saved["qodo"][0]["reply"] == "Fixed."


def test_informational_entries_are_not_counted_as_stranded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`qodo_reply` items are informational, not dropped findings."""
    _patch_post_store(monkeypatch)
    info = _cli_thread(type="qodo_reply", path="", line=None, is_auto_skipped=True, is_resolved=False)
    reviews_json = tmp_path / "pr-42-reviews.json"
    reviews_json.write_text(
        json.dumps({"metadata": {"owner": "o", "repo": "r", "pr_number": 42}, "qodo": [info]}),
        encoding="utf-8",
    )
    replies = tmp_path / "replies.json"
    replies.write_text("*|Acknowledged.\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(reviews_json), "--replies", str(replies)])
    assert "still open" not in result.output
