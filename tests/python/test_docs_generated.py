"""The committed docs artifacts must be generator output, not hand edits.

``docs/*.html``, ``docs/llms.txt``, ``docs/llms-full.txt`` and
``docs/search-index.json`` are produced by ``pi-docsite`` from ``docs/*.md`` and
``docs/nav.json``, and committed in the same change as the markdown that caused
them (AGENTS.md). A diff touching them is therefore expected — but only as
generator output, which a reviewer cannot tell apart from a hand edit by looking
at the patch.

This test settles it mechanically: regenerate from the same sources into a
throwaway directory and require a byte-for-byte match. A hand-edited page fails
here instead of shipping.

The scratch directory lives under the repo's ``.pi/tmp`` on purpose: the
generator resolves the site's repo links with ``git remote get-url origin`` from
the docs directory, so a copy outside the worktree regenerates different bytes
for reasons that have nothing to do with the markdown.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

TAGLINE = "Agent orchestration for pi: routing, subagents, background work, memory, providers, and sidecar."
REPO_ROOT = Path(__file__).resolve().parents[2]
DOCS = REPO_ROOT / "docs"


def _generated_artifacts() -> list[Path]:
    aggregate = [DOCS / name for name in ("llms.txt", "llms-full.txt", "search-index.json")]
    return sorted(DOCS.glob("*.html")) + aggregate


def test_committed_docs_are_generator_output() -> None:
    generate = pytest.importorskip(
        "pi_docsite.generate",
        reason="docs dependency group is not installed (uv run --group docs ...)",
    )
    artifacts = _generated_artifacts()
    assert artifacts, "no generated docs artifacts found -- docs/ moved?"

    scratch_parent = REPO_ROOT / ".pi" / "tmp"
    scratch_parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(dir=scratch_parent, prefix="docsgen-guard-"))
    try:
        staged = scratch / "docs"
        staged.mkdir()
        for source in [*DOCS.glob("*.md"), DOCS / "nav.json"]:
            shutil.copy2(source, staged / source.name)
        shutil.copytree(DOCS / "assets", staged / "assets")

        assert generate.main(["--docs-dir", str(staged), "--tagline", TAGLINE]) == 0

        regenerated = {path.name: path for path in staged.iterdir() if path.is_file()}
        hand_edited = [
            artifact.name
            for artifact in artifacts
            if artifact.name not in regenerated or artifact.read_bytes() != regenerated[artifact.name].read_bytes()
        ]
        assert hand_edited == [], (
            "committed docs differ from pi-docsite output: "
            f"{hand_edited} -- regenerate with `uv run --group docs pi-docsite "
            f'--docs-dir docs --tagline "{TAGLINE}"` instead of editing them'
        )
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
