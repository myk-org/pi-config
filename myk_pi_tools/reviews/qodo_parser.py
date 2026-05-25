"""Parse Qodo sticky summary comment to extract unresolved findings.

Qodo posts a persistent "Code Review by Qodo" summary comment on PRs
that tracks all findings with their resolved/open/dismissed status.
This module parses that comment to extract unresolved findings.
"""

from __future__ import annotations

import re
import sys
from typing import Any


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


# Header that identifies a Qodo sticky comment
QODO_STICKY_HEADER = "Code Review by Qodo"

# Pattern matching individual findings in the sticky comment
# Captures: number, optional strikethrough, title, codes (type, category)
_FINDING_SUMMARY_RE = re.compile(
    r"<summary>\s*(\d+)\.\s+"  # number
    r"(?:<s>(.*?)</s>|(.*?))"  # title (strikethrough group or plain group)
    r"\s*((?:<code>.*?</code>\s*)*)"  # code tags
    r"</summary>",
    re.DOTALL,
)

# Pattern for resolved/dismissed markers
_RESOLVED_RE = re.compile(r"<code>[^<]*Resolved[^<]*</code>")
_DISMISSED_RE = re.compile(r"<code>[^<]*Dismissed[^<]*</code>")

# Pattern for code references like [file[R28-52]](url) or [file[28-52]](url)
_CODE_REF_RE = re.compile(
    r"\[([^\[\]]+)\[R?(\d+)(?:-(?:R)?(\d+))?\]\]"  # file[R28-52] or file[28-52]
    r"\(([^)]+)\)"  # (url)
)

# Pattern for description in <pre> tags
_DESCRIPTION_RE = re.compile(r"<pre>(.*?)</pre>", re.DOTALL)

# Pattern for severity/type code tags
_TYPE_RE = re.compile(r"<code>([^<]*(?:Bug|Rule violation|Requirement gap)[^<]*)</code>")
_CATEGORY_RE = re.compile(r"<code>([^<]*(?:Correctness|Security|Reliability|Performance|Maintainability)[^<]*)</code>")

# Boundary marking previous review iterations (duplicates of current findings)
# Match the real fold marker — must be on its own line (not inside backtick quotes).
# The marker appears as: \n<!-- FOLDED_SECTION_START -->\n
# Inside code quotes it appears as: `<!-- FOLDED_SECTION_START -->`
_PREVIOUS_RESULTS_RE = re.compile(
    r"^\s*<!-- FOLDED_SECTION_START -->\s*$",
    re.MULTILINE,
)


def is_qodo_sticky_comment(body: str) -> bool:
    """Check if a comment body is a Qodo sticky summary comment."""
    return QODO_STICKY_HEADER in body and "<summary>" in body


def parse_qodo_sticky_comment(body: str) -> list[dict[str, Any]]:
    """Parse a Qodo sticky summary comment and return unresolved findings.

    Returns list of dicts with keys:
    - index: int (finding number)
    - title: str (finding title, HTML tags stripped)
    - path: str (file path from first code reference)
    - line: int (start line from first code reference)
    - end_line: int | None
    - description: str (from <pre> block)
    - finding_type: str (Bug, Rule violation, Requirement gap)
    - category: str (Correctness, Security, etc.)
    - status: str ("open", "resolved", "dismissed")
    """
    if not is_qodo_sticky_comment(body):
        return []

    # Truncate at "Previous review results" to avoid duplicates from older iterations
    prev_match = _PREVIOUS_RESULTS_RE.search(body)
    if prev_match:
        body = body[: prev_match.start()]

    results: list[dict[str, Any]] = []

    # Split into individual <details> blocks for each finding
    # Each finding is a <details><summary>...</summary>...</details> block
    details_blocks = re.split(r"<details>\s*\n?", body)

    for block in details_blocks:
        summary_match = _FINDING_SUMMARY_RE.search(block)
        if not summary_match:
            continue

        index = int(summary_match.group(1))
        strikethrough_title = summary_match.group(2)  # if in <s> tags
        plain_title = summary_match.group(3)  # if not in <s> tags
        codes_str = summary_match.group(4)

        # Determine status
        is_resolved = _RESOLVED_RE.search(codes_str) is not None if codes_str else False
        is_dismissed = _DISMISSED_RE.search(codes_str) is not None if codes_str else False

        if strikethrough_title is not None:
            title = strikethrough_title
            if not is_resolved and not is_dismissed:
                # Has strikethrough but no explicit marker — treat as resolved
                is_resolved = True
        else:
            title = plain_title or ""

        # Strip HTML from title
        title = re.sub(r"<[^>]+>", "", title).strip()

        if is_resolved or is_dismissed:
            continue  # Skip resolved/dismissed

        # Extract type and category from code tags
        finding_type = ""
        category = ""
        if codes_str:
            type_match = _TYPE_RE.search(codes_str)
            if type_match:
                finding_type = re.sub(r"[^\w\s]", "", type_match.group(1)).strip()
            cat_match = _CATEGORY_RE.search(codes_str)
            if cat_match:
                category = re.sub(r"[^\w\s]", "", cat_match.group(1)).strip()

        # Extract first code reference (file + lines)
        path = ""
        line = None
        end_line = None
        code_ref = _CODE_REF_RE.search(block)
        if code_ref:
            path = code_ref.group(1).strip()
            line = int(code_ref.group(2))
            if code_ref.group(3):
                end_line = int(code_ref.group(3))

        # Extract description
        description = ""
        desc_match = _DESCRIPTION_RE.search(block)
        if desc_match:
            desc_text = desc_match.group(1).strip()
            # Strip HTML tags from description
            description = re.sub(r"<[^>]+>", "", desc_text).strip()

        results.append({
            "index": index,
            "title": title,
            "path": path,
            "line": line,
            "end_line": end_line,
            "description": description,
            "finding_type": finding_type,
            "category": category,
            "status": "open",
        })

    return results
