"""Comment signature injection for AI-posted PR comments.

Reads PI_COMMENT_SIGNATURE env var (set by the pi extension on session_start)
and appends a signature line to comment bodies.
"""

from __future__ import annotations

import os


def append_signature(body: str) -> str:
    """Append AI signature to a comment body if PI_COMMENT_SIGNATURE is set.

    Args:
        body: Original comment body.

    Returns:
        Body with signature appended, or unchanged if env var is not set.
    """
    signature = os.environ.get("PI_COMMENT_SIGNATURE")
    if not signature:
        return body
    return f"{body}\n\n---\n*{signature}*"
