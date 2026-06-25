"""Tests for stale-sticky cleanup branch in _run_qodo_poll."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from myk_pi_tools.reviews.poll import _run_qodo_poll

# ---------------------------------------------------------------------------
# Shared fixtures / helpers
# ---------------------------------------------------------------------------

_OWNER = "test-org"
_REPO = "test-repo"
_PR = "42"
_REVIEW_URL = "https://example.com/review"

_PATCH_PREFIX = "myk_pi_tools.reviews.poll"


def _base_fetch_result(*, approved: bool = False) -> dict[str, object]:
    """Return a minimal fetch_run result dict."""
    return {
        "approved": approved,
        "metadata": {"pr_number": _PR},
        "qodo": [],
    }


def _write_reviews_json(output_dir: Path, findings: list[dict[str, object]]) -> None:
    """Write a pr-{number}-reviews.json file with the given Qodo findings."""
    path = output_dir / f"pr-{_PR}-reviews.json"
    data = {"metadata": {"pr_number": _PR}, "qodo": findings}
    path.write_text(json.dumps(data))


def _stale_findings() -> list[dict[str, object]]:
    """Findings that are auto-skipped AND already replied → stale sticky."""
    return [
        {"id": "1", "is_auto_skipped": True, "already_replied": True, "body": "old finding"},
        {"id": "2", "is_auto_skipped": True, "already_replied": True, "body": "another old finding"},
    ]


def _fresh_findings() -> list[dict[str, object]]:
    """Findings that are NOT auto-skipped and NOT already replied → actionable."""
    return [
        {"id": "3", "is_auto_skipped": False, "already_replied": False, "body": "new issue"},
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestStaleCleanupTriggersAndReturnsResponse:
    """Full happy path: stale findings → cleanup → reply → re-fetch → result."""

    def test_stale_cleanup_triggers_and_returns_response(self, tmp_path: Path) -> None:
        _write_reviews_json(tmp_path, _stale_findings())

        fetch_result = _base_fetch_result(approved=False)
        fresh_result = _base_fetch_result(approved=False)
        cleanup_reply = "finding 1: fixed\nfinding 2: still open"

        with (
            patch(f"{_PATCH_PREFIX}.fetch_run", side_effect=[fetch_result, fresh_result]) as mock_fetch,
            patch(f"{_PATCH_PREFIX}._has_actionable_qodo_comments", return_value=False),
            patch(f"{_PATCH_PREFIX}._is_qodo_reviewing", return_value=False),
            patch(f"{_PATCH_PREFIX}._request_qodo_sticky_cleanup", return_value=cleanup_reply) as mock_cleanup,
            patch(f"{_PATCH_PREFIX}._print_poll_summary"),
            patch(f"{_PATCH_PREFIX}.run_gh_api", return_value=[]),
            patch(f"{_PATCH_PREFIX}.is_qodo_approved", return_value=None),
            patch(f"{_PATCH_PREFIX}.time.sleep"),
            patch("builtins.print") as mock_print,
        ):
            rc = _run_qodo_poll(_REVIEW_URL, _OWNER, _REPO, _PR, str(tmp_path))

        assert rc == 0
        mock_cleanup.assert_called_once_with(_OWNER, _REPO, _PR)

        # Verify the JSON written to stdout
        printed = mock_print.call_args[0][0]
        result = json.loads(printed)
        assert result["approved"] is False
        assert result["qodo_cleanup_response"] == cleanup_reply

        # Two fetch calls: initial + re-fetch after cleanup
        assert mock_fetch.call_count == 2

        # Verify on-disk JSON file matches
        disk_path = tmp_path / f"pr-{_PR}-reviews.json"
        assert disk_path.exists()
        disk_data = json.loads(disk_path.read_text())
        assert disk_data["qodo_cleanup_response"] == cleanup_reply
        assert disk_data["approved"] is False


class TestStaleCleanupOnlyRunsOnce:
    """_cleanup_requested flag prevents requesting cleanup twice."""

    def test_stale_cleanup_only_runs_once(self, tmp_path: Path) -> None:
        _write_reviews_json(tmp_path, _stale_findings())

        # First cycle: cleanup requested but reply is empty → loop continues
        # Second cycle: has actionable comments → breaks out
        fetch_results = [
            _base_fetch_result(approved=False),  # cycle 1
            _base_fetch_result(approved=False),  # cycle 2
        ]

        actionable_returns = [False, True]  # cycle 1: no actionable, cycle 2: actionable → break

        with (
            patch(f"{_PATCH_PREFIX}.fetch_run", side_effect=fetch_results),
            patch(f"{_PATCH_PREFIX}._has_actionable_qodo_comments", side_effect=actionable_returns),
            patch(f"{_PATCH_PREFIX}._is_qodo_reviewing", return_value=False),
            patch(f"{_PATCH_PREFIX}._request_qodo_sticky_cleanup", return_value="") as mock_cleanup,
            patch(f"{_PATCH_PREFIX}._print_poll_summary"),
            patch(f"{_PATCH_PREFIX}.run_gh_api", return_value=[]),
            patch(f"{_PATCH_PREFIX}.is_qodo_approved", return_value=None),
            patch(f"{_PATCH_PREFIX}.time.sleep"),
            patch("builtins.print"),
        ):
            rc = _run_qodo_poll(_REVIEW_URL, _OWNER, _REPO, _PR, str(tmp_path))

        assert rc == 0
        # Cleanup was requested exactly once (cycle 1), NOT again in cycle 2
        mock_cleanup.assert_called_once()


class TestStaleCleanupSkippedWhenNoStaleFindings:
    """No auto-skipped findings → cleanup NOT requested."""

    def test_stale_cleanup_skipped_when_no_stale_findings(self, tmp_path: Path) -> None:
        # Write findings that are NOT stale (not auto-skipped)
        _write_reviews_json(tmp_path, _fresh_findings())

        # fetch returns not-approved, _has_actionable returns True on cycle 1 → breaks immediately
        # But we need to reach the else branch first to test cleanup skipping.
        # So: actionable=False on cycle 1 (enters else), then actionable=True on cycle 2 (breaks).
        fetch_results = [
            _base_fetch_result(approved=False),  # cycle 1
            _base_fetch_result(approved=False),  # cycle 2
        ]
        actionable_returns = [False, True]

        with (
            patch(f"{_PATCH_PREFIX}.fetch_run", side_effect=fetch_results),
            patch(f"{_PATCH_PREFIX}._has_actionable_qodo_comments", side_effect=actionable_returns),
            patch(f"{_PATCH_PREFIX}._is_qodo_reviewing", return_value=False),
            patch(f"{_PATCH_PREFIX}._request_qodo_sticky_cleanup") as mock_cleanup,
            patch(f"{_PATCH_PREFIX}._print_poll_summary"),
            patch(f"{_PATCH_PREFIX}.run_gh_api", return_value=[]),
            patch(f"{_PATCH_PREFIX}.is_qodo_approved", return_value=None),
            patch(f"{_PATCH_PREFIX}.time.sleep"),
            patch("builtins.print"),
        ):
            rc = _run_qodo_poll(_REVIEW_URL, _OWNER, _REPO, _PR, str(tmp_path))

        assert rc == 0
        mock_cleanup.assert_not_called()


class TestStaleCleanupEmptyReplyContinuesLoop:
    """Cleanup requested but Qodo doesn't reply → loop continues."""

    def test_stale_cleanup_empty_reply_continues_loop(self, tmp_path: Path) -> None:
        _write_reviews_json(tmp_path, _stale_findings())

        # Cycle 1: stale detected, cleanup requested, empty reply → no break, sleeps
        # Cycle 2: Qodo now has actionable comments → breaks
        fetch_results = [
            _base_fetch_result(approved=False),  # cycle 1
            _base_fetch_result(approved=False),  # cycle 2
        ]
        actionable_returns = [False, True]

        with (
            patch(f"{_PATCH_PREFIX}.fetch_run", side_effect=fetch_results),
            patch(f"{_PATCH_PREFIX}._has_actionable_qodo_comments", side_effect=actionable_returns),
            patch(f"{_PATCH_PREFIX}._is_qodo_reviewing", return_value=False),
            patch(f"{_PATCH_PREFIX}._request_qodo_sticky_cleanup", return_value="") as mock_cleanup,
            patch(f"{_PATCH_PREFIX}._print_poll_summary"),
            patch(f"{_PATCH_PREFIX}.run_gh_api", return_value=[]),
            patch(f"{_PATCH_PREFIX}.is_qodo_approved", return_value=None),
            patch(f"{_PATCH_PREFIX}.time.sleep") as mock_sleep,
            patch("builtins.print") as mock_print,
        ):
            rc = _run_qodo_poll(_REVIEW_URL, _OWNER, _REPO, _PR, str(tmp_path))

        assert rc == 0
        # Cleanup was attempted
        mock_cleanup.assert_called_once()
        # Sleep was called (loop continued after empty reply)
        mock_sleep.assert_called()
        # Final result should NOT contain qodo_cleanup_response (it came from actionable path)
        printed = mock_print.call_args[0][0]
        result = json.loads(printed)
        # The actionable-comments branch sets qodo_cleanup_response to _cleanup_response
        # which is still "" since cleanup reply was empty
        assert result["qodo_cleanup_response"] == ""
