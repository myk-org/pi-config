"""Tests for approved key in reviews fetch output."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

from myk_pi_tools.reviews.fetch import is_qodo_approved


class TestIsQodoApproved:
    """Test is_qodo_approved function."""

    def _mock_api(self, responses: dict[str, Any]) -> Any:
        """Create a mock for run_gh_api that returns different data per endpoint."""

        def mock_fn(endpoint: str, **_kwargs: Any) -> Any:
            for key, val in responses.items():
                if key in endpoint:
                    return val
            return None

        return mock_fn

    def test_approved_when_no_unresolved_findings(self) -> None:
        """Returns approved dict when sticky has 0 unresolved findings."""
        sticky_body = (
            "<h3>Code Review by Qodo</h3>\n"
            "<details><summary>Findings</summary>\n"
            "<code>🐞 Bugs (0)</code>\n"
            "<!-- QODO_CODE_REVIEW_STICKY -->\n"
            "finding 1 Resolved</code>\n"
            "✓ Resolved\n"
            "</details>\n"
        )
        responses = {
            "/pulls/": {"head": {"sha": "abc123"}},
            "/commits/": {"commit": {"committer": {"date": "2026-01-01T00:00:00Z"}}},
            "/comments": [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "body": sticky_body,
                    "updated_at": "2026-01-02T00:00:00Z",
                    "id": 123,
                }
            ],
        }
        with patch("myk_pi_tools.reviews.fetch.run_gh_api", side_effect=self._mock_api(responses)):
            result = is_qodo_approved("org", "repo", "1")
        assert result is not None
        assert result["approved"] is True
        assert result["reason"] == "all_resolved"

    def test_not_approved_when_unresolved_findings(self) -> None:
        """Returns None when sticky has unresolved findings."""
        sticky_body = (
            "<h3>Code Review by Qodo</h3>\n"
            "<!-- QODO_CODE_REVIEW_STICKY -->\n"
            "<details><summary>1. Bug title <code>🐞 Bug</code> <code>Category</code></summary>\n"
            "description\n</details>\n"
        )
        responses = {
            "/pulls/": {"head": {"sha": "abc123"}},
            "/commits/": {"commit": {"committer": {"date": "2026-01-01T00:00:00Z"}}},
            "/comments": [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "body": sticky_body,
                    "updated_at": "2026-01-02T00:00:00Z",
                    "id": 123,
                }
            ],
        }
        with patch("myk_pi_tools.reviews.fetch.run_gh_api", side_effect=self._mock_api(responses)):
            result = is_qodo_approved("org", "repo", "1")
        assert result is None

    def test_not_approved_when_no_sticky_comment(self) -> None:
        """Returns None when no Qodo sticky comment found."""
        responses = {
            "/pulls/": {"head": {"sha": "abc123"}},
            "/commits/": {"commit": {"committer": {"date": "2026-01-01T00:00:00Z"}}},
            "/comments": [],
        }
        with patch("myk_pi_tools.reviews.fetch.run_gh_api", side_effect=self._mock_api(responses)):
            result = is_qodo_approved("org", "repo", "1")
        assert result is None

    def test_not_approved_when_sticky_not_updated_after_commit(self) -> None:
        """Returns None when sticky was updated BEFORE the latest commit."""
        sticky_body = "<h3>Code Review by Qodo</h3>\n<!-- QODO_CODE_REVIEW_STICKY -->\nResolved</code>\n✓ Resolved\n"
        responses = {
            "/pulls/": {"head": {"sha": "abc123"}},
            "/commits/": {"commit": {"committer": {"date": "2026-01-02T00:00:00Z"}}},
            "/comments": [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "body": sticky_body,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "id": 123,
                }
            ],
        }
        with patch("myk_pi_tools.reviews.fetch.run_gh_api", side_effect=self._mock_api(responses)):
            result = is_qodo_approved("org", "repo", "1")
        assert result is None

    def test_not_approved_when_api_fails(self) -> None:
        """Returns None when API call fails."""
        with patch("myk_pi_tools.reviews.fetch.run_gh_api", return_value=None):
            result = is_qodo_approved("org", "repo", "1")
        assert result is None

    def test_approved_no_findings(self) -> None:
        """Returns approved with reason no_findings when Qodo found zero issues."""
        sticky_body = (
            "<h3>Code Review by Qodo</h3>\n"
            "<code>\U0001f41e Bugs (0)</code>\n"
            "<code>\U0001f4d8 Rule violations (0)</code>\n"
        )
        responses = {
            "/pulls/": {"head": {"sha": "abc123"}},
            "/commits/": {"commit": {"committer": {"date": "2026-01-01T00:00:00Z"}}},
            "/comments": [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "body": sticky_body,
                    "updated_at": "2026-01-02T00:00:00Z",
                    "id": 124,
                }
            ],
        }
        with patch("myk_pi_tools.reviews.fetch.run_gh_api", side_effect=self._mock_api(responses)):
            result = is_qodo_approved("org", "repo", "1")
        assert result is not None
        assert result["approved"] is True
        assert result["reason"] == "no_findings"

    def test_not_approved_empty_sticky(self) -> None:
        """Returns None when sticky has no count indicators (parse failure or mid-review)."""
        sticky_body = "<h3>Code Review by Qodo</h3>\n<!-- QODO_CODE_REVIEW_STICKY -->\n"
        responses = {
            "/pulls/": {"head": {"sha": "abc123"}},
            "/commits/": {"commit": {"committer": {"date": "2026-01-01T00:00:00Z"}}},
            "/comments": [
                {
                    "user": {"login": "qodo-code-review[bot]"},
                    "body": sticky_body,
                    "updated_at": "2026-01-02T00:00:00Z",
                    "id": 125,
                }
            ],
        }
        with patch("myk_pi_tools.reviews.fetch.run_gh_api", side_effect=self._mock_api(responses)):
            result = is_qodo_approved("org", "repo", "1")
        assert result is None
