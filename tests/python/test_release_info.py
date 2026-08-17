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
    first = _record("aaa111aaa111", "aaa111a", "feat: first")  # pragma: allowlist secret
    second_hash = "bbb222bbb222"  # pragma: allowlist secret
    second = _record(second_hash, "bbb222b", "fix: second")
    commits = _parse_git_log(f"{first}\x00\n{second}\x00")
    assert commits[1].hash == second_hash


def test_parse_git_log_parses_two_nul_separated_records() -> None:
    first_hash = "aaa111aaa111"  # pragma: allowlist secret
    second_hash = "bbb222bbb222"  # pragma: allowlist secret
    first = _record(first_hash, "aaa111a", "feat: first")
    second = _record(second_hash, "bbb222b", "fix: second")
    commits = _parse_git_log(f"{first}\x00{second}\x00")
    assert [c.hash for c in commits] == [first_hash, second_hash]


def test_parse_git_log_collapses_body_whitespace() -> None:
    record = _record("abc123def456", "abc123d", "fix: spaces", body="line one\nline two")  # pragma: allowlist secret
    commits = _parse_git_log(f"{record}\x00")
    assert commits[0].body == "line one line two"
