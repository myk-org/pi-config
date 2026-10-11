"""Tests for the reviews address subcommand."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner

from myk_pi_tools.reviews.address import (
    RepliesFileError,
    apply_replies,
    find_default_json,
    format_digest_line,
    parse_replies_file,
)
from myk_pi_tools.reviews.commands import reviews


def _entry(
    path: str = "src/a.py", line: int = 10, body: str = "Fix the loop boundary in parser", **kw: Any
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "thread_id": "T1",
        "path": path,
        "line": line,
        "body": body,
        "status": "pending",
        "reply": "",
        "type": "qodo_bug",
        "priority": "HIGH",
    }
    entry.update(kw)
    return entry


def _sample_data() -> dict[str, Any]:
    return {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            # Thread + sticky pair for the same finding (fetch emits both)
            _entry(thread_id="T1"),
            _entry(thread_id=None),
            _entry(path="src/b.py", line=3, body="Unused import os", type="qodo_finding", priority="LOW"),
            _entry(path="src/c.py", line=5, body="Old finding", is_auto_skipped=True),
        ],
        "coderabbit": [
            _entry(path="src/d.py", line=7, body="Nit: rename variable", thread_id="T9", type=None),
        ],
    }


def _write_reviews_json(directory: Path, data: dict[str, Any], name: str = "pr-42-reviews.json") -> Path:
    path = directory / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def _patch_post_store(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Replace post.run/store.run with recorders; return the call log."""
    calls: list[tuple[str, str]] = []

    def fake_post(path: str) -> None:
        calls.append(("post", path))

    def fake_store(path: str) -> None:
        calls.append(("store", path))

    monkeypatch.setattr("myk_pi_tools.reviews.post.run", fake_post)
    monkeypatch.setattr("myk_pi_tools.reviews.store.run", fake_store)
    return calls


# ---------------------------------------------------------------------------
# parse_replies_file
# ---------------------------------------------------------------------------


def test_parse_replies_file(tmp_path: Path) -> None:
    """Valid lines, comments and blank lines parse into rules."""
    f = tmp_path / "replies.txt"
    f.write_text(
        "# comment\n\nsrc/a.py:10|Fixed the boundary in abc1234\n*|All findings fixed in def5678\n",
        encoding="utf-8",
    )
    rules = parse_replies_file(f)
    assert rules == [
        {"path": "src/a.py", "line": 10, "reply": "Fixed the boundary in abc1234"},
        {"path": None, "line": None, "reply": "All findings fixed in def5678"},
    ]


@pytest.mark.parametrize(
    "line",
    [
        "src/a.py|no line separator style",  # missing :<line>
        "src/a.py:ten|bad line number",  # non-integer line
        "src/a.py:10|",  # empty reply
        "no pipe at all",
        ":10|missing path",
    ],
)
def test_parse_replies_file_malformed(tmp_path: Path, line: str) -> None:
    """Malformed lines raise RepliesFileError with file:line context."""
    f = tmp_path / "replies.txt"
    f.write_text(line, encoding="utf-8")
    with pytest.raises(RepliesFileError, match="replies.txt:1"):
        parse_replies_file(f)


def test_parse_replies_file_empty(tmp_path: Path) -> None:
    """A file with only comments/blank lines raises."""
    f = tmp_path / "replies.txt"
    f.write_text("# nothing here\n\n", encoding="utf-8")
    with pytest.raises(RepliesFileError, match="no reply rules"):
        parse_replies_file(f)


# ---------------------------------------------------------------------------
# find_default_json
# ---------------------------------------------------------------------------


def test_find_default_json_newest(tmp_path: Path) -> None:
    """Newest pr-*-reviews.json by mtime wins."""
    old = _write_reviews_json(tmp_path, {}, "pr-1-reviews.json")
    new = _write_reviews_json(tmp_path, {}, "pr-2-reviews.json")
    os.utime(old, (1, 1))
    os.utime(new, (2, 2))
    assert find_default_json(tmp_path) == new


def test_find_default_json_none(tmp_path: Path) -> None:
    """No matching files -> None; unrelated files are ignored."""
    (tmp_path / "pr-2-pending-review.json").write_text("{}", encoding="utf-8")
    assert find_default_json(tmp_path) is None


# ---------------------------------------------------------------------------
# apply_replies
# ---------------------------------------------------------------------------


def test_apply_replies_mapping_file() -> None:
    """(path, line) rules match pending findings by location."""
    data = _sample_data()
    rules = [{"path": "src/a.py", "line": 10, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    for entry in data["qodo"][:2]:
        assert entry["status"] == "addressed"
        assert entry["reply"] == "Fixed in abc1234"
    # Unmatched and auto-skipped entries stay pending
    assert data["qodo"][2]["status"] == "pending"
    assert data["qodo"][3]["status"] == "pending"
    assert data["coderabbit"][0]["status"] == "pending"


def test_apply_replies_wildcard() -> None:
    """'*' matches every pending finding, but not auto-skipped ones."""
    data = _sample_data()
    rules = [{"path": None, "line": None, "reply": "All fixed in def5678"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 3  # a.py pair (1 group), b.py, d.py
    assert all(e["status"] == "addressed" and e["reply"] == "All fixed in def5678" for g in groups for e in g)
    assert data["qodo"][3]["status"] == "pending"  # auto-skipped untouched


def test_apply_replies_specific_rule_beats_wildcard() -> None:
    """A (path, line) rule wins over a wildcard rule for the same finding."""
    data = _sample_data()
    rules: list[dict[str, Any]] = [
        {"path": None, "line": None, "reply": "generic"},
        {"path": "src/a.py", "line": 10, "reply": "specific"},
    ]
    apply_replies(data, rules, "addressed")
    assert data["qodo"][0]["reply"] == "specific"
    assert data["qodo"][2]["reply"] == "generic"


def test_apply_replies_dedupes_thread_and_sticky() -> None:
    """Thread + sticky for the same (path, line, body-prefix) form one group."""
    data = _sample_data()
    rules = [{"path": "src/a.py", "line": 10, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")
    assert len(groups) == 1
    assert len(groups[0]) == 2  # both entries updated together
    assert {e["thread_id"] for e in groups[0]} == {"T1", None}


def test_apply_replies_no_rules_flips_status_of_replied_entries() -> None:
    """Without a mapping file, pending entries that already have a reply are flipped."""
    data = _sample_data()
    data["qodo"][2]["reply"] = "Removed the unused import in abc1234"
    groups = apply_replies(data, None, "skipped")
    assert len(groups) == 1
    assert data["qodo"][2]["status"] == "skipped"
    assert data["qodo"][0]["status"] == "pending"  # no reply -> untouched


def test_apply_replies_no_match() -> None:
    """A rule that matches nothing updates nothing."""
    data = _sample_data()
    rules = [{"path": "src/zzz.py", "line": 99, "reply": "nope"}]
    assert apply_replies(data, rules, "addressed") == []


# ---------------------------------------------------------------------------
# format_digest_line
# ---------------------------------------------------------------------------


def test_format_digest_line() -> None:
    line = format_digest_line(_entry(reply="Fixed the loop boundary in commit abc1234"))
    assert line == "src/a.py:10 [pending] HIGH/qodo_bug — Fixed the loop boundary in commit abc1234"


def test_format_digest_line_truncates_reply() -> None:
    long_reply = "x" * 200
    line = format_digest_line(_entry(reply=long_reply))
    reply_part = line.split("— ", 1)[1]
    assert len(reply_part) == 80
    assert reply_part.endswith("...")


def test_format_digest_line_missing_fields() -> None:
    line = format_digest_line({"body": "b", "reply": "r"})
    assert line == "unknown: [pending] unknown — r"


# ---------------------------------------------------------------------------
# CLI (CliRunner)
# ---------------------------------------------------------------------------


def test_cli_applies_replies_posts_and_stores(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Full happy path: mapping file applied, JSON saved, post+store chained, digest printed."""
    calls = _patch_post_store(monkeypatch)
    json_path = _write_reviews_json(tmp_path, _sample_data())
    replies = tmp_path / "replies.txt"
    replies.write_text("src/a.py:10|Fixed the boundary in abc1234\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 0, result.output
    assert calls == [("post", str(json_path)), ("store", str(json_path))]
    # File on disk was updated before post ran
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert saved["qodo"][0]["status"] == "addressed"
    assert saved["qodo"][0]["reply"] == "Fixed the boundary in abc1234"
    # Digest: one line per finding, no raw JSON dump
    assert "src/a.py:10 [addressed] HIGH/qodo_bug — Fixed the boundary in abc1234" in result.output
    assert "{\n" not in result.output


def test_cli_set_status(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """--set skipped flips the target status."""
    _patch_post_store(monkeypatch)
    json_path = _write_reviews_json(tmp_path, _sample_data())
    replies = tmp_path / "replies.txt"
    replies.write_text("src/a.py:10|By design, documented in internal #782\n", encoding="utf-8")

    result = CliRunner().invoke(
        reviews, ["address", "--json", str(json_path), "--replies", str(replies), "--set", "skipped"]
    )

    assert result.exit_code == 0, result.output
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert saved["qodo"][0]["status"] == "skipped"
    assert "src/a.py:10 [skipped]" in result.output


def test_cli_default_json_discovery(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Without --json, the newest pr-*-reviews.json in .pi/tmp is used."""
    calls = _patch_post_store(monkeypatch)
    monkeypatch.chdir(tmp_path)
    tmp_dir = tmp_path / ".pi" / "tmp"
    tmp_dir.mkdir(parents=True)
    _write_reviews_json(tmp_dir, _sample_data())
    replies = tmp_path / "replies.txt"
    replies.write_text("*|All findings fixed in def5678\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--replies", str(replies)])

    assert result.exit_code == 0, result.output
    assert calls[0] == ("post", str(tmp_dir / "pr-42-reviews.json"))


def test_cli_post_failure_exits_nonzero(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failing post exits non-zero and store is not run."""
    monkeypatch.setattr("myk_pi_tools.reviews.store.run", lambda _path: None)

    def failing_post(_path: str) -> None:
        raise SystemExit(1)

    monkeypatch.setattr("myk_pi_tools.reviews.post.run", failing_post)
    json_path = _write_reviews_json(tmp_path, _sample_data())
    replies = tmp_path / "replies.txt"
    replies.write_text("src/a.py:10|Fixed in abc1234\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 1
    # JSON kept on disk with statuses applied so a retry can resume
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert saved["qodo"][0]["status"] == "addressed"


def test_cli_no_match_exits_nonzero(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No matching findings -> non-zero exit, no post/store run."""
    calls = _patch_post_store(monkeypatch)
    json_path = _write_reviews_json(tmp_path, _sample_data())
    replies = tmp_path / "replies.txt"
    replies.write_text("src/zzz.py:99|nothing here\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 1
    assert calls == []


def test_cli_missing_json_exits_nonzero(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing default JSON -> non-zero exit with a clear error."""
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(reviews, ["address"])
    assert result.exit_code == 1
    assert "not found" in result.output
