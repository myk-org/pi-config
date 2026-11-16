"""Tests for `pr check-resolved-threads` (issue #1085).

Phase 1c of /pr-review used to decide suppression with
`git log --since="{resolved_at}" -- {path}` — a shell command built from fetched data.
These tests pin the replacement: git is called with an argument list, unsafe paths and
missing timestamps fail open, and a shallow clone cannot fake "nothing changed".
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest
from click.testing import CliRunner

from myk_pi_tools.pr.commands import pr
from myk_pi_tools.pr.resolved_threads import check_thread, is_safe_relative_path, resolution_timestamp


def _git(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, **(env or {})},
    )
    return result.stdout.strip()


def _commit(repo: Path, name: str, when: str) -> None:
    """Commit `name` with a pinned committer date — `git log --since` reads that date."""
    target = repo / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(when, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", f"touch {name}", env={"GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when})


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    path = tmp_path / "repo"
    path.mkdir()
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "test@example.com")
    _git(path, "config", "user.name", "Test")
    return path


def _thread(**overrides: Any) -> dict[str, Any]:
    thread: dict[str, Any] = {
        "thread_id": "PRRT_1",
        "path": "src/probe.py",
        "created_at": "2025-02-01T00:00:00Z",
        "replies": [],
    }
    thread.update(overrides)
    return thread


def test_check_suppresses_unchanged_path(repo: Path) -> None:
    """No commit after the resolution timestamp suppresses the thread."""
    _commit(repo, "src/probe.py", "2025-01-01T00:00:00+00:00")

    assert check_thread(repo, _thread())["suppressed"] is True


def test_check_does_not_suppress_path_changed_after_resolution(repo: Path) -> None:
    """A commit touching the path after the resolution timestamp keeps the finding."""
    _commit(repo, "src/probe.py", "2025-01-01T00:00:00+00:00")
    _commit(repo, "src/probe.py", "2025-03-01T00:00:00+00:00")

    assert check_thread(repo, _thread())["suppressed"] is False


def test_check_uses_thread_creation_when_no_replies(repo: Path) -> None:
    """A reply-less thread is timed by its own created_at and says so."""
    _commit(repo, "src/probe.py", "2025-01-01T00:00:00+00:00")

    verdict = check_thread(repo, _thread())

    assert (verdict["resolved_at_source"], verdict["resolved_at"]) == ("created_at", "2025-02-01T00:00:00Z")


def test_check_prefers_last_reply_over_thread_creation(repo: Path) -> None:
    """The newest reply timestamp wins over the thread's creation time."""
    _commit(repo, "src/probe.py", "2025-01-15T00:00:00+00:00")
    thread = _thread(created_at="2025-01-01T00:00:00Z", replies=[{"created_at": "2025-02-01T00:00:00Z"}])

    verdict = check_thread(repo, thread)

    assert (verdict["resolved_at_source"], verdict["suppressed"]) == ("last_reply", True)


def test_check_prefers_resolved_at_over_derived_timestamps(repo: Path) -> None:
    """An explicit resolved_at beats the derived conversation timestamps."""
    _commit(repo, "src/probe.py", "2025-01-15T00:00:00+00:00")
    thread = _thread(created_at="2025-01-01T00:00:00Z", resolved_at="2025-02-01T00:00:00Z")

    verdict = check_thread(repo, thread)

    assert (verdict["resolved_at_source"], verdict["suppressed"]) == ("resolved_at", True)


def test_check_does_not_suppress_thread_without_timestamp(repo: Path) -> None:
    """A thread with no created_at/replies (Qodo-CLI) is never suppressed."""
    _commit(repo, "src/probe.py", "2025-01-01T00:00:00+00:00")

    verdict = check_thread(repo, _thread(created_at=None))

    assert verdict["suppressed"] is False
    assert (verdict["resolved_at"], verdict["resolved_at_source"]) == (None, "none")


def test_resolution_timestamp_reports_none_source_for_undated_thread() -> None:
    """The timestamp helper names the fallback it used, including 'none'."""
    assert resolution_timestamp({"path": "a.py"}) == (None, "none")


def test_check_does_not_suppress_magic_prefixed_filename(repo: Path) -> None:
    """A real file named `:(literal)foo.py` never gets treated as a query for foo.py."""
    _commit(repo, "foo.py", "2025-01-01T00:00:00+00:00")
    _commit(repo, ":(literal)foo.py", "2025-03-01T00:00:00+00:00")

    assert check_thread(repo, _thread(path=":(literal)foo.py"))["suppressed"] is False


def test_is_safe_relative_path_rejects_pathspec_magic() -> None:
    """Leading ':' means Git pathspec magic, so the path is unsafe."""
    assert is_safe_relative_path(":(glob)*.py") is False


def test_is_safe_relative_path_accepts_normal_path() -> None:
    """An ordinary src/ path stays safe — the magic rejection is not over-broad."""
    assert is_safe_relative_path("src/foo.py") is True


def test_check_does_not_suppress_absolute_path(repo: Path) -> None:
    """An absolute path never matches a repo file, so it cannot be suppressed."""
    assert check_thread(repo, _thread(path="/etc/passwd"))["suppressed"] is False


def test_check_does_not_suppress_parent_traversal_path(repo: Path) -> None:
    """A path escaping the clone with '..' is treated as not suppressed."""
    assert check_thread(repo, _thread(path="../outside.py"))["suppressed"] is False


def test_check_does_not_suppress_control_characters_in_path(repo: Path) -> None:
    """A newline inside a path is rejected rather than handed to git."""
    assert check_thread(repo, _thread(path="src/probe.py\nrm -rf /"))["suppressed"] is False


def test_check_never_executes_shell_metacharacters_in_path(repo: Path) -> None:
    """A tracked file named with shell syntax is passed to git verbatim, never executed."""
    name = "src/probe;touch PWNED #$(touch PWNED).py"
    _commit(repo, name, "2025-01-01T00:00:00+00:00")

    verdict = check_thread(repo, _thread(path=name))

    assert (repo / "PWNED").exists() is False
    assert verdict["suppressed"] is True


def test_check_does_not_suppress_path_absent_from_head(repo: Path) -> None:
    """An unknown path yields an empty git log, which is not proof of no change."""
    _commit(repo, "src/probe.py", "2025-01-01T00:00:00+00:00")

    assert check_thread(repo, _thread(path="src/missing.py"))["suppressed"] is False


def test_check_does_not_suppress_when_window_predates_shallow_boundary(repo: Path, tmp_path: Path) -> None:
    """A --depth 1 clone cannot rule out changes before its boundary commit."""
    _commit(repo, "src/probe.py", "2024-01-01T00:00:00+00:00")
    _commit(repo, "src/probe.py", "2025-06-01T00:00:00+00:00")
    clone = tmp_path / "clone"
    _git(tmp_path, "clone", "-q", "--depth", "1", f"file://{repo}", str(clone))

    verdict = check_thread(clone, _thread(created_at="2024-06-01T00:00:00Z"))

    assert (verdict["suppressed"], verdict["resolved_at_source"]) == (False, "created_at")


def test_check_trusts_window_inside_shallow_history(repo: Path, tmp_path: Path) -> None:
    """A timestamp after the shallow boundary is fully covered by the clone."""
    _commit(repo, "src/probe.py", "2024-01-01T00:00:00+00:00")
    _commit(repo, "src/probe.py", "2025-06-01T00:00:00+00:00")
    clone = tmp_path / "clone"
    _git(tmp_path, "clone", "-q", "--depth", "1", f"file://{repo}", str(clone))

    assert check_thread(clone, _thread(created_at="2025-07-01T00:00:00Z"))["suppressed"] is True


def test_cli_check_resolved_threads_emits_verdict_per_thread(repo: Path, tmp_path: Path) -> None:
    """The CLI reports one verdict per input thread as JSON."""
    _commit(repo, "src/probe.py", "2025-01-01T00:00:00+00:00")
    json_file = tmp_path / "threads.json"
    json_file.write_text(
        json.dumps({"threads": [_thread(thread_id="t1"), _thread(thread_id="t2", path="../escape.py")]}),
        encoding="utf-8",
    )

    result = CliRunner().invoke(pr, ["check-resolved-threads", str(repo), str(json_file)])

    assert result.exit_code == 0, result.output
    verdicts = json.loads(result.output)
    assert [(v["thread_id"], v["suppressed"]) for v in verdicts] == [("t1", True), ("t2", False)]
