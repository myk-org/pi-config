"""Unit and architectural contract tests for the unified GitHub CLI adapter (issue #1361)."""

from __future__ import annotations

import ast
import json
import subprocess
import types
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from myk_pi_tools import github
from myk_pi_tools.coderabbit import utils as coderabbit_utils
from myk_pi_tools.pr import claude_md
from myk_pi_tools.reviews import pending_fetch, pending_update

REPO_ROOT = Path(__file__).resolve().parents[2]


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


def test_run_gh_returns_stdout_and_zero_code_on_success() -> None:
    proc = subprocess.CompletedProcess(["gh", "api", "user"], 0, stdout='{"login":"octo"}', stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        code, stdout, stderr = github.run_gh(["api", "user"], timeout=15)

    assert (code, stdout, stderr) == (0, '{"login":"octo"}', "")
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


def test_run_gh_api_paginates_and_merges_arrays() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout='[{"id": 1}][{"id": 2}]', stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        result = github.run_gh_api("/repos/o/r/issues/1/comments", paginate=True)

    assert result == [{"id": 1}, {"id": 2}]
    assert mock_run.call_args.args[0] == ["gh", "api", "--paginate", "/repos/o/r/issues/1/comments"]


def test_run_gh_api_passes_method_jq_headers_and_json_input() -> None:
    proc = subprocess.CompletedProcess(["gh"], 0, stdout='{"ok": true}', stderr="")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc) as mock_run:
        result = github.run_gh_api(
            "/repos/o/r/pulls/1/reviews",
            method="POST",
            jq=".ok",
            headers=["Accept: application/vnd.github+json"],
            input_data={"event": "COMMENT"},
            timeout=45,
        )

    assert result == {"ok": True}
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
        "--input",
        "-",
    ]
    assert json.loads(mock_run.call_args.kwargs["input"]) == {"event": "COMMENT"}
    assert mock_run.call_args.kwargs["timeout"] == 45


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


def test_run_gh_graphql_returns_none_and_warns_on_transport_error(capsys: pytest.CaptureFixture[str]) -> None:
    proc = subprocess.CompletedProcess(["gh"], 1, stdout=b"", stderr=b"network error")
    with patch("myk_pi_tools.github.subprocess.run", return_value=proc):
        data = github.run_gh_graphql("query { viewer { login } }", {})

    assert data is None
    assert "GraphQL query failed" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# parse_pr_url & get_pr_info
# ---------------------------------------------------------------------------


def test_get_pr_info_extracts_directly_from_valid_url() -> None:
    assert github.get_pr_info("https://github.com/myk-org/pi-config/pull/1361#discussion_r1") == (
        "myk-org",
        "pi-config",
        "1361",
    )


def test_get_pr_info_resolves_from_branch_and_origin_repo() -> None:
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
# Caller adapter integration tests
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


def test_pending_update_submit_review_posts_via_run_gh() -> None:
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


def test_pending_fetch_helpers_route_through_github_adapter() -> None:
    user_proc = subprocess.CompletedProcess(["gh"], 0, stdout="octocat\n", stderr="")
    diff_proc = subprocess.CompletedProcess(["gh"], 0, stdout="diff --git a/x b/x\n", stderr="")
    with patch("myk_pi_tools.github.subprocess.run", side_effect=[user_proc, diff_proc]):
        assert pending_fetch.get_authenticated_user() == "octocat"
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


# ---------------------------------------------------------------------------
# Architectural invariants (prevent re-duplication)
# ---------------------------------------------------------------------------


def test_coderabbit_utils_has_no_shallow_run_gh_wrapper() -> None:
    source = (REPO_ROOT / "myk_pi_tools/coderabbit/utils.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    defined_funcs = {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
    assert "run_gh" not in defined_funcs
    assert coderabbit_utils.run_gh is github.run_gh


@pytest.mark.parametrize(
    "rel_path",
    [
        "myk_pi_tools/reviews/ask_qodo.py",
        "myk_pi_tools/reviews/pending_fetch.py",
        "myk_pi_tools/reviews/pending_update.py",
    ],
)
def test_sibling_review_modules_do_not_import_reviews_fetch(rel_path: str) -> None:
    source = (REPO_ROOT / rel_path).read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "myk_pi_tools.reviews.fetch":
            pytest.fail(f"{rel_path} must not import from myk_pi_tools.reviews.fetch")


def test_poll_does_not_import_transport_helpers_from_reviews_fetch() -> None:
    source = (REPO_ROOT / "myk_pi_tools/reviews/poll.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    forbidden = {"check_dependencies", "get_pr_info", "print_stderr", "run_gh_api", "run_gh_graphql"}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "myk_pi_tools.reviews.fetch":
            imported = {alias.name for alias in node.names}
            overlap = imported & forbidden
            assert not overlap, f"poll.py still imports transport helpers from fetch.py: {overlap}"


@pytest.mark.parametrize(
    "rel_path",
    [
        "myk_pi_tools/reviews/fetch.py",
        "myk_pi_tools/reviews/post.py",
        "myk_pi_tools/reviews/pending_update.py",
        "myk_pi_tools/reviews/pending_fetch.py",
        "myk_pi_tools/reviews/store_session.py",
        "myk_pi_tools/reviews/status.py",
        "myk_pi_tools/pr/post_comment.py",
        "myk_pi_tools/pr/claude_md.py",
        "myk_pi_tools/pr/common.py",
        "myk_pi_tools/pr/diff.py",
        "myk_pi_tools/coderabbit/utils.py",
        "myk_pi_tools/coderabbit/rate_limit.py",
    ],
)
def test_migrated_modules_have_no_direct_gh_subprocess_calls(rel_path: str) -> None:
    source = (REPO_ROOT / rel_path).read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "run"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "subprocess"
            and node.args
            and isinstance(node.args[0], ast.List)
            and node.args[0].elts
            and isinstance(node.args[0].elts[0], ast.Constant)
            and node.args[0].elts[0].value == "gh"
        ):
            pytest.fail(f"{rel_path} still invokes subprocess.run(['gh', ...]) directly")
