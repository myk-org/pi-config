"""Tests for Qodo sticky finding post validation."""

from __future__ import annotations

import json
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
