"""Deterministic finding-title extraction from raw review comment bodies.

Python port of the TypeScript ``extractFindingTitle`` in
``extensions/orchestrator/review-learning.ts`` — keep the two in sync.
Reviewer tools (Qodo, CodeRabbit) write a human-readable title as the first
meaningful line of a comment body, buried in badge images, HTML tags, and
Markdown emphasis. This module un-buries it so the reviews DB can store a
clean ``comments.title`` at store time (populated by
``myk_pi_tools.reviews.store``; historical rows are backfilled by the same
migration).

The raw ``body`` column is never modified — it stays the audit record of what
the reviewer actually said; ``title`` is a derived, re-backfillable column.
"""

from __future__ import annotations

import re

# Prompt-side body truncation per finding (mirrors the TS MAX_FINDING_BODY_CHARS).
MAX_FINDING_BODY_CHARS = 500
# Hard ceiling on an extracted title (mirrors the TS MAX_LESSON_CHARS).
MAX_TITLE_CHARS = 100

# Badge lines: shield <img>, markdown images, and bare URL lines.
_BADGE_LINE_RE = re.compile(r"^(?:<img\b|!\[[^\]]*\]\([^)]*\)|https?://\S+$)", re.IGNORECASE)

# Qodo inline label spans like <code>🐞 Bug</code> — dropped FIRST so their
# contents do not leak into the title.
_CODE_TAG_RE = re.compile(r"<code\b[^>]*>[\s\S]*?</code>", re.IGNORECASE)

# Remaining HTML tags.
_HTML_TAG_RE = re.compile(r"<[^>]+>")

# Leading list number ("1\. " / "1. ").
_LIST_NUMBER_RE = re.compile(r"^\d+\\?\.\s*")

# Markdown emphasis/fence chars — underscores are KEPT: identifiers use them.
_MARKDOWN_CHARS_RE = re.compile(r"[*`#>|]")


def extract_finding_title(body: str | None) -> str | None:
    """Extract the finding's title line from a raw review body.

    Deterministic, dependency-free. Returns the cleaned first meaningful
    line (≤ MAX_TITLE_CHARS), or None when no meaningful line exists.
    """
    if not isinstance(body, str) or not body.strip():
        return None

    for raw_line in body[:MAX_FINDING_BODY_CHARS].split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        if _BADGE_LINE_RE.match(line):
            continue
        line = _CODE_TAG_RE.sub(" ", line)
        line = _HTML_TAG_RE.sub(" ", line)
        line = _LIST_NUMBER_RE.sub("", line)
        line = _MARKDOWN_CHARS_RE.sub(" ", line)
        line = re.sub(r"\s+", " ", line).strip()
        if len(line) < 15:  # fragments, separators, leftovers
            continue
        return line[:MAX_TITLE_CHARS]
    return None
