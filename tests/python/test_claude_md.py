"""Tests for myk-pi-tools pr claude-md @file include expansion."""

from pathlib import Path

import pytest

from myk_pi_tools.pr.claude_md import _collect_local, expand_at_includes


def test_expand_at_includes_inlines_same_dir_file(tmp_path: Path) -> None:
    """@AGENTS.md line is replaced with AGENTS.md contents."""
    (tmp_path / "AGENTS.md").write_text("# Rules\nDo the thing.\n", encoding="utf-8")
    source = tmp_path / "CLAUDE.md"
    source.write_text("@AGENTS.md\n", encoding="utf-8")
    assert expand_at_includes("@AGENTS.md\n", source) == "# Rules\nDo the thing.\n"


def test_expand_at_includes_leaves_unresolved_directive(tmp_path: Path) -> None:
    """Missing include target stays as the literal @file line."""
    source = tmp_path / "CLAUDE.md"
    source.write_text("@MISSING.md\n", encoding="utf-8")
    assert expand_at_includes("@MISSING.md\n", source) == "@MISSING.md\n"


def test_expand_at_includes_keeps_surrounding_markdown(tmp_path: Path) -> None:
    """Heading plus include expands only the @file line."""
    (tmp_path / "AGENTS.md").write_text("body\n", encoding="utf-8")
    source = tmp_path / "CLAUDE.md"
    raw = "# Pi\n\n@AGENTS.md\n"
    assert expand_at_includes(raw, source) == "# Pi\n\nbody\n"


def test_collect_local_expands_includes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """_collect_local expands @file includes for files that exist."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "AGENTS.md").write_text("from-agents\n", encoding="utf-8")
    (tmp_path / "CLAUDE.md").write_text("@AGENTS.md\n", encoding="utf-8")
    sections = _collect_local(["./CLAUDE.md", "./AGENTS.md"])
    assert sections == ["from-agents\n", "from-agents\n"]
