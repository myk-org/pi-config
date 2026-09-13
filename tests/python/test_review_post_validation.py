"""Tests for Qodo sticky finding post validation."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest

from myk_pi_tools.reviews import post
from myk_pi_tools.reviews.post import is_linked_issue_spec_resolution


@pytest.mark.parametrize(
    "reply",
    [
        "Updated the issue spec in internal #782; this finding is resolved by that specification.",
        "The issue specification was updated: https://github.com/myk-org/pi-config/issues/782.",
        "The issue spec was updated: https://github.com/will/example/issues/782.",
        "The issue specification was updated: https://github.com/example/may/issues/782.",
    ],
)
def test_linked_issue_spec_resolution_accepts_explicit_completed_issue_reference(reply: str) -> None:
    """Completed affirmative updates with an allowed issue reference are accepted."""
    assert is_linked_issue_spec_resolution(reply)


@pytest.mark.parametrize(
    "reply",
    [
        "Updated the issue spec; this finding is resolved by that specification.",
        "By design; see #782.",
        "Updated the issue spec in internal issue 782.",
        "Updated the issue spec: https://github.com/myk-org/pi-config/pull/782.",
        "By design; see internal #782.",
        "The issue spec was not updated; see internal #782.",
        "If the issue spec was updated in internal #782, this finding can be skipped.",
        "The issue spec will be updated in internal #782.",
        "Hypothetically, the issue spec was updated in internal #782.",
        "The issue spec was updated in internal #782, but will be published tomorrow.",
        "The issue spec should be updated in internal #782.",
        "We recommend that the issue spec was updated in internal #782.",
        "The proposed issue spec was updated in internal #782.",
    ],
)
def test_linked_issue_spec_resolution_rejects_incomplete_or_unaffirmative_updates(reply: str) -> None:
    """Only affirmative, completed updates tied to an allowed issue are accepted."""
    assert not is_linked_issue_spec_resolution(reply)


def _write_sticky_review(tmp_path: Path, *, status: str, reply: str) -> Path:
    """Create one Qodo sticky finding for validation-path tests."""
    review_file = tmp_path / "reviews.json"
    review_file.write_text(
        json.dumps({
            "metadata": {"owner": "myk-org", "repo": "pi-config", "pr_number": "784"},
            "human": [],
            "qodo": [
                {
                    "thread_id": "thread-id",
                    "type": "qodo_finding",
                    "path": "myk_pi_tools/reviews/post.py",
                    "line": 615,
                    "status": status,
                    "reply": reply,
                }
            ],
            "coderabbit": [],
        }),
        encoding="utf-8",
    )
    return review_file


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (
            "HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nX-GitHub-Request-Id: request-123\r\n\r\n",
            ("application/json", 0, "request-123", ""),
        ),
        (
            'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"data":',
            ("application/json", len(b'{"data":'), "unavailable", '{"data":'),
        ),
        (
            "HTTP/2.0 200 OK\nContent-Type: text/html\nX-Request-ID: request-456\n\n"
            '<html>upstream failure token="token secret" body="reply secret"</html>',
            ("text/html", 70, "request-456", "<html>upstream failure token=[REDACTED] body=[REDACTED]</html>"),
        ),
    ],
)
def test_run_graphql_returns_safe_diagnostics_for_unparseable_success_response(
    monkeypatch: pytest.MonkeyPatch, response: str, expected: tuple[str, int, str, str]
) -> None:
    """Successful but malformed API responses remain actionable and safe to retry."""
    run = Mock(return_value=subprocess.CompletedProcess(["gh"], 0, stdout=response, stderr=""))
    monkeypatch.setattr(post.subprocess, "run", run)

    success, error = post.run_graphql("query { viewer { login } }", {"body": "reply secret", "token": "token secret"})

    content_type, response_bytes, request_id, body_preview = expected
    assert not success
    assert isinstance(error, str)
    assert "Retryable GraphQL response parse failure" in error
    assert "endpoint=graphql method=POST status=200" in error
    assert f"content_type={content_type}" in error
    assert f"response_bytes={response_bytes}" in error
    assert f"request_id={request_id}" in error
    assert f"body_preview={body_preview!r}" in error
    assert "parser_stack=" in error
    assert "reply secret" not in error
    assert "token secret" not in error
    assert run.call_args.args[0] == ["gh", "api", "graphql", "--include", "--input", "-"]


def test_run_graphql_logs_failed_subprocess_at_error_with_safe_metadata(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Nonzero GraphQL subprocess results emit an error-level operational event."""
    monkeypatch.setattr(
        post.subprocess,
        "run",
        Mock(return_value=subprocess.CompletedProcess(["gh"], 1, stdout=b"response", stderr=b"failure")),
    )

    with caplog.at_level("DEBUG", logger="myk_pi_tools.reviews.post"):
        assert post.run_graphql("query", {}) == (False, "response\nfailure")

    record = next(record for record in caplog.records if record.message == "GraphQL request failed")
    assert record.levelname == "ERROR"
    assert {field: record.__dict__[field] for field in ("returncode", "response_bytes", "stderr_bytes")} == {
        "returncode": 1,
        "response_bytes": 8,
        "stderr_bytes": 7,
    }


def test_run_graphql_redacts_secret_crossing_preview_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    """Secrets are redacted before a bounded response preview is taken."""
    secret = "reply-secret-crossing-preview-boundary"  # pragma: allowlist secret
    response = f"HTTP/2.0 200 OK\nContent-Type: text/html\n\n{'x' * 990}{secret}"
    monkeypatch.setattr(
        post.subprocess,
        "run",
        Mock(return_value=subprocess.CompletedProcess(["gh"], 0, stdout=response, stderr="")),
    )

    success, error = post.run_graphql("query", {"body": secret})

    assert not success
    assert secret not in error
    assert secret[:10] not in error
    assert "[REDACTED]" in error


@pytest.mark.parametrize("field", ["access_token", "api_key", "client_secret"])
def test_run_graphql_redacts_common_response_secret_fields(monkeypatch: pytest.MonkeyPatch, field: str) -> None:
    """Response secret fields are redacted even when they were not request variables."""
    secret = "response-only-secret"  # pragma: allowlist secret
    response = f'HTTP/2.0 200 OK\nContent-Type: text/html\n\n<{field} value="{secret}">'
    monkeypatch.setattr(
        post.subprocess,
        "run",
        Mock(return_value=subprocess.CompletedProcess(["gh"], 0, stdout=response, stderr="")),
    )

    success, error = post.run_graphql("query", {})

    assert not success
    assert secret not in error
    assert "[REDACTED]" in error


def test_run_graphql_reports_raw_response_byte_length(monkeypatch: pytest.MonkeyPatch) -> None:
    """Diagnostics report the received bytes rather than decoded replacement characters."""
    response = b"HTTP/2.0 200 OK\r\nContent-Type: text/html\r\n\r\n\xff"
    monkeypatch.setattr(
        post.subprocess,
        "run",
        Mock(return_value=subprocess.CompletedProcess(["gh"], 0, stdout=response, stderr=b"")),
    )

    success, error = post.run_graphql("query", {})

    assert not success
    assert "response_bytes=1" in error


@pytest.mark.parametrize("line_ending", ["\n", "\r\n"])
def test_run_graphql_parses_valid_included_response(monkeypatch: pytest.MonkeyPatch, line_ending: str) -> None:
    """Headers from --include do not prevent valid GraphQL JSON from parsing."""
    response = (
        f"HTTP/2.0 200 OK{line_ending}Content-Type: application/json{line_ending}"
        f'{line_ending}{{"data": {{"ok": true}}}}'
    )
    monkeypatch.setattr(
        post.subprocess,
        "run",
        Mock(return_value=subprocess.CompletedProcess(["gh"], 0, stdout=response, stderr="")),
    )

    assert post.run_graphql("query", {}) == (True, {"data": {"ok": True}})


def test_split_http_response_selects_final_response_after_redirects() -> None:
    """Redirect/proxy headers use the final response."""
    headers, body, status = post._split_http_response(
        "HTTP/1.1 302 Found\nLocation: https://api.github.com/graphql\n\n"
        "HTTP/2.0 200 OK\nContent-Type: application/json\n\n{}"
    )
    assert (headers, body, status) == ({"content-type": "application/json"}, "{}", "200")


def test_split_http_response_returns_fallback_for_headerless_output() -> None:
    """Missing headers stay diagnosable."""
    assert post._split_http_response("not json") == ({}, "not json", "unknown")


def test_response_helpers_emit_safe_structured_logs(caplog: pytest.LogCaptureFixture) -> None:
    """Response parsing logs only operational metadata."""
    with caplog.at_level("DEBUG", logger="myk_pi_tools.reviews.post"):
        post._split_http_response("HTTP/2.0 200 OK\nContent-Type: application/json\n\n{}")
        post._response_body_bytes(b"HTTP/2.0 200 OK\n\n{}")
        post._redact_response_preview('token="secret"', [])

    assert {record.message for record in caplog.records} == {
        "Parsed HTTP response headers",
        "Extracted HTTP response body bytes",
        "Redacted HTTP response preview",
    }


def test_split_http_response_does_not_parse_http_like_body_content() -> None:
    """Only leading --include blocks are headers; HTTP-like body text remains a body."""
    body = "invalid\nHTTP/1.1 200 OK\nContent-Type: forged\n\nbody"
    headers, parsed_body, status = post._split_http_response(f"HTTP/2.0 200 OK\nContent-Type: text/plain\n\n{body}")
    assert (headers, parsed_body, status) == ({"content-type": "text/plain"}, body, "200")


def test_run_allows_valid_linked_issue_spec_skip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A valid linked completed spec update passes validation and is posted."""
    review_file = _write_sticky_review(
        tmp_path,
        status="skipped",
        reply="Updated the issue spec in internal #782; this finding is resolved.",
    )
    post_body_comments = Mock(return_value=(1, [{"cat": "qodo", "idx": 0, "field": "posted_at", "ts": "now"}]))
    monkeypatch.setattr(post, "check_dependencies", lambda: None)
    monkeypatch.setattr(post, "post_body_comment_replies", post_body_comments)

    with pytest.raises(SystemExit, match="0"):
        post.run(str(review_file))

    post_body_comments.assert_called_once()


@pytest.mark.parametrize(
    ("status", "reply"),
    [
        ("skipped", "The issue spec was not updated; see internal #782."),
        ("not_addressed", "Updated the issue spec in internal #782; this finding is resolved."),
    ],
)
def test_run_blocks_invalid_or_non_addressed_sticky_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status: str, reply: str
) -> None:
    """Only a valid linked skip can bypass the addressed sticky status."""
    review_file = _write_sticky_review(tmp_path, status=status, reply=reply)
    post_body_comments = Mock()
    monkeypatch.setattr(post, "check_dependencies", lambda: None)
    monkeypatch.setattr(post, "post_body_comment_replies", post_body_comments)

    with pytest.raises(SystemExit, match="1"):
        post.run(str(review_file))

    post_body_comments.assert_not_called()
