"""Tests for the reviews address subcommand."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner

from myk_pi_tools.reviews.address import (
    AddressError,
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
    """Replace post.run/store.run with recorders; return the call log.

    The fake post mimics the real one: it stamps posted_at on every
    non-pending entry it processes, so the address flow's posted-verification
    sees them as successfully posted.
    """
    calls: list[tuple[str, str]] = []

    def fake_post(path: str) -> None:
        calls.append(("post", path))
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        for src in ("human", "qodo", "coderabbit"):
            for entry in data.get(src, []):
                if entry.get("status") not in (None, "pending") and not entry.get("is_auto_skipped"):
                    entry["posted_at"] = "2025-01-01T00:00:00Z"
        Path(path).write_text(json.dumps(data), encoding="utf-8")

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
    groups = apply_replies(data, None, "addressed")
    assert len(groups) == 1
    assert data["qodo"][2]["status"] == "addressed"
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
    """--set skipped flips the target status (spec-update reply passes sticky validation)."""
    _patch_post_store(monkeypatch)
    json_path = _write_reviews_json(tmp_path, _sample_data())
    replies = tmp_path / "replies.txt"
    replies.write_text("src/a.py:10|Updated the issue spec, see internal #782\n", encoding="utf-8")

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


# ---------------------------------------------------------------------------
# Retry after failed post: unposted entries stay correctable (finding 3)
# ---------------------------------------------------------------------------


def test_apply_replies_updates_unposted_nonpending_entry() -> None:
    """A rule re-applies to entries a previous run saved but failed to post."""
    data = _sample_data()
    for e in data["qodo"][:2]:
        e["status"] = "addressed"
        e["reply"] = "old rejected reply"
    rules = [{"path": "src/a.py", "line": 10, "reply": "corrected in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    for e in data["qodo"][:2]:
        assert e["reply"] == "corrected in abc1234"
        assert e["status"] == "addressed"


def test_apply_replies_protects_posted_entries() -> None:
    """Entries with a posted_at marker are never re-addressed."""
    data = _sample_data()
    data["qodo"][0]["status"] = "addressed"
    data["qodo"][0]["reply"] = "posted reply"
    data["qodo"][0]["posted_at"] = "2025-01-01T00:00:00Z"
    rules = [{"path": "src/a.py", "line": 10, "reply": "corrected in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert data["qodo"][0]["reply"] == "posted reply"  # posted member untouched
    assert data["qodo"][1]["reply"] == "corrected in abc1234"  # unposted sticky member updated
    assert len(groups) == 1
    assert len(groups[0]) == 1


def test_cli_rerun_corrects_reply_of_unposted_entry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """After a failed post, re-running with a corrected mapping updates and posts."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    for e in data["qodo"][:2]:
        e["status"] = "addressed"  # saved by a previous run whose post failed
        e["reply"] = "old rejected reply"
    json_path = _write_reviews_json(tmp_path, data)
    replies = tmp_path / "replies.txt"
    replies.write_text("src/a.py:10|corrected in abc1234\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 0, result.output
    assert calls == [("post", str(json_path)), ("store", str(json_path))]
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert saved["qodo"][0]["reply"] == "corrected in abc1234"


# ---------------------------------------------------------------------------
# Status-only mode: paired findings share the group reply (finding 4)
# ---------------------------------------------------------------------------


def test_apply_replies_status_only_copies_group_reply_to_all_members() -> None:
    """A replied thread + unreplied sticky pair both get the reply before the status flip."""
    data = _sample_data()
    data["qodo"][0]["reply"] = "Fixed in abc1234"  # only the thread member carries a reply
    groups = apply_replies(data, None, "addressed")

    assert len(groups) == 1
    assert len(groups[0]) == 2
    for e in data["qodo"][:2]:
        assert e["reply"] == "Fixed in abc1234"  # post would reject an empty reply otherwise
        assert e["status"] == "addressed"


# ---------------------------------------------------------------------------
# No-match runs must not consume the JSON (finding 5)
# ---------------------------------------------------------------------------


def test_cli_no_match_keeps_unrelated_addressed_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A mapping that matches nothing never posts/stores, even with unposted entries present."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    data["qodo"][2]["status"] = "skipped"  # previously addressed, unposted, unrelated
    data["qodo"][2]["reply"] = "Removed the unused import in abc1234"
    json_path = _write_reviews_json(tmp_path, data)
    replies = tmp_path / "replies.txt"
    replies.write_text("src/zzz.py:99|nothing here\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 1
    assert calls == []  # no post, no store — the JSON is not consumed
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert saved["qodo"][2]["status"] == "skipped"  # unchanged
    assert json_path.exists()


def test_cli_resume_only_for_rule_matching_unposted_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An unposted entry whose reply is finished is only resumed when a rule matches it."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    data["qodo"][2]["status"] = "skipped"
    data["qodo"][2]["reply"] = "Removed the unused import in abc1234"
    json_path = _write_reviews_json(tmp_path, data)
    replies = tmp_path / "replies.txt"
    replies.write_text("src/b.py:3|Removed the unused import in abc1234\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 0, result.output
    assert calls == [("post", str(json_path)), ("store", str(json_path))]


# ---------------------------------------------------------------------------
# Posted-but-unresolved entries are resumed, not abandoned (round 2, finding 5)
# ---------------------------------------------------------------------------


def test_cli_resumes_posted_unresolved_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """When only posted-but-unresolved entries remain, post retries the resolve and store runs."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    data["qodo"][0]["status"] = "addressed"
    data["qodo"][0]["reply"] = "Fixed in abc1234"
    data["qodo"][0]["posted_at"] = "2025-01-01T00:00:00Z"  # reply posted, resolve failed
    data["qodo"][0]["type"] = None  # inline thread record (not a body-embedded type)
    for e in data["qodo"][1:] + data["coderabbit"]:
        e["status"] = "addressed"  # everything else already processed: nothing pending
        e["posted_at"] = "2025-01-01T00:00:00Z"
        e["resolved_at"] = "2025-01-01T00:00:01Z"
    json_path = _write_reviews_json(tmp_path, data)

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path)])

    assert result.exit_code == 0, result.output
    assert calls == [("post", str(json_path)), ("store", str(json_path))]
    assert "Resuming 1 posted-but-unresolved" in result.output


def test_cli_resumes_posted_unresolved_node_only_entry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A posted-but-unresolved inline thread with only a node_id is resumed too —
    post.run derives the thread from the comment node_id (a real inline thread
    record carries no sticky type; body-embedded types are excluded)."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    data["qodo"][0]["status"] = "addressed"
    data["qodo"][0]["reply"] = "Fixed in abc1234"
    data["qodo"][0]["posted_at"] = "2025-01-01T00:00:00Z"  # reply posted, resolve failed
    data["qodo"][0]["thread_id"] = None  # REST-fetched: only the node_id is known
    data["qodo"][0]["node_id"] = "PRRC_kwDOR"
    data["qodo"][0]["type"] = None  # inline thread, not a body-embedded comment
    for e in data["qodo"][1:] + data["coderabbit"]:
        e["status"] = "addressed"  # nothing pending: store may consume the JSON
        e["posted_at"] = "2025-01-01T00:00:00Z"
        e["resolved_at"] = "2025-01-01T00:00:01Z"
    json_path = _write_reviews_json(tmp_path, data)

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path)])

    assert result.exit_code == 0, result.output
    assert calls == [("post", str(json_path)), ("store", str(json_path))]
    assert "Resuming 1 posted-but-unresolved" in result.output


def test_cli_no_match_when_everything_posted_or_resolved(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Posted-and-resolved entries never trigger the resume path."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    data["qodo"][0]["status"] = "addressed"
    data["qodo"][0]["reply"] = "Fixed in abc1234"
    data["qodo"][0]["posted_at"] = "2025-01-01T00:00:00Z"
    data["qodo"][0]["resolved_at"] = "2025-01-01T00:00:01Z"
    json_path = _write_reviews_json(tmp_path, data)

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path)])

    assert result.exit_code == 1
    assert calls == []  # fully processed: no resume, no post, no store


# ---------------------------------------------------------------------------
# Unposted addressed entries keep their retry file (finding 6)
# ---------------------------------------------------------------------------


def test_cli_keeps_json_when_post_skips_addressed_entry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Post exiting 0 while skipping an entry (no thread id) must not lead to store."""
    calls = _patch_post_store(monkeypatch)

    def skipping_post(path: str) -> None:
        calls.append(("post", path))  # exits 0 but never stamps posted_at

    monkeypatch.setattr("myk_pi_tools.reviews.post.run", skipping_post)
    data = _sample_data()
    data["qodo"][2]["thread_id"] = None  # inline sticky finding, no resolvable thread
    json_path = _write_reviews_json(tmp_path, data)
    replies = tmp_path / "replies.txt"
    replies.write_text("src/b.py:3|Removed the unused import in abc1234\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 1
    assert ("store", str(json_path)) not in calls
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert saved["qodo"][2]["status"] == "addressed"  # reply kept for retry
    assert json_path.exists()


# ---------------------------------------------------------------------------
# Invalid status for Qodo sticky findings rejected before persisting (finding 7)
# ---------------------------------------------------------------------------


def test_apply_replies_rejects_invalid_status_for_qodo_sticky() -> None:
    """--set not_addressed/failed is rejected for sticky findings; nothing changes."""
    data = _sample_data()
    rules = [{"path": "src/b.py", "line": 3, "reply": "not fixing this"}]
    with pytest.raises(AddressError, match="qodo_finding"):
        apply_replies(data, rules, "not_addressed")

    assert data["qodo"][2]["status"] == "pending"  # nothing was modified
    assert data["qodo"][2]["reply"] == ""


def test_apply_replies_allows_skipped_sticky_with_spec_update_reply() -> None:
    """'skipped' is allowed for stickies when the reply documents an issue-spec update."""
    data = _sample_data()
    rules = [{"path": "src/b.py", "line": 3, "reply": "Updated the issue spec, see internal #782"}]
    groups = apply_replies(data, rules, "skipped")

    assert len(groups) == 1
    assert data["qodo"][2]["status"] == "skipped"


def test_cli_invalid_sticky_status_changes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The CLI rejects incompatible statuses before saving, posting, or storing."""
    calls = _patch_post_store(monkeypatch)
    json_path = _write_reviews_json(tmp_path, _sample_data())
    replies = tmp_path / "replies.txt"
    replies.write_text("src/b.py:3|not fixing this\n", encoding="utf-8")

    result = CliRunner().invoke(
        reviews, ["address", "--json", str(json_path), "--replies", str(replies), "--set", "failed"]
    )

    assert result.exit_code == 1
    assert calls == []
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert saved["qodo"][2]["status"] == "pending"


# ---------------------------------------------------------------------------
# Thread + sticky records with different bodies still pair (finding 8)
# ---------------------------------------------------------------------------


def test_apply_replies_pairs_thread_with_sticky_despite_marker_suffixes() -> None:
    """Thread bodies carry '<emoji> Type <emoji> Quality' markers after the title;
    sticky bodies are '**Title**' — still one cluster, and the thread's marker
    phrase maps to the sticky's finding type."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(
                line=107,
                body="1\\. New review helpers skip required structured logs 📜 Rule violation ≡ Correctness",
                thread_id="T1",
                type=None,
            ),
            _entry(
                line=107,
                body="**New review helpers skip required structured logs**\n\nThe new functions lack logs.",
                thread_id=None,
                type="qodo_rule_violation",
            ),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 107, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert len(groups[0]) == 2  # pair grouped despite the marker suffix
    assert all(e["reply"] == "Fixed in abc1234" for e in groups[0])


def test_apply_replies_pairs_thread_with_sticky_despite_unmapped_type_phrase() -> None:
    """A thread marker phrase outside QODO_TYPE_MAP (e.g. 'Skill insight') derives
    qodo_finding — the same fallback fetch uses for the sticky's type."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(
                line=536,
                body="6\\. Thread pairing test name uses skill hints 📜 Skill insight ✨ Quality",
                thread_id="T1",
                type=None,
            ),
            _entry(
                line=536,
                body="**Thread pairing test name uses skill hints**\n\nSplit the test.",
                thread_id=None,
                type="qodo_finding",
            ),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 536, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert len(groups[0]) == 2
    assert all(e["reply"] == "Fixed in abc1234" for e in groups[0])


def test_apply_replies_pairs_thread_with_sticky_despite_line_shift() -> None:
    """A sticky's [line, end_line] span covers its thread's shifted line — one cluster."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(
                line=107,
                body="1\\. New review helpers skip required structured logs 📜 Rule violation ≡ Correctness",
                thread_id="T1",
                type=None,
            ),
            _entry(
                line=105,
                end_line=110,
                body="**New review helpers skip required structured logs**\n\nThe new functions lack logs.",
                thread_id=None,
                type="qodo_rule_violation",
            ),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 107, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert len(groups[0]) == 2  # pair grouped despite different lines
    assert all(e["reply"] == "Fixed in abc1234" for e in groups[0])


# ---------------------------------------------------------------------------
# Status-only retries source the group reply from unposted siblings (round 2, finding 1)
# ---------------------------------------------------------------------------


def test_apply_replies_status_only_sources_reply_from_unposted_sibling() -> None:
    """A non-pending unposted member's reply is copied to its pending pair member."""
    data = _sample_data()
    data["qodo"][0]["status"] = "addressed"  # saved by a run whose post failed
    data["qodo"][0]["reply"] = "Fixed in abc1234"
    groups = apply_replies(data, None, "addressed")

    assert len(groups) == 1
    assert data["qodo"][1]["reply"] == "Fixed in abc1234"  # pending sibling completed
    assert data["qodo"][1]["status"] == "addressed"
    assert len(groups[0]) == 1  # only the pending member is (re)applied


# ---------------------------------------------------------------------------
# Dedupe key distinguishes finding type and full title (round 2, findings 2-3)
# ---------------------------------------------------------------------------


def test_apply_replies_separates_same_titled_findings_of_different_types() -> None:
    """Same path + title but different sticky types are distinct findings."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(line=10, body="**Fix the parser**\n\nIt crashes.", thread_id=None, type="qodo_bug"),
            _entry(line=12, body="**Fix the parser**\n\nIt crashes.", thread_id=None, type="qodo_finding"),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 10, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert data["qodo"][0]["status"] == "addressed"
    assert data["qodo"][1]["status"] == "pending"  # different type: untouched


def test_apply_replies_separates_findings_differing_after_80_chars() -> None:
    """Titles sharing a long prefix but differing after char 80 stay distinct findings."""
    prefix = "rename the review helper " * 4  # 100 chars: the titles differ only past char 80
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(line=10, body=f"**{prefix}for github**", thread_id=None, type="qodo_bug"),
            _entry(line=20, body=f"**{prefix}for storage**", thread_id=None, type="qodo_bug"),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 10, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert data["qodo"][0]["status"] == "addressed"
    assert data["qodo"][1]["status"] == "pending"  # differs only after char 80


# ---------------------------------------------------------------------------
# Location rules are scoped to the rule's line cluster (round 2, finding 4)
# ---------------------------------------------------------------------------


def test_apply_replies_location_rule_scopes_to_rule_line() -> None:
    """A rule for file:10 must not mark a same-titled finding at line 50."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(line=10, body="**Rename variable x**", thread_id="T1"),
            _entry(line=50, body="**Rename variable x**", thread_id="T2"),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 10, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert data["qodo"][0]["status"] == "addressed"
    assert data["qodo"][1]["status"] == "pending"  # distinct location: untouched


def test_apply_replies_chained_spans_stay_separate_findings() -> None:
    """Chained sticky spans [10,20],[20,30],[30,40] are three findings; a rule
    for line 35 must not touch the line-10 finding."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(line=10, end_line=20, body="**Rename variable x**", thread_id=None),
            _entry(line=20, end_line=30, body="**Rename variable x**", thread_id=None),
            _entry(line=30, end_line=40, body="**Rename variable x**", thread_id=None),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 35, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert data["qodo"][0]["status"] == "pending"  # chained overlap is not a pair
    assert data["qodo"][1]["status"] == "pending"
    assert data["qodo"][2]["status"] == "addressed"  # only the span containing 35


def test_apply_replies_location_rule_matches_thread_within_sticky_span() -> None:
    """A rule at the sticky's start line still reaches the pair's thread line."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(
                line=240,
                body="1\\. Status-only retries miss paired replies 📌 Requirement gap ≡ Correctness",
                thread_id="T1",
                type=None,
            ),
            _entry(
                line=234,
                end_line=240,
                body="**Status-only retries miss paired replies**\n\nThe reply is ignored.",
                thread_id=None,
                type="qodo_requirement_gap",
            ),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 234, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert len(groups[0]) == 2  # rule at the sticky's line updates the whole pair


# ---------------------------------------------------------------------------
# Ambiguous rules: one rule must not answer multiple distinct findings (finding 9)
# ---------------------------------------------------------------------------


def test_apply_replies_rejects_rule_matching_multiple_findings() -> None:
    """A specific rule matching two distinct findings at one location fails cleanly."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(body="Fix the loop boundary in parser", thread_id="T1"),
            _entry(body="Rename variable x to y", thread_id="T2"),
        ],
        "coderabbit": [],
    }
    rules = [{"path": "src/a.py", "line": 10, "reply": "one reply for both"}]
    with pytest.raises(AddressError, match="2 distinct findings"):
        apply_replies(data, rules, "addressed")

    assert data["qodo"][0]["status"] == "pending"  # nothing was modified
    assert data["qodo"][1]["status"] == "pending"


def test_apply_replies_wildcard_still_matches_multiple_findings() -> None:
    """The wildcard rule is allowed to answer several distinct findings."""
    data: dict[str, Any] = {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(body="Fix the loop boundary in parser", thread_id="T1"),
            _entry(body="Rename variable x to y", thread_id="T2"),
        ],
        "coderabbit": [],
    }
    rules = [{"path": None, "line": None, "reply": "all fixed in def5678"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 2
    assert all(e["status"] == "addressed" for g in groups for e in g)


def test_cli_ambiguous_rule_changes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The CLI fails with a clear error and leaves the JSON untouched."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    data["qodo"].append(_entry(body="Rename variable x to y", thread_id="T2"))
    json_path = _write_reviews_json(tmp_path, data)
    replies = tmp_path / "replies.txt"
    replies.write_text("src/a.py:10|one reply for both\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 1
    assert "2 distinct findings" in result.output
    assert calls == []
    saved = json.loads(json_path.read_text(encoding="utf-8"))
    assert all(e["status"] == "pending" for e in saved["qodo"])


# ---------------------------------------------------------------------------
# Posted body-embedded comments never consume the JSON (round 4, finding 1)
# ---------------------------------------------------------------------------


def test_cli_posted_body_comment_with_pending_findings_not_consumed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A posted body-embedded comment (review node_id, no thread) is not a
    resolution retry: with no matching rules the run exits no-match and the
    JSON holding pending findings is kept."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    data["qodo"][1] = _entry(  # sticky record, posted as a consolidated body comment
        thread_id=None,
        node_id="PRRC_kwDOR",  # review node, not a resolvable thread
        status="addressed",
        reply="Fixed in abc1234",
        posted_at="2025-01-01T00:00:00Z",
    )
    json_path = _write_reviews_json(tmp_path, data)
    replies = tmp_path / "replies.txt"
    replies.write_text("src/zzz.py:99|nothing here\n", encoding="utf-8")

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path), "--replies", str(replies)])

    assert result.exit_code == 1
    assert "no findings matched" in result.output
    assert calls == []  # no post, no store — the pending findings survive
    assert json_path.exists()


def test_cli_resume_keeps_json_when_pending_findings_remain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Store must not delete the JSON while unposted findings remain, even
    when a posted-but-unresolved entry triggers the resume path."""
    calls = _patch_post_store(monkeypatch)
    data = _sample_data()
    data["qodo"][0]["status"] = "addressed"
    data["qodo"][0]["reply"] = "Fixed in abc1234"
    data["qodo"][0]["posted_at"] = "2025-01-01T00:00:00Z"  # reply posted, resolve failed
    data["qodo"][0]["type"] = None  # inline thread: resolvable
    json_path = _write_reviews_json(tmp_path, data)

    result = CliRunner().invoke(reviews, ["address", "--json", str(json_path)])

    assert result.exit_code == 0, result.output
    assert calls == [("post", str(json_path))]  # store skipped: pending findings remain
    assert "still pending" in result.output
    assert json_path.exists()


# ---------------------------------------------------------------------------
# A sticky spanning two same-titled threads pairs with one (round 4, finding 2)
# ---------------------------------------------------------------------------


def _overlap_data() -> dict[str, Any]:
    """Sticky span [230,250] covering two same-titled threads at 235 and 245."""
    return {
        "metadata": {"owner": "org", "repo": "repo", "pr_number": 42},
        "human": [],
        "qodo": [
            _entry(
                line=235,
                body="1\\. Overlapping threads cannot be addressed 📜 Bug ≡ Correctness",
                thread_id="T1",
                type=None,
            ),
            _entry(
                line=245,
                body="2\\. Overlapping threads cannot be addressed 📜 Bug ≡ Correctness",
                thread_id="T2",
                type=None,
            ),
            _entry(
                line=230,
                end_line=250,
                body="**Overlapping threads cannot be addressed**\n\nThe sticky spans both threads.",
                thread_id=None,
                type="qodo_bug",
            ),
        ],
        "coderabbit": [],
    }


def test_apply_replies_rule_at_first_thread_addresses_pair() -> None:
    """A rule at 235 addresses the first thread plus its paired sticky; the
    second thread stays untouched and no ambiguity is raised."""
    data = _overlap_data()
    rules = [{"path": "src/a.py", "line": 235, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert len(groups[0]) == 2  # thread@235 + its paired sticky
    assert data["qodo"][0]["status"] == "addressed"
    assert data["qodo"][2]["status"] == "addressed"  # paired sticky updated
    assert data["qodo"][1]["status"] == "pending"  # second thread untouched


def test_apply_replies_rule_at_second_thread_addresses_it_alone() -> None:
    """A rule at 245 addresses the second thread alone — the contested sticky's
    span no longer makes the rule ambiguous."""
    data = _overlap_data()
    rules = [{"path": "src/a.py", "line": 245, "reply": "Fixed in abc1234"}]
    groups = apply_replies(data, rules, "addressed")

    assert len(groups) == 1
    assert len(groups[0]) == 1  # thread@245 alone
    assert data["qodo"][1]["status"] == "addressed"
    assert data["qodo"][0]["status"] == "pending"
    assert data["qodo"][2]["status"] == "pending"  # sticky belongs to the first pair
