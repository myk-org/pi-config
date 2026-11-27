"""Unit tests for check-run-based CodeRabbit rate-limit detection (issue #1015)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from myk_pi_tools.coderabbit import rate_limit, utils
from myk_pi_tools.coderabbit.approved import _APPROVED_MARKER
from myk_pi_tools.coderabbit.rate_limit import (
    _REVIEWS_PAUSED_MARKER,
    DEFAULT_RATE_LIMIT_WINDOW,
    RateLimitStatus,
    detect_rate_limit,
    run_check,
)
from myk_pi_tools.coderabbit.utils import (
    CODERABBIT_APP_SLUG,
    CODERABBIT_BOT_LOGIN,
    CODERABBIT_CHECK_NAME,
    SUMMARY_MARKER,
    find_coderabbit_check_run,
    find_rate_limit_reply_comment,
)
from myk_pi_tools.reviews import fetch, poll

_SHA = "abc1234"


def _make_check_run(
    *,
    run_id: int = 1001,
    name: str = CODERABBIT_CHECK_NAME,
    app_slug: str = CODERABBIT_APP_SLUG,
    status: str = "completed",
    conclusion: str | None = "neutral",
    title: str = "Review rate limited",
    summary: str = "Rate limit exceeded for this repository.",
    text: str = "",
    started_at: str = "2026-04-01T10:00:00Z",
    completed_at: str | None = "2026-04-01T10:01:00Z",
    head_sha: str | None = _SHA,
) -> dict[str, Any]:
    run: dict[str, Any] = {
        "id": run_id,
        "name": name,
        "app": {"slug": app_slug},
        "status": status,
        "conclusion": conclusion,
        "started_at": started_at,
        "completed_at": completed_at,
        "output": {
            "title": title,
            "summary": summary,
            "text": text,
        },
    }
    if head_sha is not None:
        run["head_sha"] = head_sha
    return run


def _make_comment(
    *,
    comment_id: int = 5001,
    login: str = CODERABBIT_BOT_LOGIN,
    body: str = "Rate limit exceeded. Your next included review will be available in 44 minutes.",
    created_at: str = "2026-04-01T10:00:31Z",
    updated_at: str | None = None,
) -> dict[str, Any]:
    return {
        "id": comment_id,
        "user": {"login": login},
        "body": body,
        "created_at": created_at,
        "updated_at": updated_at or created_at,
    }


def _freeze_rate_limit_now(now: datetime) -> MagicMock:
    mock_dt = MagicMock()
    mock_dt.now.return_value = now
    mock_dt.fromisoformat = datetime.fromisoformat
    return mock_dt


class TestFindCoderabbitCheckRun:
    """Tests for utils.find_coderabbit_check_run."""

    def test_matches_coderabbit_name_and_app_slug_and_populates_head_sha(self) -> None:
        run = _make_check_run(run_id=77, head_sha=None)
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), ({"check_runs": [run]}, "")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 6743)

        assert err == ""
        assert found is not None
        assert found["id"] == 77
        assert found["head_sha"] == _SHA

    def test_ignores_non_coderabbit_app_with_same_name(self) -> None:
        impostor = _make_check_run(run_id=10, name=CODERABBIT_CHECK_NAME, app_slug="other-app")
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), ({"check_runs": [impostor]}, "")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert found is None
        assert err == ""

    def test_ignores_coderabbit_app_with_different_name(self) -> None:
        other = _make_check_run(run_id=11, name="CodeRabbit Finishing Touches", app_slug=CODERABBIT_APP_SLUG)
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), ({"check_runs": [other]}, "")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert found is None
        assert err == ""

    def test_newer_success_supersedes_older_neutral_rate_limited_run(self) -> None:
        older_neutral = _make_check_run(
            run_id=100,
            conclusion="neutral",
            title="Review rate limited",
            started_at="2026-04-01T10:00:00Z",
            completed_at="2026-04-01T10:01:00Z",
        )
        newer_success = _make_check_run(
            run_id=101,
            conclusion="success",
            title="Review completed",
            summary="Looks good",
            started_at="2026-04-01T11:00:00Z",
            completed_at="2026-04-01T11:02:00Z",
        )
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), ({"check_runs": [older_neutral, newer_success]}, "")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert err == ""
        assert found is not None
        assert found["id"] == 101
        assert found["conclusion"] == "success"

    def test_selects_highest_id_when_timestamps_tie(self) -> None:
        first = _make_check_run(
            run_id=200,
            conclusion="neutral",
            started_at="2026-04-01T10:00:00Z",
            completed_at="2026-04-01T10:01:00Z",
        )
        second = _make_check_run(
            run_id=205,
            conclusion="success",
            title="Review completed",
            started_at="2026-04-01T10:00:00Z",
            completed_at="2026-04-01T10:01:00Z",
        )
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), ({"check_runs": [first, second]}, "")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert err == ""
        assert found is not None
        assert found["id"] == 205

    def test_newer_in_progress_run_supersedes_older_completed_neutral_run(self) -> None:
        older_neutral = _make_check_run(
            run_id=300,
            status="completed",
            conclusion="neutral",
            started_at="2026-04-01T10:00:00Z",
            completed_at="2026-04-01T10:01:00Z",
        )
        newer_in_progress = _make_check_run(
            run_id=301,
            status="in_progress",
            conclusion=None,
            title="Review in progress",
            summary="",
            started_at="2026-04-01T10:30:00Z",
            completed_at=None,
        )
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), ({"check_runs": [older_neutral, newer_in_progress]}, "")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert err == ""
        assert found is not None
        assert found["id"] == 301
        assert found["status"] == "in_progress"
        assert found["conclusion"] is None

    def test_flattens_paginated_check_runs_pages(self) -> None:
        page1 = {"check_runs": [_make_check_run(run_id=1, name="CI", app_slug="github-actions")]}
        page2 = {"check_runs": [_make_check_run(run_id=2, completed_at="2026-04-01T10:01:00Z")]}
        page3 = {"check_runs": [_make_check_run(run_id=3, completed_at="2026-04-01T10:05:00Z")]}
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), ([page1, page2, page3], "")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert err == ""
        assert found is not None
        assert found["id"] == 3

    def test_returns_none_and_empty_error_when_no_coderabbit_check_run(self) -> None:
        ci_run = _make_check_run(run_id=1, name="pytest", app_slug="github-actions")
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), ({"check_runs": [ci_run]}, "")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert found is None
        assert err == ""

    def test_returns_error_on_pr_api_failure(self) -> None:
        with patch.object(utils, "run_gh_api_result", return_value=(None, "HTTP 502")):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert found is None
        assert "HTTP 502" in err

    def test_returns_error_when_pr_head_sha_missing(self) -> None:
        with patch.object(utils, "run_gh_api_result", return_value=({"head": {}}, "")):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert found is None
        assert err != ""

    def test_returns_error_on_check_runs_api_failure(self) -> None:
        with patch.object(
            utils,
            "run_gh_api_result",
            side_effect=[({"head": {"sha": _SHA}}, ""), (None, "rate limit exceeded")],
        ):
            found, err = find_coderabbit_check_run("owner/repo", 1)

        assert found is None
        assert "rate limit exceeded" in err


class TestFindRateLimitReplyComment:
    """Tests for utils.find_rate_limit_reply_comment."""

    def test_accepts_newest_reply_within_lookback_including_29s_before_completed_at(self) -> None:
        # Matches real PR #6743 timing: reply created 29s before check_run completed_at.
        older_valid = _make_comment(comment_id=10, created_at="2026-04-01T09:57:00Z")
        newest_valid = _make_comment(comment_id=11, created_at="2026-04-01T10:00:31Z")
        with patch.object(utils, "run_gh_api_result", return_value=([older_valid, newest_valid], "")):
            found, err = find_rate_limit_reply_comment("owner/repo", 6743, completed_at="2026-04-01T10:01:00Z")

        assert err == ""
        assert found is not None
        assert found["id"] == 11

    def test_rejects_stale_reply_older_than_300s_before_completed_at(self) -> None:
        stale = _make_comment(comment_id=10, created_at="2026-04-01T09:55:59Z")
        found, err = find_rate_limit_reply_comment(
            "owner/repo",
            6743,
            completed_at="2026-04-01T10:01:00Z",
            comments=[stale],
        )

        assert found is None
        assert err == ""

    def test_rejects_future_reply_after_300s_lookahead_from_completed_at(self) -> None:
        just_past = _make_comment(comment_id=12, created_at="2026-04-01T10:06:01Z")
        much_later = _make_comment(comment_id=13, created_at="2026-04-01T12:01:00Z")
        found, err = find_rate_limit_reply_comment(
            "owner/repo",
            6743,
            completed_at="2026-04-01T10:01:00Z",
            comments=[just_past, much_later],
        )

        assert found is None
        assert err == ""

    def test_accepts_reply_within_300s_lookahead_after_completed_at(self) -> None:
        within_lookahead = _make_comment(comment_id=14, created_at="2026-04-01T10:02:00Z")
        found, err = find_rate_limit_reply_comment(
            "owner/repo",
            6743,
            completed_at="2026-04-01T10:01:00Z",
            comments=[within_lookahead],
        )

        assert err == ""
        assert found is not None
        assert found["id"] == 14

    def test_ignores_summary_comment_even_when_mentioning_rate_limit(self) -> None:
        summary = _make_comment(
            comment_id=20,
            body=f"{SUMMARY_MARKER}\nNote: previous rate limit cleared.",
            created_at="2026-04-01T10:00:50Z",
        )
        found, err = find_rate_limit_reply_comment(
            "owner/repo",
            1,
            completed_at="2026-04-01T10:01:00Z",
            comments=[summary],
        )

        assert found is None
        assert err == ""

    def test_ignores_non_coderabbit_comments_and_non_rate_limit_replies(self) -> None:
        human = _make_comment(comment_id=30, login="octocat", body="Rate limit hit? Wait 10 minutes.")
        normal_reply = _make_comment(comment_id=31, login=CODERABBIT_BOT_LOGIN, body="Review triggered.")
        found, err = find_rate_limit_reply_comment(
            "owner/repo",
            1,
            completed_at="2026-04-01T10:01:00Z",
            comments=[human, normal_reply],
        )

        assert found is None
        assert err == ""

    def test_reuses_passed_comments_without_api_call(self) -> None:
        reply = _make_comment(comment_id=40, created_at="2026-04-01T10:00:40Z")
        with patch.object(utils, "run_gh_api_result") as mock_api:
            found, err = find_rate_limit_reply_comment(
                "owner/repo",
                1,
                completed_at="2026-04-01T10:01:00Z",
                comments=[reply],
            )

        assert err == ""
        assert found is not None
        assert found["id"] == 40
        mock_api.assert_not_called()

    def test_returns_error_on_api_failure(self) -> None:
        with patch.object(utils, "run_gh_api_result", return_value=(None, "HTTP 500")):
            found, err = find_rate_limit_reply_comment("owner/repo", 1, completed_at="2026-04-01T10:01:00Z")

        assert found is None
        assert "HTTP 500" in err


class TestDetectRateLimitAndRunCheck:
    """Tests for rate_limit.detect_rate_limit and rate_limit.run_check."""

    def test_neutral_rate_limited_with_fresh_reply_comment(self, capsys: pytest.CaptureFixture[str]) -> None:
        now = datetime(2026, 4, 1, 10, 1, 0, tzinfo=UTC)
        check_run = _make_check_run(
            run_id=9001,
            conclusion="neutral",
            title="Review rate limited",
            summary="No duration in summary.",
            completed_at="2026-04-01T10:01:00Z",
        )
        summary_no_rate_limit = _make_comment(
            comment_id=1,
            body=f"{SUMMARY_MARKER}\nClean walkthrough.",
            created_at="2026-04-01T09:50:00Z",
        )
        fresh_reply = _make_comment(
            comment_id=2,
            body="Rate limit exceeded. Your next included review will be available in 44 minutes.",
            created_at="2026-04-01T10:00:31Z",
        )
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(utils, "run_gh_api_result", return_value=([summary_no_rate_limit, fresh_reply], "")),
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
        ):
            rc = run_check("owner/repo", 6743)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload == {
            "rate_limited": True,
            "wait_seconds": 2611,  # 2640 - 29s elapsed since reply created_at
            "check_run_id": 9001,
            "head_sha": _SHA,
            "conclusion": "neutral",
            "title": "Review rate limited",
            "updated_at": "2026-04-01T10:01:00Z",
        }
        assert "fallback" not in payload

    def test_run_check_subtracts_elapsed_time_for_parsed_reply_wait(
        self,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        now = datetime(2026, 4, 1, 10, 11, 0, tzinfo=UTC)
        check_run = _make_check_run(
            run_id=9010,
            conclusion="neutral",
            title="Review rate limited",
            summary="No duration in summary.",
            completed_at="2026-04-01T10:01:00Z",
        )
        reply = _make_comment(
            comment_id=20,
            body="Rate limit exceeded. Your next included review will be available in 44 minutes.",
            created_at="2026-04-01T10:01:00Z",  # 10 minutes (600s) elapsed -> 2640 - 600 = 2040
        )
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(utils, "run_gh_api_result", return_value=([reply], "")),
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
        ):
            rc = run_check("owner/repo", 6743)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["rate_limited"] is True
        assert payload["wait_seconds"] == 2040
        assert payload["updated_at"] == "2026-04-01T10:01:00Z"
        assert "fallback" not in payload

    def test_run_check_parsed_wait_with_unparseable_timestamp_warns_and_emits_full_wait(
        self,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        status = RateLimitStatus(
            rate_limited=True,
            check_run_id=9011,
            head_sha=_SHA,
            conclusion="neutral",
            title="Review rate limited",
            updated_at="not-a-timestamp",
            parsed_wait_seconds=1200,
            wait_reference_at="not-a-timestamp",
        )
        with patch.object(rate_limit, "detect_rate_limit", return_value=(status, "")):
            rc = run_check("owner/repo", 1)

        captured = capsys.readouterr()
        assert rc == 0
        assert "Could not parse check-run timestamp" in captured.err
        assert "using full wait" in captured.err
        payload = json.loads(captured.out)
        assert payload["rate_limited"] is True
        assert payload["wait_seconds"] == 1200
        assert "fallback" not in payload

    def test_detect_rate_limit_sets_wait_reference_at_to_reply_created_at(self) -> None:
        check_run = _make_check_run(
            run_id=9012,
            conclusion="neutral",
            title="Review rate limited",
            summary="No duration in summary.",
            completed_at="2026-04-01T10:01:00Z",
        )
        reply = _make_comment(
            comment_id=21,
            body="Rate limit exceeded. Your next included review will be available in 44 minutes.",
            created_at="2026-04-01T09:59:00Z",
        )
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(utils, "run_gh_api_result", return_value=([reply], "")),
        ):
            status, err = detect_rate_limit("owner/repo", 1)

        assert err == ""
        assert status is not None
        assert status.rate_limited is True
        assert status.parsed_wait_seconds == 2640
        assert status.updated_at == "2026-04-01T10:01:00Z"
        assert status.wait_reference_at == "2026-04-01T09:59:00Z"

    def test_detect_rate_limit_sets_wait_reference_at_to_completed_at_for_output_wait(self) -> None:
        check_run = _make_check_run(
            run_id=9013,
            conclusion="neutral",
            title="Review rate limited",
            summary="Rate limit hit.",
            text="Your next included review will be available in 25 minutes.",
            completed_at="2026-04-01T10:01:00Z",
        )
        with patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")):
            status, err = detect_rate_limit("owner/repo", 1)

        assert err == ""
        assert status is not None
        assert status.parsed_wait_seconds == 1500
        assert status.updated_at == "2026-04-01T10:01:00Z"
        assert status.wait_reference_at == "2026-04-01T10:01:00Z"

    def test_detect_rate_limit_sets_wait_reference_at_to_completed_at_on_fallback(self) -> None:
        check_run = _make_check_run(
            run_id=9014,
            conclusion="neutral",
            title="Review rate limited",
            summary="No duration in summary.",
            completed_at="2026-04-01T10:01:00Z",
        )
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(rate_limit, "_find_rate_limit_reply_comment", return_value=(None, "")),
        ):
            status, err = detect_rate_limit("owner/repo", 1)

        assert err == ""
        assert status is not None
        assert status.parsed_wait_seconds is None
        assert status.updated_at == "2026-04-01T10:01:00Z"
        assert status.wait_reference_at == "2026-04-01T10:01:00Z"

    def test_run_check_uses_wait_reference_at_over_updated_at(self, capsys: pytest.CaptureFixture[str]) -> None:
        now = datetime(2026, 4, 1, 10, 11, 0, tzinfo=UTC)
        check_run = _make_check_run(
            run_id=9015,
            conclusion="neutral",
            title="Review rate limited",
            summary="No duration in summary.",
            completed_at="2026-04-01T10:01:00Z",  # 600s elapsed
        )
        reply = _make_comment(
            comment_id=22,
            body="Rate limit exceeded. Your next included review will be available in 44 minutes.",
            created_at="2026-04-01T09:59:00Z",  # 120s earlier -> 720s elapsed -> 2640 - 720 = 1920
        )
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(utils, "run_gh_api_result", return_value=([reply], "")),
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
        ):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["wait_seconds"] == 1920
        assert payload["updated_at"] == "2026-04-01T10:01:00Z"
        assert "fallback" not in payload

    def test_neutral_rate_limited_without_reply_uses_fallback_from_completed_at(
        self,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        now = datetime(2026, 4, 1, 10, 41, 0, tzinfo=UTC)
        completed_at = (now - timedelta(minutes=40)).isoformat()
        check_run = _make_check_run(run_id=9002, conclusion="neutral", completed_at=completed_at)
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(rate_limit, "_find_rate_limit_reply_comment", return_value=(None, "")),
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
        ):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["rate_limited"] is True
        assert payload["fallback"] is True
        assert payload["wait_seconds"] == 1200  # 3600 - 40*60
        assert payload["check_run_id"] == 9002

    def test_neutral_rate_limited_with_stale_reply_degrades_to_fallback(
        self,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        now = datetime(2026, 4, 1, 10, 11, 0, tzinfo=UTC)
        completed_at = "2026-04-01T10:01:00Z"
        check_run = _make_check_run(run_id=9003, conclusion="neutral", completed_at=completed_at)
        stale_reply = _make_comment(
            comment_id=3,
            body="Rate limit exceeded. Please wait **5 minutes and 0 seconds**.",
            created_at="2026-04-01T09:50:00Z",
        )
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(utils, "run_gh_api_result", return_value=([stale_reply], "")),
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
        ):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["rate_limited"] is True
        assert payload["fallback"] is True
        assert payload["wait_seconds"] == 3000  # 3600 - 10*60

    def test_neutral_rate_limited_with_reply_api_error_degrades_to_fallback(
        self,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        now = datetime(2026, 4, 1, 10, 11, 0, tzinfo=UTC)
        check_run = _make_check_run(run_id=9004, conclusion="neutral", completed_at="2026-04-01T10:01:00Z")
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(rate_limit, "_find_rate_limit_reply_comment", return_value=(None, "GitHub API error: 503")),
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
        ):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["rate_limited"] is True
        assert payload["fallback"] is True
        assert payload["wait_seconds"] == 3000

    def test_neutral_with_wait_in_output_skips_reply_comment_fetch(self) -> None:
        check_run = _make_check_run(
            run_id=9005,
            conclusion="neutral",
            title="Review rate limited",
            summary="Rate limit hit.",
            text="Your next included review will be available in 25 minutes.",
        )
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(rate_limit, "_find_rate_limit_reply_comment") as mock_find_reply,
        ):
            status, err = detect_rate_limit("owner/repo", 1)

        assert err == ""
        assert status is not None
        assert status.rate_limited is True
        assert status.parsed_wait_seconds == 1500
        mock_find_reply.assert_not_called()

    def test_success_conclusion_is_not_rate_limited_even_with_old_rate_limit_comments(
        self,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        check_run = _make_check_run(
            run_id=9006,
            conclusion="success",
            title="Review completed",
            summary="All checks passed.",
        )
        with (
            patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")),
            patch.object(rate_limit, "_find_rate_limit_reply_comment") as mock_find_reply,
        ):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        mock_find_reply.assert_not_called()
        payload = json.loads(capsys.readouterr().out)
        assert payload == {
            "rate_limited": False,
            "check_run_id": 9006,
            "head_sha": _SHA,
            "conclusion": "success",
            "title": "Review completed",
        }

    def test_skipped_conclusion_is_not_rate_limited(self, capsys: pytest.CaptureFixture[str]) -> None:
        check_run = _make_check_run(run_id=9007, conclusion="skipped", title="Review skipped", summary="Draft PR")
        with patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["rate_limited"] is False
        assert payload["conclusion"] == "skipped"

    def test_in_progress_run_is_not_rate_limited(self, capsys: pytest.CaptureFixture[str]) -> None:
        check_run = _make_check_run(
            run_id=9008,
            status="in_progress",
            conclusion=None,
            title="Review in progress",
            summary="",
            completed_at=None,
        )
        with patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["rate_limited"] is False
        assert payload["conclusion"] is None

    def test_neutral_without_rate_limit_text_is_not_rate_limited(self, capsys: pytest.CaptureFixture[str]) -> None:
        check_run = _make_check_run(
            run_id=9009,
            conclusion="neutral",
            title="Reviews paused",
            summary="Auto-paused after too many commits.",
        )
        with patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(check_run, "")):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["rate_limited"] is False
        assert payload["conclusion"] == "neutral"

    def test_no_coderabbit_check_run_outputs_minimal_false_json(self, capsys: pytest.CaptureFixture[str]) -> None:
        with patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(None, "")):
            rc = run_check("owner/repo", 1)

        assert rc == 0
        assert json.loads(capsys.readouterr().out) == {"rate_limited": False}

    def test_api_failure_exits_1_with_stderr_error_and_empty_stdout(
        self,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        with patch.object(rate_limit, "_find_coderabbit_check_run", return_value=(None, "GitHub API error: 500")):
            rc = run_check("owner/repo", 1)

        captured = capsys.readouterr()
        assert rc == 1
        assert captured.out == ""
        assert "GitHub API error: 500" in captured.err


class TestPollCoderabbitRateLimitIntegration:
    """Tests for reviews/poll.py integration with detect_rate_limit."""

    def test_poll_forwards_issue_comments_triggers_with_buffer_and_exits_on_approval(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        now = datetime(2026, 4, 1, 10, 11, 0, tzinfo=UTC)
        issue_comments = [
            {"id": 10, "body": SUMMARY_MARKER, "updated_at": "2026-04-01T10:00:00Z"},
            _make_comment(comment_id=11, created_at="2026-04-01T10:00:31Z"),
        ]
        status = RateLimitStatus(
            rate_limited=True,
            check_run_id=9001,
            head_sha=_SHA,
            conclusion="neutral",
            title="Review rate limited",
            updated_at="2026-04-01T10:01:00Z",  # 600s elapsed
            parsed_wait_seconds=1000,  # 400s remaining -> +30s buffer = 430s
        )
        summary_calls = 0

        def fake_find_summary(_owner_repo: str, _pr: int) -> tuple[int, str, str, str]:
            nonlocal summary_calls
            summary_calls += 1
            if summary_calls == 1:
                return (10, f"{SUMMARY_MARKER}\nPending", "2026-04-01T10:00:00Z", "")
            return (10, f"{SUMMARY_MARKER}\n{_APPROVED_MARKER}", "2026-04-01T10:20:00Z", "")

        fetch_calls = 0

        def fake_fetch(_url: str, *, output_dir: str) -> dict[str, Any]:  # noqa: ARG001
            nonlocal fetch_calls
            fetch_calls += 1
            if fetch_calls == 1:
                fetch._LAST_FETCH_CONTEXT = {
                    "key": ("o", "r", "5"),
                    "issue_comments": issue_comments,
                    "approval_detail": None,
                }
            return {"human": [], "qodo": [], "coderabbit": []}

        with (
            patch.object(poll, "get_pr_info", return_value=("o", "r", "5")),
            patch.object(poll, "validate_owner_repo", return_value=True),
            patch.object(poll, "find_summary_comment", side_effect=fake_find_summary),
            patch.object(poll, "fetch_run", side_effect=fake_fetch),
            patch.object(poll, "detect_rate_limit", return_value=(status, "")) as mock_detect,
            patch.object(poll, "run_trigger", return_value=0) as mock_trigger,
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
            patch.object(poll.time, "sleep") as mock_sleep,
        ):
            rc = poll.run(source="coderabbit", output_dir=str(tmp_path))

        assert rc == 0
        mock_detect.assert_called_once_with("o/r", 5, comments=issue_comments)
        mock_trigger.assert_called_once_with("o/r", 5, 430)
        mock_sleep.assert_not_called()
        payload = json.loads(capsys.readouterr().out)
        assert payload["approved"] is True

    def test_poll_uses_default_window_when_parsed_wait_seconds_is_none(self, tmp_path: Path) -> None:
        now = datetime(2026, 4, 1, 10, 11, 0, tzinfo=UTC)
        status = RateLimitStatus(
            rate_limited=True,
            check_run_id=9002,
            head_sha=_SHA,
            conclusion="neutral",
            title="Review rate limited",
            updated_at="2026-04-01T10:01:00Z",  # 600s elapsed of 3600s -> 3000s + 30s buffer = 3030s
            parsed_wait_seconds=None,
        )
        summary_calls = 0

        def fake_find_summary(_owner_repo: str, _pr: int) -> tuple[int, str, str, str]:
            nonlocal summary_calls
            summary_calls += 1
            if summary_calls == 1:
                return (10, f"{SUMMARY_MARKER}\nPending", "2026-04-01T10:00:00Z", "")
            return (10, f"{SUMMARY_MARKER}\n{_APPROVED_MARKER}", "2026-04-01T11:05:00Z", "")

        with (
            patch.object(poll, "get_pr_info", return_value=("o", "r", "5")),
            patch.object(poll, "validate_owner_repo", return_value=True),
            patch.object(poll, "find_summary_comment", side_effect=fake_find_summary),
            patch.object(poll, "fetch_run", return_value={"human": [], "qodo": [], "coderabbit": []}),
            patch.object(poll, "detect_rate_limit", return_value=(status, "")),
            patch.object(poll, "run_trigger", return_value=0) as mock_trigger,
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
            patch("builtins.print"),
        ):
            rc = poll.run(source="coderabbit", output_dir=str(tmp_path))

        assert rc == 0
        expected_wait = (DEFAULT_RATE_LIMIT_WINDOW - 600) + 30
        mock_trigger.assert_called_once_with("o/r", 5, expected_wait)

    def test_poll_logs_warning_on_detect_rate_limit_error_and_still_resumes_paused_reviews(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        paused_body = f"{SUMMARY_MARKER}\n{_REVIEWS_PAUSED_MARKER}"
        summary_calls = 0

        def fake_find_summary(_owner_repo: str, _pr: int) -> tuple[int, str, str, str]:
            nonlocal summary_calls
            summary_calls += 1
            if summary_calls == 1:
                return (10, paused_body, "2026-04-01T10:00:00Z", "")
            return (10, f"{SUMMARY_MARKER}\n{_APPROVED_MARKER}", "2026-04-01T10:05:00Z", "")

        fetch_calls = 0

        def fake_fetch(_url: str, *, output_dir: str) -> dict[str, Any]:  # noqa: ARG001
            nonlocal fetch_calls
            fetch_calls += 1
            if fetch_calls == 1:
                fetch._LAST_FETCH_CONTEXT = {
                    "key": ("o", "r", "5"),
                    "issue_comments": [{"id": 10, "body": paused_body, "updated_at": "2026-04-01T10:00:00Z"}],
                    "approval_detail": None,
                }
            return {"human": [], "qodo": [], "coderabbit": []}

        with (
            patch.object(poll, "get_pr_info", return_value=("o", "r", "5")),
            patch.object(poll, "validate_owner_repo", return_value=True),
            patch.object(poll, "find_summary_comment", side_effect=fake_find_summary),
            patch.object(poll, "fetch_run", side_effect=fake_fetch),
            patch.object(poll, "detect_rate_limit", return_value=(None, "GitHub API error: 502")),
            patch.object(poll, "_post_resume_trigger", return_value=555) as mock_resume,
            patch.object(poll.time, "sleep") as mock_sleep,
        ):
            rc = poll.run(source="coderabbit", output_dir=str(tmp_path))

        captured = capsys.readouterr()
        assert rc == 0
        assert "Could not check rate limit (GitHub API error: 502)" in captured.err
        mock_resume.assert_called_once_with("o/r", 5)
        mock_sleep.assert_not_called()
        assert json.loads(captured.out)["approved"] is True

    def test_poll_uses_wait_reference_at_over_updated_at(self, tmp_path: Path) -> None:
        now = datetime(2026, 4, 1, 10, 11, 0, tzinfo=UTC)
        status = RateLimitStatus(
            rate_limited=True,
            check_run_id=9020,
            head_sha=_SHA,
            conclusion="neutral",
            title="Review rate limited",
            updated_at="2026-04-01T10:01:00Z",  # 600s elapsed
            wait_reference_at="2026-04-01T09:59:00Z",  # 120s earlier -> 720s elapsed -> 1000 - 720 = 280s + 30s = 310s
            parsed_wait_seconds=1000,
        )
        summary_calls = 0

        def fake_find_summary(_owner_repo: str, _pr: int) -> tuple[int, str, str, str]:
            nonlocal summary_calls
            summary_calls += 1
            if summary_calls == 1:
                return (10, f"{SUMMARY_MARKER}\nPending", "2026-04-01T10:00:00Z", "")
            return (10, f"{SUMMARY_MARKER}\n{_APPROVED_MARKER}", "2026-04-01T10:20:00Z", "")

        with (
            patch.object(poll, "get_pr_info", return_value=("o", "r", "5")),
            patch.object(poll, "validate_owner_repo", return_value=True),
            patch.object(poll, "find_summary_comment", side_effect=fake_find_summary),
            patch.object(poll, "fetch_run", return_value={"human": [], "qodo": [], "coderabbit": []}),
            patch.object(poll, "detect_rate_limit", return_value=(status, "")),
            patch.object(poll, "run_trigger", return_value=0) as mock_trigger,
            patch.object(rate_limit, "datetime", _freeze_rate_limit_now(now)),
            patch("builtins.print"),
        ):
            rc = poll.run(source="coderabbit", output_dir=str(tmp_path))

        assert rc == 0
        mock_trigger.assert_called_once_with("o/r", 5, 310)

    def test_poll_sleeps_default_window_and_rechecks_when_parsed_cooldown_exceeds_one_hour(
        self,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        clock = {"now": datetime(2026, 4, 1, 10, 1, 0, tzinfo=UTC)}
        mock_dt = MagicMock()
        mock_dt.now.side_effect = lambda _tz=None: clock["now"]
        mock_dt.fromisoformat = datetime.fromisoformat

        status = RateLimitStatus(
            rate_limited=True,
            check_run_id=9021,
            head_sha=_SHA,
            conclusion="neutral",
            title="Review rate limited",
            updated_at="2026-04-01T10:01:00Z",
            wait_reference_at="2026-04-01T10:01:00Z",
            parsed_wait_seconds=7200,  # 2h remaining on cycle 1 (> 3600s)
        )
        events: list[tuple[str, int]] = []
        detect_calls = 0
        summary_calls = 0

        def fake_find_summary(_owner_repo: str, _pr: int) -> tuple[int, str, str, str]:
            nonlocal summary_calls
            summary_calls += 1
            if summary_calls <= 2:
                return (10, f"{SUMMARY_MARKER}\nPending", "2026-04-01T10:00:00Z", "")
            return (10, f"{SUMMARY_MARKER}\n{_APPROVED_MARKER}", "2026-04-01T12:05:00Z", "")

        def fake_detect(
            _owner_repo: str,
            _pr: int,
            *,
            comments: list[dict[str, Any]] | None = None,  # noqa: ARG001
        ) -> tuple[RateLimitStatus, str]:
            nonlocal detect_calls
            detect_calls += 1
            events.append(("detect", detect_calls))
            return (status, "")

        def fake_sleep(seconds: int) -> None:
            events.append(("sleep", seconds))
            clock["now"] = clock["now"] + timedelta(seconds=seconds)

        def fake_trigger(_owner_repo: str, _pr: int, wait_seconds: int) -> int:
            events.append(("trigger", wait_seconds))
            return 0

        with (
            patch.object(poll, "get_pr_info", return_value=("o", "r", "5")),
            patch.object(poll, "validate_owner_repo", return_value=True),
            patch.object(poll, "find_summary_comment", side_effect=fake_find_summary),
            patch.object(poll, "fetch_run", return_value={"human": [], "qodo": [], "coderabbit": []}),
            patch.object(poll, "detect_rate_limit", side_effect=fake_detect),
            patch.object(poll, "run_trigger", side_effect=fake_trigger),
            patch.object(rate_limit, "datetime", mock_dt),
            patch.object(poll.time, "sleep", side_effect=fake_sleep),
        ):
            rc = poll.run(source="coderabbit", output_dir=str(tmp_path))

        assert rc == 0
        assert events == [
            ("detect", 1),
            ("sleep", DEFAULT_RATE_LIMIT_WINDOW),
            ("detect", 2),
            ("trigger", DEFAULT_RATE_LIMIT_WINDOW + 30),
        ]
        assert json.loads(capsys.readouterr().out)["approved"] is True
