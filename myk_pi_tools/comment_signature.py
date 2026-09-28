"""Comment signature injection for AI-posted GitHub markdown bodies.

Uses the operation's PI_MODEL when available, otherwise the session-start
PI_COMMENT_SIGNATURE, to sign comment / review bodies when enabled. `gh pr create` /
`gh issue create` injection lives in the TS enforcement hook
(`injectGhBodySignature`), not here.
"""

from __future__ import annotations

import os
import re

from myk_pi_tools.logger import create_logger

_FOOTER = re.compile(r"(?:\r?\n\r?\n---\r?\n|\r?\n|^)\*Assisted-by: PI \(([^\r\n]*?)\)\*(?=\r?\n|$)")
_VALID_MODEL = re.compile(r"[\w:./+@-]+(?: [\w:./+@-]+)*", re.ASCII)
log = create_logger(__name__)


def append_signature(body: str) -> str:
    """Append an AI signature using PI_MODEL or the cached session signature.

    Idempotent: removes unresolved template footers and duplicate valid
    footers. When PI_MODEL is set, replaces stale models on existing footers;
    otherwise preserves the first valid model on retries/updates.

    Args:
        body: Original comment body.

    Returns:
        Body with one valid footer, or unchanged if signing is disabled.
    """
    cached_signature = os.environ.get("PI_COMMENT_SIGNATURE")
    if not cached_signature:
        return body
    model = os.environ.get("PI_MODEL")
    if not model or not _VALID_MODEL.fullmatch(model):
        model = None
    signature = f"Assisted-by: PI ({model})" if model else cached_signature
    log.debug("Selecting comment signature", extra={"operation_model_present": bool(model)})
    signed = False

    def keep_footer(match: re.Match[str]) -> str:
        nonlocal signed
        existing_model = match.group(1)
        if "PI_MODEL" in existing_model:
            return ""
        if _VALID_MODEL.fullmatch(existing_model):
            if signed:
                return ""
            signed = True
            if model:
                if existing_model != model:
                    log.debug(
                        "Replacing stale standalone comment signature",
                        extra={"from_model": existing_model, "to_model": model},
                    )
                return match.group(0).replace(f"({existing_model})*", f"({model})*")
        return match.group(0)

    body = _FOOTER.sub(keep_footer, body)
    if signed:
        return body
    return f"{body}\n\n---\n*{signature}*"
