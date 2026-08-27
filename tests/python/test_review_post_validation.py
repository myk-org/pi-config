"""Tests for Qodo sticky finding post validation."""

import pytest

from myk_pi_tools.reviews.post import is_linked_issue_spec_resolution


@pytest.mark.parametrize(
    "reply",
    [
        "Updated the issue spec in internal #782; this finding is resolved by that specification.",
        "The issue specification was updated: https://github.com/myk-org/pi-config/issues/782.",
    ],
)
def test_linked_issue_spec_resolution_accepts_explicit_issue_reference(reply: str) -> None:
    """Explicit internal or GitHub issue references substantiate a spec resolution."""
    assert is_linked_issue_spec_resolution(reply)


@pytest.mark.parametrize(
    "reply",
    [
        "Updated the issue spec; this finding is resolved by that specification.",
        "By design; see #782.",
        "Updated the issue spec in internal issue 782.",
        "Updated the issue spec: https://github.com/myk-org/pi-config/pull/782.",
        "By design; see internal #782.",
    ],
)
def test_linked_issue_spec_resolution_rejects_missing_or_bogus_references(reply: str) -> None:
    """A bare rationale or non-issue reference cannot skip a Qodo sticky finding."""
    assert not is_linked_issue_spec_resolution(reply)
