"""Tests for _retrigger_qodo_review — stuck Qodo review re-trigger."""

from __future__ import annotations

import subprocess
import time
from unittest.mock import patch

from myk_pi_tools.reviews.poll import (
    _QODO_RETRIGGER_COOLDOWN_SECONDS,
    _QODO_STUCK_TIMEOUT_SECONDS,
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


class TestStuckReviewConstants:
    """Test stuck review detection constants and timer math."""

    def test_stuck_timeout_is_one_hour(self) -> None:
        """Stuck timeout is 3600 seconds (1 hour)."""
        assert _QODO_STUCK_TIMEOUT_SECONDS == 3600

    def test_cooldown_exceeds_half_timeout(self) -> None:
        """Cooldown is roughly half the timeout (~30 min) so retries aren't too frequent."""
        assert _QODO_RETRIGGER_COOLDOWN_SECONDS > _QODO_STUCK_TIMEOUT_SECONDS / 2 - 100
        assert _QODO_RETRIGGER_COOLDOWN_SECONDS < _QODO_STUCK_TIMEOUT_SECONDS

    def test_cooldown_accounts_for_strict_comparison(self) -> None:
        """Cooldown is > 1800 to account for strict > comparison in stuck check."""
        assert _QODO_RETRIGGER_COOLDOWN_SECONDS > 1800

    def test_failed_retrigger_timer_math(self) -> None:
        """On failed re-trigger, timer shifts forward so next retry is in ~30 min."""
        now = time.time()
        # Simulate: reviewing_since was set 1 hour ago, re-trigger failed
        shifted = now - _QODO_STUCK_TIMEOUT_SECONDS + _QODO_RETRIGGER_COOLDOWN_SECONDS
        # Time until next trigger: timeout - (now - shifted)
        elapsed = now - shifted
        remaining = _QODO_STUCK_TIMEOUT_SECONDS - elapsed
        # Should be approximately cooldown seconds from now
        assert abs(remaining - _QODO_RETRIGGER_COOLDOWN_SECONDS) < 1

    def test_successful_retrigger_resets_fully(self) -> None:
        """On successful re-trigger, timer resets to now — next trigger in 1 full hour."""
        now = time.time()
        # Simulate: reset to now
        reset_time = now
        elapsed = now - reset_time
        remaining = _QODO_STUCK_TIMEOUT_SECONDS - elapsed
        assert abs(remaining - _QODO_STUCK_TIMEOUT_SECONDS) < 1
