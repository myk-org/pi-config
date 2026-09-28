"""Comment signature injection for AI-posted GitHub markdown bodies.

Reads PI_COMMENT_SIGNATURE env var (set by the pi extension on session_start)
and appends a signature line to comment / review bodies. `gh pr create` /
`gh issue create` injection lives in the TS enforcement hook
(`injectGhBodySignature`), not here.
"""

from __future__ import annotations

import os
import re

_FOOTER = re.compile(r"(?:\r?\n\r?\n---\r?\n|\r?\n|^)\*Assisted-by: PI \(([^\r\n]*?)\)\*(?=\r?\n|$)")
_VALID_MODEL = re.compile(r"[\w:./+@-]+(?: [\w:./+@-]+)*", re.ASCII)


def append_signature(body: str) -> str:
    """Append AI signature to a comment body if PI_COMMENT_SIGNATURE is set.

    Idempotent: removes unresolved template footers and duplicate valid
    footers, preserving the first valid model on retries/updates.

    Args:
        body: Original comment body.

    Returns:
        Body with one valid footer, or unchanged if env var is not set.
    """
    signature = os.environ.get("PI_COMMENT_SIGNATURE")
    if not signature:
        return body
    signed = False

    def keep_footer(match: re.Match[str]) -> str:
        nonlocal signed
        model = match.group(1)
        if "PI_MODEL" in model:
            return ""
        if _VALID_MODEL.fullmatch(model):
            if signed:
                return ""
            signed = True
        return match.group(0)

    body = _FOOTER.sub(keep_footer, body)
    if signed:
        return body
    return f"{body}\n\n---\n*{signature}*"
