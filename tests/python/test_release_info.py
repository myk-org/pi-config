"""Tests for myk-pi-tools release info git-log parsing."""

from myk_pi_tools.release.info import _parse_git_log


def _record(
    hash_full: str,
    short_hash: str,
    subject: str,
    author: str = "Test Author",
    date: str = "2026-08-17 19:00:00 +0300",
    body: str = "body text",
) -> str:
    return f"{hash_full}\x1f{short_hash}\x1f{subject}\x1f{author}\x1f{date}\x1f{body}"


def test_parse_git_log_strips_leading_newline_on_later_commits() -> None:
    """Git format inserts a newline after each NUL, which used to taint hash."""
    first_hash = "aaa111aaa111"  # pragma: allowlist secret
    second_hash = "bbb222bbb222"  # pragma: allowlist secret
    first = _record(first_hash, "aaa111a", "feat: first", body="first body")
    second = _record(second_hash, "bbb222b", "fix: second", body="second body")
    output = f"{first}\x00\n{second}\x00"

    commits = _parse_git_log(output)

    assert len(commits) == 2
    assert commits[0].hash == first_hash
    assert commits[0].short_hash == "aaa111a"
    assert commits[1].hash == second_hash
    assert commits[1].short_hash == "bbb222b"
    assert not commits[1].hash.startswith("\n")
    assert commits[1].subject == "fix: second"
    assert commits[1].body == "second body"


def test_parse_git_log_collapses_body_whitespace() -> None:
    hash_full = "abc123def456"  # pragma: allowlist secret
    record = _record(hash_full, "abc123d", "fix: spaces", body="line one\nline two")
    commits = _parse_git_log(f"{record}\x00")
    assert len(commits) == 1
    assert commits[0].body == "line one line two"
    assert commits[0].hash == hash_full
