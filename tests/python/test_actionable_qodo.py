"""Tests for _has_actionable_qodo_comments — pushback detection in poll loop."""

import json
from pathlib import Path
from typing import Any

import pytest

from myk_pi_tools.reviews.poll import _has_actionable_qodo_comments


@pytest.fixture
def reviews_dir(tmp_path: Path) -> Path:
    """Provide a temp directory for review JSON files."""
    return tmp_path


def _write_reviews(reviews_dir: Path, pr_number: str, qodo_comments: list[dict[str, Any]]) -> None:
    """Write a reviews JSON file with the given Qodo comments."""
    data = {
        "metadata": {"owner": "test", "repo": "test", "pr_number": int(pr_number)},
        "human": [],
        "qodo": qodo_comments,
        "coderabbit": [],
    }
    json_path = reviews_dir / f"pr-{pr_number}-reviews.json"
    json_path.write_text(json.dumps(data))


class TestHasActionableQodoComments:
    """Test pushback detection in _has_actionable_qodo_comments."""

    def test_new_finding_is_actionable(self, reviews_dir: Path) -> None:
        """New finding (not already_replied) → actionable."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {"status": "pending", "body": "New finding"},
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is True

    def test_already_replied_no_response_not_actionable(self, reviews_dir: Path) -> None:
        """already_replied + no qodo_response → not actionable (Qodo silent = resolved)."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {"already_replied": True, "status": "pending", "body": "Replied finding"},
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is False

    def test_already_replied_confirmed_resolved_not_actionable(self, reviews_dir: Path) -> None:
        """already_replied + qodo_response confirms resolution → not actionable."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {
                    "already_replied": True,
                    "qodo_response": "Yes — finding 9 is addressed. Thanks for the fix.",
                    "status": "pending",
                    "body": "Confirmed resolved",
                },
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is False

    def test_already_replied_with_pushback_is_actionable(self, reviews_dir: Path) -> None:
        """already_replied + pushback in qodo_response → actionable."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {
                    "already_replied": True,
                    "qodo_response": "The issue is still present in the code.",
                    "status": "pending",
                    "body": "Pushback finding",
                },
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is True

    def test_already_replied_disagree_pushback_is_actionable(self, reviews_dir: Path) -> None:
        """already_replied + 'disagree' in qodo_response → actionable."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {
                    "already_replied": True,
                    "qodo_response": "I disagree with this approach.",
                    "status": "pending",
                    "body": "Disagree finding",
                },
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is True

    def test_already_replied_not_fixed_pushback_is_actionable(self, reviews_dir: Path) -> None:
        """already_replied + 'not fixed' in qodo_response → actionable."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {
                    "already_replied": True,
                    "qodo_response": "This bug is not fixed.",
                    "status": "pending",
                    "body": "Not fixed finding",
                },
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is True

    def test_auto_skipped_not_actionable(self, reviews_dir: Path) -> None:
        """is_auto_skipped → not actionable regardless of other fields."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {"is_auto_skipped": True, "status": "skipped", "body": "Auto-skipped"},
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is False

    def test_empty_qodo_list_not_actionable(self, reviews_dir: Path) -> None:
        """No Qodo comments → not actionable."""
        _write_reviews(reviews_dir, "99", [])
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is False

    def test_missing_json_file_is_actionable(self, reviews_dir: Path) -> None:
        """Missing JSON file → assume actionable (safe default)."""
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is True

    def test_mixed_findings(self, reviews_dir: Path) -> None:
        """Mix: auto-skipped + resolved + new → actionable (new finding present)."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {"is_auto_skipped": True, "status": "skipped", "body": "Skipped"},
                {"already_replied": True, "status": "pending", "body": "Resolved silently"},
                {"status": "pending", "body": "New finding"},
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is True

    def test_only_resolved_findings_not_actionable(self, reviews_dir: Path) -> None:
        """All already_replied with no pushback → not actionable."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {"already_replied": True, "status": "pending", "body": "Resolved 1"},
                {
                    "already_replied": True,
                    "qodo_response": "Looks good, addressed.",
                    "status": "pending",
                    "body": "Resolved 2",
                },
                {"is_auto_skipped": True, "status": "skipped", "body": "Skipped"},
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is False

    def test_empty_qodo_response_not_actionable(self, reviews_dir: Path) -> None:
        """already_replied + empty qodo_response → not actionable (empty = no pushback)."""
        _write_reviews(
            reviews_dir,
            "99",
            [
                {"already_replied": True, "qodo_response": "", "status": "pending", "body": "Empty response"},
            ],
        )
        assert _has_actionable_qodo_comments("99", str(reviews_dir)) is False
