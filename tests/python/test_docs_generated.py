"""docs/ carries sources only — the site is built by CI, not committed.

``docs/*.md`` and ``docs/nav.json`` are the hand-written source. The generated
``docs/*.html``, ``docs/assets/**``, ``docs/llms*.txt`` and
``docs/search-index.json`` are build output of ``.github/workflows/docs.yml`` and
are gitignored (issue #1040). Two things are therefore worth checking
mechanically:

1. No generated artifact is tracked. Committing one re-introduces the
   merge-conflict machine the migration removed (``llms-full.txt`` and
   ``search-index.json`` are global: any two page edits collide in the same
   bytes), and ``.github/workflows/docs-guard.yml`` fails such a PR anyway.
2. The tracked sources still build. CI would catch a broken source, but only
   after the push; this local check keeps the failure at the edit.

Ownership of the output stays with the generator: nothing here globs the
repository for artifacts, it asks ``pi-docsite`` what it produces.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

TAGLINE = "Agent orchestration for pi: routing, subagents, background work, memory, providers, and sidecar."
REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"


def test_docs_tree_carries_no_generated_output() -> None:
    """Only top-level ``docs/*.md`` and ``docs/nav.json`` may be TRACKED.

    A local preview build may leave artifacts on disk (they are gitignored); what
    must never come back is a committed one, so this asks git, not the filesystem.
    Nested markdown is rejected too: ``pi-docsite`` reads ``docs/*.md`` only, so a
    ``docs/guides/new.md`` would be tracked and never render.
    """
    tracked = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "ls-files", "docs"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    generated = sorted(
        path for path in tracked if path != "docs/nav.json" and not re.fullmatch(r"docs/[^/]+\.md", path)
    )
    assert generated == [], (
        "only top-level docs/*.md and docs/nav.json may be tracked; found: "
        + ", ".join(generated)
        + " — edit docs/*.md instead; .github/workflows/docs.yml builds the site"
    )


def test_generator_builds_from_tracked_sources() -> None:
    """Every tracked page still builds from the sources in the tree."""
    generate = pytest.importorskip(
        "pi_docsite.generate",
        reason="docs dependency group is not installed (uv run --group docs ...)",
    )

    scratch_parent = REPO_ROOT / ".pi" / "tmp"
    scratch_parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(dir=scratch_parent, prefix="docsgen-guard-"))
    try:
        staged = scratch / "docs"
        staged.mkdir()
        sources = sorted(DOCS.glob("*.md"))
        assert sources, "docs/ has no markdown sources"
        for source in [*sources, DOCS / "nav.json"]:
            shutil.copy2(source, staged / source.name)

        assert generate.main(["--docs-dir", str(staged), "--tagline", TAGLINE]) == 0

        produced = {path.stem for path in staged.glob("*.html")}
        missing = [source.stem for source in sources if source.stem not in produced]
        assert not missing, f"pages that did not render: {', '.join(missing)}"
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
