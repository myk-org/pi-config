#!/usr/bin/env python3
"""Regenerate the static documentation site in ``docs/`` from ``docs/*.md``.

Usage:
    uv run python scripts/generate_docs.py

Renders deterministically (markdown -> HTML via the vendored docsfy renderer),
so repeated runs produce byte-identical output. The markdown sources are the
single source of truth: this script only ever writes HTML, ``llms*.txt``,
``search-index.json`` and ``docs/assets/``; it never touches a ``.md`` file.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from docs_render import renderer

REPO_ROOT = Path(__file__).resolve().parent.parent
DOCS_DIR = REPO_ROOT / "docs"
PROJECT_NAME = "pi-config"
REPO_URL = "https://github.com/myk-org/pi-config"
TAGLINE = "Agent orchestration for pi: routing, subagents, background work, memory, providers, and sidecar."

# Sidebar grouping. Order and membership are what the sidebar renders, so keep
# them stable. Titles come from each file's H1.
NAVIGATION: list[tuple[str, list[str]]] = [
    ("Getting Started", ["quickstart", "configuration"]),
    (
        "Core Workflows",
        [
            "built-in-workflows",
            "automating-code-reviews",
            "custom-slash-commands",
            "managing-custom-agents",
            "using-the-web-dashboard",
        ],
    ),
    (
        "Background & Memory",
        [
            "async-agents-and-cron",
            "background-dreaming",
            "memory-architecture",
            "curating-project-memory",
        ],
    ),
    (
        "Agents & Integrations",
        [
            "inter-agent-communication",
            "external-ai-agents",
            "image-generation",
            "neovim-integration",
            "discord-bot",
        ],
    ),
    ("Providers", ["acpx-provider", "vertex-claude-provider"]),
    (
        "Reference",
        [
            "mcp-servers",
            "pi-sidecar",
            "cli-reference",
            "safety-enforcements",
            "daemon-and-websockets",
            "btw-command",
        ],
    ),
]

_H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_FENCE_RE = re.compile(r"^(`{3,}|~{3,})(.*)$")


def _h1(markdown_text: str, slug: str) -> str:
    """Return the page's H1 title, ignoring ``#`` lines inside code fences.

    YAML samples legitimately contain top-level keys, so a plain ``^# ``
    search finds several hits; only headings outside fences are real.
    """
    titles: list[str] = []
    fence: str | None = None
    for line in markdown_text.splitlines():
        stripped = line.lstrip()
        fence_match = _FENCE_RE.match(stripped)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not fence_match.group(2).strip():
                fence = None
            continue
        if fence is None:
            match = _H1_RE.match(line)
            if match:
                titles.append(match.group(1))
    if len(titles) != 1:
        raise ValueError(f"docs/{slug}.md has {len(titles)} H1 headings, expected 1")
    return titles[0]


def _is_generation_failure_stub(markdown_text: str) -> bool:
    """Return True when a page's body is the docsfy generation-failure notice.

    Upstream docsfy keeps such pages out of the AI-readable indexes so a failed
    generation is never published as if it were real documentation; that filter
    was lost when the renderer and generator were vendored. The pattern lives in
    the renderer, which already declares it, so reuse it here rather than
    keeping a second copy that can drift.
    """
    return renderer._FAILURE_STUB_RE.match(markdown_text) is not None  # noqa: SLF001


def _build_navigation(pages: dict[str, str]) -> list[dict[str, Any]]:
    # "group" is the key the Jinja templates read; "title" is the documented
    # shape for the plan dict. Both carry the same group heading.
    return [
        {
            "group": group,
            "title": group,
            "pages": [{"slug": slug, "title": _h1(pages[slug], slug)} for slug in slugs],
        }
        for group, slugs in NAVIGATION
    ]


def main() -> int:
    pages: dict[str, str] = {}
    for md_file in sorted(DOCS_DIR.glob("*.md")):
        pages[md_file.stem] = md_file.read_text(encoding="utf-8")

    known = {slug for _, slugs in NAVIGATION for slug in slugs}
    missing = known - pages.keys()
    if missing:
        raise SystemExit(f"Navigation references missing docs: {sorted(missing)}")

    navigation = _build_navigation(pages)
    plan = {
        "project_name": PROJECT_NAME,
        "tagline": TAGLINE,
        "repo_url": REPO_URL,
        "navigation": navigation,
    }

    assets_dir = DOCS_DIR / "assets"
    assets_dir.mkdir(exist_ok=True)
    for static_file in sorted(renderer.STATIC_DIR.iterdir()):
        if static_file.is_file():
            shutil.copy2(static_file, assets_dir / static_file.name)

    written: list[tuple[str, int]] = []

    def _write(name: str, text: str) -> None:
        # The committed site is hook-clean (no trailing whitespace, exactly one
        # final newline), so normalise here instead of letting the pre-commit
        # fixers rewrite generated files on every run.
        text = "\n".join(line.rstrip() for line in text.split("\n")).rstrip("\n") + "\n"
        (DOCS_DIR / name).write_text(text, encoding="utf-8")
        written.append((name, len(text.encode("utf-8"))))

    _write(
        "index.html",
        renderer.render_index(PROJECT_NAME, TAGLINE, navigation, repo_url=REPO_URL),
    )

    order = [page for group in navigation for page in group["pages"]]
    for idx, page in enumerate(order):
        slug = page["slug"]
        _write(
            f"{slug}.html",
            renderer.render_page(
                markdown_content=pages[slug],
                page_title=page["title"],
                project_name=PROJECT_NAME,
                tagline=TAGLINE,
                navigation=navigation,
                current_slug=slug,
                prev_page=order[idx - 1] if idx > 0 else None,
                next_page=order[idx + 1] if idx < len(order) - 1 else None,
                repo_url=REPO_URL,
            ),
        )

    search_pages = {page["slug"]: pages[page["slug"]] for page in order}
    _write(
        "search-index.json",
        json.dumps(renderer._build_search_index(search_pages, plan)),  # noqa: SLF001
    )
    # Both AI-readable indexes drop generation-failure stubs. The rendered HTML
    # and search-index.json keep every page: a stub still has a link to follow.
    ai_navigation = [
        {**group, "pages": [p for p in group["pages"] if not _is_generation_failure_stub(pages[p["slug"]])]}
        for group in navigation
    ]
    _write("llms.txt", renderer._build_llms_txt(plan, ai_navigation))  # noqa: SLF001
    _write("llms-full.txt", renderer._build_llms_full_txt(plan, pages, ai_navigation))  # noqa: SLF001

    # Drop HTML for pages that are no longer in the navigation (renamed or
    # removed markdown). glob() is non-recursive, so docs/assets/ is untouched,
    # and only *.html is considered -- .md sources and .nojekyll are safe.
    nav_slugs = {page["slug"] for page in order}
    stale: list[str] = []
    for html_file in sorted(DOCS_DIR.glob("*.html")):
        if html_file.stem not in nav_slugs and html_file.stem != "index":
            html_file.unlink()
            stale.append(html_file.name)

    for name, size in written:
        print(f"{size:>8} B  {name}")
    for name in stale:
        print(f"   removed  {name}")
    print(f"{len(order)} pages, {len(written)} files, {sum(s for _, s in written)} B total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
