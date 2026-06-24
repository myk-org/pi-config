"""CodeRabbit PR approval detection.

Checks if CodeRabbit's summary comment indicates the PR is approved
(no actionable comments generated).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from myk_pi_tools.coderabbit.utils import find_summary_comment, validate_owner_repo

if TYPE_CHECKING:
    from myk_pi_tools.platform.base import Platform

_APPROVED_MARKER = "No actionable comments were generated in the recent review"


def is_approved(owner_repo: str, pr_number: int) -> bool:
    """Check if CodeRabbit approved the PR.

    Returns True if the summary comment contains the approval marker.
    """
    if not validate_owner_repo(owner_repo):
        return False

    _, body, _, _ = find_summary_comment(owner_repo, pr_number)
    if body is None:
        return False

    return _APPROVED_MARKER in body


def is_approved_via_platform(platform: Platform, pr_number: int) -> bool:
    """Check if CodeRabbit approved the PR using Platform protocol.

    Returns True if the summary comment contains the approval marker.
    """
    from myk_pi_tools.coderabbit.utils import find_summary_comment_via_platform

    _, body, _, _ = find_summary_comment_via_platform(platform, pr_number)
    if body is None:
        return False

    return _APPROVED_MARKER in body
