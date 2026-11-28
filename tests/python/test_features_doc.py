from __future__ import annotations

import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = REPO_ROOT / "docs"
FEATURES_DOC = DOCS_DIR / "features.md"
NAV_JSON = DOCS_DIR / "nav.json"
README_MD = REPO_ROOT / "README.md"

HTML_LINK_RE = re.compile(r"\[[^\]]+\]\(([A-Za-z0-9._-]+)\.html(?:#([A-Za-z0-9._-]+))?\)")
SLASH_CMD_RE = re.compile(r"(?<![A-Za-z0-9_-])/[a-z][a-z0-9-]*")
BACKTICK_RE = re.compile(r"`([^`]+)`")
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*#*$", re.MULTILINE)
GENERIC_WORDS = frozenset({"tool", "tools", "command", "commands", "integration", "mode", "per-turn", "opt-in", "turn"})


def _slugify_heading(text: str) -> str:
    return re.sub(r"[^a-z0-9 -]", "", text.strip().lower()).replace(" ", "-")


def _parse_markdown_table(markdown: str, heading: str) -> list[tuple[str, str]]:
    lines = markdown.splitlines()
    start = next((idx + 1 for idx, line in enumerate(lines) if line.strip() == heading), None)
    assert start is not None, f"Heading {heading!r} not found in README.md"

    table_lines: list[str] = []
    for line in lines[start:]:
        if line.startswith("#") or (table_lines and not line.lstrip().startswith("|")):
            break
        if line.lstrip().startswith("|"):
            table_lines.append(line.strip())

    assert len(table_lines) >= 3, f"Markdown table under {heading!r} is missing or empty"
    rows = [
        (cells[0], cells[1])
        for row_line in table_lines[2:]
        if len(cells := [c.strip().replace(r"\|", "|") for c in re.split(r"(?<!\\)\|", row_line.strip("|"))]) >= 2
    ]
    return rows


def _contains_slash_command(text: str, command: str) -> bool:
    return re.search(rf"(?<![A-Za-z0-9_-]){re.escape(command)}(?![A-Za-z0-9_-])", text) is not None


def test_features_page_wired_in_nav_and_readme() -> None:
    nav_data = json.loads(NAV_JSON.read_text(encoding="utf-8"))
    groups: list[dict[str, object]] = nav_data["groups"]
    getting_started = next((g for g in groups if g.get("name") == "Getting Started"), None)
    assert getting_started is not None, "Missing 'Getting Started' group in docs/nav.json"

    pages = getting_started["pages"]
    assert isinstance(pages, list) and "quickstart" in pages and "features" in pages, (
        f"Expected 'quickstart' and 'features' in Getting Started pages, got: {pages!r}"
    )
    assert pages.index("features") == pages.index("quickstart") + 1, (
        f"'features' must appear immediately after 'quickstart' in Getting Started, got: {pages}"
    )
    assert "(docs/features.md)" in README_MD.read_text(encoding="utf-8"), "README.md must link to (docs/features.md)"


def test_features_bullets_have_valid_doc_links_or_explicit_note() -> None:
    text = FEATURES_DOC.read_text(encoding="utf-8")
    bullets = [line for line in text.splitlines() if line.startswith("- ")]
    assert bullets, "No feature bullets found in docs/features.md"

    for bullet in bullets:
        assert HTML_LINK_RE.search(bullet) or "no separate deep-dive page" in bullet, (
            f"Feature bullet missing .html doc link or explicit note: {bullet}"
        )

    heading_cache: dict[str, set[str]] = {}
    for slug, anchor in HTML_LINK_RE.findall(text):
        target = DOCS_DIR / f"{slug}.md"
        assert target.is_file(), f"docs/features.md links to {slug}.html, but docs/{slug}.md does not exist"
        if anchor:
            if slug not in heading_cache:
                heading_cache[slug] = {_slugify_heading(m) for m in HEADING_RE.findall(target.read_text("utf-8"))}
            assert anchor in heading_cache[slug], (
                f"docs/features.md links to {slug}.html#{anchor}, but no matching heading exists in docs/{slug}.md"
            )


def test_readme_feature_and_prompt_tables_covered_by_features_doc() -> None:
    readme_text = README_MD.read_text(encoding="utf-8")
    features_text = FEATURES_DOC.read_text(encoding="utf-8")
    features_lower = features_text.lower()

    prompt_rows = _parse_markdown_table(readme_text, "### Prompt Templates")
    assert prompt_rows, "No rows parsed from README.md '### Prompt Templates' table"
    for prompt_col, _ in prompt_rows:
        match = SLASH_CMD_RE.search(prompt_col)
        assert match is not None, f"Prompt Templates row missing leading /command: {prompt_col!r}"
        cmd = match.group(0)
        assert _contains_slash_command(features_text, cmd), (
            f"Prompt Templates command {cmd!r} (row {prompt_col!r}) missing from docs/features.md"
        )

    feature_rows = _parse_markdown_table(readme_text, "### Extension: `orchestrator`")
    assert feature_rows, "No rows parsed from README.md '### Extension: `orchestrator`' table"
    saw_slash_commands = False
    for feature_col, desc_col in feature_rows:
        for token in sorted(set(SLASH_CMD_RE.findall(feature_col)) | set(BACKTICK_RE.findall(feature_col))):
            tok = token.lower()
            found = _contains_slash_command(features_lower, tok) if tok.startswith("/") else tok in features_lower
            assert found, f"README feature row {feature_col!r} token {token!r} missing from docs/features.md"

        title = feature_col.replace("**", "").replace("`", "")
        keywords = [
            part
            for word in re.findall(r"[a-z0-9][a-z0-9_-]*", title.lower())
            if word not in GENERIC_WORDS
            for part in word.split("-")
            if len(part) >= 4 and part not in GENERIC_WORDS
        ]
        assert keywords, f"No distinctive keywords extracted from README feature row: {feature_col!r}"
        assert any(kw in features_lower for kw in keywords), (
            f"README feature row {feature_col!r} (keywords {keywords}) not covered in docs/features.md"
        )

        if title.strip().lower() == "slash commands":
            saw_slash_commands = True
            slash_cmds = SLASH_CMD_RE.findall(desc_col)
            assert slash_cmds, "README 'Slash commands' row contains no /commands"
            for cmd in slash_cmds:
                assert _contains_slash_command(features_text, cmd), (
                    f"README 'Slash commands' entry {cmd!r} missing from docs/features.md"
                )
    assert saw_slash_commands, "README '### Extension: `orchestrator`' table missing 'Slash commands' row"
