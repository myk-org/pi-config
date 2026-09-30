"""Outcome tests for scripts/generate_docs.py, run against a temporary docs/ tree."""

from __future__ import annotations

import json
from pathlib import Path

import generate_docs
from pytest import MonkeyPatch

NAV: list[tuple[str, list[str]]] = [("Group", ["alpha", "beta"])]


def test_h1_ignores_inline_code_before_heading() -> None:
    assert generate_docs._h1("`inline code`\n# Title\n", "example") == "Title"


def _setup(tmp_path: Path, monkeypatch: MonkeyPatch, slugs: list[str]) -> Path:
    docs = tmp_path / "docs"
    docs.mkdir()
    for slug in slugs:
        (docs / f"{slug}.md").write_text(f"# {slug.title()}\n\nBody of {slug}.\n", encoding="utf-8")
    # Artefacts the generator must never touch.
    (docs / "assets").mkdir()
    (docs / "assets" / "style.css").write_text("body{}\n", encoding="utf-8")
    (docs / ".nojekyll").touch()
    monkeypatch.setattr(generate_docs, "DOCS_DIR", docs)
    monkeypatch.setattr(generate_docs, "NAVIGATION", NAV)
    return docs


def test_main_writes_pages_indexes_and_removes_stale_html(tmp_path: Path, monkeypatch: MonkeyPatch) -> None:
    docs = _setup(tmp_path, monkeypatch, ["alpha", "beta", "gone"])
    (docs / "gone.html").write_text("<html>stale</html>\n", encoding="utf-8")

    assert generate_docs.main() == 0

    for name in ["index.html", "alpha.html", "beta.html", "search-index.json", "llms.txt", "llms-full.txt"]:
        assert (docs / name).is_file(), f"{name} was not generated"
    assert "Body of beta." in (docs / "beta.html").read_text(encoding="utf-8")
    assert "alpha.md" in (docs / "llms.txt").read_text(encoding="utf-8")
    assert "gone" not in (docs / "llms.txt").read_text(encoding="utf-8")
    search_index = json.loads((docs / "search-index.json").read_text(encoding="utf-8"))
    assert {entry["slug"] for entry in search_index} == {"alpha", "beta"}

    # Stale page removed; its markdown source and every other artefact untouched.
    assert not (docs / "gone.html").exists()
    assert (docs / "gone.md").is_file()
    assert (docs / "assets" / "style.css").is_file()
    assert (docs / ".nojekyll").is_file()
    assert (docs / "index.html").is_file()


def test_main_is_idempotent(tmp_path: Path, monkeypatch: MonkeyPatch) -> None:
    docs = _setup(tmp_path, monkeypatch, ["alpha", "beta"])
    assert generate_docs.main() == 0
    first = {p.name: p.read_bytes() for p in docs.glob("*") if p.is_file()}
    assert generate_docs.main() == 0
    second = {p.name: p.read_bytes() for p in docs.glob("*") if p.is_file()}
    assert first == second
