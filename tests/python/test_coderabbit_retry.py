"""Tests for myk_pi_tools.coderabbit.rate_limit.run_retry."""

from __future__ import annotations

from datetime import UTC
from unittest.mock import patch

import pytest

_MODULE = "myk_pi_tools.coderabbit.rate_limit"

_RATE_LIMITED_BODY = (
    "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n"
    "Please wait **2 minutes and 30 seconds** before trying again."
)
_NOT_RATE_LIMITED_BODY = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\nSummary of changes."


def test_not_rate_limited(capsys: pytest.CaptureFixture[str]) -> None:
    """Not rate limited -> exit 0 with not_rate_limited status."""
    with patch(
        f"{_MODULE}._find_summary_comment",
        return_value=(1, _NOT_RATE_LIMITED_BODY, "2025-01-01T00:00:00Z", ""),
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
    out = capsys.readouterr().out
    assert '"not_rate_limited"' in out


def test_rate_limited_wait_elapsed(capsys: pytest.CaptureFixture[str]) -> None:
    """Rate limited but wait already elapsed -> trigger immediately."""
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, _RATE_LIMITED_BODY, "2020-01-01T00:00:00Z", "")),
        patch(f"{_MODULE}._post_and_poll_trigger", return_value=(99, 0)),
        patch(f"{_MODULE}.time") as mock_time,
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_time.sleep.assert_not_called()
    out = capsys.readouterr().out
    assert '"triggered"' in out
    assert '"comment_id": 42' in out


def test_rate_limited_wait_remaining() -> None:
    """Rate limited with remaining wait -> sleep then trigger."""
    from datetime import datetime, timedelta

    recent = (datetime.now(UTC) - timedelta(seconds=30)).isoformat()
    # wait_seconds=150 (2m30s), elapsed=30s -> remaining=120s
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, _RATE_LIMITED_BODY, recent, "")),
        patch(f"{_MODULE}._post_and_poll_trigger", return_value=(99, 0)),
        patch(f"{_MODULE}.time") as mock_time,
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_time.sleep.assert_called_once()
        slept = mock_time.sleep.call_args[0][0]
        assert 115 <= slept <= 125  # ~120s remaining, allow small timing variance


def test_trigger_failure() -> None:
    """Trigger fails -> exit 1."""
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, _RATE_LIMITED_BODY, "2020-01-01T00:00:00Z", "")),
        patch(f"{_MODULE}._post_and_poll_trigger", return_value=(None, 1)),
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 1


def test_invalid_repo() -> None:
    """Invalid repo format -> exit 1."""
    from myk_pi_tools.coderabbit.rate_limit import run_retry

    assert run_retry("bad-format", 1) == 1


def test_unparseable_wait(capsys: pytest.CaptureFixture[str]) -> None:
    """Rate limited but can't parse wait time -> exit 1."""
    bad_body = "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\nNo wait time here."
    with patch(f"{_MODULE}._find_summary_comment", return_value=(42, bad_body, "2025-01-01T00:00:00Z", "")):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 1
    captured = capsys.readouterr()
    assert "Could not parse wait time" in captured.err
    assert captured.out == ""


def test_bad_timestamp_falls_back(capsys: pytest.CaptureFixture[str]) -> None:
    """Bad updated_at -> warn and fall back to full wait."""
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, _RATE_LIMITED_BODY, "not-a-date", "")),
        patch(f"{_MODULE}._post_and_poll_trigger", return_value=(99, 0)),
        patch(f"{_MODULE}.time") as mock_time,
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_time.sleep.assert_called_once_with(150)  # full 2m30s wait
    captured = capsys.readouterr()
    assert "Could not parse comment timestamp" in captured.err
    assert '"triggered"' in captured.out


def test_wait_capped_at_one_hour() -> None:
    """Remaining wait > 1 hour -> sleep capped at 3600s."""
    long_body = (
        "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n"
        "Please wait **120 minutes and 0 seconds** before trying again."
    )
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, long_body, "not-a-date", "")),
        patch(f"{_MODULE}._post_and_poll_trigger", return_value=(99, 0)) as mock_poll,
        patch(f"{_MODULE}.time") as mock_time,
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_time.sleep.assert_called_once_with(3600)
        assert mock_poll.call_args.kwargs.get("output") is not None


def test_run_check_includes_updated_at(capsys: pytest.CaptureFixture[str]) -> None:
    """run_check rate_limited JSON includes updated_at field."""
    with patch(
        f"{_MODULE}._find_summary_comment",
        return_value=(42, _RATE_LIMITED_BODY, "2025-01-01T00:00:00Z", ""),
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_check

        assert run_check("owner/repo", 1) == 0
    out = capsys.readouterr().out
    import json as _json

    result = _json.loads(out)
    assert result["rate_limited"] is True
    assert result["updated_at"] == "2025-01-01T00:00:00Z"
    assert "wait_seconds" in result
    assert "comment_id" in result
