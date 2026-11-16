"""Tests for resolved-thread fields in `reviews fetch` output (issue #1085).

Phase 1c of /pr-review isolates resolved third-party threads from this output, so it
needs is_resolved, author, and a resolution timestamp on every thread.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

from myk_pi_tools.reviews import fetch

_THREAD = {
    "id": "PRRT_thread1",
    "isResolved": True,
    "comments": {
        "nodes": [
            {
                "id": "PRRC_comment1",
                "databaseId": 111,
                "author": {"login": "coderabbitai"},
                "path": "src/probe.py",
                "line": 40,
                "body": "TCP probe should not use exec",
                "createdAt": "2025-01-01T10:00:00Z",
            },
            {
                "id": "PRRC_comment2",
                "databaseId": 222,
                "author": {"login": "pr-author"},
                "path": "src/probe.py",
                "line": 40,
                "body": "Fixed",
                "createdAt": "2025-01-02T11:00:00Z",
            },
        ]
    },
}

_RESPONSE = {
    "data": {
        "repository": {
            "pullRequest": {
                "reviewThreads": {
                    "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": [_THREAD],
                }
            }
        }
    }
}


def _fetch(include_resolved: bool, user: str | None = None) -> list[dict[str, Any]]:
    with patch.object(fetch, "run_gh_graphql", return_value=_RESPONSE):
        return fetch.fetch_review_threads("org", "repo", "1", include_resolved=include_resolved, user=user)


def test_resolved_thread_emits_is_resolved() -> None:
    """A resolved thread carries is_resolved."""
    assert _fetch(include_resolved=True)[0]["is_resolved"] is True


def test_resolved_thread_emits_author_login() -> None:
    """The thread author is the first comment's author login."""
    assert _fetch(include_resolved=True)[0]["author"] == "coderabbitai"


def test_resolved_thread_created_at_is_first_comment_time() -> None:
    """created_at is the first comment's timestamp."""
    assert _fetch(include_resolved=True)[0]["created_at"] == "2025-01-01T10:00:00Z"


def test_resolved_thread_emits_path() -> None:
    """The thread path drives the Phase 1c suppression check."""
    assert _fetch(include_resolved=True)[0]["path"] == "src/probe.py"


def test_resolved_thread_reply_carries_created_at() -> None:
    """Replies keep their own created_at so resolution time can be derived."""
    assert _fetch(include_resolved=True)[0]["replies"][0]["created_at"] == "2025-01-02T11:00:00Z"


def test_resolved_thread_filtered_out_without_include_resolved() -> None:
    """Without --include-resolved the resolved thread is not in the output."""
    assert _fetch(include_resolved=False) == []


def test_resolved_threads_filtered_by_user() -> None:
    """--user keeps only threads authored by that user."""
    assert _fetch(include_resolved=True, user="someone-else") == []
    assert len(_fetch(include_resolved=True, user="CodeRabbitAI")) == 1
