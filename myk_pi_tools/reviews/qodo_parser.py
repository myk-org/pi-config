"""Parse Qodo sticky summary comment to extract unresolved findings.

Qodo posts a persistent "Code Review by Qodo" summary comment on PRs
that tracks all findings with their resolved/open/dismissed status.
This module parses that comment to extract unresolved findings.
"""

from __future__ import annotations

import re
import sys
from typing import Any

from bs4 import BeautifulSoup, Tag


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


# Header that identifies a Qodo sticky comment
QODO_STICKY_HEADER = "Code Review by Qodo"

# Boundary marking previous review iterations (duplicates of current findings)
# Match the real fold marker — must be on its own line (not inside backtick quotes).
_PREVIOUS_RESULTS_RE = re.compile(
    r"^\s*<!-- FOLDED_SECTION_START -->\s*$",
    re.MULTILINE,
)

# Pattern matching individual finding summary lines
# Captures: number, optional strikethrough, title, codes (type, category)
_FINDING_SUMMARY_RE = re.compile(
    r"<summary>\s*(\d+)\.\s+"  # number
    r"(?:<s>(.*?)</s>|(.*?))"  # title (strikethrough group or plain group)
    r"\s*((?:<code>.*?</code>\s*)*)"  # code tags
    r"</summary>",
    re.DOTALL,
)

# Pattern for code references like [file[R28-52]](url) or [file[28-52]](url)
_CODE_REF_RE = re.compile(
    r"\[([^\[\]]+)\[R?(\d+)(?:-(?:R)?(\d+))?\]\]"  # file[R28-52] or file[28-52]
    r"\(([^)]+)\)"  # (url)
)

# Pattern to extract fenced diff blocks (```diff ... ```)
_FENCED_DIFF_RE = re.compile(r"```diff\n(.*?)```", re.DOTALL)

# Pattern to extract fenced code blocks (``` ... ```)
_FENCED_CODE_RE = re.compile(r"```(?!\w)\n(.*?)```", re.DOTALL)


def _strip_blockquote_prefix(text: str) -> str:
    """Strip leading `> ` or `>` markdown blockquote prefix from each line."""
    lines = []
    for line in text.splitlines():
        if line.startswith(">"):
            line = line[1:]
            if line.startswith(" "):
                line = line[1:]
        lines.append(line)
    return "\n".join(lines)


def _find_inner_section(soup: BeautifulSoup | Tag, section_name: str) -> Tag | None:
    """Find a nested <details> whose <summary> text matches *section_name*."""
    for details in soup.find_all("details"):
        summary = details.find("summary")
        if summary and summary.get_text(strip=True) == section_name:
            return details
    return None


def _extract_description(section: Tag) -> str:
    """Extract description from a Description section's <pre> block, preserving HTML."""
    pre = section.find("pre")
    if not pre:
        return ""
    return pre.decode_contents().strip()


def _extract_evidence(section: Tag) -> str:
    """Extract evidence text from an Evidence section's <pre> block, preserving HTML."""
    pre = section.find("pre")
    if not pre:
        return ""
    return pre.decode_contents().strip()


def _extract_evidence_refs(section: Tag) -> list[str]:
    """Extract <code> tags from Evidence section that are OUTSIDE any <pre> block."""
    # Get all <pre> tags to identify which <code> tags are inside them
    pre_tags = set()
    for pre in section.find_all("pre"):
        for code in pre.find_all("code"):
            pre_tags.add(id(code))

    refs = []
    for code in section.find_all("code"):
        if id(code) in pre_tags:
            continue
        text = code.get_text(strip=True)
        if text:
            refs.append(text)
    return refs


def _extract_agent_prompt(raw_section: str) -> str:
    """Extract agent prompt from fenced code block, excluding trailing copy-hint line."""
    match = _FENCED_CODE_RE.search(raw_section)
    if not match:
        return ""
    content = match.group(1).strip()
    lines = content.splitlines()
    while lines and "ⓘ Copy this prompt" in lines[-1]:
        lines.pop()
    return "\n".join(lines).strip()


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
    - description: str (from Description section <pre> block, HTML preserved)
    - finding_type: str (Bug, Rule violation, Requirement gap)
    - category: str (Correctness, Security, etc.)
    - status: str ("open")
    - code_diff: str (diff content from Code section)
    - evidence: str (reasoning text from Evidence section <pre> block, HTML preserved)
    - evidence_refs: list[str] (reference lines from Evidence section <code> tags)
    - agent_prompt: str (prompt text from Agent prompt section)
    """
    if not is_qodo_sticky_comment(body):
        return []

    # Truncate at "Previous review results" to avoid duplicates from older iterations
    prev_match = _PREVIOUS_RESULTS_RE.search(body)
    if prev_match:
        body = body[: prev_match.start()]

    results: list[dict[str, Any]] = []

    # Split into individual <details> blocks for each finding
    details_blocks = re.split(r"^<details>\s*\n?", body, flags=re.MULTILINE)

    for block in details_blocks:
        summary_match = _FINDING_SUMMARY_RE.search(block)
        if not summary_match:
            continue

        index = int(summary_match.group(1))
        strikethrough_title = summary_match.group(2)
        plain_title = summary_match.group(3)
        codes_str = summary_match.group(4)

        # Parse code tags with BeautifulSoup to determine status, type, category
        is_resolved = False
        is_dismissed = False
        finding_type = ""
        category = ""

        if codes_str:
            codes_soup = BeautifulSoup(codes_str, "html.parser")
            for code_tag in codes_soup.find_all("code"):
                text = code_tag.get_text()
                _types = (
                    "Bug",
                    "Rule violation",
                    "Requirement gap",
                    "UX issue",
                    "Cross-repo conflict",
                )
                _cats = (
                    "Correctness",
                    "Security",
                    "Reliability",
                    "Performance",
                    "Maintainability",
                    "Observability",
                )
                if "Resolved" in text:
                    is_resolved = True
                elif "Dismissed" in text:
                    is_dismissed = True
                elif any(t in text for t in _types):
                    finding_type = re.sub(r"[^\w\s-]", "", text).strip()
                elif any(c in text for c in _cats):
                    category = re.sub(r"[^\w\s]", "", text).strip()

        if strikethrough_title is not None:
            title = strikethrough_title
            if not is_resolved and not is_dismissed:
                is_resolved = True
        else:
            title = plain_title or ""

        # Strip HTML from title
        title = re.sub(r"<[^>]+>", "", title).strip()

        if is_resolved or is_dismissed:
            continue

        # Extract first code reference from raw block (markdown construct)
        path = ""
        line = None
        end_line = None
        code_ref = _CODE_REF_RE.search(block)
        if code_ref:
            path = code_ref.group(1).strip()
            line = int(code_ref.group(2))
            if code_ref.group(3):
                end_line = int(code_ref.group(3))

        # Strip blockquote prefixes and parse inner sections with BeautifulSoup
        stripped_block = _strip_blockquote_prefix(block)
        soup = BeautifulSoup(stripped_block, "html.parser")

        # Extract description
        description = ""
        desc_section = _find_inner_section(soup, "Description")
        if desc_section:
            description = _extract_description(desc_section)

        # Extract code diff from Code section
        code_diff = ""
        code_section = _find_inner_section(soup, "Code")
        if code_section:
            # Use raw stripped text for fenced diff extraction (markdown)
            code_section_str = str(code_section)
            diff_match = _FENCED_DIFF_RE.search(code_section_str)
            if diff_match:
                code_diff = diff_match.group(1).strip()

        # Extract evidence and evidence refs
        evidence = ""
        evidence_refs: list[str] = []
        evidence_section = _find_inner_section(soup, "Evidence")
        if evidence_section:
            evidence = _extract_evidence(evidence_section)
            evidence_refs = _extract_evidence_refs(evidence_section)

        # Extract agent prompt
        agent_prompt = ""
        prompt_section = _find_inner_section(soup, "Agent prompt")
        if prompt_section:
            agent_prompt = _extract_agent_prompt(str(prompt_section))

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
            "code_diff": code_diff,
            "evidence": evidence,
            "evidence_refs": evidence_refs,
            "agent_prompt": agent_prompt,
        })

    return results
