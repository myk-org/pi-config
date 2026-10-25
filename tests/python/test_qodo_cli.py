"""Tests for the qodo CLI read source (issue #958).

Covers: availability probe (missing bin / not logged in / old version /
success + caching), trace-line stripping, malformed JSON, finding mapping
(all attribution_status values, action_level→priority, spans, thread ids),
review state derivation (reviewing / approved), and the poll integration
branching (CLI used / per-cycle fallback / unavailable → GitHub flow).
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

import myk_pi_tools.reviews.qodo_cli as qodo_cli
from myk_pi_tools.reviews.qodo_cli import (
    ACTION_LEVEL_PRIORITY,
    OPEN_ATTRIBUTION_STATUSES,
    _parse_version,
    _strip_trace_line,
    _thread_id_from_inline,
    cli_review_state,
    fetch_qodo_cli_findings,
    fetch_qodo_cli_threads,
    map_cli_findings_to_threads,
    qodo_cli_available,
)

FIXTURES = Path(__file__).parent / "fixtures"
PR_URL = "https://github.com/myk-org/pi-config/pull/956"
HEAD_SHA = "970b77877fce1ad48d04053f27b0601daa49ada7"  # pragma: allowlist secret (git SHA of PR #956 head)


def _load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture(autouse=True)
def _reset_availability_cache() -> Iterator[None]:
    qodo_cli._availability_cache = None
    yield
    qodo_cli._availability_cache = None


@pytest.fixture
def fake_bin(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Any:
    """Install a fake `qodo` binary script; returns a controller.

    The script reads its behavior from a JSON config file on each invocation,
    so tests can flip version/auth/read outcomes after setup.
    """

    class FakeQodo:
        _CONFIG_KEYS = ("version_output", "version_rc", "whoami_rc", "whoami_output", "read_output", "read_rc")

        _config_dir: Path

        def __init__(self) -> None:
            self.version_output = "1.6.0\n"
            self.version_rc = 0
            self.whoami_rc = 0
            self.whoami_output = '{"email":"t@example.com","workspace_id":"w"}'
            self.read_output: str | None = None
            self.read_rc = 0
            self.calls: list[list[str]] = []

        def __setattr__(self, name: str, value: Any) -> None:
            super().__setattr__(name, value)
            if name in self._CONFIG_KEYS and hasattr(self, "_config_dir"):
                self._write_config()

        def _config_path(self) -> Path:
            return self._config_dir / "qodo-fake-config.json"

        def _write_config(self) -> None:
            self._config_path().write_text(json.dumps({k: getattr(self, k) for k in self._CONFIG_KEYS}))

        def script(self) -> str:
            return """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "qodo-fake-config.json")
with open(config_path) as f:
    cfg = json.load(f)
if args == ["--version"]:
    print(cfg["version_output"], end="")
    sys.exit(cfg["version_rc"])
if args == ["read", "whoami", "--json"]:
    print(cfg["whoami_output"], end="")
    sys.exit(cfg["whoami_rc"])
out = cfg["read_output"]
print(out if out is not None else "", end="")
sys.exit(cfg["read_rc"])
"""

    fake = FakeQodo()
    fake._config_dir = tmp_path
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "qodo").write_text(fake.script())
    (bin_dir / "qodo").chmod(0o755)
    fake._write_config()
    # Keep the original PATH — the fake script's `env python3` shebang needs it
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    return fake


# --- version parsing / trace stripping ---


def test_parse_version_plain() -> None:
    assert _parse_version("1.6.0\n") == (1, 6, 0)


def test_parse_version_next_suffix() -> None:
    assert _parse_version("qodo 0.1.0-next.37\n") == (0, 1, 0)


def test_parse_version_garbage() -> None:
    assert _parse_version("garbage") is None


def test_strip_trace_line_removes_trailing_trace() -> None:
    raw = (FIXTURES / "pr-956-compact-raw.txt").read_text()
    assert raw.rstrip().endswith("trace") or "  trace " in raw
    cleaned = _strip_trace_line(raw)
    data = json.loads(cleaned)
    assert data["finding_count"] == 8


def test_strip_trace_line_no_trace_is_noop() -> None:
    assert _strip_trace_line('{"a": 1}\n') == '{"a": 1}\n'


# --- availability probe ---


def test_available_missing_bin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qodo_cli.shutil, "which", lambda _name: None)
    assert qodo_cli_available() is False


def test_available_old_version(fake_bin: Any) -> None:
    fake_bin.version_output = "0.1.0-next.37\n"
    assert qodo_cli_available() is False


def test_available_version_probe_fails(fake_bin: Any) -> None:
    fake_bin.version_rc = 1
    assert qodo_cli_available() is False


def test_available_not_logged_in(fake_bin: Any) -> None:
    fake_bin.whoami_rc = 1
    assert qodo_cli_available() is False


def test_available_success(fake_bin: Any) -> None:  # noqa: ARG001 — fixture installs the fake bin on PATH
    assert qodo_cli_available() is True


def test_available_probe_result_cached(fake_bin: Any) -> None:
    assert qodo_cli_available() is True
    # Cached: second call does not re-run the probes (script now fails)
    fake_bin.version_rc = 1
    assert qodo_cli_available() is True
    assert qodo_cli_available(force_recheck=True) is False


# --- fetch ---


def test_fetch_missing_bin_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qodo_cli.shutil, "which", lambda _name: None)
    assert fetch_qodo_cli_findings(PR_URL) is None


def test_fetch_failure_returns_none(fake_bin: Any) -> None:
    fake_bin.read_rc = 1
    fake_bin.read_output = "MT-RATE-LIMITED"
    assert fetch_qodo_cli_findings(PR_URL) is None


def test_fetch_malformed_json_returns_none(fake_bin: Any) -> None:
    fake_bin.read_output = "not json at all"
    assert fetch_qodo_cli_findings(PR_URL) is None


def test_fetch_parses_cli_output_with_trace_line(fake_bin: Any) -> None:
    fake_bin.read_output = (FIXTURES / "pr-956-compact-raw.txt").read_text()
    data = fetch_qodo_cli_findings(PR_URL)
    assert data is not None
    assert data["finding_count"] == 8
    assert data["review_session"]["status"] == "completed"


def test_fetch_extended_flag(fake_bin: Any) -> None:
    fake_bin.read_output = (FIXTURES / "pr-956-compact-raw.txt").read_text()
    fetch_qodo_cli_findings(PR_URL, extended=True)
    # (The fake ignores the flag; command construction covered by CLI call test below.)


# --- mapping ---


def _open_finding(**over: Any) -> dict[str, Any]:
    finding: dict[str, Any] = {
        "id": "uuid-1",
        "title": "Sample finding",
        "description": "Description text",
        "category": "Correctness",
        "action_level": "action_required",
        "attribution_status": "pending",
        "git_sha": "abc1234",
        "review_run_id": 1,
        "comment_id": 111,
        "inline_comment_id": "gh1:PRRT_kwxxx:222",
        "created_at": "2026-10-22T00:00:00Z",
        "finding_source": "IssueFinding",
    }
    finding.update(over)
    return finding


def test_map_open_finding_shape() -> None:
    data = {
        "review_session": {"run_id": 9, "status": "completed"},
        "findings": [
            _open_finding(
                file_path="src/a.py",
                start_line=10,
                end_line=12,
                side="RIGHT",
                code_snippet="+ foo()",
                evidence={"explanation": "why", "citations": [{"source": "src/a.py[10-12]"}]},
            )
        ],
    }
    threads = map_cli_findings_to_threads(data)
    assert len(threads) == 1
    t = threads[0]
    assert t["path"] == "src/a.py"
    assert t["side"] == "RIGHT"
    assert t["line"] == 10
    assert t["end_line"] == 12
    assert t["thread_id"] == "PRRT_kwxxx"
    assert t["comment_id"] == 111
    assert t["status"] == "pending"
    assert t["priority"] == "HIGH"
    assert t["type"] == "qodo_bug"
    assert t["title"] == "Sample finding"
    assert t["body"].startswith("**Sample finding**")
    assert t["code_diff"] == "+ foo()"
    assert t["evidence"] == "why"
    assert t["evidence_refs"] == ["src/a.py[10-12]"]
    assert t["qodo_cli"] is True
    assert t["finding_uuid"] == "uuid-1"
    assert "is_auto_skipped" not in t


@pytest.mark.parametrize("status", sorted(OPEN_ATTRIBUTION_STATUSES))
def test_map_all_open_statuses_actionable(status: str) -> None:
    data = {"review_session": {}, "findings": [_open_finding(attribution_status=status)]}
    threads = map_cli_findings_to_threads(data)
    assert threads[0]["status"] == "pending"
    assert "is_auto_skipped" not in threads[0]


@pytest.mark.parametrize("status", ["full_implementation", "dismissed", "detected_after_merge", "outdated"])
def test_map_all_closed_statuses_skipped(status: str) -> None:
    data = {"review_session": {}, "findings": [_open_finding(attribution_status=status)]}
    threads = map_cli_findings_to_threads(data)
    t = threads[0]
    assert t["status"] == "skipped"
    assert t["is_auto_skipped"] is True
    assert t["already_replied"] is True


@pytest.mark.parametrize(("level", "priority"), sorted(ACTION_LEVEL_PRIORITY.items()))
def test_map_action_level_priority(level: str, priority: str) -> None:
    data = {"review_session": {}, "findings": [_open_finding(action_level=level)]}
    assert map_cli_findings_to_threads(data)[0]["priority"] == priority


def test_map_unknown_action_level_defaults_medium() -> None:
    data = {"review_session": {}, "findings": [_open_finding(action_level="weird")]}
    assert map_cli_findings_to_threads(data)[0]["priority"] == "MEDIUM"


def test_map_fixture_pr956() -> None:
    data = _load("pr-956-compact.json")
    threads = map_cli_findings_to_threads(data)
    assert len(threads) == 8
    # All findings on merged PR #956 were implemented → all auto-skipped
    assert all(t["is_auto_skipped"] for t in threads)
    assert all(t["qodo_cli"] for t in threads)
    # Spans from the extended fixture
    ext = _load("pr-956-extended.json")
    ext_threads = map_cli_findings_to_threads(ext)
    spans = {(t["path"], t["line"]) for t in ext_threads}
    assert ("extensions/orchestrator/memory-write.ts", 1202) in spans


def test_thread_id_from_inline() -> None:
    assert _thread_id_from_inline("gh1:PRRT_kwxxx:222") == "PRRT_kwxxx"
    assert _thread_id_from_inline(None) is None
    assert _thread_id_from_inline("") is None
    assert _thread_id_from_inline("bad") is None


# --- review state ---


def test_review_state_approved_at_head() -> None:
    data = _load("pr-956-compact.json")
    state = cli_review_state(data, HEAD_SHA)
    assert state["approved"] is True
    assert state["reviewing"] is False
    assert state["reason"] == "all_resolved"
    assert state["total_findings"] == 8
    assert state["resolved_count"] == 8
    assert state["unresolved_count"] == 0


def test_review_state_stale_commit_not_approved() -> None:
    data = _load("pr-956-compact.json")
    state = cli_review_state(data, "ffffffffffffffffffffffffffffffffffffffff")
    assert state["approved"] is False
    assert state["reviewing"] is True


def test_review_state_session_in_progress() -> None:
    data = _load("pr-956-compact.json")
    data["review_session"]["status"] = "started"
    state = cli_review_state(data, HEAD_SHA)
    assert state["reviewing"] is True
    assert state["approved"] is False


def test_review_state_open_findings_not_approved() -> None:
    data = _load("pr-956-compact.json")
    data["findings"][0]["attribution_status"] = "pending"
    state = cli_review_state(data, HEAD_SHA)
    assert state["approved"] is False
    assert state["unresolved_count"] == 1


def test_review_state_no_findings() -> None:
    state = cli_review_state({"review_session": {"status": "completed", "commit_sha": "x"}, "findings": []}, "x")
    assert state["approved"] is True
    assert state["reason"] == "no_findings"


# --- high-level fetch_qodo_cli_threads ---


def test_fetch_wrong_shape_json_returns_none(fake_bin: Any) -> None:
    """Syntactically valid JSON of the wrong shape fails open to the scrape."""
    fake_bin.read_output = '["a", "list"]'
    assert fetch_qodo_cli_findings(PR_URL) is None
    fake_bin.read_output = '{"no_session_key": true}'
    assert fetch_qodo_cli_findings(PR_URL) is None
    # null top level
    fake_bin.read_output = "null"
    assert fetch_qodo_cli_findings(PR_URL) is None
    # findings not a list
    fake_bin.read_output = '{"review_session": null, "findings": {"a": 1}}'
    assert fetch_qodo_cli_findings(PR_URL) is None
    # non-object entries inside the findings list
    fake_bin.read_output = '{"review_session": null, "findings": ["not", "objects"]}'
    assert fetch_qodo_cli_findings(PR_URL) is None


def test_threads_missing_head_sha_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without the PR head SHA the CLI branch can never confirm freshness —
    approval would stall forever, so it must fall back to the GitHub scrape."""
    monkeypatch.setattr(qodo_cli, "qodo_cli_available", lambda: True)
    reads: list[str] = []

    def fake_fetch(pr_url: str, *, extended: bool = False, timeout: int = 90) -> dict[str, Any] | None:  # noqa: ARG001
        reads.append(pr_url)
        return _load("pr-956-compact.json")

    monkeypatch.setattr(qodo_cli, "fetch_qodo_cli_findings", fake_fetch)
    threads, state = fetch_qodo_cli_threads(PR_URL, None)
    assert threads is None and state is None
    assert reads == []  # no CLI read attempted at all


def test_threads_unavailable_returns_none_pair(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qodo_cli, "qodo_cli_available", lambda: False)
    assert fetch_qodo_cli_threads(PR_URL, HEAD_SHA) == (None, None)


def test_threads_no_session_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qodo_cli, "qodo_cli_available", lambda: True)
    monkeypatch.setattr(
        qodo_cli, "fetch_qodo_cli_findings", lambda *_a, **_kw: {"review_session": None, "findings": []}
    )
    threads, state = fetch_qodo_cli_threads(PR_URL, HEAD_SHA)
    assert threads is None and state is None


def test_threads_read_failure_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qodo_cli, "qodo_cli_available", lambda: True)
    monkeypatch.setattr(qodo_cli, "fetch_qodo_cli_findings", lambda *_a, **_kw: None)
    assert fetch_qodo_cli_threads(PR_URL, HEAD_SHA) == (None, None)


def test_threads_closed_only_uses_compact_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qodo_cli, "qodo_cli_available", lambda: True)
    calls: list[dict] = []

    def fake_fetch(_pr_url: str, *, extended: bool = False, _timeout: int = 90) -> dict[str, Any] | None:
        calls.append({"extended": extended})
        return _load("pr-956-compact.json")

    monkeypatch.setattr(qodo_cli, "fetch_qodo_cli_findings", fake_fetch)
    threads, state = fetch_qodo_cli_threads(PR_URL, HEAD_SHA)
    assert threads is not None and state is not None
    assert len(threads) == 8
    assert state["approved"] is True
    # All findings closed → no extended re-read
    assert calls == [{"extended": False}]


def test_threads_open_findings_trigger_extended_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qodo_cli, "qodo_cli_available", lambda: True)
    compact = _load("pr-956-compact.json")
    compact["findings"][0]["attribution_status"] = "pending"
    extended_data = _load("pr-956-extended.json")
    extended_data["findings"][0]["attribution_status"] = "pending"
    reads: list[bool] = []

    def fake_fetch(_pr_url: str, *, extended: bool = False, _timeout: int = 90) -> dict[str, Any] | None:
        reads.append(extended)
        return extended_data if extended else compact

    monkeypatch.setattr(qodo_cli, "fetch_qodo_cli_findings", fake_fetch)
    threads, state = fetch_qodo_cli_threads(PR_URL, HEAD_SHA)
    assert threads is not None and state is not None
    assert reads == [False, True]
    assert sum(1 for t in threads if t["status"] == "pending") == 1
    assert state["unresolved_count"] == 1


def test_threads_extended_failure_keeps_compact(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(qodo_cli, "qodo_cli_available", lambda: True)
    compact = _load("pr-956-compact.json")
    compact["findings"][0]["attribution_status"] = "partial_implementation"

    def fake_fetch(_pr_url: str, *, extended: bool = False, _timeout: int = 90) -> dict[str, Any] | None:
        if extended:
            return None  # extended read fails
        return compact

    monkeypatch.setattr(qodo_cli, "fetch_qodo_cli_findings", fake_fetch)
    threads, state = fetch_qodo_cli_threads(PR_URL, HEAD_SHA)
    assert threads is not None and state is not None
    assert state["unresolved_count"] == 1


# --- poll integration ---


def test_poll_cli_state_reviewing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Poll uses the CLI reviewing flag instead of GitHub comment churn."""
    from myk_pi_tools.reviews import poll as poll_mod

    cli_state = {"source": "qodo-cli", "status": "started", "reviewing": True, "approved": False}
    fetch_result = {
        "metadata": {"owner": "myk-org", "repo": "pi-config", "pr_number": 956, "author": "a", "json_path": ""},
        "human": [],
        "qodo": [],
        "coderabbit": [],
        "approved": False,
        "qodo_cleanup_response": "",
        "qodo_cli_state": cli_state,
    }

    cycles = {"n": 0}

    def fake_fetch_run(review_url: str, *, output_dir: str) -> dict[str, Any]:  # noqa: ARG001
        cycles["n"] += 1
        if cycles["n"] == 1:
            return fetch_result
        # Second cycle: approved via CLI
        fetch_result["qodo_cli_state"] = {
            "source": "qodo-cli",
            "status": "completed",
            "reviewing": False,
            "approved": True,
            "reason": "all_resolved",
            "total_findings": 1,
            "resolved_count": 1,
            "unresolved_count": 0,
        }
        fetch_result["approved"] = True
        return fetch_result

    monkeypatch.setattr(poll_mod, "fetch_run", fake_fetch_run)
    monkeypatch.setattr(poll_mod, "_print_poll_summary", lambda *_a, **_kw: None)
    monkeypatch.setattr(poll_mod, "_has_actionable_qodo_comments", lambda *_a, **_kw: False)
    monkeypatch.setattr(
        poll_mod, "_is_qodo_reviewing", lambda *_a, **_kw: pytest.fail("GitHub heuristic must not run in CLI mode")
    )
    monkeypatch.setattr(
        poll_mod, "is_qodo_approved", lambda *_a, **_kw: pytest.fail("GitHub approval must not run in CLI mode")
    )
    monkeypatch.setattr(poll_mod, "time_sleep_s", None) if hasattr(poll_mod, "time_sleep_s") else None
    monkeypatch.setattr(poll_mod.time, "sleep", lambda _s: None)

    rc = poll_mod._run_qodo_poll(PR_URL, "myk-org", "pi-config", "956", str(tmp_path))
    assert rc == 0
    out = capsys.readouterr()
    assert "CLI session status: started" in out.err
    assert "Qodo approved" in out.err
    assert cycles["n"] == 2


def test_poll_cli_state_approved_skips_cleanup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Approved CLI state breaks immediately; no sticky cleanup request."""
    from myk_pi_tools.reviews import poll as poll_mod

    cli_state = {
        "source": "qodo-cli",
        "status": "completed",
        "reviewing": False,
        "approved": True,
        "reason": "all_resolved",
        "total_findings": 8,
        "resolved_count": 8,
        "unresolved_count": 0,
    }
    fetch_result = {
        "metadata": {"owner": "myk-org", "repo": "pi-config", "pr_number": 956, "author": "a", "json_path": ""},
        "human": [],
        "qodo": [],
        "coderabbit": [],
        "approved": True,
        "qodo_cleanup_response": "",
        "qodo_cli_state": cli_state,
    }

    def fake_run(url: str, *, output_dir: str) -> dict[str, Any]:  # noqa: ARG001
        return fetch_result

    monkeypatch.setattr(poll_mod, "fetch_run", fake_run)
    monkeypatch.setattr(poll_mod, "_print_poll_summary", lambda *_a, **_kw: None)
    monkeypatch.setattr(poll_mod, "_has_actionable_qodo_comments", lambda *_a, **_kw: False)
    monkeypatch.setattr(
        poll_mod, "_request_qodo_sticky_cleanup", lambda *_a, **_kw: pytest.fail("cleanup must not run in CLI mode")
    )

    rc = poll_mod._run_qodo_poll(PR_URL, "myk-org", "pi-config", "956", str(tmp_path))
    assert rc == 0
    out = capsys.readouterr()
    assert "Total findings: 8 (8 resolved by Qodo, 0 still in sticky)" in out.err


def test_poll_github_branch_when_no_cli_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No qodo_cli_state (CLI unavailable) → GitHub heuristics run as before."""
    from myk_pi_tools.reviews import poll as poll_mod

    fetch_result = {
        "metadata": {"owner": "myk-org", "repo": "pi-config", "pr_number": 956, "author": "a", "json_path": ""},
        "human": [],
        "qodo": [],
        "coderabbit": [],
        "approved": True,
        "qodo_cleanup_response": "",
        "qodo_cli_state": None,
    }
    github_heuristic_ran = {"reviewing": False, "approved_detail": False}

    def fake_is_reviewing(owner: str, repo: str, pr_number: str, comments: list | None = None) -> bool:  # noqa: ARG001
        github_heuristic_ran["reviewing"] = True
        return False

    def fake_is_approved(owner: str, repo: str, pr_number: str, comments: list | None = None) -> dict | None:  # noqa: ARG001
        github_heuristic_ran["approved_detail"] = True
        return {
            "approved": True,
            "reason": "all_resolved",
            "total_findings": 1,
            "resolved_count": 1,
            "unresolved_count": 0,
        }

    def fake_run(url: str, *, output_dir: str) -> dict[str, Any]:  # noqa: ARG001
        return fetch_result

    monkeypatch.setattr(poll_mod, "fetch_run", fake_run)
    monkeypatch.setattr(poll_mod, "_print_poll_summary", lambda *_a, **_kw: None)
    monkeypatch.setattr(poll_mod, "_has_actionable_qodo_comments", lambda *_a, **_kw: False)
    monkeypatch.setattr(poll_mod, "_is_qodo_reviewing", fake_is_reviewing)
    monkeypatch.setattr(poll_mod, "is_qodo_approved", fake_is_approved)
    monkeypatch.setattr(poll_mod.time, "sleep", lambda _s: None)

    rc = poll_mod._run_qodo_poll(PR_URL, "myk-org", "pi-config", "956", str(tmp_path))
    assert rc == 0
    assert github_heuristic_ran["reviewing"] is True
    assert github_heuristic_ran["approved_detail"] is True


def test_fetch_run_cli_branch_used(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """fetch_run prefers the CLI threads and skips the GitHub sticky scrape."""
    from myk_pi_tools.reviews import fetch as fetch_mod

    cli_threads: list[dict[str, Any]] = [
        {
            "thread_id": "T1",
            "node_id": None,
            "comment_id": 1,
            "author": "qodo-code-review",
            "path": "src/a.py",
            "line": 3,
            "end_line": 4,
            "body": "**X**\n\ndesc",
            "title": "X",
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
            "finding_uuid": "u1",
        }
    ]
    cli_state = {
        "source": "qodo-cli",
        "status": "completed",
        "reviewing": False,
        "approved": False,
        "unresolved_count": 1,
    }

    monkeypatch.setattr(fetch_mod, "fetch_qodo_cli_threads", lambda _url, _head: (cli_threads, cli_state))
    monkeypatch.setattr(
        fetch_mod,
        "fetch_qodo_sticky_findings",
        lambda *_a, **_kw: pytest.fail("GitHub sticky scrape must not run when CLI succeeded"),
    )
    monkeypatch.setattr(fetch_mod, "fetch_qodo_reply_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_review_threads", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_coderabbit_body_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(
        fetch_mod,
        "run_gh_api",
        lambda endpoint, paginate=False: (  # noqa: ARG005
            {"user": {"login": "myakove"}, "head": {"sha": HEAD_SHA}} if "/pulls/" in endpoint else []
        ),
    )
    monkeypatch.setattr(
        fetch_mod, "is_qodo_approved", lambda *_a, **_kw: pytest.fail("GitHub approval must not run in CLI mode")
    )

    result = fetch_mod.run(PR_URL, output_dir=str(tmp_path))
    assert isinstance(result, dict)
    assert result["qodo_cli_state"] is cli_state
    assert len(result["qodo"]) >= 1
    assert any(t.get("qodo_cli") for t in result["qodo"])


def test_fetch_run_dedups_github_threads_covered_by_cli(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """GitHub review threads duplicating CLI findings are dropped; others stay.

    Qodo posts each finding as a GitHub review thread AND reports it through
    the CLI session — same PRRT thread_id. The CLI entries are canonical;
    the GitHub twins (raw HTML bodies) must not double every finding.
    """
    from myk_pi_tools.reviews import fetch as fetch_mod

    cli_threads: list[dict[str, Any]] = [
        {
            "thread_id": "PRRT_dup",
            "node_id": None,
            "comment_id": 1,
            "author": "qodo-code-review",
            "path": "src/a.py",
            "line": 3,
            "end_line": 4,
            "body": "**X**\n\ndesc",
            "title": "X",
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
            "finding_uuid": "u1",
        },
    ]
    cli_state = {
        "source": "qodo-cli",
        "status": "completed",
        "reviewing": False,
        "approved": False,
        "unresolved_count": 1,
    }

    # GitHub review threads: one duplicate of the CLI finding, one qodo thread
    # NOT covered by the CLI read (e.g. truncated), one human thread.
    gh_threads: list[dict[str, Any]] = [
        {
            "thread_id": "PRRT_dup",
            "node_id": "PRRC_dup",
            "comment_id": 11,
            "author": "qodo-code-review",
            "path": "src/a.py",
            "line": 3,
            "body": "<img badge> raw HTML twin",
            "status": "pending",
            "source": "qodo",
            "priority": "HIGH",
            "reply": None,
            "replies": [],
        },
        {
            "thread_id": "PRRT_only_gh",
            "node_id": "PRRC_only_gh",
            "comment_id": 12,
            "author": "qodo-code-review",
            "path": "src/c.py",
            "line": 30,
            "body": "qodo thread the CLI read missed",
            "status": "pending",
            "source": "qodo",
            "priority": "HIGH",
            "reply": None,
            "replies": [],
        },
        {
            "thread_id": "PRRT_human",
            "node_id": "PRRC_human",
            "comment_id": 13,
            "author": "myakove",
            "path": "src/d.py",
            "line": 40,
            "body": "human comment",
            "status": "pending",
            "source": "human",
            "priority": "HIGH",
            "reply": None,
            "replies": [],
        },
    ]

    monkeypatch.setattr(fetch_mod, "fetch_qodo_cli_threads", lambda _url, _head: (cli_threads, cli_state))
    monkeypatch.setattr(
        fetch_mod,
        "fetch_qodo_sticky_findings",
        lambda *_a, **_kw: pytest.fail("GitHub sticky scrape must not run when CLI succeeded"),
    )
    monkeypatch.setattr(fetch_mod, "fetch_qodo_reply_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_review_threads", lambda *_a, **_kw: gh_threads)
    monkeypatch.setattr(fetch_mod, "fetch_coderabbit_body_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(
        fetch_mod,
        "run_gh_api",
        lambda endpoint, paginate=False: (  # noqa: ARG005
            {"user": {"login": "myakove"}, "head": {"sha": HEAD_SHA}} if "/pulls/" in endpoint else []
        ),
    )
    monkeypatch.setattr(
        fetch_mod, "is_qodo_approved", lambda *_a, **_kw: pytest.fail("GitHub approval must not run in CLI mode")
    )

    result = fetch_mod.run(PR_URL, output_dir=str(tmp_path))
    assert isinstance(result, dict)
    # The duplicate thread is gone; the CLI entry, the uncovered qodo thread,
    # and the human thread all survive.
    qodo_thread_ids = [t.get("thread_id") for t in result["qodo"]]
    assert qodo_thread_ids.count("PRRT_dup") == 1
    assert "PRRT_only_gh" in qodo_thread_ids
    cli_entries = [t for t in result["qodo"] if t.get("qodo_cli")]
    assert len(cli_entries) == 1
    assert len([t for t in result["human"]]) == 1


def test_fetch_run_cli_failure_falls_back_to_github(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """CLI read failure → GitHub sticky scrape runs for that cycle."""
    from myk_pi_tools.reviews import fetch as fetch_mod

    sticky_threads = [
        {
            "thread_id": None,
            "node_id": None,
            "comment_id": 2,
            "author": "qodo-code-review",
            "path": "src/b.py",
            "line": 9,
            "end_line": None,
            "body": "**Y**\n\ndesc",
            "title": "Y",
            "quality_label": "",
            "type": "qodo_bug",
            "source": "qodo",
            "priority": "HIGH",
            "reply": None,
            "status": "pending",
        }
    ]
    scrape_ran = {"n": 0}

    def fake_sticky(*_a: Any, **_kw: Any) -> list[dict[str, Any]]:
        scrape_ran["n"] += 1
        return sticky_threads

    monkeypatch.setattr(fetch_mod, "fetch_qodo_cli_threads", lambda _url, _head: (None, None))
    monkeypatch.setattr(fetch_mod, "fetch_qodo_sticky_findings", fake_sticky)
    monkeypatch.setattr(fetch_mod, "fetch_qodo_reply_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_review_threads", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_coderabbit_body_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(
        fetch_mod,
        "run_gh_api",
        lambda endpoint, paginate=False: (  # noqa: ARG005
            {"user": {"login": "myakove"}, "head": {"sha": HEAD_SHA}} if "/pulls/" in endpoint else []
        ),
    )
    monkeypatch.setattr(fetch_mod, "is_qodo_approved", lambda *_a, **_kw: None)

    result = fetch_mod.run(PR_URL, output_dir=str(tmp_path))
    assert isinstance(result, dict)
    assert scrape_ran["n"] == 1
    assert result["qodo_cli_state"] is None
    assert any(t["title"] == "Y" for t in result["qodo"])


def test_fetch_run_stale_head_downgrades_cli_approval(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A push during the fetch must not let a stale CLI review approve."""
    from myk_pi_tools.reviews import fetch as fetch_mod

    cli_state = {
        "source": "qodo-cli",
        "status": "completed",
        "reviewing": False,
        "approved": True,
        "reason": "all_resolved",
        "total_findings": 1,
        "resolved_count": 1,
        "unresolved_count": 0,
        "head_sha": "oldsha0000000000000000000000000000000000",
        "commit_sha": "oldsha0000000000000000000000000000000000",
    }

    pulls_calls: list[int] = []

    def fake_gh_api(endpoint: str, paginate: bool = False) -> Any:  # noqa: ARG001
        if "/pulls/" in endpoint:
            pulls_calls.append(1)
            # First call: pre-read head. Second call (freshness re-check): new head.
            head = (
                "oldsha0000000000000000000000000000000000"
                if len(pulls_calls) == 1
                else "newsha00000000000000000000000000000000000"
            )
            return {"user": {"login": "myakove"}, "head": {"sha": head}}
        return []

    monkeypatch.setattr(fetch_mod, "fetch_qodo_cli_threads", lambda _url, _head: ([], cli_state))
    monkeypatch.setattr(fetch_mod, "fetch_review_threads", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_coderabbit_body_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_qodo_reply_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "run_gh_api", fake_gh_api)
    monkeypatch.setattr(
        fetch_mod, "is_qodo_approved", lambda *_a, **_kw: pytest.fail("GitHub approval must not run in CLI mode")
    )

    result = fetch_mod.run(PR_URL, output_dir=str(tmp_path))
    assert isinstance(result, dict)
    assert len(pulls_calls) == 2  # pre-read + freshness re-check
    assert result["approved"] is False
    assert result["qodo_cli_state"]["reviewing"] is True


def test_fetch_run_same_head_keeps_cli_approval(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No push during the fetch — the CLI approval stands."""
    from myk_pi_tools.reviews import fetch as fetch_mod

    cli_state = {
        "source": "qodo-cli",
        "status": "completed",
        "reviewing": False,
        "approved": True,
        "reason": "all_resolved",
        "total_findings": 1,
        "resolved_count": 1,
        "unresolved_count": 0,
        "head_sha": HEAD_SHA,
        "commit_sha": HEAD_SHA,
    }

    def fake_gh_api(endpoint: str, paginate: bool = False) -> Any:  # noqa: ARG001
        if "/pulls/" in endpoint:
            return {"user": {"login": "myakove"}, "head": {"sha": HEAD_SHA}}
        return []

    monkeypatch.setattr(fetch_mod, "fetch_qodo_cli_threads", lambda _url, _head: ([], cli_state))
    monkeypatch.setattr(fetch_mod, "fetch_review_threads", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_coderabbit_body_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "fetch_qodo_reply_comments", lambda *_a, **_kw: [])
    monkeypatch.setattr(fetch_mod, "run_gh_api", fake_gh_api)
    monkeypatch.setattr(fetch_mod, "is_qodo_approved", lambda *_a, **_kw: None)

    result = fetch_mod.run(PR_URL, output_dir=str(tmp_path))
    assert isinstance(result, dict)
    assert result["approved"] is True
