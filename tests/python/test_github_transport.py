"""Unit and transport behavior tests for the unified GitHub CLI adapter (issue #1361)."""

from __future__ import annotations

import json
import subprocess
import types
from typing import Any
from unittest.mock import patch

import pytest

from myk_pi_tools import github
from myk_pi_tools.coderabbit import rate_limit
from myk_pi_tools.coderabbit import utils as coderabbit_utils
from myk_pi_tools.pr import claude_md
from myk_pi_tools.reviews import pending_fetch, pending_update, poll, store_session

# ---------------------------------------------------------------------------
# check_dependencies
# ---------------------------------------------------------------------------


def test_check_dependencies_succeeds_when_all_binaries_exist() -> None:
    with patch("myk_pi_tools.github.shutil.which", return_value="/usr/bin/gh"):
        github.check_dependencies(("gh", "git"))


def test_check_dependencies_exits_when_gh_missing(capsys: pytest.CaptureFixture[str]) -> None:
    with (
        patch("myk_pi_tools.github.shutil.which", return_value=None),
        pytest.raises(SystemExit) as exc,
    ):
        github.check_dependencies()

    assert exc.value.code == 1
    assert "'gh' is required but not installed." in capsys.readouterr().err


def test_check_dependencies_uses_custom_error_message(capsys: pytest.CaptureFixture[str]) -> None:
    with (
        patch("myk_pi_tools.github.shutil.which", return_value=None),
        pytest.raises(SystemExit) as exc,
    ):
        github.check_dependencies(("gh",), error_message="Custom missing gh error")

    assert exc.value.code == 1
    assert "Custom missing gh error" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# run_gh
# ---------------------------------------------------------------------------


def test_run_gh_returns_stdout_on_success() -> None:
    proc = subprocess.CompletedProcess(["gh", "api", "user"], 0, stdout='{"login":"octo"}', stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        code, stdout, stderr = github.run_gh(["api", "user"])

    assert (code, stdout, stderr) == (0, '{"login":"octo"}', "")


def test_run_gh_forwards_arguments_with_timeout() -> None:
    proc = subprocess.CompletedProcess(["gh", "api", "user"], 0, stdout="{}", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        github.run_gh(["api", "user"], timeout=15)

    assert mock_run.call_args.args[0] == ["gh", "api", "user"]
    assert mock_run.call_args.kwargs["timeout"] == 15


def test_run_gh_handles_missing_binary() -> None:
    with patch("myk_pi_tools.github.subprocess.run", side_effect=FileNotFoundError):
        code, stdout, stderr = github.run_gh(["--version"])

    assert code == 1
    assert stdout == ""
    assert "gh CLI not found" in stderr


def test_run_gh_handles_timeout() -> None:
    with patch("myk_pi_tools.github.subprocess.run", side_effect=subprocess.TimeoutExpired(["gh"], 12)):
        code, stdout, stderr = github.run_gh(["api", "user"], timeout=12)

    assert code == 1
    assert stdout == ""
    assert "timed out after 12s" in stderr


def test_run_gh_handles_os_error() -> None:
    with patch("myk_pi_tools.github.subprocess.run", side_effect=OSError("exec failed")):
        code, stdout, stderr = github.run_gh(["api", "user"])

    assert code == 1
    assert stdout == ""
    assert "exec failed" in stderr


def test_run_gh_normalizes_minimal_result_double_without_stderr() -> None:
    minimal = types.SimpleNamespace(returncode=0, stdout="ok")
    with patch("myk_pi_tools.github.subprocess.run", return_value=minimal):
        code, stdout, stderr = github.run_gh(["api", "user"])

    assert (code, stdout, stderr) == (0, "ok", "")


# ---------------------------------------------------------------------------
# merge_paginated_json & run_gh_api
# ---------------------------------------------------------------------------


def test_merge_paginated_json_merges_concatenated_arrays_with_brackets_in_strings() -> None:
    raw = '[{"patch":"d[\\"a\\"][\\"b\\"]"}]\n[{"id":2}]'
    assert github.merge_paginated_json(raw) == [{"patch": 'd["a"]["b"]'}, {"id": 2}]


def test_merge_paginated_json_handles_empty_whitespace() -> None:
    assert github.merge_paginated_json("   \n\t ") == []


def test_run_gh_api_returns_parsed_json_for_single_page() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout='{"id": 42}', stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        result = github.run_gh_api("/repos/o/r/pulls/1")

    assert result == {"id": 42}
    assert mock_run.call_args.args[0] == ["gh", "api", "/repos/o/r/pulls/1"]


def test_run_gh_api_adds_paginate_flag() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout="[]", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        github.run_gh_api("/repos/o/r/issues/1/comments", paginate=True)

    assert mock_run.call_args.args[0] == ["gh", "api", "--paginate", "/repos/o/r/issues/1/comments"]


def test_run_gh_api_merges_paginated_arrays() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout='[{"id": 1}][{"id": 2}]', stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        result = github.run_gh_api("/repos/o/r/issues/1/comments", paginate=True)

    assert result == [{"id": 1}, {"id": 2}]


def test_run_gh_api_forwards_method_headers_jq_flags() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout='{"ok": true}', stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        github.run_gh_api(
            "/repos/o/r/pulls/1/reviews",
            method="POST",
            jq=".ok",
            headers=["Accept: application/vnd.github+json"],
            timeout=45,
        )

    assert mock_run.call_args.args[0] == [
        "gh",
        "api",
        "--method",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "--jq",
        ".ok",
        "/repos/o/r/pulls/1/reviews",
    ]
    assert mock_run.call_args.kwargs["timeout"] == 45


def test_run_gh_api_serializes_json_input_on_stdin() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout='{"ok": true}', stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        result = github.run_gh_api(
            "/repos/o/r/pulls/1/reviews",
            method="POST",
            input_data={"event": "COMMENT"},
        )

    assert result == {"ok": True}
    assert mock_run.call_args.args[0][-2:] == ["--input", "-"]
    assert json.loads(mock_run.call_args.kwargs["input"]) == {"event": "COMMENT"}


def test_run_gh_api_quiet_suppresses_stderr_on_failure(capsys: pytest.CaptureFixture[str]) -> None:
    proc = subprocess.CompletedProcess(["gh"], 1, stdout="", stderr="404 Not Found")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        result = github.run_gh_api("/repos/o/r/pulls/999", quiet=True)

    assert result is None
    assert capsys.readouterr().err == ""


def test_run_gh_api_reports_invalid_json_to_stderr(capsys: pytest.CaptureFixture[str]) -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout="not-json", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        result = github.run_gh_api("/repos/o/r/pulls/1")

    assert result is None
    assert "Error parsing JSON from gh api" in capsys.readouterr().err


def test_run_gh_api_result_returns_error_message_on_failure() -> None:
    proc = subprocess.CompletedProcess(["gh"], 1, stdout="", stderr="gh: API rate limit exceeded")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        data, error = github.run_gh_api_result("/repos/o/r/pulls/1/comments", paginate=True)

    assert data is None
    assert "API rate limit exceeded" in error


# ---------------------------------------------------------------------------
# GraphQL transport (partial data, non-string variables, errors, redaction)
# ---------------------------------------------------------------------------


def test_run_graphql_raw_preserves_partial_data_on_nonzero_exit() -> None:
    body = json.dumps({
        "data": {"addPullRequestReviewThreadReply": {"comment": {"id": "C1"}}, "resolveReviewThread": None},
        "errors": [{"message": "Forbidden"}],
    })
    proc = subprocess.CompletedProcess(
        ["gh"],
        1,
        stdout=f"HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{body}".encode(),
        stderr=b"gh: Forbidden",
    )
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        ok, data, err = github.run_graphql_raw("mutation { ... }", {"threadId": "T1"})

    assert ok is True
    assert data is not None
    assert data["data"]["addPullRequestReviewThreadReply"]["comment"]["id"] == "C1"
    assert "Forbidden" in err


def test_run_graphql_raw_strips_http_headers_from_nonzero_error_output() -> None:
    raw = (
        "HTTP/2.0 422 Unprocessable Entity\r\n"
        "Content-Type: application/json\r\n"
        "X-GitHub-Request-Id: req-999\r\n"
        "\r\n"
        '{"message":"Validation Failed"}'
    )
    proc = subprocess.CompletedProcess(["gh"], 1, stdout=raw.encode(), stderr=b"gh: Validation Failed")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        ok, data, err = github.run_graphql_raw("mutation { ... }", {})

    assert (ok, data) == (False, None)
    assert "HTTP/2.0" not in err
    assert "X-GitHub-Request-Id" not in err
    assert "Validation Failed" in err


def test_run_graphql_raw_redacts_reflected_variables_on_nonzero_exit() -> None:
    review_text = "private-review-comment-body-secret"  # pragma: allowlist secret
    raw = f"HTTP/2.0 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\nreflected {review_text}"
    proc = subprocess.CompletedProcess(["gh"], 1, stdout=raw.encode(), stderr=f"stderr {review_text}".encode())
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        ok, data, err = github.run_graphql_raw("mutation { ... }", {"id": "PRRC_1", "body": review_text})

    assert (ok, data) == (False, None)
    assert review_text not in err
    assert "[REDACTED]" in err


def test_run_graphql_raw_handles_missing_gh_binary() -> None:
    with patch("myk_pi_tools.github.subprocess.run", side_effect=FileNotFoundError):
        ok, data, err = github.run_graphql_raw("query { viewer { login } }", {})

    assert (ok, data) == (False, None)
    assert "gh CLI not found" in err


def test_run_graphql_raw_handles_timeout() -> None:
    with patch("myk_pi_tools.github.subprocess.run", side_effect=subprocess.TimeoutExpired(["gh"], 30)):
        ok, data, err = github.run_graphql_raw("query { viewer { login } }", {}, timeout=30)

    assert (ok, data) == (False, None)
    assert "timed out after 30 seconds" in err


def test_run_graphql_raw_rejects_non_object_json_body() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout=b"HTTP/2.0 200 OK\n\n[]", stderr=b"")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        ok, data, err = github.run_graphql_raw("query { viewer { login } }", {})

    assert (ok, data) == (False, None)
    assert "Unexpected GraphQL JSON response type" in err


def test_run_graphql_redacts_secrets_when_variables_include_non_strings() -> None:
    secret = "super-secret-reply-value"  # pragma: allowlist secret
    raw = f"HTTP/2.0 200 OK\nContent-Type: text/plain\n\nreflected {secret}"
    proc = subprocess.CompletedProcess(["gh"], 0, stdout=raw.encode(), stderr=b"")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        ok, err = github.run_graphql("query($pr: Int!, $body: String!) { ... }", {"pr": 42, "body": secret})

    assert ok is False
    assert isinstance(err, str)
    assert secret not in err
    assert "[REDACTED]" in err


def test_run_graphql_returns_first_graphql_error_message() -> None:
    body = json.dumps({"data": None, "errors": [{"message": "Rate limit exceeded"}]})
    proc = subprocess.CompletedProcess(["gh"], 0, stdout=f"HTTP/2.0 200 OK\n\n{body}".encode(), stderr=b"")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        ok, err = github.run_graphql("query { viewer { login } }", {})

    assert (ok, err) == (False, "Rate limit exceeded")


def test_run_gh_graphql_returns_payload_with_errors_for_caller_inspection() -> None:
    body = json.dumps({"data": {"repository": None}, "errors": [{"message": "Could not resolve"}]})
    proc = subprocess.CompletedProcess(["gh"], 1, stdout=f"HTTP/2.0 200 OK\n\n{body}".encode(), stderr=b"")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        data = github.run_gh_graphql("query($pr: Int!) { ... }", {"pr": 99})

    assert data == {"data": {"repository": None}, "errors": [{"message": "Could not resolve"}]}


def test_run_gh_graphql_returns_none_on_transport_error() -> None:
    proc = subprocess.CompletedProcess(["gh"], 1, stdout=b"", stderr=b"network error")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        data = github.run_gh_graphql("query { viewer { login } }", {})

    assert data is None


def test_run_gh_graphql_prints_warning_on_transport_error(capsys: pytest.CaptureFixture[str]) -> None:
    proc = subprocess.CompletedProcess(["gh"], 1, stdout=b"HTTP/2.0 502 Bad Gateway\r\n\r\n", stderr=b"network error")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        github.run_gh_graphql("query { viewer { login } }", {})

    err = capsys.readouterr().err
    assert "GraphQL query failed: network error" in err
    assert "HTTP/2.0" not in err


# ---------------------------------------------------------------------------
# parse_pr_url & get_pr_info
# ---------------------------------------------------------------------------


def test_get_pr_info_extracts_directly_from_valid_url() -> None:
    assert github.get_pr_info("https://github.com/myk-org/pi-config/pull/1361#discussion_r1") == (
        "myk-org",
        "pi-config",
        "1361",
    )


def test_get_pr_info_resolves_from_current_branch() -> None:
    def fake_run(cmd: list[str], **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        if cmd[:3] == ["git", "rev-parse", "--abbrev-ref"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="feat/test\n", stderr="")
        if cmd[:3] == ["git", "remote", "get-url"]:
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="no upstream")
        if cmd[:3] == ["gh", "pr", "view"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="1361\n", stderr="")
        if cmd[:3] == ["gh", "repo", "view"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="myk-org/pi-config\n", stderr="")
        raise AssertionError(f"Unexpected cmd: {cmd}")

    with patch("myk_pi_tools.github.subprocess.run", side_effect=fake_run):
        assert github.get_pr_info("") == ("myk-org", "pi-config", "1361")


# ---------------------------------------------------------------------------
# Caller transport behavior tests
# ---------------------------------------------------------------------------


def test_pending_update_comment_body_maps_graphql_not_found() -> None:
    body = json.dumps({"data": {"updatePullRequestReviewComment": None}, "errors": [{"message": "NOT_FOUND"}]})
    proc = subprocess.CompletedProcess(["gh"], 1, stdout=f"HTTP/2.0 200 OK\n\n{body}".encode(), stderr=b"")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        assert pending_update.update_comment_body("PRRC_123", "Updated comment") == "not_found"


def test_pending_update_comment_body_succeeds_via_unified_graphql() -> None:
    body = json.dumps({"data": {"updatePullRequestReviewComment": {"pullRequestReviewComment": {"id": "PRRC_123"}}}})
    proc = subprocess.CompletedProcess(["gh"], 0, stdout=f"HTTP/2.0 200 OK\n\n{body}".encode(), stderr=b"")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        assert pending_update.update_comment_body("PRRC_123", "Updated comment") == "success"


def test_pending_update_comment_body_redacts_review_text_on_failure(capsys: pytest.CaptureFixture[str]) -> None:
    review_text = "sensitive-draft-review-comment"  # pragma: allowlist secret
    raw = f"HTTP/2.0 500 Error\r\nX-GitHub-Request-Id: req-1\r\n\r\nreflected {review_text}"
    proc = subprocess.CompletedProcess(["gh"], 1, stdout=raw.encode(), stderr=b"gh: internal error")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        assert pending_update.update_comment_body("PRRC_123", review_text) == "error"

    err = capsys.readouterr().err
    assert review_text not in err
    assert "HTTP/2.0" not in err
    assert "internal error" in err


def test_pending_update_submit_review_posts_via_github_adapter() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout="{}", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        assert pending_update.submit_review("org", "repo", 10, 20, "COMMENT", "LGTM") is True

    assert mock_run.call_args.args[0] == [
        "gh",
        "api",
        "--method",
        "POST",
        "/repos/org/repo/pulls/10/reviews/20/events",
        "--input",
        "-",
    ]


def test_pending_fetch_authenticated_user_uses_github_adapter() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout="octocat\n", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        assert pending_fetch.get_authenticated_user() == "octocat"


def test_pending_fetch_pr_diff_uses_github_adapter() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout="diff --git a/x b/x\n", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        assert pending_fetch.fetch_pr_diff("org", "repo", "7") == "diff --git a/x b/x\n"


def test_pr_claude_md_fetch_from_github_routes_through_github_adapter() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout="# AGENTS\n", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        assert claude_md.fetch_from_github("org", "repo", "AGENTS.md") == "# AGENTS\n"

    assert mock_run.call_args.args[0] == [
        "gh",
        "api",
        "/repos/org/repo/contents/AGENTS.md",
        "-H",
        "Accept: application/vnd.github.raw",
    ]


def test_coderabbit_find_summary_comment_routes_through_github_adapter() -> None:
    payload = json.dumps({"id": 7, "body": coderabbit_utils.SUMMARY_MARKER, "updated_at": "2026-01-01T00:00:00Z"})
    proc = subprocess.CompletedProcess(["gh"], 0, stdout=f"{payload}\n", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        cid, body, updated_at, error = coderabbit_utils.find_summary_comment("org/repo", 12)

    assert (cid, body, updated_at, error) == (7, coderabbit_utils.SUMMARY_MARKER, "2026-01-01T00:00:00Z", "")


def test_coderabbit_trigger_reply_lookup_routes_through_github_adapter() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout="1\n", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        assert rate_limit._find_trigger_reply("org/repo", 12, 100) is True


def test_poll_is_qodo_reviewing_routes_through_github_adapter() -> None:
    comments = [{"user": {"login": "qodo-code-review[bot]"}, "body": "<h3>Looking for bugs?</h3>"}]
    proc = subprocess.CompletedProcess(["gh"], 0, stdout=json.dumps(comments), stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        assert poll._is_qodo_reviewing("org", "repo", "12") is True


def test_store_session_prefetch_logs_warning_with_failure_cause(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(store_session, "_INLINE_LOCATION_CACHE", {})
    proc = subprocess.CompletedProcess(["gh"], 1, stdout="", stderr="gh: HTTP 403 API rate limit exceeded")
    with (
        patch("myk_pi_tools.github.subprocess.run", return_value=proc),
        caplog.at_level("WARNING", logger="myk_pi_tools.reviews.store_session"),
    ):
        store_session._prefetch_inline_locations("org", "repo", 55, [])

    warnings = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert any("org/repo#55" in msg and "API rate limit exceeded" in msg for msg in warnings)
