"""Tests for _retrigger_qodo_review — stuck Qodo review re-trigger."""

from __future__ import annotations

import subprocess
from unittest.mock import patch

from myk_pi_tools.reviews.poll import _retrigger_qodo_review


class TestRetriggerQodoReview:
    """Test the stuck Qodo review re-trigger helper."""

    def test_success_returns_true(self) -> None:
        """Returns True when gh api call succeeds."""
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0
            result = _retrigger_qodo_review("org", "repo", "123")
        assert result is True
        mock_run.assert_called_once()
        # Verify the command posts /agentic_review
        call_args = mock_run.call_args
        assert "/agentic_review" in str(call_args)

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
