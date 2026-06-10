"""Parse CodeRabbit review body comments (outside diff range, major, minor, nitpick, and duplicate).

CodeRabbit embeds certain comments directly in the review body text
(not as inline threads). This module extracts those comments into
structured data using BeautifulSoup for HTML structure parsing and
regex for markdown-level patterns. Five kinds of body-embedded
sections are supported:

- **Outside diff range** comments (code outside the PR diff range)
- **Major** comments (significant issues requiring attention)
- **Minor** comments (less critical suggestions)
- **Nitpick** comments (minor suggestions)
- **Duplicate** comments (comments repeated from previous reviews)

The expected format is a blockquoted ``<details>`` section with nested
file-level ``<details>`` blocks, each containing individual comments
separated by ``---`` dividers.
"""

from __future__ import annotations

import re
from typing import Any

from bs4 import BeautifulSoup, Tag

# ---------------------------------------------------------------------------
# Section keyword mapping
# ---------------------------------------------------------------------------

_SECTION_KEYWORDS: dict[str, str] = {
    "outside_diff": "Outside diff range",
    "major": "Major",
    "minor": "Minor",
    "nitpick": "Nitpick",
    "duplicate": "Duplicate",
}

# ---------------------------------------------------------------------------
# Compiled patterns (markdown-level — NOT HTML)
# ---------------------------------------------------------------------------

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

# Strips trailing count like " (2)" from file summary text.
_FILE_PATH_COUNT_RE = re.compile(r"\s*\(\d+\)\s*$")


# ---------------------------------------------------------------------------
# BeautifulSoup helpers
# ---------------------------------------------------------------------------


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


def _remove_ai_prompts(soup: BeautifulSoup) -> None:
    """Remove all 'Prompt for AI Agents' details blocks from the soup.

    Collects targets first to avoid modifying the tree during iteration.
    """
    to_remove: list[Tag] = []
    for details in soup.find_all("details"):
        summary = details.find("summary", recursive=False)
        if summary and "Prompt for AI Agents" in summary.get_text():
            to_remove.append(details)
    for details in to_remove:
        details.decompose()


def _find_sections(soup: BeautifulSoup, keyword: str) -> list[Tag]:
    """Find all ``<details>`` tags whose ``<summary>`` text contains *keyword*.

    Args:
        soup: Parsed HTML tree.
        keyword: Text to search for in ``<summary>`` content (e.g. ``"Major"``).

    Returns:
        List of matching ``<details>`` :class:`Tag` objects.
    """
    results: list[Tag] = []
    for details in soup.find_all("details"):
        summary = details.find("summary", recursive=False)
        if summary and keyword in summary.get_text():
            results.append(details)
    return results


def _find_file_blocks(section_bq: Tag) -> list[tuple[str, Tag]]:
    """Find file-level ``<details>`` blocks inside a section's ``<blockquote>``.

    Each file block is expected to have a ``<summary>`` with the file path
    (optionally followed by a count in parentheses) and a ``<blockquote>``
    containing the individual comments.

    Args:
        section_bq: The ``<blockquote>`` tag of a section-level ``<details>``.

    Returns:
        List of ``(path, blockquote_tag)`` tuples.
    """
    results: list[tuple[str, Tag]] = []
    for details in section_bq.find_all("details", recursive=False):
        summary = details.find("summary", recursive=False)
        if summary:
            path = _FILE_PATH_COUNT_RE.sub("", summary.get_text()).strip()
            bq = details.find("blockquote", recursive=False)
            if bq and path:
                results.append((path, bq))
    return results


def _prepare_soup(body: str) -> BeautifulSoup:
    """Prepare a :class:`BeautifulSoup` tree from a review body string.

    Strips markdown blockquote ``>`` prefixes, parses the HTML, and removes
    any "Prompt for AI Agents" ``<details>`` blocks.
    """
    cleaned = _strip_blockquote_prefix(body)
    soup = BeautifulSoup(cleaned, "html.parser")
    _remove_ai_prompts(soup)
    return soup


# ---------------------------------------------------------------------------
# Comment parsing
# ---------------------------------------------------------------------------


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
    # Body starts after the title line. AI prompt sections have already
    # been removed from the soup before text extraction.
    body_text = text
    if title_match:
        body_text = text[title_match.end() :].strip()

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


def _parse_section_comments(soup: BeautifulSoup, keyword: str) -> list[dict[str, Any]]:
    """Extract and parse comments from sections matching *keyword*.

    Finds all ``<details>`` blocks whose ``<summary>`` contains *keyword*,
    then iterates their file-level sub-blocks and parses individual
    comments separated by ``---`` dividers.

    Args:
        soup: Parsed and AI-prompt-cleaned HTML tree.
        keyword: Section keyword (e.g. ``"Major"``).

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

    for section in _find_sections(soup, keyword):
        section_bq = section.find("blockquote", recursive=False)
        if section_bq is None:
            continue

        for file_path, file_bq in _find_file_blocks(section_bq):
            file_content = file_bq.decode_contents().strip()

            # Split individual comments on --- separators
            comment_blocks = re.split(r"\r?\n---\s*\r?\n", file_content)

            for block in comment_blocks:
                parsed = _parse_single_comment(block)
                if parsed is not None:
                    parsed["path"] = file_path
                    results.append(parsed)

    return results


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


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

    return _parse_section_comments(_prepare_soup(body), _SECTION_KEYWORDS["outside_diff"])


def parse_major_comments(body: str) -> list[dict[str, Any]]:
    """Parse 'major' comments from a CodeRabbit review body.

    Args:
        body: The review body text.

    Returns:
        List of dicts, each with keys:
        - path: str (file path)
        - line: int (start line)
        - end_line: int | None (end line, or None if single line)
        - body: str (the full comment body including title, but excluding AI prompt sections)
        - category: str (e.g., "Potential issue")
        - severity: str (e.g., "Major")
    """
    if not body:
        return []

    return _parse_section_comments(_prepare_soup(body), _SECTION_KEYWORDS["major"])


def parse_minor_comments(body: str) -> list[dict[str, Any]]:
    """Parse 'minor' comments from a CodeRabbit review body.

    Args:
        body: The review body text.

    Returns:
        List of dicts, each with keys:
        - path: str (file path)
        - line: int (start line)
        - end_line: int | None (end line, or None if single line)
        - body: str (the full comment body including title, but excluding AI prompt sections)
        - category: str (e.g., "Suggestion")
        - severity: str (e.g., "Minor")
    """
    if not body:
        return []

    return _parse_section_comments(_prepare_soup(body), _SECTION_KEYWORDS["minor"])


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

    return _parse_section_comments(_prepare_soup(body), _SECTION_KEYWORDS["nitpick"])


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

    return _parse_section_comments(_prepare_soup(body), _SECTION_KEYWORDS["duplicate"])


def parse_review_body_comments(body: str) -> dict[str, list[dict[str, Any]]]:
    """Parse all body-embedded comments from a CodeRabbit review body.

    Returns:
        Dict with keys ``'outside_diff'``, ``'major'``, ``'minor'``,
        ``'nitpick'``, and ``'duplicate'``, each containing a list of
        parsed comment dicts.
    """
    if not body:
        return {"outside_diff": [], "major": [], "minor": [], "nitpick": [], "duplicate": []}

    soup = _prepare_soup(body)

    return {key: _parse_section_comments(soup, keyword) for key, keyword in _SECTION_KEYWORDS.items()}
