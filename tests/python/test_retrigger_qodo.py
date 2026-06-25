"""Tests for _retrigger_qodo_review — stuck Qodo review re-trigger."""

from __future__ import annotations

import subprocess
from unittest.mock import patch

from myk_pi_tools.reviews.poll import (
    _request_qodo_sticky_cleanup,
    _retrigger_qodo_review,
)


class TestRetriggerQodoReview:
    """Test the stuck Qodo review re-trigger helper."""

    def test_success_returns_true(self) -> None:
        """Returns True when gh api call succeeds."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0
            result = _retrigger_qodo_review("org", "repo", "123")
        assert result is True

    def test_api_failure_returns_false(self) -> None:
        """Returns False when gh api call fails."""
        with patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "gh")):
            result = _retrigger_qodo_review("org", "repo", "123")
        assert result is False

    def test_timeout_returns_false(self) -> None:
        """Returns False on timeout."""
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("gh", 30)):
            result = _retrigger_qodo_review("org", "repo", "123")
        assert result is False

    def test_gh_not_found_returns_false(self) -> None:
        """Returns False when gh binary not found."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            result = _retrigger_qodo_review("org", "repo", "123")
        assert result is False


class TestRequestQodoStickyCleanup:
    """Test the sticky cleanup request helper."""

    def test_returns_reply_on_successful_cleanup(self) -> None:
        """Returns reply body when Qodo responds to cleanup request."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api") as mock_api,
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
        ):
            mock_run.return_value.returncode = 0
            # Simulate Qodo's reply containing our quoted cleanup text
            mock_api.return_value = [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "created_at": "2099-01-01T00:00:00Z",
                    "body": (
                        "> Please re-evaluate all remaining sticky findings against the current code.\n"
                        "> For each finding, check if the referenced code has been fixed in subsequent commits.\n"
                        "> Remove findings that are fully addressed."
                        " Keep any findings where the issue is still present in the code.\n\n"
                        "finding 1: fixed\nfinding 2: still open"
                    ),
                }
            ]
            result = _request_qodo_sticky_cleanup("org", "repo", "1")
        assert "finding 1: fixed" in result
        assert "finding 2: still open" in result

    def test_returns_empty_on_post_failure(self) -> None:
        """Returns empty string when comment post fails."""
        with patch("myk_pi_tools.reviews.ask_qodo.subprocess.run", side_effect=subprocess.CalledProcessError(1, "gh")):
            result = _request_qodo_sticky_cleanup("org", "repo", "1")
        assert result == ""

    def test_returns_empty_on_timeout(self) -> None:
        """Returns empty string when no reply within timeout."""
        with (
            patch("myk_pi_tools.reviews.ask_qodo.subprocess.run") as mock_run,
            patch("myk_pi_tools.reviews.ask_qodo.run_gh_api", return_value=[]),
            patch("myk_pi_tools.reviews.ask_qodo.time.sleep"),
            patch("myk_pi_tools.reviews.ask_qodo.time.time") as mock_time,
        ):
            mock_run.return_value.returncode = 0
            # Simulate timeout: first call returns start time, subsequent calls exceed timeout
            mock_time.side_effect = [0, 0, 700]
            result = _request_qodo_sticky_cleanup("org", "repo", "1")
        assert result == ""
