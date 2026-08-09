"""Tests for myk_pi_tools.coderabbit.rate_limit.run_retry."""

from __future__ import annotations

from datetime import UTC
from typing import Any
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
        patch(f"{_MODULE}._post_review_trigger", return_value=99),
        patch(f"{_MODULE}._find_trigger_reply", return_value=True) as mock_find_reply,
        patch(f"{_MODULE}.time") as mock_time,
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_time.sleep.assert_not_called()
        mock_find_reply.assert_called_with("owner/repo", 1, 99)
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
        patch(f"{_MODULE}._post_review_trigger", return_value=99),
        patch(f"{_MODULE}._find_trigger_reply", return_value=True) as mock_find_reply,
        patch(f"{_MODULE}.time") as mock_time,
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_time.sleep.assert_called_once()
        slept = mock_time.sleep.call_args[0][0]
        assert 115 <= slept <= 125  # ~120s remaining, allow small timing variance
        mock_find_reply.assert_called_with("owner/repo", 1, 99)


def test_trigger_failure() -> None:
    """Trigger fails -> exit 1."""
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, _RATE_LIMITED_BODY, "2020-01-01T00:00:00Z", "")),
        patch(f"{_MODULE}._post_review_trigger", return_value=None),
        patch(f"{_MODULE}.time"),
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 1


def test_invalid_repo() -> None:
    """Invalid repo format -> exit 1."""
    from myk_pi_tools.coderabbit.rate_limit import run_retry

    assert run_retry("bad-format", 1) == 1


_UNPARSEABLE_BODY = "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\nNo wait time here."


def _unparseable_wait_fallback_patches() -> Any:
    """Shared patches for unparseable-wait fallback tests (45-min-old comment)."""
    from datetime import datetime, timedelta

    # Comment posted 45 min ago -> remaining ~900s
    ts = (datetime.now(UTC) - timedelta(minutes=45)).isoformat()
    return (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, _UNPARSEABLE_BODY, ts, "")),
        patch(f"{_MODULE}._post_review_trigger", return_value=99),
        patch(f"{_MODULE}._find_trigger_reply", return_value=True),
        patch(f"{_MODULE}.time"),
    )


def test_unparseable_wait_fallback_warns(capsys: pytest.CaptureFixture[str]) -> None:
    """Unparseable wait time -> warn on stderr."""
    summary, trigger, find_reply, mock_time = _unparseable_wait_fallback_patches()
    with summary, trigger, find_reply as mock_find_reply, mock_time:
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_find_reply.assert_called_once_with("owner/repo", 1, 99)
    assert "Could not parse wait time" in capsys.readouterr().err


def test_unparseable_wait_fallback_triggers(capsys: pytest.CaptureFixture[str]) -> None:
    """Unparseable wait time -> trigger with ~900s waited_seconds."""
    import json as _json

    summary, trigger, find_reply, mock_time = _unparseable_wait_fallback_patches()
    with summary, trigger, find_reply as mock_find_reply, mock_time:
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_find_reply.assert_called_once_with("owner/repo", 1, 99)
    result = _json.loads(capsys.readouterr().out)
    assert result["status"] == "triggered"
    assert 850 <= result["waited_seconds"] <= 950  # ~900s remaining


def test_unparseable_wait_fallback_waits_remaining(capsys: pytest.CaptureFixture[str]) -> None:
    """Unparseable wait time with remaining cooldown -> wait message on stderr."""
    summary, trigger, find_reply, mock_time = _unparseable_wait_fallback_patches()
    with summary, trigger, find_reply as mock_find_reply, mock_time:
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_find_reply.assert_called_once_with("owner/repo", 1, 99)
    assert "Rate limited — waiting" in capsys.readouterr().err


def test_unparseable_wait_expired(capsys: pytest.CaptureFixture[str]) -> None:
    """No-wait-time body 90 min old -> wait_seconds = 0, trigger immediately."""
    from datetime import datetime, timedelta

    ts = (datetime.now(UTC) - timedelta(minutes=90)).isoformat()
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, _UNPARSEABLE_BODY, ts, "")),
        patch(f"{_MODULE}._post_review_trigger", return_value=99),
        patch(f"{_MODULE}._find_trigger_reply", return_value=True) as mock_find_reply,
        patch(f"{_MODULE}.time"),
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_find_reply.assert_called_once_with("owner/repo", 1, 99)
    captured = capsys.readouterr()
    assert '"triggered"' in captured.out
    assert "triggering immediately" in captured.err or "expired" in captured.err


def test_run_check_unparseable_fallback(capsys: pytest.CaptureFixture[str]) -> None:
    """run_check with no-wait-time body -> JSON with fallback: true, exit 0."""
    bad_body = "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\nNo wait time here."
    from datetime import datetime, timedelta

    ts = (datetime.now(UTC) - timedelta(minutes=45)).isoformat()
    with patch(f"{_MODULE}._find_summary_comment", return_value=(42, bad_body, ts, "")):
        from myk_pi_tools.coderabbit.rate_limit import run_check

        assert run_check("owner/repo", 1) == 0
    import json as _json

    out = capsys.readouterr().out
    result = _json.loads(out)
    assert result["rate_limited"] is True
    assert result["fallback"] is True
    assert 850 <= result["wait_seconds"] <= 950


def test_bad_timestamp_falls_back(capsys: pytest.CaptureFixture[str]) -> None:
    """Bad updated_at -> warn and fall back to full wait."""
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, _RATE_LIMITED_BODY, "not-a-date", "")),
        patch(f"{_MODULE}._post_review_trigger", return_value=99),
        patch(f"{_MODULE}._find_trigger_reply", return_value=True) as mock_find_reply,
        patch(f"{_MODULE}.time") as mock_time,
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_time.sleep.assert_called_once_with(150)  # full 2m30s wait
        mock_find_reply.assert_called_with("owner/repo", 1, 99)
    captured = capsys.readouterr()
    assert "Could not parse comment timestamp" in captured.err
    assert '"triggered"' in captured.out


def test_wait_capped_at_one_hour(capsys: pytest.CaptureFixture[str]) -> None:
    """Remaining wait > 1 hour -> sleep capped at 3600s."""
    long_body = (
        "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n"
        "Please wait **120 minutes and 0 seconds** before trying again."
    )
    with (
        patch(f"{_MODULE}._find_summary_comment", return_value=(42, long_body, "not-a-date", "")),
        patch(f"{_MODULE}._post_review_trigger", return_value=99),
        patch(f"{_MODULE}._find_trigger_reply", return_value=True) as mock_find_reply,
        patch(f"{_MODULE}.time") as mock_time,
    ):
        from myk_pi_tools.coderabbit.rate_limit import run_retry

        assert run_retry("owner/repo", 1) == 0
        mock_time.sleep.assert_called_once_with(3600)
        mock_find_reply.assert_called_with("owner/repo", 1, 99)
    captured = capsys.readouterr()
    # Poll progress goes to stderr (output=sys.stderr)
    assert "Posting @coderabbitai review..." in captured.err
    assert "Review triggered confirmed!" in captured.err


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


class TestParseWaitSeconds:
    """Tests for _parse_wait_seconds with various duration formats."""

    def test_legacy_minutes_with_seconds(self) -> None:
        """Legacy format: 'Please wait **2 minutes and 30 seconds**' -> 150."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Please wait **2 minutes and 30 seconds** before trying again."
        assert _parse_wait_seconds(body) == 150

    def test_please_wait_for(self) -> None:
        """'Please wait for' phrasing with duration."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Please wait for **45 minutes** before trying again."
        assert _parse_wait_seconds(body) == 2700

    def test_please_wait_for_plain(self) -> None:
        """'Please wait for' without bold markers."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Please wait for 45 minutes before trying again."
        assert _parse_wait_seconds(body) == 2700

    def test_minutes_only(self) -> None:
        """New format: '**58 minutes**' -> 3480."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **58 minutes**"
        assert _parse_wait_seconds(body) == 3480

    def test_hours_only(self) -> None:
        """Hours only: '**2 hours**' -> 7200."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **2 hours**"
        assert _parse_wait_seconds(body) == 7200

    def test_seconds_only(self) -> None:
        """Seconds only: '**90 seconds**' -> 90."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **90 seconds**"
        assert _parse_wait_seconds(body) == 90

    def test_hours_with_minutes(self) -> None:
        """Combined: '**1 hour and 30 minutes**' -> 5400."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **1 hour and 30 minutes**"
        assert _parse_wait_seconds(body) == 5400

    def test_compound_without_conjunction(self) -> None:
        """Compound duration without 'and' separator."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **1 hour 30 minutes**"
        assert _parse_wait_seconds(body) == 5400

    def test_compound_with_comma(self) -> None:
        """Compound duration with comma separator."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **1 hour, 30 minutes**"
        assert _parse_wait_seconds(body) == 5400

    def test_three_part_compound(self) -> None:
        """Three-part compound duration."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **2 hours 5 minutes 10 seconds**"
        assert _parse_wait_seconds(body) == 7510

    def test_no_duration_returns_none(self) -> None:
        """No parseable duration -> None."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "No wait time information here."
        assert _parse_wait_seconds(body) is None

    def test_mixed_durations_anchored(self) -> None:
        """Duration near 'Next review available in' is preferred over stray body text."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Some text mentioning 2 hours ago. **Next review available in:** **58 minutes**"
        assert _parse_wait_seconds(body) == 3480

    def test_anchored_with_trailing_text(self) -> None:
        """Anchored parsing works when duration is followed by newline + unrelated text."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **58 minutes**\n\nAdditional details: cooldown lasts 2 hours."
        assert _parse_wait_seconds(body) == 3480

    def test_context_phrase_without_tokens_returns_none(self) -> None:
        """Context phrase found but no duration tokens → None, not body-wide match."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** soon. Mentioning 2 hours elsewhere."
        assert _parse_wait_seconds(body) is None

    def test_body_wide_scan_no_context_phrase(self) -> None:
        """No context phrase → body-wide scan picks up duration tokens."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Rate limited. Retry after 45 minutes."
        assert _parse_wait_seconds(body) == 2700

    def test_same_line_trailing_duration_ignored(self) -> None:
        """Only the duration immediately after the phrase is parsed, not trailing text."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:** **58 minutes** then 2 hours later"
        assert _parse_wait_seconds(body) == 3480

    def test_duration_on_next_line(self) -> None:
        """Duration on line after phrase is still parsed."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "**Next review available in:**\n**58 minutes**"
        assert _parse_wait_seconds(body) == 3480

    def test_phrase_with_comma_separator(self) -> None:
        """Comma after phrase still parses duration."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Please wait, 45 minutes before trying again."
        assert _parse_wait_seconds(body) == 2700

    def test_phrase_with_period_separator(self) -> None:
        """Period after phrase still parses duration."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Please wait. 45 minutes before trying again."
        assert _parse_wait_seconds(body) == 2700

    def test_phrase_with_dash_separator(self) -> None:
        """Em dash after phrase still parses duration."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Next review available in — 58 minutes"
        assert _parse_wait_seconds(body) == 3480

    def test_body_wide_multiple_durations_first_match(self) -> None:
        """Multiple unrelated durations without phrase → only first match used."""
        from myk_pi_tools.coderabbit.rate_limit import _parse_wait_seconds

        body = "Rate limited. Retry after 45 minutes. The window resets every 2 hours."
        assert _parse_wait_seconds(body) == 2700
