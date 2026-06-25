"""Comment signature injection for AI-posted PR comments.

Reads PI_COMMENT_SIGNATURE env var (set by the pi extension on session_start)
and appends a signature line to comment bodies.
"""

from __future__ import annotations

import os


def append_signature(body: str) -> str:
    """Append AI signature to a comment body if PI_COMMENT_SIGNATURE_LINE is set.

    Idempotent — checks for existing signature before appending to prevent
    duplicate signatures on retries/updates.

    Args:
        body: Original comment body.

    Returns:
        Body with signature appended, or unchanged if env var is not set
        or signature already present.
    """
    signature = os.environ.get("PI_COMMENT_SIGNATURE")
    if not signature:
        return body
    # Check if signature is already present (idempotent — prevents duplicates on retry)
    signature_line = f"*{signature}*"
    if signature_line in body:
        return body
    return f"{body}\n\n---\n{signature_line}"
