"""Tests for deterministic finding-title extraction (comments.title backfill).

Python port of the TS extractFindingTitle — the two must stay in sync.
"""

from myk_pi_tools.reviews.title_extraction import extract_finding_title


def test_unburies_title_from_real_qodo_body() -> None:
    body = (
        '<img src="https://img.shields.io/badge/High-634FD1?style=flat-square" height="20px" alt="Action required">\n\n'
        "3\\. Generated reference text is edited directly "
        "<code>\U0001f4d8 Rule violation</code> <code>\u2699 Maintainability</code>\n\n"
        "<pre>\n<b><i>docs/llms-full.txt</i></b> adds documentation content directly "
        "alongside source Markdown changes.\n</pre>"
    )
    assert extract_finding_title(body) == "Generated reference text is edited directly"


def test_lifts_markdown_bold_titles_and_strips_emphasis() -> None:
    body = (
        "**Formatted tool permissions bypass pinned-rule protection**\n\n"
        "<b><i>ONLY_PERMIT_RE</i></b> requires the first character"
    )
    assert extract_finding_title(body) == "Formatted tool permissions bypass pinned-rule protection"


def test_strips_inline_code_tags_without_leaking_contents() -> None:
    body = (
        "7\\. Some eligible findings never become lessons <code>\U0001f41e Bug</code> <code>\u2261 Correctness</code>"
    )
    assert extract_finding_title(body) == "Some eligible findings never become lessons"


def test_keeps_underscores_in_identifiers() -> None:
    body = "**Missing strip_sensitive_from_response on the endpoint**"
    assert extract_finding_title(body) == "Missing strip_sensitive_from_response on the endpoint"


def test_skips_badge_image_and_url_only_lines() -> None:
    assert extract_finding_title('<img src="https://shields.io/badge/x">') is None
    assert extract_finding_title("![badge](https://img.example/x.svg)") is None
    assert extract_finding_title("https://example.com/finding/1") is None


def test_rejects_fragments_and_empty_bodies() -> None:
    assert extract_finding_title("1\\. too short") is None
    assert extract_finding_title("") is None
    assert extract_finding_title(None) is None


def test_caps_title_at_100_chars() -> None:
    assert len(extract_finding_title("**" + "y" * 150 + "** tail") or "") == 100


def test_scans_only_first_500_chars() -> None:
    # A title past the 500-char scan window (behind enough badge lines) is not found
    badges = "\n".join(f'<img src="https://shields.io/badge/{i}">' for i in range(30))
    body = badges + "\nA perfectly good title line right here"
    assert extract_finding_title(body) is None
