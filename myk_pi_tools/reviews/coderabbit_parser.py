"""Parse CodeRabbit review body comments (outside diff range, nitpick, and duplicate).

CodeRabbit embeds certain comments directly in the review body text
(not as inline threads). This module extracts those comments into
structured data. Three kinds of body-embedded sections are supported:

- **Outside diff range** comments (code outside the PR diff range)
- **Nitpick** comments (minor suggestions)
- **Duplicate** comments (comments repeated from previous reviews)

The expected format is a blockquoted ``<details>`` section with nested
file-level ``<details>`` blocks, each containing individual comments
separated by ``---`` dividers.
"""

from __future__ import annotations

import re
from typing import Any

# ---------------------------------------------------------------------------
# Compiled patterns
# ---------------------------------------------------------------------------

# Matches the start of the outer "Outside diff range comments" section.
_OUTSIDE_SECTION_START_RE = re.compile(
    r"<summary>\s*(?:\S+\s+)*?Outside diff range comments?\s*(?:\(\d+\))?\s*</summary>\s*<blockquote>",
)

# Matches the start of the outer "Nitpick comments" section.
_NITPICK_SECTION_START_RE = re.compile(
    r"<summary>\s*(?:\S+\s+)*?Nitpick comments?\s*(?:\(\d+\))?\s*</summary>\s*<blockquote>",
)

# Matches the start of the outer "Duplicate comments" section.
_DUPLICATE_SECTION_START_RE = re.compile(
    r"<summary>\s*(?:\S+\s+)*?Duplicate comments?\s*(?:\(\d+\))?\s*</summary>\s*<blockquote>",
)

# Matches the start of a file-level <details> block with path and count.
_FILE_SUMMARY_RE = re.compile(
    r"<details>\s*\n?\s*<summary>\s*(?P<path>.+?)\s*(?:\(\d+\))?\s*</summary>\s*<blockquote>",
)

# Matches the backtick line-range pattern at the start of a comment.
# Handles both range (`552-572`) and single-line (`42`) formats.
_LINE_RANGE_RE = re.compile(
    r"^`(?P<start>\d+)(?:-(?P<end>\d+))?`",
)

# Matches the category/severity annotation line.
# Example: _:warning: Potential issue_ | _:orange_circle: Major_
_ANNOTATION_RE = re.compile(
    r"_\S*\s*(?P<category>[^_]+?)_\s*\|\s*_\S*\s*(?P<severity>[^_]+?)_",
)

# Matches the bold title line.
_TITLE_RE = re.compile(
    r"^\*\*(?P<title>.+?)\*\*",
    re.MULTILINE,
)

# Matches the "Prompt for AI Agents" details block (to be excluded).
_AI_PROMPT_RE = re.compile(
    r"<details>\s*\n?\s*<summary>\s*\S*\s*Prompt for AI Agents\s*</summary>.*?</details>",
    re.DOTALL,
)


def _strip_blockquote_prefix(text: str) -> str:
    """Strip the ``>`` prefix from each line of a blockquoted section.

    Handles varying whitespace between ``>`` and the content.
    """
    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped.startswith(">"):
            # Remove ">" and any whitespace after it
            lines.append(stripped[1:].lstrip())
        else:
            lines.append(line)
    return "\n".join(lines)


def _extract_blockquote_content(text: str, start: int) -> str | None:
    """Extract blockquote content by tracking nesting depth from a given position.

    Args:
        text: The full text.
        start: Position immediately after the opening ``<blockquote>`` tag.

    Returns:
        The content between the opening and its matching closing
        ``</blockquote>`` tag, or ``None`` if no matching close is found.
    """
    depth = 1
    pos = start
    bq_open_tag = "<blockquote>"
    bq_close_tag = "</blockquote>"

    while depth > 0 and pos < len(text):
        next_open = text.find(bq_open_tag, pos)
        next_close = text.find(bq_close_tag, pos)

        if next_close == -1:
            # No closing tag found at all
            break

        if next_open != -1 and next_open < next_close:
            depth += 1
            pos = next_open + len(bq_open_tag)
        else:
            depth -= 1
            if depth == 0:
                return text[start:next_close]
            pos = next_close + len(bq_close_tag)

    return None


def _parse_single_comment(raw: str) -> dict[str, Any] | None:
    """Parse a single comment block within a file section.

    Args:
        raw: The raw text of one comment (between ``---`` separators).

    Returns:
        A dict with parsed fields, or ``None`` if unparseable.
    """
    text = raw.strip()
    if not text:
        return None

    # --- Line range ---
    line: int | None = None
    end_line: int | None = None
    line_match = _LINE_RANGE_RE.search(text)
    if not line_match:
        return None

    line = int(line_match.group("start"))
    end_raw = line_match.group("end")
    if end_raw is not None:
        end_line = int(end_raw)

    # --- Category and severity ---
    category: str = ""
    severity: str = ""
    ann_match = _ANNOTATION_RE.search(text)
    if ann_match:
        category = ann_match.group("category").strip()
        severity = ann_match.group("severity").strip()

    # --- Title ---
    title: str = ""
    title_match = _TITLE_RE.search(text)
    if title_match:
        title = title_match.group("title").strip()

    # --- Body ---
    # Body starts after the title line. We keep everything except the
    # "Prompt for AI Agents" details block.
    body_text = text
    if title_match:
        body_text = text[title_match.end() :].strip()

    # Remove AI prompt sections
    body_text = _AI_PROMPT_RE.sub("", body_text).strip()

    # Build the full body: title + remaining body
    body_parts: list[str] = []
    if title:
        body_parts.append(f"**{title}**")
    if body_text:
        body_parts.append(body_text)

    body = "\n\n".join(body_parts) if body_parts else text

    return {
        "path": "",  # placeholder, filled by caller
        "line": line,
        "end_line": end_line,
        "body": body,
        "category": category,
        "severity": severity,
    }


def _parse_section_comments(cleaned: str, section_re: re.Pattern[str]) -> list[dict[str, Any]]:
    """Extract and parse comments from a single section of a cleaned review body.

    This is the shared logic for "outside diff range", "nitpick", and "duplicate"
    sections. The caller is responsible for cleaning the text first (stripping
    blockquote prefixes and trailing AI prompt blocks).

    Args:
        cleaned: The review body text after blockquote-prefix and AI-prompt
            stripping.
        section_re: Compiled regex that matches the section's ``<summary>``
            header (up to and including the opening ``<blockquote>`` tag).

    Returns:
        List of dicts, each with keys:
        - path: str (file path)
        - line: int (start line)
        - end_line: int | None (end line, or None if single line)
        - body: str (comment body including title, excluding AI prompt sections)
        - category: str (e.g., "Potential issue", "Nitpick")
        - severity: str (e.g., "Major", "Trivial")
    """
    results: list[dict[str, Any]] = []

    for section_start_match in section_re.finditer(cleaned):
        section_content = _extract_blockquote_content(cleaned, section_start_match.end())
        if section_content is None:
            continue

        # Extract each file-level block using nesting-aware extraction.
        for file_match in _FILE_SUMMARY_RE.finditer(section_content):
            file_path = file_match.group("path").strip()
            file_content = _extract_blockquote_content(section_content, file_match.end())
            if file_content is None:
                continue

            file_content = file_content.strip()

            # Split individual comments on --- separators
            comment_blocks = re.split(r"\r?\n---\s*\r?\n", file_content)

            for block in comment_blocks:
                parsed = _parse_single_comment(block)
                if parsed is not None:
                    parsed["path"] = file_path
                    results.append(parsed)

    return results


def parse_outside_diff_comments(body: str) -> list[dict[str, Any]]:
    """Parse 'outside diff range' comments from a CodeRabbit review body.

    Args:
        body: The review body text.

    Returns:
        List of dicts, each with keys:
        - path: str (file path)
        - line: int (start line)
        - end_line: int | None (end line, or None if single line)
        - body: str (the full comment body including title, but excluding AI prompt sections)
        - category: str (e.g., "Potential issue", "Nitpick")
        - severity: str (e.g., "Major", "Trivial")
    """
    if not body:
        return []

    # Strip blockquote prefixes so we can parse clean HTML
    cleaned = _strip_blockquote_prefix(body)

    # Also strip a trailing AI prompt section that may appear outside the
    # blockquote at the very end of the review body.
    cleaned = _AI_PROMPT_RE.sub("", cleaned).strip()

    return _parse_section_comments(cleaned, _OUTSIDE_SECTION_START_RE)


def parse_nitpick_comments(body: str) -> list[dict[str, Any]]:
    """Parse 'nitpick' comments from a CodeRabbit review body.

    Args:
        body: The review body text.

    Returns:
        List of dicts, each with keys:
        - path: str (file path)
        - line: int (start line)
        - end_line: int | None (end line, or None if single line)
        - body: str (the full comment body including title, but excluding AI prompt sections)
        - category: str (e.g., "Nitpick")
        - severity: str (e.g., "Trivial")
    """
    if not body:
        return []

    # Strip blockquote prefixes so we can parse clean HTML
    cleaned = _strip_blockquote_prefix(body)

    # Also strip a trailing AI prompt section that may appear outside the
    # blockquote at the very end of the review body.
    cleaned = _AI_PROMPT_RE.sub("", cleaned).strip()

    return _parse_section_comments(cleaned, _NITPICK_SECTION_START_RE)


def parse_duplicate_comments(body: str) -> list[dict[str, Any]]:
    """Parse 'duplicate' comments from a CodeRabbit review body.

    Args:
        body: The review body text.

    Returns:
        List of dicts, each with keys:
        - path: str (file path)
        - line: int (start line)
        - end_line: int | None (end line, or None if single line)
        - body: str (the full comment body including title, but excluding AI prompt sections)
        - category: str (e.g., "Refactor suggestion")
        - severity: str (e.g., "Major")
    """
    if not body:
        return []

    # Strip blockquote prefixes so we can parse clean HTML
    cleaned = _strip_blockquote_prefix(body)

    # Also strip a trailing AI prompt section that may appear outside the
    # blockquote at the very end of the review body.
    cleaned = _AI_PROMPT_RE.sub("", cleaned).strip()

    return _parse_section_comments(cleaned, _DUPLICATE_SECTION_START_RE)


def parse_review_body_comments(body: str) -> dict[str, list[dict[str, Any]]]:
    """Parse all body-embedded comments from a CodeRabbit review body.

    Returns:
        Dict with keys ``'outside_diff'``, ``'nitpick'``, and ``'duplicate'``,
        each containing a list of parsed comment dicts.
    """
    if not body:
        return {"outside_diff": [], "nitpick": [], "duplicate": []}

    cleaned = _strip_blockquote_prefix(body)
    cleaned = _AI_PROMPT_RE.sub("", cleaned).strip()

    return {
        "outside_diff": _parse_section_comments(cleaned, _OUTSIDE_SECTION_START_RE),
        "nitpick": _parse_section_comments(cleaned, _NITPICK_SECTION_START_RE),
        "duplicate": _parse_section_comments(cleaned, _DUPLICATE_SECTION_START_RE),
    }
