"""Tests for reviews status report deduplication (Qodo 06f18ba6).

Session findings store path=None — without a discriminator in the dedup key,
two distinct findings sharing a title collapse into one report row.
"""

from myk_pi_tools.reviews.status import deduplicate_comments


def _comment(body: str, path: str | None, node_id: str | None = None) -> dict:
    return {
        "source": "qodo",
        "path": path,
        "line": None,
        "body": body,
        "status": "addressed",
        "reply": None,
        "priority": "HIGH",
        "skip_reason": None,
        "type": "session_finding",
        "quality_label": "Correctness",
        "node_id": node_id,
    }


def test_same_title_session_findings_stay_distinct() -> None:
    """Two pathless findings with the same title but different node_ids survive dedup."""
    comments = [
        _comment("Duplicate title\n\nfirst description", None, "uuid-1"),
        _comment("Duplicate title\n\nsecond description", None, "uuid-2"),
    ]
    result = deduplicate_comments(comments)
    assert len(result) == 2, "distinct findings must not replace each other"


def test_reimported_session_finding_dedupes_to_one_row() -> None:
    """The same finding (same node_id, same title) stored twice → one row."""
    comments = [
        _comment("Stale snapshot\n\nbody", None, "uuid-1"),
        _comment("Stale snapshot\n\nbody", None, "uuid-1"),
    ]
    result = deduplicate_comments(comments)
    assert len(result) == 1


def test_github_comments_still_dedup_by_path_summary() -> None:
    """Path-bearing rows keep the source+path+summary key (latest wins)."""
    comments = [
        _comment("Same summary across rounds", "src/api.py", "node-a"),
        _comment("Same summary across rounds", "src/api.py", "node-b"),
    ]
    result = deduplicate_comments(comments)
    assert len(result) == 1, "same path+summary across rounds is one issue"
    assert result[0]["node_id"] == "node-b", "last one wins (latest cycle)"


def test_pathless_rows_without_node_id_fall_back_to_summary_key() -> None:
    """Legacy pathless rows with no node_id keep the old collapse behavior."""
    comments = [
        _comment("Legacy title\n\nbody", None, None),
        _comment("Legacy title\n\nother body", None, None),
    ]
    result = deduplicate_comments(comments)
    assert len(result) == 1
